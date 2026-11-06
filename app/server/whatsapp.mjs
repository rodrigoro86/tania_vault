/**
 * whatsapp.mjs — ponte WhatsApp (Evolution API) ↔ assistente/vault.
 *
 * Fluxo: Evolution chama POST /api/evolution/webhook → verifica o apikey →
 * whitelist de números → classifica (comprovante / ideia / feito / conversa
 * livre) → grava no MinIO (ou responde via agente) → devolve a confirmação
 * via sendText.
 *
 * Comprovante (imagem/PDF): só é guardado, nunca vai para o LLM (traz CPF, SPEC
 * NFR-06). Os dados do recebimento vêm da legenda ou da conversa.
 *
 * Teste sem enviar WhatsApp: EVOLUTION_DRY_RUN=1 (o sendText só loga).
 */
import crypto from 'node:crypto';
import { store, readJson, writeVaultFile } from './vault-api.mjs';
import { getMedia, sendText } from './evolution.mjs';

const DIGITS = (s) => String(s ?? '').replace(/\D/g, '');
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** dedupe de webhooks reenviados pela Evolution (evita nota duplicada) */
const seen = new Set();
function dedupe(id) {
  if (!id) return true;
  if (seen.has(id)) return false;
  if (seen.size > 500) seen.delete(seen.values().next().value);
  seen.add(id);
  return true;
}

function allowedNumbers() {
  return new Set(String(process.env.WHATSAPP_ALLOWED_NUMBERS || '').split(',').map(DIGITS).filter(Boolean));
}

/** com addressing LID o remoteJid não é telefone; o número real vem em remoteJidAlt */
export function senderNumber(key) {
  const alt = String(key?.remoteJidAlt ?? '');
  const jid = alt.endsWith('@s.whatsapp.net') ? alt : String(key?.remoteJid ?? '');
  return DIGITS(jid.split('@')[0]);
}

function sameSecret(a, b) {
  const A = Buffer.from(String(a ?? ''));
  const B = Buffer.from(String(b ?? ''));
  return A.length > 0 && A.length === B.length && crypto.timingSafeEqual(A, B);
}

function extractText(msg) {
  if (!msg) return '';
  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.ephemeralMessage?.message?.conversation ||
    msg.ephemeralMessage?.message?.extendedTextMessage?.text ||
    msg.buttonsResponseMessage?.selectedDisplayText ||
    msg.listResponseMessage?.title ||
    ''
  );
}

/** imagem ou documento da mensagem, com a legenda */
export function extractMedia(msg) {
  const m = msg?.ephemeralMessage?.message ?? msg;
  const media = m?.imageMessage ?? m?.documentMessage ?? m?.documentWithCaptionMessage?.message?.documentMessage;
  return media ? { mimetype: String(media.mimetype ?? '').split(';')[0], caption: String(media.caption ?? '').trim() } : null;
}

const COMPROVANTE_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
const MAX_COMPROVANTE = 20 * 1024 * 1024;

/** nome único por mensagem: reenvio da Evolution não duplica o arquivo */
export function comprovantePath(dir, messageId, mimetype, hoje) {
  const id = String(messageId ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 32) || 'sem-id';
  return `${dir}/${hoje.slice(0, 7)}/${hoje}-${id}.${COMPROVANTE_EXT[mimetype]}`;
}

/** o dia do usuário: em UTC, depois das 21h já seria o dia seguinte */
export const hojeSP = (agora = new Date()) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(agora);

async function saveComprovante(data, mimetype) {
  const { COMPROVANTES_DIR } = await import('./finance.mjs');
  const base64 = data.message?.base64 || (await getMedia(data.key)).base64;
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length > MAX_COMPROVANTE) throw new Error('arquivo acima de 20 MB');
  const hoje = hojeSP();
  const path = comprovantePath(COMPROVANTES_DIR, data.key?.id, mimetype, hoje);
  await writeVaultFile(path, buffer, { overwrite: true });
  return path;
}

/** memória curta por número: sem ela o agente não entende a resposta à própria pergunta */
const CONVERSA_TTL = 30 * 60 * 1000;
const CONVERSA_MAX = 12;
const conversas = new Map();

function conversa(number) {
  const atual = conversas.get(number);
  if (atual && Date.now() - atual.at < CONVERSA_TTL) return atual;
  const nova = { at: Date.now(), history: [], comprovantes: [] };
  conversas.set(number, nova);
  return nova;
}

/** único ponto que grava na memória: o agente só recebe as últimas CONVERSA_MAX mensagens */
export function lembrar(c, ...mensagens) {
  c.at = Date.now();
  c.history.push(...mensagens);
  c.history.splice(0, Math.max(0, c.history.length - CONVERSA_MAX));
}

/** roda o agente com o histórico e os comprovantes ainda sem recebimento */
async function askAgent(number, text) {
  const c = conversa(number);
  const nota = c.comprovantes.length
    ? `\n\n[Comprovantes guardados e ainda sem recebimento: ${c.comprovantes.join(', ')}. ` +
      'Use o caminho em "comprovante" ao registrar o recebimento correspondente. Você não vê o conteúdo deles.]'
    : '';
  const { runAgentText } = await import('./agent.ts');
  const reply = (await runAgentText(text + nota, { history: c.history })) || 'Feito.';
  lembrar(c, { role: 'user', content: text }, { role: 'assistant', content: reply });
  if (c.comprovantes.length) {
    const { comprovanteVinculado } = await import('./finance.mjs');
    const usados = await Promise.all(c.comprovantes.map(comprovanteVinculado));
    c.comprovantes = c.comprovantes.filter((_, i) => !usados[i]);
  }
  return reply;
}

function slugify(text) {
  return (
    norm(text)
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'ideia'
  );
}

function isIdea(text) {
  const t = String(text).trim();
  if (/^(💡|ideia\s*:)/i.test(t)) return true;
  const n = norm(t);
  return /\b(escreva|crie|anote|salve|registre|monte|faca)\b/.test(n) && /\bideia\b/.test(n);
}

function isDone(text) {
  return /^(✅|feito\s*:)/i.test(String(text).trim());
}

/** gera a nota (LLM, com fallback para o texto do usuário) e grava em 05-Ideias/ */
async function writeIdea(text) {
  let body = '';
  try {
    const { chatText } = await import('./agent.ts');
    body = await chatText(
      'Você é a Tania, assistente pessoal. Escreva uma nota de ideia curta em português, em markdown. ' +
        'Formato: primeira linha "# Título curto" e depois 3 a 6 bullets objetivos (problema, proposta, próximo passo). ' +
        'Não use frontmatter. Responda só com a nota.',
      text,
    );
  } catch (err) {
    console.error('whatsapp: LLM falhou, usando o texto do usuário:', err?.message);
  }
  body = String(body || '').trim();
  const fallbackTitle = text.replace(/^(💡|ideia\s*:)/i, '').trim().slice(0, 80);
  const title = (/^#\s+(.+)$/m.exec(body)?.[1] || fallbackTitle || 'Ideia').slice(0, 80);
  if (!/^#\s+/m.test(body)) body = `# ${title}\n\n${body || text}`;
  const today = new Date().toISOString().slice(0, 10);
  const path = `05-Ideias/${today}-${slugify(title)}.md`;
  const note = `---\ntype: idea\ncreated: ${today}\ntags: [ideia]\nstatus: open\n---\n\n${body}\n`;
  await store.writeText(path, note);
  return path;
}

/** acrescenta "✅ feito" na nota do dia em 01-Diario/ */
async function writeDone(text) {
  const today = hojeSP();
  const path = `01-Diario/${today}.md`;
  let current = '';
  try {
    current = await store.readText(path);
  } catch {
    /* nota do dia ainda não existe */
  }
  const line = `- ✅ ${text.replace(/^(✅|feito\s*:)/i, '').trim()}`;
  if (!current) {
    current = `---\ntype: journal\ncreated: ${today}\ntags: [agenda/diario]\nstatus: open\n---\n\n# ${today}\n\n`;
  }
  const next = /##\s+✅\s+Feito/.test(current)
    ? `${current.replace(/\n*$/, '\n')}${line}\n`
    : `${current.replace(/\n*$/, '\n')}\n## ✅ Feito\n\n${line}\n`;
  await store.writeText(path, next);
  return path;
}

async function processMessage(body) {
  const data = body?.data ?? {};
  const jid = String(data.key?.remoteJid ?? '');
  if (!jid || jid.endsWith('@g.us')) return; // ignora grupos
  if (data.key?.fromMe) return; // evita loop

  const number = senderNumber(data.key);
  if (!allowedNumbers().has(number)) {
    console.warn('whatsapp: número fora da whitelist:', number);
    return;
  }
  if (!dedupe(data.key?.id)) return;

  const media = extractMedia(data.message);
  const text = media ? media.caption : extractText(data.message).trim();
  if (!text && !(media && COMPROVANTE_EXT[media.mimetype])) {
    await sendText(number, 'Recebi, mas só consigo processar texto, imagem ou PDF (ideia:, feito:, uma pergunta ou um comprovante).');
    return;
  }

  try {
    if (media) {
      if (!COMPROVANTE_EXT[media.mimetype]) {
        await sendText(number, '⚠️ Para comprovante, mande imagem ou PDF.');
        return;
      }
      const path = await saveComprovante(data, media.mimetype);
      const c = conversa(number);
      c.comprovantes.push(path);
      if (!text) {
        const pergunta = '📎 Comprovante guardado. De qual aluguel é, qual o valor e a data?';
        lembrar(c, { role: 'assistant', content: pergunta });
        await sendText(number, pergunta);
        return;
      }
      await sendText(number, await askAgent(number, text));
      return;
    }
    if (isIdea(text)) {
      const resposta = `✅ Ideia salva em ${await writeIdea(text)}`;
      lembrar(conversa(number), { role: 'user', content: text }, { role: 'assistant', content: resposta });
      await sendText(number, resposta);
      return;
    }
    if (isDone(text)) {
      const resposta = `✅ Registrado em ${await writeDone(text)}`;
      lembrar(conversa(number), { role: 'user', content: text }, { role: 'assistant', content: resposta });
      await sendText(number, resposta);
      return;
    }

    await sendText(number, await askAgent(number, text));
  } catch (err) {
    console.error('whatsapp: erro ao processar:', err?.message);
    await sendText(number, `⚠️ Não consegui concluir: ${err?.message || 'erro interno'}`).catch(() => {});
  }
}

export async function handleEvolutionWebhook(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'método não permitido' }));
  }

  let body;
  try {
    body = await readJson(req);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'JSON inválido' }));
  }

  // autentica a origem: vale a chave global OU o token da instância (o que a
  // Evolution manda no body.apikey do webhook)
  const url = new URL(req.url ?? '/', 'http://whatsapp');
  const provided = req.headers.apikey || body?.apikey || url.searchParams.get('apikey') || '';
  const clean = (v) => String(v ?? '').trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
  const expected = [clean(process.env.EVOLUTION_API_KEY), clean(process.env.EVOLUTION_INSTANCE_TOKEN)].filter(Boolean);
  if (!expected.some((k) => sameSecret(provided, k))) {
    console.warn('whatsapp: webhook com apikey inválido');
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'apikey inválido' }));
  }

  // responde rápido (a Evolution não espera o LLM); processa em seguida
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));

  void processMessage(body).catch((err) => console.error('whatsapp:', err));
}

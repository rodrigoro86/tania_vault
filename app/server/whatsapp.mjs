/**
 * whatsapp.mjs — ponte WhatsApp (Evolution API) ↔ assistente/vault.
 *
 * Fluxo: Evolution chama POST /api/evolution/webhook → verifica o apikey →
 * whitelist de números → classifica (anexo / melhoria / feito / conversa
 * livre) → grava no vault (ou responde via agente) → devolve a confirmação
 * via sendText.
 *
 * Anexo (imagem/PDF, ex.: print de erro): só é guardado, nunca vai para o LLM
 * (SPEC NFR-06). A legenda e o caminho do arquivo vão para o agente.
 *
 * Teste sem enviar WhatsApp: EVOLUTION_DRY_RUN=1 (o sendText só loga).
 */
import crypto from 'node:crypto';
import { ATTACHMENTS_DIR, store, readJson, writeVaultFile } from './vault-api.mjs';
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

const ANEXO_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
const MAX_ANEXO = 20 * 1024 * 1024;
const ANEXOS_DIR = `${ATTACHMENTS_DIR}/whatsapp`;

/** nome único por mensagem: reenvio da Evolution não duplica o arquivo */
export function anexoPath(dir, messageId, mimetype, hoje) {
  const id = String(messageId ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 32) || 'sem-id';
  return `${dir}/${hoje.slice(0, 7)}/${hoje}-${id}.${ANEXO_EXT[mimetype]}`;
}

/** o dia do usuário: em UTC, depois das 21h já seria o dia seguinte */
export const hojeSP = (agora = new Date()) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(agora);

async function saveAnexo(data, mimetype) {
  const base64 = data.message?.base64 || (await getMedia(data.key)).base64;
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length > MAX_ANEXO) throw new Error('arquivo acima de 20 MB');
  const hoje = hojeSP();
  const path = anexoPath(ANEXOS_DIR, data.key?.id, mimetype, hoje);
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
  const nova = { at: Date.now(), history: [] };
  conversas.set(number, nova);
  return nova;
}

/** único ponto que grava na memória: o agente só recebe as últimas CONVERSA_MAX mensagens */
export function lembrar(c, ...mensagens) {
  c.at = Date.now();
  c.history.push(...mensagens);
  c.history.splice(0, Math.max(0, c.history.length - CONVERSA_MAX));
}

/**
 * atalhos (melhoria:/ideia:, feito:) passam pelo agente, que escolhe o agente especializado (agenda, melhorias...);
 * se o agente falhar (sem LLM, erro, timeout), grava direto como antes, para não perder a mensagem
 */
export async function atalhoPeloAgente(pedir, direto) {
  try {
    return await pedir();
  } catch (err) {
    console.warn('whatsapp: agente indisponível, atalho gravado direto:', err?.message);
    return direto();
  }
}

/** roda o agente com o histórico; `anexo` = caminho do arquivo recém-guardado (o agente não vê o conteúdo) */
async function askAgent(number, text, anexo = '') {
  const c = conversa(number);
  const nota = anexo
    ? `\n\n[Arquivo anexado e guardado em ${anexo}. Você não vê o conteúdo; para citar numa nota use ![[${anexo.split('/').pop()}]].]`
    : '';
  const { runAgentText } = await import('./agent.ts');
  const reply = (await runAgentText(text + nota, { history: c.history })) || 'Feito.';
  lembrar(c, { role: 'user', content: text }, { role: 'assistant', content: reply });
  return reply;
}

function slugify(text) {
  return (
    norm(text)
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'melhoria'
  );
}

function isIdea(text) {
  const t = String(text).trim();
  if (/^(💡|ideia\s*:|melhoria\s*:)/i.test(t)) return true;
  const n = norm(t);
  return /\b(escreva|crie|anote|salve|registre|monte|faca)\b/.test(n) && /\b(ideia|melhoria)\b/.test(n);
}

function isDone(text) {
  return /^(✅|feito\s*:)/i.test(String(text).trim());
}

/** gera a nota (LLM, com fallback para o texto do usuário) e grava em 03-Melhorias/ */
async function writeIdea(text) {
  let body = '';
  try {
    const { chatText } = await import('./agent.ts');
    body = await chatText(
      'Você é a Tania, assistente de análise e teste de sistemas. Escreva uma nota de melhoria curta em português, em markdown. ' +
        'Formato: primeira linha "# Título curto" e depois 3 a 6 bullets objetivos (situação atual, proposta, impacto, próximo passo). ' +
        'Não use frontmatter. Responda só com a nota.',
      text,
    );
  } catch (err) {
    console.error('whatsapp: LLM falhou, usando o texto do usuário:', err?.message);
  }
  body = String(body || '').trim();
  const fallbackTitle = text.replace(/^(💡|ideia\s*:|melhoria\s*:)/i, '').trim().slice(0, 80);
  const title = (/^#\s+(.+)$/m.exec(body)?.[1] || fallbackTitle || 'Melhoria').slice(0, 80);
  if (!/^#\s+/m.test(body)) body = `# ${title}\n\n${body || text}`;
  const today = new Date().toISOString().slice(0, 10);
  const path = `03-Melhorias/${today}-${slugify(title)}.md`;
  const note = `---\ntype: improvement\ncreated: ${today}\ntags: [melhoria]\nstatus: open\n---\n\n${body}\n`;
  await store.writeText(path, note);
  return path;
}

/** acrescenta "✅ feito" na nota do dia em 01-Agenda/ */
async function writeDone(text) {
  const today = hojeSP();
  const path = `01-Agenda/${today}.md`;
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
  if (!text && !(media && ANEXO_EXT[media.mimetype])) {
    await sendText(number, 'Recebi, mas só consigo processar texto, imagem ou PDF (melhoria:, feito:, uma pergunta ou um anexo).');
    return;
  }

  try {
    if (media) {
      if (!ANEXO_EXT[media.mimetype]) {
        await sendText(number, '⚠️ Anexo só como imagem ou PDF.');
        return;
      }
      const path = await saveAnexo(data, media.mimetype);
      if (!text) {
        const aviso = `📎 Arquivo guardado em ${path}. Mande uma mensagem dizendo onde ele entra (teste, melhoria...).`;
        lembrar(conversa(number), { role: 'assistant', content: aviso });
        await sendText(number, aviso);
        return;
      }
      await sendText(number, await askAgent(number, text, path));
      return;
    }
    if (isIdea(text) || isDone(text)) {
      const resposta = await atalhoPeloAgente(
        () => askAgent(number, text),
        async () => {
          const direto = isIdea(text) ? `✅ Melhoria salva em ${await writeIdea(text)}` : `✅ Registrado em ${await writeDone(text)}`;
          lembrar(conversa(number), { role: 'user', content: text }, { role: 'assistant', content: direto });
          return direto;
        },
      );
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

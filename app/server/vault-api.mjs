/**
 * vault-api.mjs — camada de escrita sobre o vault (API REST).
 *
 * Dev:  montado como middleware do Vite pelo plugin `vaultApiPlugin` (vite.config.ts).
 * Prod: server.mjs sobe standalone, servindo app/dist + /api/*.
 *
 * Regras de segurança seguem AGENTS.md: nada de .obsidian/, .git/, app/, tmp/;
 * dentro do vault a escrita é livre, inclusive na raiz.
 */
import path from 'node:path';
import { createAuthGate } from './auth.mjs';
import { store } from './storage/index.mjs';
import { NOTE_EXT, SKIP_DIRS, FILE_TYPES, fileType } from './storage/constants.mjs';

export { store, FILE_TYPES, fileType };

const HERE = path.dirname(new URL(import.meta.url).pathname);
/** raiz do vault: ../ em relação a app/server */
export const VAULT_ROOT = path.resolve(process.env.VAULT_ROOT || path.join(HERE, '..', '..'));

/** pastas que fazem parte do vault e aceitam escrita */
/* SKIP_DIRS, NOTE_EXT, FILE_TYPES e fileType vêm de storage/constants.mjs */

/* FILE_TYPES/fileType vêm de storage/constants.mjs (importados e reexportados acima) */

/** uploads (site e agente) só caem aqui: AGENTS.md §6 */
export const ATTACHMENTS_DIR = '99-Meta/attachments';
const MAX_UPLOAD = 50 * 1024 * 1024;

/** CSP de isolamento: scripts rodam, mas em origem opaca (sem cookie, sem /api) */
const SANDBOX_CSP = 'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-presentation allow-downloads';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** valida um caminho relativo ao vault, bloqueando traversals e pastas fora do escopo */
export function sanitize(rawPath, kind = 'note') {
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    throw new ApiError(400, 'path é obrigatório');
  }
  const rel = rawPath.replace(/\\/g, '/').trim().replace(/^\/+/, '');
  if (!rel) throw new ApiError(400, 'path inválido');

  const parts = rel.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..') || /%2e|%2f|%5c/i.test(rel)) {
    throw new ApiError(400, 'path inválido (.. não é permitido)');
  }

  const abs = path.normalize(path.join(VAULT_ROOT, rel));
  if (abs !== VAULT_ROOT && !abs.startsWith(VAULT_ROOT + path.sep)) {
    throw new ApiError(400, 'path fora do vault');
  }

  const top = parts[0];
  if (SKIP_DIRS.has(top) || top.startsWith('.')) {
    throw new ApiError(403, `${top}/ não faz parte do vault`);
  }

  if (kind === 'note') {
    if (!NOTE_EXT.test(rel)) throw new ApiError(400, 'nota precisa terminar em .md ou .base');
    if (rel === 'AGENTS.md') throw new ApiError(403, 'AGENTS.md é protegido');
  }
  return { rel, abs, kind };
}

/** varre o vault (local ou MinIO): notas (.md/.base), anexos e pastas existentes */
export async function listVault() {
  const { notes, folders, files } = await store.list();
  return { notes, folders, files, root: store.label };
}

export function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) reject(new ApiError(413, 'payload grande demais'));
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new ApiError(400, 'JSON inválido'));
      }
    });
    req.on('error', reject);
  });
}

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.write(JSON.stringify(payload));
  res.end();
}

/* ---------- anexos: /files/<caminho> e envio ---------- */

const ASCII_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * caminho de anexo para leitura: sem traversal, sem dotfile em nenhum nível
 * (.env, .htpasswd, .git…), fora de SKIP_DIRS (app/ tem agent.config.json)
 * e só extensões de FILE_TYPES
 */
export function sanitizeFile(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) throw new ApiError(400, 'path é obrigatório');
  const rel = rawPath.replace(/\\/g, '/').trim().replace(/^\/+/, '');
  const parts = rel.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..')) throw new ApiError(400, 'path inválido (.. não é permitido)');
  if (parts.some((p) => p.startsWith('.') || SKIP_DIRS.has(p))) throw new ApiError(403, `${rel} não faz parte do vault`);
  const type = fileType(rel);
  if (!type) throw new ApiError(415, `${rel}: tipo de arquivo não suportado`);
  const abs = path.normalize(path.join(VAULT_ROOT, rel));
  if (!abs.startsWith(VAULT_ROOT + path.sep)) throw new ApiError(400, 'path fora do vault');
  return { rel, abs, type };
}

/** caminho de envio: qualquer pasta do vault, nomes ASCII */
export function sanitizeUpload(rawPath) {
  const f = sanitizeFile(rawPath);
  const bad = f.rel.split('/').find((seg) => !ASCII_SEGMENT.test(seg));
  if (bad) throw new ApiError(400, `"${bad}": use nome ASCII, sem espaço nem acento (hyphens)`);
  return f;
}

/**
 * grava um anexo (não sobrescreve sem `overwrite`) e commita só ele
 * @param {string} rawPath
 * @param {Buffer} data
 * @param {{ overwrite?: boolean }} [opts]
 */
export async function writeVaultFile(rawPath, data, { overwrite = false } = {}) {
  const f = sanitizeUpload(rawPath);
  if (data.length > MAX_UPLOAD) throw new ApiError(413, `arquivo maior que ${MAX_UPLOAD / 1024 / 1024} MB`);
  const exists = await store.exists(f.rel);
  if (exists && !overwrite) throw new ApiError(409, `${f.rel} já existe`);
  await store.write(f.rel, data);
  return { path: f.rel, created: !exists, size: data.length };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new ApiError(413, `arquivo maior que ${limit / 1024 / 1024} MB`));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * GET/HEAD /files/<caminho>: anexo direto do disco (aparece sem rebuild).
 * ETag/304 para não rebaixar imagens a cada visita; Range para vídeo/áudio.
 */
export async function handleVaultFile(req, res) {
  const fail = (status, message) => {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
    res.end(message);
  };
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(405, 'método não permitido');
    const url = new URL(req.url, 'http://vault');
    const f = sanitizeFile(decodeURIComponent(url.pathname.replace(/^\/files\//, '')));

    // MinIO: redireciona para URL assinada (Range/ETag ficam por conta do MinIO)
    if (store.kind === 's3') {
      const signed = await store.presign(f.rel, { download: f.type.kind === 'office' });
      res.writeHead(302, { Location: signed, 'Cache-Control': 'private, no-store' });
      return res.end();
    }

    let st;
    try {
      st = await store.stat(f.rel);
    } catch {
      return fail(404, `${f.rel} não existe`);
    }

    const name = path.basename(f.rel);
    const etag = `W/"${st.size}-${Math.floor(st.mtimeMs)}"`;
    const headers = {
      'Content-Type': f.type.mime,
      'Cache-Control': 'private, no-cache',
      ETag: etag,
      'Last-Modified': new Date(st.mtimeMs).toUTCString(),
      'X-Content-Type-Options': 'nosniff',
      'Accept-Ranges': 'bytes',
      // office não abre no navegador: baixa; o resto abre na aba
      'Content-Disposition': `${f.type.kind === 'office' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}`,
      ...(f.type.sandbox ? { 'Content-Security-Policy': SANDBOX_CSP } : {}),
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }

    let start = 0;
    let end = st.size - 1;
    let status = 200;
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    if (range && st.size > 0) {
      start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
      end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
      if (start > end || start >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    }
    headers['Content-Length'] = st.size ? end - start + 1 : 0;
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || st.size === 0) return res.end();
    (await store.readStream(f.rel, { start, end })).on('error', () => res.destroy()).pipe(res);
  } catch (err) {
    fail(err instanceof ApiError ? err.status : 500, err.message || 'erro interno');
  }
}

export async function handleVaultApi(req, res) {
  try {
    const url = new URL(req.url, 'http://vault-api');
    // em dev (Express via Vite) o prefixo "/api" é removido antes de chegar aqui
    const pathname = url.pathname.startsWith('/api') ? url.pathname : `/api${url.pathname}`;

    /* ---------- envio de anexo (corpo binário) ---------- */
    // application/octet-stream não é Content-Type "simples": força preflight de
    // CORS, então fecha o mesmo vetor de CSRF que o JSON fecha abaixo
    if (pathname.startsWith('/api/files/') && req.method === 'PUT') {
      const ct = String(req.headers['content-type'] ?? '').toLowerCase();
      if (!ct.startsWith('application/octet-stream')) {
        return json(res, 415, { ok: false, error: 'Content-Type deve ser application/octet-stream' });
      }
      const rel = decodeURIComponent(pathname.slice('/api/files/'.length));
      // usuário logado no site: qualquer pasta do vault (o agente segue preso a 99-Meta/attachments)
      sanitizeUpload(rel, 'vault'); // falha antes de ler o corpo
      const data = await readBody(req, MAX_UPLOAD);
      const out = await writeVaultFile(rel, data);
      return json(res, 201, { ok: true, ...out });
    }

    // CSRF por Content-Type: uma "simple request" (text/plain, form, beacon)
    // disparada por qualquer página aberta no mesmo navegador chega sem
    // preflight de CORS e escreveria no vault. Exigir JSON fecha esse vetor.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const ct = String(req.headers['content-type'] ?? '');
      if (!ct.toLowerCase().startsWith('application/json')) {
        return json(res, 415, { ok: false, error: 'Content-Type deve ser application/json' });
      }
    }

    /* ---------- webhook do WhatsApp (Evolution) ---------- */
    if (pathname === '/api/evolution/webhook' && req.method === 'POST') {
      const { handleEvolutionWebhook } = await import('./whatsapp.mjs');
      return await handleEvolutionWebhook(req, res);
    }

    /* ---------- financeiro (Postgres) ---------- */
    if (pathname.startsWith('/api/finance/')) {
      const { handleFinance } = await import('./finance.mjs');
      return await handleFinance(req, res, pathname, url);
    }

    /* ---------- lembretes (Postgres) ---------- */
    if (pathname.startsWith('/api/investimentos/')) {
      const { handleInvestimentos } = await import('./investimentos.mjs');
      return handleInvestimentos(req, res, pathname, url);
    }

    if (pathname === '/api/reminders' || pathname.startsWith('/api/reminders/')) {
      const { handleReminders } = await import('./reminders.mjs');
      return await handleReminders(req, res, pathname, url);
    }

    if (pathname === '/api/health') {
      return json(res, 200, { ok: true, storage: store.kind, writable: true });
    }

    /* ---------- agente LLM (terminal do painel da direita) ---------- */
    if (pathname.startsWith('/api/agent/')) {
      // import dinâmico: agent.ts importa este módulo (evita ciclo na carga)
      const { handleAgent } = await import('./agent.ts');
      return await handleAgent(req, res, pathname);
    }

    /* ---------- ClickUp (só leitura) ---------- */
    if (pathname.startsWith('/api/clickup/')) {
      const { handleClickUp } = await import('./clickup.ts');
      return await handleClickUp(req, res, pathname);
    }

    /* ---------- notas ---------- */
    if (pathname === '/api/notes' && req.method === 'GET') {
      return json(res, 200, await listVault());
    }

    if (pathname === '/api/notes' && (req.method === 'POST' || req.method === 'PUT')) {
      const body = await readJson(req);
      const { rel } = sanitize(body.path, 'note');
      const exists = await store.exists(rel);
      if (req.method === 'POST' && exists) {
        return json(res, 409, { ok: false, error: `${rel} já existe` });
      }
      if (typeof body.content !== 'string') {
        return json(res, 400, { ok: false, error: 'content é obrigatório' });
      }
      await store.writeText(rel, body.content);
      return json(res, exists ? 200 : 201, { ok: true, path: rel, created: !exists });
    }

    if (pathname.startsWith('/api/notes/') && req.method === 'DELETE') {
      const rel = decodeURIComponent(pathname.slice('/api/notes/'.length));
      sanitize(rel, 'note');
      if (!(await store.exists(rel))) return json(res, 404, { ok: false, error: `${rel} não existe` });
      await store.remove(rel);
      return json(res, 200, { ok: true, path: rel, removed: true });
    }

    /* ---------- pastas ---------- */
    if (pathname === '/api/folders' && req.method === 'POST') {
      const body = await readJson(req);
      const { rel } = sanitize(body.path, 'folder');
      if (await store.dirExists(rel)) return json(res, 409, { ok: false, error: `${rel}/ já existe` });
      await store.mkdir(rel);
      return json(res, 201, { ok: true, path: rel });
    }

    if (pathname.startsWith('/api/folders/') && req.method === 'DELETE') {
      const rel = decodeURIComponent(pathname.slice('/api/folders/'.length));
      const { rel: cleanRel } = sanitize(rel, 'folder');
      if (!(await store.dirExists(cleanRel))) return json(res, 404, { ok: false, error: `${cleanRel}/ não existe` });

      const empty = await store.isEmptyDir(cleanRel);
      if (!empty && url.searchParams.get('recursive') !== '1') {
        return json(res, 409, { ok: false, error: `${cleanRel}/ não está vazia` });
      }

      // AGENTS.md §3 ("nunca apagar"): o disco local não tem undo
      if (!empty && store.kind === 'local') {
        return json(res, 409, { ok: false, error: `${cleanRel}/ não está vazia: no modo local apagar seria irrecuperável` });
      }

      await store.removeDir(cleanRel);
      return json(res, 200, { ok: true, path: cleanRel, removed: true });
    }

    /* ---------- renomear nota ou pasta ---------- */
    if (pathname === '/api/rename' && req.method === 'POST') {
      const body = await readJson(req);
      const isNote = NOTE_EXT.test(String(body.from ?? ''));
      const from = sanitize(body.from, isNote ? 'note' : 'folder');
      const to = sanitize(body.to, isNote ? 'note' : 'folder');
      const fromExists = isNote ? await store.exists(from.rel) : await store.dirExists(from.rel);
      if (!fromExists) return json(res, 404, { ok: false, error: `${from.rel} não existe` });
      const toExists = isNote ? await store.exists(to.rel) : await store.dirExists(to.rel);
      if (toExists) return json(res, 409, { ok: false, error: `${to.rel} já existe` });
      await store.rename(from.rel, to.rel);
      return json(res, 200, { ok: true, from: from.rel, to: to.rel });
    }

    return json(res, 404, { ok: false, error: `rota desconhecida: ${pathname}` });
  } catch (err) {
    const status = err instanceof ApiError ? err.status : 500;
    console.error('vault-api:', req.method, req.url, '->', status, err?.name || '', err?.message || err);
    return json(res, status, { ok: false, error: err.message || 'erro interno' });
  }
}

/** plugin Vite: expõe /api/* no servidor de desenvolvimento */
export function vaultApiPlugin() {
  return {
    name: 'vault-api',
    configureServer(server) {
      // portão de login primeiro: em dev o Vite serve os módulos com o texto das notas
      const gate = createAuthGate();
      server.middlewares.use((req, res, next) => {
        // webhook do WhatsApp: sem cookie; autentica pelo apikey no handler
        if (req.url?.startsWith('/api/evolution/webhook')) return next();
        gate(req, res).then((handled) => handled || next(), next);
      });
      // middlewares internos do Vite (server.app não existe em Vite >= 6)
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith('/files/')) return void handleVaultFile(req, res);
        if (!req.url || !req.url.startsWith('/api')) return next();
        handleVaultApi(req, res).catch((err) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String(err.message || err) }));
        });
      });
    },
  };
}



/**
 * server.mjs — servidor standalone para produção:
 *   /api/*  -> vault-api (CRUD do vault)
 *   /files/* -> anexos do vault direto do disco (imagens, html, pdf…)
 *   demais  -> app/dist (SPA com fallback para index.html)
 *
 * Uso: node server/server.mjs   (PORT=3000 VAULT_ROOT=...)
 */
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createAuthGate, isTrustedProxy } from './auth.mjs';
import { createRateLimit } from './rate-limit.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
// VAULT_AUTH pode vir de app/.env (gitignored); env do processo tem prioridade
try {
  process.loadEnvFile(path.join(HERE, '..', '.env'));
} catch {
  /* sem .env: usa só o env do processo */
}
// config das integrações vem do banco e vence o .env: carga antes de qualquer módulo ler env
const dbOn = Boolean(process.env.DATABASE_URL || process.env.PGHOST); // mesma regra de db.mjs#dbConfigured
if (dbOn) await (await import('./config-db.mjs')).loadDbConfig();
// import dinâmico: vault-api lê VAULT_ROOT do env na carga do módulo, depois do .env
const { handleVaultApi, handleVaultFile, store } = await import('./vault-api.mjs');

// banco: aplica migrações e liga o scheduler de lembretes (não derruba o server se falhar)
if (dbOn) {
  import('./db.mjs')
    .then(({ migrate }) => migrate())
    .then(() => import('./reminders.mjs'))
    .then(({ startScheduler }) => startScheduler())
    .catch((err) => console.error('db/reminders:', err.message));
}

const gate = createAuthGate();
const apiRate = createRateLimit();
const DIST = path.resolve(process.env.FRONT_DIST || path.join(HERE, '..', 'dist'));
const PORT = Number(process.env.PORT || 3000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv': 'text/csv; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.ico': 'image/x-icon',
};

/**
 * cache: assets do Vite têm hash no nome (mudou o build, mudou a URL) -> cache
 * eterno; index.html sempre revalida, senão o navegador fica preso no bundle
 * antigo (que continua em dist/assets: o scp do deploy não apaga nada)
 */
function cacheFor(target) {
  if (target.startsWith(path.join(DIST, 'assets') + path.sep)) return 'public, max-age=31536000, immutable';
  return 'no-cache';
}

async function serveStatic(req, res) {
  const pathname = decodeURIComponent(new URL(req.url, 'http://vault').pathname);
  const target = path.normalize(path.join(DIST, pathname === '/' ? 'index.html' : pathname));
  if (!target.startsWith(DIST + path.sep) && target !== path.join(DIST, 'index.html')) {
    res.writeHead(400).end('bad request');
    return;
  }
  try {
    const file = await fs.readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target)] || 'application/octet-stream',
      'Cache-Control': cacheFor(target),
    });
    res.end(file);
  } catch {
    // fallback SPA: qualquer rota não-asset devolve index.html
    try {
      const index = await fs.readFile(path.join(DIST, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(index);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('dist não construído: rode npm run build');
    }
  }
}

async function route(req, res) {
  // restart interno: só o backend Rust (que prova o segredo do proxy) pode pedir;
  // o container (`restart: unless-stopped`) ou o Swarm sobe os dois de novo
  if (req.method === 'POST' && req.url === '/api/internal/restart') {
    if (isTrustedProxy(req)) {
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      setTimeout(() => process.exit(0), 200);
    } else {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'proibido' }));
    }
    return;
  }
  // webhook do WhatsApp: autenticado pelo apikey da Evolution (não tem cookie)
  if (req.url?.startsWith('/api/evolution/webhook')) {
    handleVaultApi(req, res).catch((err) => {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }));
    });
    return;
  }
  // login antes de tudo: dist/ contém o texto de todas as notas
  if (await gate(req, res)) return;
  // janela por IP na /api (abuso); o /login já tem o bloqueio próprio no auth.mjs
  if (req.url?.startsWith('/api')) {
    const ip = req.socket?.remoteAddress ?? '?';
    if (!apiRate(ip)) {
      res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'muitas requisições: aguarde um instante' }));
      return;
    }
  }
  if (req.url?.startsWith('/files/')) {
    await handleVaultFile(req, res);
    return;
  }
  if (req.url?.startsWith('/api')) {
    handleVaultApi(req, res).catch((err) => {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }));
    });
    return;
  }
  serveStatic(req, res).catch(() => {
    if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('bad request');
  });
}

const server = http.createServer((req, res) => {
  // nenhuma Promise aqui pode ficar sem catch: uma rejeição não tratada
  // derruba o processo Node inteiro (ex.: GET /% -> decodeURIComponent lança)
  route(req, res).catch((err) => {
    console.error('server: erro na rota', req.method, req.url, err?.stack || err);
    if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('bad request');
  });
});

server.listen(PORT, () => {
  console.log(`storage:   ${store.kind === 's3' ? 'rustfs' : 'local'} (${store.label})`);
  if (store.kind !== 's3') {
    console.warn('AVISO: storage local em uso — para usar o bucket, defina VAULT_STORAGE=rustfs no .env');
  }
  store
    .listKeys('')
    .then((keys) => console.log(`bucket:    ${keys.length} objeto(s)`))
    .catch((err) => console.error(`bucket:    ERRO (${err?.name || ''}: ${err?.message || err})`));
  console.log(`static:    ${DIST}`);
  console.log(`http://localhost:${PORT}`);
});

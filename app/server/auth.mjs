/**
 * auth.mjs — tela de login (usuário/senha) na frente de TUDO: /api e o front.
 *
 * O bundle do front contém o texto de todas as notas (import.meta.glob), então
 * proteger só /api não basta: o portão roda antes do Vite (dev) e antes do
 * static (server.mjs). A página de login é HTML puro, sem o bundle.
 *
 * Credencial: VAULT_AUTH="usuario:senha" (env ou app/.env, fora do git).
 * Sem VAULT_AUTH: só localhost entra; acesso remoto (VPN/LAN) recebe 503.
 *
 * Sessão: cookie HttpOnly assinado com HMAC (chave derivada de VAULT_AUTH):
 * sobrevive a restart do servidor e trocar a senha derruba todas as sessões.
 *
 * LEGACY_PROXY_SECRET: segredo compartilhado com o backend Rust que fica na
 * frente; quando ele já autentica o usuário, manda x-tania-proxy com esse
 * segredo e o portão deixa passar (sem cookie).
 */
import crypto from 'node:crypto';

const COOKIE = 'vault_session';

/**
 * PWA: o navegador busca manifest e ícones para instalar o app, às vezes sem
 * cookie (inclusive a partir da tela de login). São só marca visual, gerados
 * por scripts/gen-icons.mjs, sem nada do vault: liberados sem login.
 * /brand/: logotipos da identidade visual (public/brand). Apresentações HTML
 * abrem isoladas, sem cookie, e só enxergam o logo se ele for público.
 * Comparação exata / prefixo fixo; o static do server.mjs já barra traversal.
 */
export function isPublicAsset(pathname) {
  return pathname === '/manifest.webmanifest' || /^\/(icons|brand)\/[\w.-]+\.(png|svg)$/.test(pathname);
}
const MAX_AGE_S = 30 * 24 * 3600; // 30 dias
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

/** "user:pass" -> { user, pass }; a senha pode conter ":" (corta só no 1º).
 *  Remove aspas em volta: o env_file do Docker/Swarm entrega `'usuario:senha'` literal. */
export function parseAuth(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const clean = String(raw).trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
  if (!clean) return null;
  const i = clean.indexOf(':');
  const user = i > 0 ? clean.slice(0, i) : '';
  const pass = i > 0 ? clean.slice(i + 1) : '';
  if (!user || !pass) throw new Error('VAULT_AUTH deve ter o formato usuario:senha (ambos não vazios)');
  return { user, pass };
}

const sha = (s) => crypto.createHash('sha256').update(s).digest();
/** comparação em tempo constante (hash antes: timingSafeEqual exige mesmo tamanho) */
const same = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

/**
 * o backend Rust (na frente) já autentica o usuário (x-tania-user) e prova isso
 * com o segredo compartilhado LEGACY_PROXY_SECRET no header x-tania-proxy.
 * Também usa essa regra o `POST /api/internal/restart` do server.mjs.
 */
export function isTrustedProxy(req, secret = process.env.LEGACY_PROXY_SECRET) {
  const proxy = req?.headers?.['x-tania-proxy'];
  return Boolean(secret) && typeof proxy === 'string' && proxy.length > 0 && same(proxy, secret);
}

function sign(key, exp) {
  return crypto.createHmac('sha256', key).update(String(exp)).digest('base64url');
}

export function makeToken(key, now = Date.now()) {
  const exp = Math.floor(now / 1000) + MAX_AGE_S;
  return `${exp}.${sign(key, exp)}`;
}

export function validToken(key, token, now = Date.now()) {
  const [exp, mac] = String(token ?? '').split('.');
  if (!exp || !mac || !/^\d+$/.test(exp)) return false;
  if (Number(exp) * 1000 < now) return false;
  return same(mac, sign(key, exp));
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return '';
}

function isLoopback(req) {
  const ip = req.socket?.remoteAddress ?? '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function isHttps(req) {
  return Boolean(req.socket?.encrypted) || req.headers['x-forwarded-proto'] === 'https';
}

async function readForm(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 4096) throw new Error('form grande demais');
  }
  return new URLSearchParams(body);
}

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function loginPage(error = '') {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#16191b">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icons/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<title>Vault — entrar</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: 16px;
    background: #16191b; color: #dcddde; font: 15px/1.5 Inter, system-ui, -apple-system, sans-serif; }
  form { width: min(100%, 340px); display: grid; gap: 14px; padding: 28px 24px;
    background: #1d2124; border: 1px solid #2f3437; border-radius: 14px; }
  h1 { margin: 0 0 4px; font-size: 18px; font-weight: 600; }
  label { display: grid; gap: 6px; font-size: 13px; color: #9a9fa3; }
  input { font: inherit; font-size: 16px; padding: 10px 12px; border-radius: 8px;
    border: 1px solid #2f3437; background: #101315; color: #dcddde; }
  input:focus { outline: 2px solid #4fab9a; outline-offset: 0; }
  button { font: inherit; font-weight: 600; padding: 11px; border: 0; border-radius: 8px;
    background: #4fab9a; color: #0e1113; cursor: pointer; min-height: 44px; }
  button:hover { background: #5fc0ae; }
  .error { margin: 0; padding: 8px 10px; border-radius: 8px; font-size: 13px;
    color: #f2b8b8; background: rgba(160, 59, 59, .2); border: 1px solid rgba(160, 59, 59, .5); }
</style>
</head>
<body>
<form method="post" action="/login">
  <h1>🔒 Vault</h1>
  ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
  <label>Usuário <input name="user" autocomplete="username" autocapitalize="none" required autofocus></label>
  <label>Senha <input name="password" type="password" autocomplete="current-password" required></label>
  <button type="submit">Entrar</button>
</form>
</body>
</html>`;
}

/**
 * cria o portão. Devolve `gate(req, res) -> boolean`: true = já respondeu
 * (login, logout, redirect, 401/503); false = autenticado, segue o fluxo.
 */
export function createAuthGate(raw = process.env.VAULT_AUTH, proxySecret = process.env.LEGACY_PROXY_SECRET) {
  const creds = parseAuth(raw);
  const key = creds ? sha(`vault-session:${creds.user}:${creds.pass}`) : null;
  // shortcut: bloqueio por IP em memória, zera no restart; suficiente para uso pessoal via VPN
  const fails = new Map();

  function html(res, status, body, headers = {}) {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(body);
  }
  function redirect(res, to, headers = {}) {
    res.writeHead(303, { Location: to, 'Cache-Control': 'no-store', ...headers });
    res.end();
  }
  function cookie(req, value, maxAge) {
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
  }

  return async function gate(req, res) {
    const pathname = new URL(req.url ?? '/', 'http://vault').pathname;
    if (req.method === 'GET' && isPublicAsset(pathname)) return false;
    // healthcheck do container (público, sem dados sensíveis)
    if (req.method === 'GET' && pathname === '/api/health') return false;

    // o backend Rust (na frente) já autenticou o usuário (x-tania-user) e prova isso com o segredo compartilhado
    if (isTrustedProxy(req, proxySecret)) return false;

    if (!creds) {
      if (isLoopback(req)) return false;
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Acesso remoto bloqueado: defina VAULT_AUTH=usuario:senha no servidor.');
      return true;
    }

    if (pathname === '/login' && req.method === 'POST') {
      const ip = req.socket?.remoteAddress ?? '?';
      const f = fails.get(ip);
      if (f && f.until > Date.now()) {
        html(res, 429, loginPage('Muitas tentativas. Espere 15 minutos.'));
        return true;
      }
      let form;
      try {
        form = await readForm(req);
      } catch {
        html(res, 413, loginPage('Requisição inválida.'));
        return true;
      }
      // avalia os dois sempre: não vaza se o usuário existe pelo tempo de resposta
      const okUser = same(form.get('user') ?? '', creds.user);
      const okPass = same(form.get('password') ?? '', creds.pass);
      if (okUser && okPass) {
        fails.delete(ip);
        redirect(res, '/', { 'Set-Cookie': cookie(req, makeToken(key), MAX_AGE_S) });
      } else {
        const count = (f?.count ?? 0) + 1;
        fails.set(ip, { count, until: count >= MAX_FAILS ? Date.now() + LOCK_MS : 0 });
        html(res, 401, loginPage('Usuário ou senha incorretos.'));
      }
      return true;
    }

    if (pathname === '/logout') {
      redirect(res, '/login', { 'Set-Cookie': cookie(req, '', 0) });
      return true;
    }

    const authed = validToken(key, readCookie(req, COOKIE));

    if (pathname === '/login') {
      if (authed) redirect(res, '/');
      else html(res, 200, loginPage());
      return true;
    }

    if (authed) return false;

    if (pathname.startsWith('/api')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'não autenticado' }));
    } else {
      redirect(res, '/login');
    }
    return true;
  };
}

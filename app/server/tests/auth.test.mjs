/**
 * auth.test.mjs — portão de login (VAULT_AUTH=usuario:senha).
 *
 * Roda:  npm run test
 *
 * Sobe o portão num servidor efêmero e cobre: formato do VAULT_AUTH, token
 * assinado/expirado, redirect para /login, 401 na /api, login certo/errado,
 * bloqueio após 5 falhas, logout, o modo sem VAULT_AUTH (só localhost) e o
 * header x-tania-proxy (LEGACY_PROXY_SECRET) que o backend Rust manda.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createAuthGate, parseAuth, makeToken, validToken, isPublicAsset } from '../auth.mjs';

async function serve(raw, proxySecret = '') {
  const gate = createAuthGate(raw, proxySecret);
  const server = http.createServer(async (req, res) => {
    if (await gate(req, res)) return;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('conteudo-protegido');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

function login(base, user, password) {
  return fetch(`${base}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ user, password }),
  });
}

test('parseAuth: formato usuario:senha, senha pode ter ":"', () => {
  assert.equal(parseAuth(undefined), null);
  assert.deepEqual(parseAuth('rodrigo:a:b'), { user: 'rodrigo', pass: 'a:b' });
  // env_file do Docker/Swarm mantém as aspas: aceitar dos dois jeitos
  assert.deepEqual(parseAuth("'rodrigo:a:b'"), { user: 'rodrigo', pass: 'a:b' });
  assert.deepEqual(parseAuth('"rodrigo:senha"'), { user: 'rodrigo', pass: 'senha' });
  assert.throws(() => parseAuth('sem-dois-pontos'));
  assert.throws(() => parseAuth(':senha'));
  assert.throws(() => parseAuth('user:'));
});

test('token: válido, adulterado, expirado e de outra chave', () => {
  const t = makeToken('k1');
  assert.equal(validToken('k1', t), true);
  assert.equal(validToken('k2', t), false);
  assert.equal(validToken('k1', t.replace(/^\d+/, '9999999999')), false);
  assert.equal(validToken('k1', makeToken('k1', 0)), false);
  assert.equal(validToken('k1', ''), false);
});

test('com VAULT_AUTH: protege tudo, login e logout funcionam', async () => {
  const { server, base } = await serve('rodrigo:s3nha:forte');
  try {
    const page = await fetch(`${base}/`, { redirect: 'manual' });
    assert.equal(page.status, 303);
    assert.equal(page.headers.get('location'), '/login');

    const api = await fetch(`${base}/api/notes`);
    assert.equal(api.status, 401);
    assert.doesNotMatch(await api.text(), /conteudo-protegido/);

    const form = await fetch(`${base}/login`);
    assert.equal(form.status, 200);
    assert.match(await form.text(), /type="password"/);

    const bad = await login(base, 'rodrigo', 'errada');
    assert.equal(bad.status, 401);
    assert.equal(bad.headers.get('set-cookie'), null);

    const ok = await login(base, 'rodrigo', 's3nha:forte');
    assert.equal(ok.status, 303);
    const cookie = ok.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    const session = cookie.split(';')[0];

    const inside = await fetch(`${base}/api/notes`, { headers: { cookie: session } });
    assert.equal(await inside.text(), 'conteudo-protegido');

    const out = await fetch(`${base}/logout`, { redirect: 'manual', headers: { cookie: session } });
    assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  } finally {
    server.close();
  }
});

test('com VAULT_AUTH: 5 falhas bloqueiam até a senha certa', async () => {
  const { server, base } = await serve('u:p');
  try {
    for (let i = 0; i < 5; i++) assert.equal((await login(base, 'u', 'x')).status, 401);
    assert.equal((await login(base, 'u', 'p')).status, 429);
  } finally {
    server.close();
  }
});

test('LEGACY_PROXY_SECRET: header certo passa, errado/ausente não', async () => {
  const { server, base } = await serve('u:p', 's3gredo');
  try {
    // o Rust (na frente) já autentica o usuário: só o header com o segredo basta
    const ok = await fetch(`${base}/api/x`, { headers: { 'x-tania-proxy': 's3gredo' } });
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), 'conteudo-protegido');

    const wrong = await fetch(`${base}/api/x`, { headers: { 'x-tania-proxy': 'errado' } });
    assert.equal(wrong.status, 401);

    const none = await fetch(`${base}/api/x`);
    assert.equal(none.status, 401);
  } finally {
    server.close();
  }

  // segredo vazio (LEGACY_PROXY_SECRET não definido): header presente não autentica nada
  const gate = createAuthGate('u:p', '');
  let status = 0;
  const res = { writeHead: (s) => (status = s), end: () => {} };
  const handled = await gate(
    { url: '/api/x', method: 'GET', headers: { 'x-tania-proxy': '' }, socket: { remoteAddress: '100.64.0.1' } },
    res,
  );
  assert.equal(handled, true);
  assert.equal(status, 401);
});

test('sem VAULT_AUTH: localhost entra, remoto recebe 503', async () => {
  const { server, base } = await serve(undefined);
  try {
    assert.equal(await (await fetch(`${base}/`)).text(), 'conteudo-protegido');
  } finally {
    server.close();
  }
  const gate = createAuthGate(undefined);
  let status = 0;
  const res = { writeHead: (s) => (status = s), end: () => {} };
  const handled = await gate({ url: '/', headers: {}, socket: { remoteAddress: '100.64.0.1' } }, res);
  assert.equal(handled, true);
  assert.equal(status, 503);
});

test('PWA: só manifest, ícones e logos de marca ficam públicos', () => {
  for (const p of ['/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-maskable-512.png', '/icons/icon.svg', '/brand/logo.png']) {
    assert.equal(isPublicAsset(p), true, p);
  }
  for (const p of ['/', '/index.html', '/sw.js', '/assets/index-abc.js', '/icons/x.js', '/icons/a/b.png', '/icons/', '/api/notes', '/manifest.webmanifest/x', '/brand/../index.html', '/brand/x.html', '/files/99-Meta/attachments/x.png']) {
    assert.equal(isPublicAsset(p), false, p);
  }
});

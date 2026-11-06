/**
 * files.test.mjs — anexos servidos do disco (/files/*) e envio (/api/files/*).
 *
 * Roda:  node --test server/tests/files.test.mjs
 *
 * Cobre: imagem nova aparece sem rebuild, HTML/SVG isolados (CSP sandbox),
 * 304 por ETag, Range (vídeo), bloqueio de dotfiles/app/.md/traversal,
 * envio do site em qualquer pasta do vault (agente: só 99-Meta/attachments),
 * sem sobrescrever.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-files-test-'));
process.env.VAULT_ROOT = ROOT;

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
await fs.mkdir(path.join(ROOT, '99-Meta/attachments/Sprints'), { recursive: true });
await fs.mkdir(path.join(ROOT, 'app'), { recursive: true });
await fs.writeFile(path.join(ROOT, '99-Meta/attachments/foto.png'), PNG);
await fs.writeFile(path.join(ROOT, '99-Meta/attachments/Sprints/deck.html'), '<!doctype html><title>deck</title><script>1</script>');
await fs.writeFile(path.join(ROOT, '99-Meta/attachments/video.mp4'), Buffer.alloc(1000, 7));
await fs.writeFile(path.join(ROOT, 'app/segredo.png'), PNG);
await fs.writeFile(path.join(ROOT, '.env.png'), PNG);
await fs.writeFile(path.join(ROOT, 'Home.md'), '# Home\n');

const { handleVaultApi, handleVaultFile } = await import('../vault-api.mjs');
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/files/')) return void handleVaultFile(req, res);
  void handleVaultApi(req, res);
});
await new Promise((r) => server.listen(0, r));
const BASE = `http://127.0.0.1:${server.address().port}`;

test('anexos do disco', async (t) => {
  await t.test('imagem servida com MIME, ETag e 304', async () => {
    const r = await fetch(`${BASE}/files/99-Meta/attachments/foto.png`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/png');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('content-security-policy'), null);
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), PNG);

    const again = await fetch(`${BASE}/files/99-Meta/attachments/foto.png`, { headers: { 'If-None-Match': r.headers.get('etag') } });
    assert.equal(again.status, 304);
  });

  await t.test('HTML abre isolado: CSP sandbox sem allow-same-origin', async () => {
    const r = await fetch(`${BASE}/files/99-Meta/attachments/Sprints/deck.html`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /^text\/html/);
    const csp = r.headers.get('content-security-policy');
    assert.match(csp, /^sandbox /);
    assert.match(csp, /allow-scripts/);
    assert.doesNotMatch(csp, /allow-same-origin/);
  });

  await t.test('Range para vídeo', async () => {
    const r = await fetch(`${BASE}/files/99-Meta/attachments/video.mp4`, { headers: { Range: 'bytes=100-199' } });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-range'), 'bytes 100-199/1000');
    assert.equal((await r.arrayBuffer()).byteLength, 100);
    const bad = await fetch(`${BASE}/files/99-Meta/attachments/video.mp4`, { headers: { Range: 'bytes=5000-' } });
    assert.equal(bad.status, 416);
  });

  await t.test('bloqueia dotfiles, app/, notas, traversal e inexistente', async () => {
    const cases = [
      ['/files/.env.png', 403],
      ['/files/app/segredo.png', 403],
      ['/files/Home.md', 415],
      ['/files/99-Meta/attachments/nao-existe.png', 404],
    ];
    for (const [url, status] of cases) {
      const r = await fetch(BASE + url);
      assert.equal(r.status, status, url);
    }
    // caminho cru (fetch normalizaria): travessia até app/ ou .git/ nunca serve o arquivo
    const raw = (p) =>
      new Promise((resolve) => http.get({ host: '127.0.0.1', port: server.address().port, path: p }, (r) => (r.resume(), resolve(r.statusCode))));
    for (const p of ['/files/99-Meta/attachments/../../app/segredo.png', '/files/99-Meta/%2e%2e/%2e%2e/app/segredo.png', '/files/..%2f.git/config.png']) {
      const status = await raw(p);
      assert.ok(status >= 400, `${p} -> ${status}`);
    }
  });

  await t.test('arquivo novo aparece sem rebuild e na listagem', async () => {
    await fs.writeFile(path.join(ROOT, '99-Meta/attachments/nova.webp'), PNG);
    const r = await fetch(`${BASE}/files/99-Meta/attachments/nova.webp`);
    assert.equal(r.status, 200);
    const snap = await fetch(`${BASE}/api/notes`).then((x) => x.json());
    assert.ok(snap.files.some((f) => f.path === '99-Meta/attachments/nova.webp' && f.kind === 'image'));
    assert.ok(!snap.files.some((f) => f.path.startsWith('app/') || f.path.startsWith('.')));
  });

  const put = (p, body, type = 'application/octet-stream') =>
    fetch(`${BASE}/api/files/${p}`, { method: 'PUT', headers: { 'Content-Type': type }, body });

  await t.test('envio: pastas do vault, sem sobrescrever', async () => {
    const ok = await put('99-Meta/attachments/2026/colada.png', PNG);
    assert.equal(ok.status, 201);
    const data = await ok.json();
    assert.equal(data.path, '99-Meta/attachments/2026/colada.png');

    assert.equal((await put('99-Meta/attachments/2026/colada.png', PNG)).status, 409);
    // site (usuário logado): qualquer pasta do vault; nunca a raiz, app/ ou dotfiles
    assert.equal((await put('00-Inbox/foto.png', PNG)).status, 201);
    assert.equal((await put('07-Ideias/Sub/esboco.jpg', PNG)).status, 201);
    assert.equal((await put('foto-na-raiz.png', PNG)).status, 201);
    assert.equal((await put('app/x.png', PNG)).status, 403);
    assert.equal((await put('.obsidian/x.png', PNG)).status, 403);
    assert.equal((await put('outra-pasta/x.png', PNG)).status, 201);
    assert.equal((await put('99-Meta/attachments/foto com espaco.png', PNG)).status, 400);
    assert.equal((await put('99-Meta/attachments/script.js', PNG)).status, 415);
    assert.equal((await put('99-Meta/attachments/form.png', PNG, 'text/plain')).status, 415, 'CSRF: tipo simples recusado');
  });

  server.close();
});

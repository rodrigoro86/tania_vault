/**
 * vault-api.test.mjs — testes da camada de escrita do vault.
 *
 * Roda:  npm run test
 *
 * Cria um vault-fixture em /tmp, então o vault real nunca é
 * tocado. Cobre: sanitize (traversal, pastas fora do escopo, AGENTS.md),
 * CSRF por Content-Type e
 * segurança do DELETE de pastas (AGENTS.md §3 "nunca apagar").
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

/* ---------- fixture ---------- */
const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-api-test-'));
process.env.VAULT_ROOT = ROOT;

const { handleVaultApi, VAULT_ROOT } = await import('../vault-api.mjs');
await fs.mkdir(path.join(ROOT, '00-Inbox'), { recursive: true });
await fs.mkdir(path.join(ROOT, '02-Comandos/Git'), { recursive: true });
await fs.writeFile(path.join(ROOT, 'AGENTS.md'), '# contrato do vault\n');
await fs.writeFile(path.join(ROOT, 'Home.md'), '# Home\n');
await fs.writeFile(path.join(ROOT, '02-Comandos/Git/Git.md'), '# Git\n');

const server = http.createServer((req, res) => {
  handleVaultApi(req, res).catch((err) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: String(err) }));
  });
});
await new Promise((r) => server.listen(0, r));
const BASE = `http://127.0.0.1:${server.address().port}`;

async function api(method, p, body, headers = { 'Content-Type': 'application/json' }) {
  const res = await fetch(BASE + p, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

/* ---------- testes ---------- */
test('vault-api: sanitize e CSRF', async (t) => {
  await t.test('health responde e aponta para o fixture', async () => {
    const r = await api('GET', '/api/health');
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
    assert.equal(r.data.storage, 'local');
    assert.equal(VAULT_ROOT, ROOT);
  });

  await t.test('traversal e pastas fora do vault são bloqueadas', async () => {
    const blocked = [
      ['../Home.md', 400],
      ['00-Inbox/../01-Agenda/x.md', 400],
      ['%2e%2e/Home.md', 400],
      ['.git/config.md', 403],
      ['.obsidian/x.md', 403],
      ['app/x.md', 403],
      ['AGENTS.md', 403],
      ['99-Meta/attachments/x.txt', 400],
      ['Leitura.txt', 400],
    ];
    for (const [p, status] of blocked) {
      const r = await api('POST', '/api/notes', { path: p, content: '# x' });
      assert.equal(r.status, status, `${p} deveria dar ${status}, deu ${r.status}: ${r.data.error}`);
    }
    const stillThere = await fs.readFile(path.join(ROOT, 'Home.md'), 'utf8');
    assert.ok(stillThere.includes('# Home'));
  });

  await t.test('pasta nova na raiz aceita nota dentro', async () => {
    assert.equal((await api('POST', '/api/folders', { path: 'Minha-Pasta' })).status, 201);
    assert.equal((await api('POST', '/api/notes', { path: 'Minha-Pasta/x.md', content: '# x\n' })).status, 201);
  });

  await t.test('create/edit/delete funcionam', async () => {
    const created = await api('POST', '/api/notes', { path: '00-Inbox/Nota.md', content: '# Nota\n' });
    assert.equal(created.status, 201);

    const edited = await api('PUT', '/api/notes', { path: '00-Inbox/Nota.md', content: '# Nota editada\n' });
    assert.equal(edited.status, 200);

    const renamed = await api('POST', '/api/rename', { from: '00-Inbox/Nota.md', to: '01-Agenda/Nota.md' });
    assert.equal(renamed.status, 200);

    const deleted = await api('DELETE', '/api/notes/01-Agenda/Nota.md');
    assert.equal(deleted.status, 200);
    await assert.rejects(fs.stat(path.join(ROOT, '01-Agenda/Nota.md')));
  });
  await t.test('métodos sem Content-Type JSON são recusados (415)', async () => {
    const before = await fs.readFile(path.join(ROOT, 'Home.md'), 'utf8');
    const res = await fetch(`${BASE}/api/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '{"path":"Home.md","content":"# INJETADO"}',
    });
    assert.equal(res.status, 415);
    const after = await fs.readFile(path.join(ROOT, 'Home.md'), 'utf8');
    assert.equal(after, before, 'a nota foi escrita mesmo sem JSON');
  });

  await t.test('DELETE de pasta: com conteúdo bloqueada, vazia ok, inclusive na raiz', async () => {
    const root = await api('DELETE', '/api/folders/02-Comandos?recursive=1');
    assert.equal(root.status, 409);

    await fs.mkdir(path.join(ROOT, '01-Agenda/Cheia'), { recursive: true });
    await fs.writeFile(path.join(ROOT, '01-Agenda/Cheia/x.md'), '# x\n');
    const cheia = await api('DELETE', '/api/folders/01-Agenda/Cheia?recursive=1');
    assert.equal(cheia.status, 409, 'no modo local pasta com conteúdo não pode ser apagada');
    await fs.readFile(path.join(ROOT, '01-Agenda/Cheia/x.md')); // continua lá

    await fs.mkdir(path.join(ROOT, '01-Agenda/Vazia'), { recursive: true });
    const ok = await api('DELETE', '/api/folders/01-Agenda/Vazia');
    assert.equal(ok.status, 200);

    await fs.mkdir(path.join(ROOT, 'Raiz-Vazia'));
    assert.equal((await api('DELETE', '/api/folders/Raiz-Vazia')).status, 200);
  });

  await t.test('GET /api/notes devolve o snapshot do vault', async () => {
    const snap = await api('GET', '/api/notes');
    assert.equal(snap.status, 200);
    assert.ok(snap.data.notes.some((n) => n.path === 'AGENTS.md'));
    assert.ok(snap.data.folders.includes('02-Comandos/Git'));
  });

  server.close();
});




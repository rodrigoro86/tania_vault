// scripts/tests/agentes.test.mjs — servidor falso com node:http.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lerConfig, gravarConfig, login, push, pull } from '../agentes.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentes-'));
}

function servidor(handler) {
  const srv = http.createServer(handler);
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() });
    });
  });
}

test('login grava a sessão, nunca a senha, e o arquivo fica 0600', async () => {
  const srv = await servidor((req, res) => {
    if (req.url !== '/login') return res.writeHead(404).end('{}');
    res.writeHead(200, { 'set-cookie': ['vault_session=ses-123; Path=/; HttpOnly'] });
    res.end('ok');
  });
  const dir = tempDir();

  const sessao = await login({ url: srv.url, user: 'tania', password: 'senha-nunca-gravada' });
  assert.equal(sessao, 'ses-123');

  await gravarConfig(dir, { url: srv.url, sessao });
  const arquivo = path.join(dir, '.env.agentes');
  const texto = fs.readFileSync(arquivo, 'utf8');
  assert.match(texto, /^TANIA_URL=http:\/\/127\.0\.0\.1:\d+$/m);
  assert.match(texto, /^TANIA_SESSAO=ses-123$/m);
  assert.ok(!texto.includes('senha-nunca-gravada'));
  assert.equal(fs.statSync(arquivo).mode & 0o777, 0o600);

  const cfg = await lerConfig(dir);
  assert.deepEqual(cfg, { url: srv.url, sessao: 'ses-123' });
  srv.close();
});

test('lerConfig de arquivo inexistente devolve vazio', async () => {
  assert.deepEqual(await lerConfig(tempDir()), { url: '', sessao: '' });
});

test('login sem cookie de sessão -> login recusado', async () => {
  const srv = await servidor((req, res) => res.writeHead(401).end('{"error":"credenciais inválidas"}'));
  await assert.rejects(() => login({ url: srv.url, user: 'a', password: 'b' }), /login recusado/);
  srv.close();
});

test('push cria notas novas e pula as que já existem (409)', async () => {
  const pedidos = [];
  const srv = await servidor((req, res) => {
    if (req.url !== '/api/notes') return res.writeHead(404).end('{}');
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { path: nota } = JSON.parse(body);
      pedidos.push(nota);
      if (nota === '99-Meta/Agentes/Equipe/existe.md') {
        return res.writeHead(409).end('{"error":"já existe"}');
      }
      res.writeHead(201).end('{"ok":true}');
    });
  });

  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'agent-spec.md'), 'spec');
  fs.writeFileSync(path.join(dir, 'existe.md'), 'existe');
  fs.writeFileSync(path.join(dir, 'README.md'), 'readme');
  fs.writeFileSync(path.join(dir, 'ignore.txt'), 'nope');
  fs.writeFileSync(path.join(dir, 'nome estranho.md'), 'nope');

  const r = await push({ url: srv.url, sessao: 'ses', agentsDir: dir });
  assert.deepEqual(r.criados, ['README.md', 'agent-spec.md']);
  assert.deepEqual(r.pulados, ['existe.md']);
  assert.deepEqual(pedidos, [
    '99-Meta/Agentes/Equipe/README.md',
    '99-Meta/Agentes/Equipe/agent-spec.md',
    '99-Meta/Agentes/Equipe/existe.md',
  ]);
  srv.close();
});

test('sessão expirada (401) -> erro claro e nada local muda', async () => {
  const srv = await servidor((req, res) => res.writeHead(401).end('{"error":"sessão inválida"}'));
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.md'), 'original');

  await assert.rejects(() => push({ url: srv.url, sessao: 'ruim', agentsDir: dir }),
    /sessão expirada: rode node scripts\/agentes\.mjs login/);
  await assert.rejects(() => pull({ url: srv.url, sessao: 'ruim', agentsDir: dir }),
    /sessão expirada/);

  assert.equal(fs.readFileSync(path.join(dir, 'a.md'), 'utf8'), 'original');
  assert.equal(fs.readdirSync(dir).length, 1);
  srv.close();
});

test('sessão expirada (302 para /login) -> erro claro', async () => {
  const srv = await servidor((req, res) => {
    assert.ok(req.headers.cookie === 'vault_session=ruim');
    res.writeHead(302, { location: '/login?next=/api/notes' });
    res.end();
  });
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.md'), 'original');
  await assert.rejects(() => pull({ url: srv.url, sessao: 'ruim', agentsDir: dir }), /sessão expirada/);
  assert.equal(fs.readFileSync(path.join(dir, 'a.md'), 'utf8'), 'original');
  srv.close();
});

test('Tania fora do ar -> erro claro e nada local muda', async () => {
  const srv = await servidor((req, res) => res.writeHead(200).end('{}'));
  const url = srv.url;
  srv.close();
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.md'), 'original');

  await assert.rejects(() => push({ url, sessao: 'ses', agentsDir: dir }),
    (err) => err.message === `Tania fora do ar em ${url}`);
  await assert.rejects(() => pull({ url, sessao: 'ses', agentsDir: dir }),
    (err) => err.message === `Tania fora do ar em ${url}`);
  assert.equal(fs.readdirSync(dir).join(','), 'a.md');
});

test('erro não-2xx devolve status e mensagem do JSON', async () => {
  const srv = await servidor((req, res) => res.writeHead(500).end('{"error":"vault indisponível"}'));
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.md'), 'a');
  await assert.rejects(() => push({ url: srv.url, sessao: 'ses', agentsDir: dir }),
    (err) => err.message === '500 vault indisponível');
  srv.close();
});

test('pull grava só Equipe/<nome>.md válido, não apaga nada e só escreve quando muda', async () => {
  const notes = [
    { path: '99-Meta/Agentes/Equipe/agent-spec.md', content: 'nova spec' },
    { path: '99-Meta/Agentes/Equipe/README.md', content: 'readme do vault' },
    { path: '99-Meta/Agentes/Equipe/sub/b.md', content: 'subpasta' },
    { path: '99-Meta/Agentes/Equipe/../d.md', content: 'travessura' },
    { path: '99-Meta/Agentes/Outra/c.md', content: 'outra pasta' },
    { path: '99-Meta/Agentes/Equipe/e.txt', content: 'sem .md' },
    { path: '99-Meta/Agentes/Tania.md', content: 'tania' },
    { path: '99-Meta/Agentes/Equipe/README.md', content: 'readme do vault' },
  ];
  const srv = await servidor((req, res) => {
    if (req.url !== '/api/notes') return res.writeHead(404).end('{}');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ notes }));
  });

  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'agent-spec.md'), 'spec antiga');
  fs.writeFileSync(path.join(dir, 'x.txt'), 'arquivo fora do padrão');

  const r = await pull({ url: srv.url, sessao: 'ses', agentsDir: dir });
  assert.deepEqual(r.gravados, ['agent-spec.md', 'README.md']);
  assert.equal(fs.readFileSync(path.join(dir, 'agent-spec.md'), 'utf8'), 'nova spec');
  assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), 'readme do vault');
  assert.equal(fs.readFileSync(path.join(dir, 'x.txt'), 'utf8'), 'arquivo fora do padrão');
  assert.ok(!fs.existsSync(path.join(dir, 'sub')));
  assert.ok(!fs.existsSync(path.join(dir, 'd.md')));
  assert.ok(!fs.existsSync(path.join(dir, 'c.md')));
  assert.ok(!fs.existsSync(path.join(dir, 'e.txt')));

  const repetido = await pull({ url: srv.url, sessao: 'ses', agentsDir: dir });
  assert.deepEqual(repetido.gravados, []);
  srv.close();
});

test('agents/tania/ ↔ 99-Meta/Agentes/Tania/: push cria, pull traz (sem subpasta)', async () => {
  const criadas = [];
  const notes = [
    { path: '99-Meta/Agentes/Tania/agenda.md', content: 'agenda do vault' },
    { path: '99-Meta/Agentes/Tania/sub/x.md', content: 'subpasta' },
  ];
  const srv = await servidor((req, res) => {
    if (req.method === 'POST' && req.url === '/api/notes') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        criadas.push(JSON.parse(body).path);
        res.writeHead(201, { 'content-type': 'application/json' }).end('{"ok":true}');
      });
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ notes }));
  });

  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'agent-spec.md'), 'spec');
  fs.mkdirSync(path.join(dir, 'tania'));
  fs.writeFileSync(path.join(dir, 'tania', 'ideias.md'), 'ideias');

  const p = await push({ url: srv.url, sessao: 'ses', agentsDir: dir });
  assert.deepEqual(p.criados, ['agent-spec.md', 'tania/ideias.md']);
  assert.deepEqual(criadas, ['99-Meta/Agentes/Equipe/agent-spec.md', '99-Meta/Agentes/Tania/ideias.md']);

  const r = await pull({ url: srv.url, sessao: 'ses', agentsDir: dir });
  assert.deepEqual(r.gravados, ['tania/agenda.md']);
  assert.equal(fs.readFileSync(path.join(dir, 'tania', 'agenda.md'), 'utf8'), 'agenda do vault');
  assert.ok(!fs.existsSync(path.join(dir, 'tania', 'sub')));
  assert.equal(fs.readFileSync(path.join(dir, 'tania', 'ideias.md'), 'utf8'), 'ideias', 'pull não apaga');
  srv.close();
});

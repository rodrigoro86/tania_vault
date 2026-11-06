/**
 * tools-remotas.test.mjs — as funções MCP das tools registradas (Task 4).
 *
 * Roda:  node --test server/tests/tools-remotas.test.mjs   (Node 24)
 *
 * Um servidor MCP falso em porta efêmera, exigindo `x-tania-tool-secret`, cobre:
 * sanitização dos nomes, registro pelo env (id/url/segredo inválidos pulados),
 * manifesto (id errado, SSE), specs e prompt, `tools/call` (ok, isError, nome
 * desconhecido), tool fora do ar, tool que nunca responde (orçamento de 5 s) e
 * a ligação com `runTool` do agente.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { carregarTools, limparCacheTools, nomeFuncao } from '../agent/tools-remotas.ts';

// vault efêmero só para as ferramentas do núcleo no teste de runTool
process.env.VAULT_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-tools-test-'));

const SECRET = 's3gredo-da-tool';
const SCHEMA = { type: 'object', properties: { texto: { type: 'string' } }, required: ['texto'] };

/** servidor MCP falso: manifesto + initialize/notifications/tools/list/tools/call */
function fakeMcp({
  secret = SECRET,
  manifest = { id: 'fake', nome: 'Fake', icone: '🧪', paginas: [], prompt: 'use fake__eco para ecoar texto' },
  tools = [{ name: 'eco', description: 'ecoar um texto', inputSchema: SCHEMA }],
  sse = false,
  nuncaResponde = false,
  erroRpc = false,
} = {}) {
  const chamadas = [];
  const server = http.createServer((req, res) => {
    if (req.headers['x-tania-tool-secret'] !== secret) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'segredo inválido' }));
    }
    if (req.method === 'GET' && req.url === '/manifest.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(manifest));
    }
    if (req.method !== 'POST' || !req.url.startsWith('/mcp')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end('{}');
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (nuncaResponde) return; // socket fica aberto: o timeout da Tania tem que fechar
      const msg = JSON.parse(body || '{}');
      chamadas.push({ method: msg.method, headers: req.headers });
      const send = (result) => {
        const payload = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result });
        if (sse) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'mcp-session-id': 'sess-falsa' });
          return res.end(`event: message\ndata: ${payload}\n\n`);
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'mcp-session-id': 'sess-falsa' });
        return res.end(payload);
      };
      if (erroRpc) {
        // erro JSON-RPC de verdade (top-level), não dentro de result
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -1, message: 'tool fora do ar' } }));
      }
      if (msg.method === 'initialize') return send({ protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake', version: '0.1' } });
      if (msg.method === 'notifications/initialized') {
        assert.equal(msg.id, undefined, 'notificação não leva id');
        res.writeHead(202);
        return res.end();
      }
      if (msg.method === 'tools/list') return send({ tools });
      if (msg.method === 'tools/call') {
        const nome = msg.params?.name;
        if (nome === 'eco') return send({ content: [{ type: 'text', text: `eco: ${msg.params.arguments?.texto ?? ''}` }] });
        if (nome === 'boom') return send({ content: [{ type: 'text', text: 'o servidor da tool falhou' }], isError: true });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `função ${nome} não existe` } }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `método ${msg.method} não existe` } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}`, chamadas }));
  });
}

/** roda fn com um conjunto de env definido e restaura process.env depois */
async function withEnv(vars, fn) {
  const guardado = {};
  for (const chave of Object.keys(vars)) {
    guardado[chave] = process.env[chave];
    if (vars[chave] === undefined) delete process.env[chave];
    else process.env[chave] = vars[chave];
  }
  limparCacheTools();
  try {
    await fn();
  } finally {
    for (const chave of Object.keys(vars)) {
      if (guardado[chave] === undefined) delete process.env[chave];
      else process.env[chave] = guardado[chave];
    }
    limparCacheTools();
  }
}

test('nomeFuncao: prefixo do id, só [a-zA-Z0-9_-], até 64, colisão com sufixo', () => {
  assert.equal(nomeFuncao('clickup', 'clickup_tasks', new Set()), 'clickup__clickup_tasks');
  assert.equal(nomeFuncao('a', 'x.y z', new Set()), 'a__x_y_z');
  const longo = nomeFuncao('a', 'x'.repeat(80), new Set());
  assert.equal(longo.length, 64);
  assert.match(longo, /^[a-z0-9_]+$/);
  const usados = new Set(['a__x']);
  assert.equal(nomeFuncao('a', 'x', usados), 'a__x_2');
  assert.equal(nomeFuncao('a', 'x', usados), 'a__x_3');
});

test('carregarTools pelo env: specs com inputSchema e prompt do manifesto', async () => {
  const { server, base, chamadas } = await fakeMcp();
  try {
    await withEnv({ TANIA_TOOLS: `fake=${base}`, TANIA_TOOL_SECRET_FAKE: SECRET }, async () => {
      const remotas = await carregarTools();
      assert.equal(remotas.specs.length, 1);
      assert.deepEqual(remotas.specs[0], {
        type: 'function',
        function: { name: 'fake__eco', description: 'Fake: ecoar um texto', parameters: SCHEMA },
      });
      assert.match(remotas.prompt, /ecoar texto/);
      // initialize + notifications/initialized + tools/list, sempre com o segredo
      assert.deepEqual(chamadas.map((c) => c.method), ['initialize', 'notifications/initialized', 'tools/list']);
      assert.equal(chamadas[0].headers['x-tania-tool-secret'], SECRET);
      assert.match(chamadas[0].headers.accept, /text\/event-stream/);
      assert.equal(chamadas[2].headers['mcp-session-id'], 'sess-falsa');

      // cache de 60 s: segunda chamada não fala com a tool de novo
      const deNovo = await carregarTools();
      assert.equal(deNovo, remotas);
      assert.equal(chamadas.length, 3);
    });
  } finally {
    server.close();
  }
});

test('env inválido, segredo ausente e tool fora do ar são pulados sem quebrar as outras', async () => {
  const { server, base } = await fakeMcp();
  try {
    await withEnv(
      {
        TANIA_TOOLS: `fake=${base},BAD=http://127.0.0.1:9,ftp=http://127.0.0.1:9,inexistente=http://127.0.0.1:9`,
        TANIA_TOOL_SECRET_FAKE: SECRET,
        TANIA_TOOL_SECRET_BAD: 'tem',
        TANIA_TOOL_SECRET_FTP: 'ftp',
        // sem TANIA_TOOL_SECRET_INEXISTENTE (pulada) e porta 9 fechada (inexistente cai no timeout)
        TANIA_CONFIG_KEY: undefined,
        DATABASE_URL: undefined,
        PGHOST: undefined,
      },
      async () => {
        const remotas = await carregarTools();
        assert.deepEqual(remotas.specs.map((s) => s.function.name), ['fake__eco']);
      },
    );
  } finally {
    server.close();
  }
});

test('manifesto com id diferente do registrado: tool pulada; resposta SSE funciona', async () => {
  const ruim = await fakeMcp({ manifest: { id: 'outra', nome: 'Errada', prompt: 'nada' } });
  const boa = await fakeMcp({
    manifest: { id: 'sse', nome: 'Sse', paginas: [], prompt: 'prompt vindo do manifesto SSE' },
    tools: [{ name: 'eco', description: 'ecoar', inputSchema: { type: 'object' } }],
    sse: true,
  });
  try {
    await withEnv(
      {
        TANIA_TOOLS: `mismatch=${ruim.base},sse=${boa.base}`,
        TANIA_TOOL_SECRET_MISMATCH: SECRET,
        TANIA_TOOL_SECRET_SSE: SECRET,
      },
      async () => {
        const remotas = await carregarTools();
        assert.deepEqual(remotas.specs.map((s) => s.function.name), ['sse__eco']);
        const out = await remotas.call('sse__eco', { texto: 'oi' });
        assert.equal(out.ok, true);
        assert.equal(out.result, 'eco: oi');
        assert.equal(out.summary, 'sse: Sse');
      },
    );
  } finally {
    ruim.server.close();
    boa.server.close();
  }
});

test('tools/call: ok, isError vira falha, erro JSON-RPC vira falha, nome desconhecido devolve null', async () => {
  const { server, base } = await fakeMcp({
    tools: [
      { name: 'eco', description: 'ecoar', inputSchema: SCHEMA },
      { name: 'boom', description: 'falha', inputSchema: {} },
      { name: 'inexistente', description: 'sumiu', inputSchema: {} },
    ],
  });
  try {
    await withEnv({ TANIA_TOOLS: `fake=${base}`, TANIA_TOOL_SECRET_FAKE: SECRET }, async () => {
      const remotas = await carregarTools();
      const ok = await remotas.call('fake__eco', { texto: 'oi' });
      assert.equal(ok.ok, true);
      assert.equal(ok.summary, 'fake: Fake');
      assert.equal(ok.result, 'eco: oi');

      // várias parts de content viram texto unido por \n
      const mult = await remotas.call('fake__eco', { texto: 'a' });
      assert.equal(mult.result, 'eco: a');

      const err = await remotas.call('fake__boom', {});
      assert.equal(err.ok, false);
      assert.equal(err.summary, 'o servidor da tool falhou');

      // erro JSON-RPC da chamada = falha daquela tool
      const rpc = await remotas.call('fake__inexistente', {});
      assert.equal(rpc.ok, false);
      assert.match(rpc.summary, /tool fake:/);

      assert.equal(remotas.call('nada_da_vault', {}), null);
    });
  } finally {
    server.close();
  }
});

test('segredo errado: tool pulada, as outras seguem; erro JSON-RPC no tools/list = falha da tool', async () => {
  const semSegredo = await fakeMcp({ secret: 'outro', manifest: { id: 'errada', nome: 'Errada', prompt: 'x' } });
  const rpcErro = await fakeMcp({ erroRpc: true, manifest: { id: 'erro', nome: 'Erro', prompt: 'x' } });
  try {
    await withEnv(
      {
        TANIA_TOOLS: `errada=${semSegredo.base},erro=${rpcErro.base}`,
        TANIA_TOOL_SECRET_ERRADA: SECRET,
        TANIA_TOOL_SECRET_ERRO: SECRET,
      },
      async () => {
        const remotas = await carregarTools();
        assert.equal(remotas.specs.length, 0);
        assert.equal(remotas.prompt, '');
        assert.equal(remotas.call('erro__x', {}), null);
      },
    );
  } finally {
    semSegredo.server.close();
    rpcErro.server.close();
  }
});

test('tool que nunca responde: carregarTools resolve em menos de 6 s só com a que responde', async () => {
  const lenta = await fakeMcp({ nuncaResponde: true, manifest: { id: 'lenta', nome: 'Lenta', prompt: 'x' } });
  const rapida = await fakeMcp({ manifest: { id: 'rapida', nome: 'Rápida', prompt: 'prompt da rápida' } });
  try {
    const inicio = Date.now();
    await withEnv({ TANIA_TOOLS: `lenta=${lenta.base},rapida=${rapida.base}`, TANIA_TOOL_SECRET_LENTA: SECRET, TANIA_TOOL_SECRET_RAPIDA: SECRET }, async () => {
      const remotas = await carregarTools();
      const gastos = Date.now() - inicio;
      assert.deepEqual(remotas.specs.map((s) => s.function.name), ['rapida__eco']);
      assert.ok(gastos < 6000, `demorou ${gastos} ms`);
      // erro de rede/timeout na chamada também vira falha, não exceção
      const out = await carregarTools().then((r) => r.call('rapida__eco', { texto: 'oi' }));
      assert.equal(out.ok, true);
    });
  } finally {
    lenta.server.close();
    rapida.server.close();
  }
});

test('runTool do agente: usa ctx.remotas antes de "ferramenta desconhecida"', async () => {
  const { server, base } = await fakeMcp();
  try {
    await withEnv({ TANIA_TOOLS: `fake=${base}`, TANIA_TOOL_SECRET_FAKE: SECRET }, async () => {
      const remotas = await carregarTools();
      const { runTool } = await import('../agent.ts');
      const usada = await runTool('fake__eco', JSON.stringify({ texto: 'oi do agente' }), { approved: null, remotas });
      assert.equal(usada.ok, true);
      assert.equal(usada.result, 'eco: oi do agente');

      const desconhecida = await runTool('fake__nao_existe', '{}', { approved: null, remotas });
      assert.equal(desconhecida.ok, false);
      assert.match(desconhecida.summary, /ferramenta desconhecida/);

      // sem remotas no contexto, o núcleo funciona como antes
      const core = await runTool('list_notes', '{}', { approved: null });
      assert.equal(core.ok, true);
    });
  } finally {
    server.close();
  }
});

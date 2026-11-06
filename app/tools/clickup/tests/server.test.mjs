/**
 * server.test.mjs — o servidor da tool ClickUp (Task 5, Step 1).
 *
 * Roda:  node --test tools/clickup/tests/server.test.mjs
 *
 * `criarServidor()` é importado (não subprocesso) e ouvimos numa porta livre.
 * A API do ClickUp é um servidor falso, igual ao teste de clickup.ts.
 * Cobre: segredo em todas as rotas, /manifest.json, /mcp (initialize,
 * notifications, tools/list, tools/call, método desconhecido), /api/* (a API
 * de antes, sem o prefixo /api/clickup), /ui/<pagina> e o token vindo do
 * núcleo via /api/core/config.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

const SEG = 'segredo-de-teste';
process.env.TANIA_TOOL_SECRET = SEG;

const day = (offset) => String(Date.now() + offset * 86_400_000);
const user = (id, username) => ({ id, username, initials: username.slice(0, 2).toUpperCase(), color: '#40A8C4', profilePicture: null });
const RODRIGO = user(1, 'Rodrigo');
const ANA = user(2, 'Ana Souza');
const task = (id, name, assignees, due, status = 'em andamento', type = 'custom') => ({
  id,
  name,
  url: `https://app.clickup.com/t/${id}`,
  status: { status, color: '#40A8C4', type },
  priority: { priority: 'high', color: '#f00' },
  due_date: due,
  date_updated: day(0),
  assignees,
  tags: [{ name: 'spec' }],
  list: { id: 'L1', name: 'Backlog' },
  folder: { id: 'F1', name: 'Core', hidden: false },
  space: { id: 'S1' },
  parent: null,
  text_content: 'descrição',
});
const TASKS = [
  task('t1', 'Revisar spec de inundação', [RODRIGO], day(0)),
  task('t2', 'Mapa de estiagem', [ANA], day(-3)),
  task('t3', 'Validar alagamento', [], day(10)),
  task('t4', 'Fechar relatório de estiagem', [ANA], day(-5), 'done', 'closed'),
];

const api = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (body, status = 200) => (res.writeHead(status, { 'Content-Type': 'application/json' }), res.end(JSON.stringify(body)));
  if (req.headers.authorization !== 'pk_teste' && req.headers.authorization !== 'pk_do_nucleo') return send({ err: 'Token invalid' }, 401);
  if (url.pathname === '/user') return send({ user: RODRIGO });
  if (url.pathname === '/team') return send({ teams: [{ id: 'T1', name: 'Tania', members: [{ user: RODRIGO }, { user: ANA }] }] });
  if (url.pathname === '/team/T1/space') return send({ spaces: [{ id: 'S1', name: 'EMPRESA' }] });
  if (url.pathname === '/space/S1/folder') return send({ folders: [{ id: 'F1', name: 'Core', lists: [{ id: 'L1', name: 'Backlog' }] }] });
  if (url.pathname === '/team/T1/task') {
    const who = url.searchParams.getAll('assignees[]').map(Number);
    let list = who.length ? TASKS.filter((t) => t.assignees.some((a) => who.includes(a.id))) : TASKS;
    if (url.searchParams.get('include_closed') !== 'true') list = list.filter((t) => t.status.type !== 'closed');
    return send({ tasks: list, last_page: true });
  }
  if (url.pathname === '/task/t2') return send(TASKS[1]);
  return send({ err: 'not found' }, 404);
});
await new Promise((r) => api.listen(0, r));
process.env.CLICKUP_API_BASE = `http://127.0.0.1:${api.address().port}`;

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'clickup-server-test-'));
const CONFIG = path.join(TMP, 'clickup.config.json');
process.env.CLICKUP_CONFIG = CONFIG;
process.env.TANIA_TOOL_DIST = path.join(TMP, 'dist');
await fs.writeFile(CONFIG, JSON.stringify({ token: 'pk_teste' }));

const { criarServidor } = await import('../server.mjs');
const server = criarServidor();
await new Promise((r) => server.listen(0, r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const comSegredo = (p, init = {}) => fetch(BASE + p, { ...init, headers: { 'x-tania-tool-secret': SEG, ...init.headers } });
const semSegredo = (p, init = {}) => fetch(BASE + p, { ...init, headers: init.headers ?? {} });
const json = async (res) => ({ status: res.status, data: await res.json() });
const mcp = async (method, params, secret = SEG) => {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'x-tania-tool-secret': secret, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: res.status, body: res.status === 202 ? '' : await res.json() };
};

test('segredo: sem header ou errado → 401 em todas as rotas', async () => {
  for (const [p, init] of [
    ['/manifest.json', {}],
    ['/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"jsonrpc":"2.0","method":"tools/list"}' }],
    ['/api/status', {}],
    ['/ui/tarefas', {}],
  ]) {
    const r = await semSegredo(p, init);
    assert.equal(r.status, 401, `${p} sem segredo`);
    assert.equal((await r.json()).ok, false);
  }
  // segredo de tamanho diferente: timingSafeEqual não explode, devolve 401
  assert.equal((await semSegredo('/manifest.json', { headers: { 'x-tania-tool-secret': 'curto' } })).status, 401);
  assert.equal((await semSegredo('/manifest.json', { headers: { 'x-tania-tool-secret': 'segredo-de-testeXXX' } })).status, 401);
  assert.equal((await comSegredo('/manifest.json')).status, 200);
});

test('manifesto: id, ícone, páginas, vínculos, config e prompt', async () => {
  const { data } = await json(await comSegredo('/manifest.json'));
  assert.equal(data.id, 'clickup');
  assert.equal(data.icone, '✅');
  assert.deepEqual(data.paginas.map((p) => p.id), ['tarefas', 'painel']);
  assert.deepEqual(data.vinculos, [{ campo: 'clickup', pagina: 'card' }]);
  assert.equal(data.config[0].chave, 'CLICKUP_TOKEN');
  assert.equal(data.config[0].segredo, true);
  assert.ok(data.prompt.length > 0);
  assert.match(data.prompt, /clickup__clickup_tasks/);
  assert.match(data.prompt, /clickup__clickup_task\b/);
  assert.match(data.prompt, /SÓ LEITURA/);
});

test('MCP: initialize, notifications e método desconhecido', async () => {
  const init = await mcp('initialize', { clientInfo: { name: 'tania', version: '1' } });
  assert.equal(init.status, 200);
  assert.equal(init.body.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.body.result.capabilities, { tools: {} });
  assert.equal(init.body.result.serverInfo.name, 'tania-clickup');
  assert.ok(init.body.result.serverInfo.version);

  const nota = await mcp('notifications/initialized', {});
  assert.equal(nota.status, 202);
  assert.equal(nota.body, '');

  const ruim = await mcp('tools/foo', {});
  assert.equal(ruim.body.error.code, -32601);
});

test('MCP: tools/list traz clickup_tasks e clickup_task com os schemas de antes', async () => {
  const { body } = await mcp('tools/list', {});
  const tools = body.result.tools;
  assert.deepEqual(tools.map((t) => t.name), ['clickup_tasks', 'clickup_task']);
  const taks = tools[0];
  assert.match(taks.description, /Lê tarefas do ClickUp \(só leitura\)/);
  assert.equal(taks.inputSchema.type, 'object');
  assert.deepEqual(
    Object.keys(taks.inputSchema.properties).sort(),
    ['due_within_days', 'include_closed', 'list', 'overdue', 'person', 'project', 'scope', 'space'],
  );
  const one = tools[1];
  assert.equal(one.inputSchema.type, 'object');
  assert.deepEqual(one.inputSchema.required, ['id']);
  assert.equal(one.inputSchema.properties.id.type, 'string');
});

test('MCP: tools/call devolve JSON; erro vira isError', async () => {
  const ok = await mcp('tools/call', { name: 'clickup_task', arguments: { id: 'https://app.clickup.com/t/t2' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.result.content[0].type, 'text');
  const out = JSON.parse(ok.body.result.content[0].text);
  assert.equal(out.ok, true);
  assert.equal(out.result.name, 'Mapa de estiagem');
  assert.equal(out.result.overdue, true);

  const lista = await mcp('tools/call', { name: 'clickup_tasks', arguments: { scope: 'me' } });
  assert.equal(JSON.parse(lista.body.result.content[0].text).result.tasks.length, 1);

  const erro = await mcp('tools/call', { name: 'clickup_task', arguments: { id: 'a' } });
  assert.equal(erro.body.result.isError, true);
  assert.ok(erro.body.result.content[0].text.length > 0);

  const desconhecida = await mcp('tools/call', { name: 'clickup_escrever', arguments: {} });
  assert.equal(desconhecida.body.error.code, -32602);
});

test('API: /api/* responde como /api/clickup/* respondia', async () => {
  const st = await json(await comSegredo('/api/status'));
  assert.equal(st.status, 200);
  assert.equal(st.data.configured, true);
  assert.equal(st.data.me.name, 'Rodrigo');

  const tasks = await json(await comSegredo('/api/tasks?scope=me'));
  assert.deepEqual(tasks.data.tasks.map((t) => t.id), ['t1']);

  const late = await json(await comSegredo('/api/tasks?scope=team&overdue=1'));
  assert.deepEqual(late.data.tasks.map((t) => t.id), ['t2']);

  const dash = await json(await comSegredo('/api/dashboard?scope=team'));
  assert.equal(dash.data.open, 3, 't4, fechada, não vira card');
  assert.equal(dash.data.overdue, 1);

  const post = await comSegredo('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(post.status, 405);

  assert.equal((await comSegredo('/api/task/a')).status, 400);
  assert.equal((await comSegredo('/api/nada')).status, 404);
});

test('UI: /ui/tarefas serve o HTML; página inexistente 404; arquivo ausente 503', async () => {
  await fs.mkdir(process.env.TANIA_TOOL_DIST, { recursive: true });
  await fs.writeFile(path.join(process.env.TANIA_TOOL_DIST, 'tarefas.html'), '<!doctype html><title>Tarefas</title>');
  const r = await comSegredo('/ui/tarefas');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.match(await r.text(), /Tarefas/);

  assert.equal((await comSegredo('/ui/pagina-inexistente')).status, 404);
  assert.equal((await comSegredo('/ui/painel')).status, 503);
  assert.match(await (await comSegredo('/ui/painel')).text(), /rode npm run build/);
});

test('token: vem do núcleo (/api/core/config), senão env/arquivo', async () => {
  // núcleo falso devolve CLICKUP_TOKEN
  const core = http.createServer((req, res) => {
    if (req.headers.authorization !== 'Tool clickup:segredo-de-teste') return (res.writeHead(401), res.end(JSON.stringify({ ok: false, error: 'segredo inválido' })));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, valores: { CLICKUP_TOKEN: 'pk_do_nucleo' } }));
  });
  await new Promise((r) => core.listen(0, r));
  process.env.TANIA_CORE_URL = `http://127.0.0.1:${core.address().port}`;
  try {
    await fs.rm(CONFIG, { force: true }); // sem arquivo, sem env: o token vem do núcleo
    const st = await json(await comSegredo('/api/status'));
    assert.equal(st.status, 200);
    assert.equal(st.data.configured, true, 'token vindo de /api/core/config');

    // núcleo fora do ar → volta ao arquivo
    process.env.TANIA_CORE_URL = 'http://127.0.0.1:1';
    await fs.writeFile(CONFIG, JSON.stringify({ token: 'pk_teste' }));
    const fallback = await json(await comSegredo('/api/status'));
    assert.equal(fallback.status, 200);
    assert.equal(fallback.data.configured, true, 'falha no núcleo: usa o arquivo como antes');
  } finally {
    delete process.env.TANIA_CORE_URL;
    core.close();
  }
});

after(async () => {
  server.close();
  api.close();
  await fs.rm(TMP, { recursive: true, force: true });
});

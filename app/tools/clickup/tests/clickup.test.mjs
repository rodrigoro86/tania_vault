/**
 * clickup.test.mjs — leitura do ClickUp (tools/clickup/clickup.ts) e as
 * ferramentas MCP da tool (tools/clickup/mcp.ts).
 *
 * Roda:  node --test tools/clickup/tests/clickup.test.mjs   (Node >= 22.18: type stripping)
 *
 * Um servidor falso imita a API v2 do ClickUp; o servidor da tool atende
 * /api/* e /mcp com o segredo no header. Cobre: sem config, token só no
 * servidor, filtros (minhas, pessoa, espaço, atrasadas), normalização, tarefa
 * por id/URL, só leitura (POST recusado) e as funções clickup_tasks/clickup_task via MCP.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'clickup-tool-test-'));
const CONFIG = path.join(TMP, 'clickup.config.json');
process.env.CLICKUP_CONFIG = CONFIG;
process.env.TANIA_TOOL_SECRET = 'segredinho-de-teste';

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
  task('t6', 'Revisar plantio', [ANA], day(3)),
  // aberta, sem prazo, em outro projeto (pasta Campo)
  { ...task('t5', 'Plantar mudas', [], null), list: { id: 'L3', name: 'Cliente B' }, folder: { id: 'F2', name: 'Campo', hidden: false } },
];

const seen = [];
const api = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  seen.push({ path: url.pathname, params: url.searchParams, auth: req.headers.authorization, method: req.method });
  const send = (body, status = 200) => (res.writeHead(status, { 'Content-Type': 'application/json' }), res.end(JSON.stringify(body)));
  if (req.headers.authorization !== 'pk_teste') return send({ err: 'Token invalid' }, 401);
  if (url.pathname === '/user') return send({ user: RODRIGO });
  if (url.pathname === '/team') return send({ teams: [{ id: 'T1', name: 'Tania', members: [{ user: RODRIGO }, { user: ANA }] }] });
  if (url.pathname === '/team/T1/space') return send({ spaces: [{ id: 'S1', name: 'EMPRESA' }, { id: 'S2', name: 'Pessoal' }] });
  if (url.pathname === '/space/S1/folder') {
    return send({
      folders: [
        { id: 'F1', name: 'Core', lists: [{ id: 'L1', name: 'Backlog' }, { id: 'L2', name: 'Cliente A' }] },
        { id: 'F2', name: 'Campo', lists: [{ id: 'L3', name: 'Cliente B' }] },
        { id: 'FH', name: 'hidden', hidden: true, lists: [] },
      ],
    });
  }
  if (url.pathname === '/space/S2/folder') return send({ folders: [{ id: 'F9', name: 'Casa', lists: [{ id: 'L9', name: 'Obras' }] }] });
  if (url.pathname === '/team/T1/task') {
    const who = url.searchParams.getAll('assignees[]').map(Number);
    let list = who.length ? TASKS.filter((t) => t.assignees.some((a) => who.includes(a.id))) : TASKS;
    if (url.searchParams.get('include_closed') !== 'true') list = list.filter((t) => t.status.type !== 'closed');
    const proj = url.searchParams.get('project_ids[]');
    if (proj) list = list.filter((t) => t.folder?.id === proj);
    const lt = url.searchParams.get('due_date_lt');
    if (lt) list = list.filter((t) => t.due_date && Number(t.due_date) < Number(lt));
    return send({ tasks: list, last_page: true });
  }
  if (url.pathname === '/task/t2') return send(TASKS[1]);
  return send({ err: 'not found' }, 404);
});
await new Promise((r) => api.listen(0, r));
process.env.CLICKUP_API_BASE = `http://127.0.0.1:${api.address().port}`;

const { criarServidor } = await import('../server.mjs');
const server = criarServidor();
await new Promise((r) => server.listen(0, r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const SECRET = { 'x-tania-tool-secret': 'segredinho-de-teste' };
const getJson = async (p, init = {}) => {
  const r = await fetch(BASE + p, { ...init, headers: { ...SECRET, ...init.headers } });
  return { status: r.status, text: await r.clone().text(), data: await r.json() };
};
/** chamada MCP: devolve o objeto result do JSON-RPC */
const mcp = async (method, params) => {
  const r = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { ...SECRET, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return r.json();
};
const callTool = async (name, args) => {
  const out = await mcp('tools/call', { name, arguments: args });
  const text = out.result.content[0].text;
  return out.result.isError ? { ok: false, error: text } : JSON.parse(text);
};

test('ClickUp só leitura', async (t) => {
  await t.test('sem config: não configurado (e sem erro)', async () => {
    const r = await getJson('/api/status');
    assert.equal(r.status, 200);
    assert.equal(r.data.configured, false);
    assert.equal((await getJson('/api/tasks')).status, 503);
  });

  await fs.writeFile(CONFIG, JSON.stringify({ token: 'pk_teste' }));

  await t.test('status: eu, workspace, espaços e membros — token nunca vai ao navegador', async () => {
    const r = await getJson('/api/status');
    assert.equal(r.data.configured, true);
    assert.equal(r.data.me.name, 'Rodrigo');
    assert.equal(r.data.team, 'Tania');
    assert.deepEqual(r.data.spaces.map((x) => x.name), ['EMPRESA', 'Pessoal']);
    assert.deepEqual(r.data.members.map((x) => x.name), ['Rodrigo', 'Ana Souza']);
    assert.ok(!r.text.includes('pk_teste'));
    assert.ok(seen.every((x) => x.auth === 'pk_teste'), 'token mandado só ao ClickUp');
  });

  await t.test('tarefas: equipe, minhas, atrasadas e normalização', async () => {
    const team = await getJson('/api/tasks?scope=team');
    assert.equal(team.data.tasks.length, 5, 't4, fechada, fica fora por padrão');
    const t2 = team.data.tasks.find((x) => x.id === 't2');
    assert.equal(t2.overdue, true);
    assert.equal(t2.space, 'EMPRESA');
    assert.equal(t2.folder, 'Core');
    assert.equal(t2.priority, 'high');
    assert.match(t2.due, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(t2.assignees[0].name, 'Ana Souza');

    const mine = await getJson('/api/tasks?scope=me');
    assert.deepEqual(mine.data.tasks.map((x) => x.id), ['t1']);
    assert.equal(seen.at(-1).params.get('include_closed'), 'false');

    const late = await getJson('/api/tasks?scope=team&overdue=1');
    assert.deepEqual(late.data.tasks.map((x) => x.id), ['t2']);

    const all = await getJson('/api/tasks?scope=team&include_closed=1');
    assert.deepEqual([...all.data.tasks.map((x) => x.id)].sort(), ['t1', 't2', 't3', 't4', 't5', 't6']);
    assert.equal(all.data.tasks.find((x) => x.id === 't4').closed, true);
  });

  await t.test('projetos: pastas com listas no status; filtro por pasta/lista vai como project_ids/list_ids', async () => {
    const st = await getJson('/api/status');
    assert.deepEqual(st.data.folders.map((f) => [f.name, f.spaceId, f.lists.length]), [['Core', 'S1', 2], ['Campo', 'S1', 1], ['Casa', 'S2', 1]]);

    await getJson('/api/tasks?scope=team&folder=F2');
    assert.equal(seen.at(-1).params.get('project_ids[]'), 'F2');
    assert.equal(seen.at(-1).params.get('space_ids[]'), null);
    await getJson('/api/tasks?scope=team&folder=F1&list=L2');
    assert.equal(seen.at(-1).params.get('list_ids[]'), 'L2');
    assert.equal(seen.at(-1).params.get('project_ids[]'), null);

    const t1 = (await getJson('/api/tasks?scope=team')).data.tasks[0];
    assert.equal(t1.folderId, 'F1');
    assert.equal(t1.listId, 'L1');

    assert.equal((await getJson('/api/tasks?folder=FX')).status, 400);
    assert.equal((await getJson('/api/tasks?folder=F2&list=L1')).status, 400, 'lista de outra pasta');
    assert.equal((await getJson('/api/tasks?space=SX')).status, 400);
  });

  await t.test('painel (dashboard): cards abertos por pessoa e por projeto, nunca fechados', async () => {
    const d = await getJson('/api/dashboard?scope=team');
    assert.equal(d.status, 200);
    assert.equal(d.data.team, 'Tania');
    assert.equal(d.data.open, 5, 't4, fechada, não vira card');
    assert.equal(d.data.overdue, 1, 't2 venceu');
    assert.equal(d.data.dueToday, 1, 't1 vence hoje');
    assert.equal(d.data.dueSoon, 1, 't6 em 3 dias');
    assert.equal(d.data.noDue, 1, 't5 sem prazo');
    assert.equal(d.data.noAssignee, 2, 't3 e t5');
    assert.equal(d.data.overdue + d.data.dueToday + d.data.dueSoon + d.data.noDue, 4, 't3, due em 10 dias, não entra em nenhum card');
    assert.deepEqual(d.data.people, [
      { name: 'Ana Souza', open: 2, overdue: 1 },
      { name: 'Sem responsável', open: 2, overdue: 0 },
      { name: 'Rodrigo', open: 1, overdue: 0 },
    ]);
    assert.deepEqual(d.data.projects, [
      { name: 'Core', open: 4, overdue: 1 },
      { name: 'Campo', open: 1, overdue: 0 },
    ]);
    // filtros novos (space/pasta) vão ao ClickUp: os params idênticos aos de
    // tarefas ficam no cache de 60 s e não aparecem em `seen`
    await getJson('/api/dashboard?scope=team&space=S1');
    assert.equal(seen.at(-1).params.get('include_closed'), 'false', 'o painel pede só cards abertos');
    assert.equal(seen.at(-1).params.get('space_ids[]'), 'S1');

    const mine = await getJson('/api/dashboard?scope=me');
    assert.equal(mine.data.open, 1, 'só t1, que tem Rodrigo');
    assert.deepEqual(mine.data.people, [{ name: 'Rodrigo', open: 1, overdue: 0 }]);

    // pasta = "projeto" do painel: F1 (Core) tem 4 abertos, F2 (Campo) só t5
    const core = await getJson('/api/dashboard?scope=team&folder=F1');
    assert.equal(core.data.open, 4, 't4 fechada não entra nem por pasta');
    assert.equal(core.data.overdue, 1);
    assert.deepEqual(core.data.projects, [{ name: 'Core', open: 4, overdue: 1 }]);
    assert.equal(seen.at(-1).params.get('project_ids[]'), 'F1', 'painel filtra pelo projeto escolhido');
    assert.equal(seen.at(-1).params.get('space_ids[]'), null, 'pasta vence o espaço');

    const flo = await getJson('/api/dashboard?scope=team&folder=F2');
    assert.equal(flo.data.open, 1, 'só t5, sem prazo e sem responsável');
    assert.equal(flo.data.noDue, 1);
    assert.equal(flo.data.noAssignee, 1);
    assert.equal((await getJson('/api/dashboard?folder=FX')).status, 400);
  });

  await t.test('spaceIds: pastas, filtros e tarefa por id presos aos espaços permitidos', async () => {
    await fs.writeFile(CONFIG, JSON.stringify({ token: 'pk_teste', spaceIds: ['S2'] }));
    const st = await getJson('/api/status');
    assert.deepEqual(st.data.folders.map((f) => f.name), ['Casa']);
    assert.equal((await getJson('/api/tasks?space=S1')).status, 400);
    assert.equal((await getJson('/api/tasks?folder=F1')).status, 400);
    assert.equal((await getJson('/api/task/t2')).status, 403);
    await fs.writeFile(CONFIG, JSON.stringify({ token: 'pk_teste' }));
  });

  await t.test('tarefa por id ou URL; id inválido recusado', async () => {
    const byUrl = await getJson(`/api/task/${encodeURIComponent('https://app.clickup.com/t/t2')}`);
    assert.equal(byUrl.data.task.name, 'Mapa de estiagem');
    assert.equal(byUrl.data.task.description, 'descrição');
    assert.equal((await getJson('/api/task/a')).status, 400);
  });

  await t.test('só leitura: escrita recusada', async () => {
    const r = await getJson('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 405);
    assert.ok(seen.every((x) => x.method === 'GET'), 'nenhum pedido de escrita ao ClickUp');
  });

  await t.test('MCP: clickup_tasks por pessoa/espaço e clickup_task', async () => {
    const ana = await callTool('clickup_tasks', { person: 'ana', space: 'empresa' });
    assert.equal(ana.ok, true, JSON.stringify(ana));
    assert.deepEqual(ana.result.tasks.map((x) => x.tarefa), ['Mapa de estiagem', 'Revisar plantio'], 'Ana tem t2 e t6; t4, fechada, fora');
    assert.equal(ana.result.tasks[0].onde, 'EMPRESA › Core › Backlog');
    assert.equal(seen.at(-1).params.get('assignees[]'), '2');
    assert.equal(seen.at(-1).params.get('space_ids[]'), 'S1');

    // (filtro diferente dos testes HTTP: o cache de 60 s responderia sem chamar a API)
    const core = await callTool('clickup_tasks', { project: 'core', list: 'backlog' });
    assert.equal(core.ok, true, JSON.stringify(core));
    assert.equal(seen.at(-1).params.get('list_ids[]'), 'L1');

    // "dentro de 7 dias" é filtrado aqui, não na API: inclui as vencidas (t2)
    const week = await callTool('clickup_tasks', { due_within_days: 7 });
    assert.equal(week.ok, true);
    assert.equal(week.result.total, 3, 't1 hoje, t2 vencida, t6 em 3 dias; t3 em 10 fica fora');
    assert.equal(week.result.tasks.find((x) => x.tarefa === 'Validar alagamento'), undefined);
    const flo = await callTool('clickup_tasks', { project: 'campo', overdue: true });
    assert.equal(flo.ok, true);
    assert.equal(seen.at(-1).params.get('project_ids[]'), 'F2');
    const noProj = await callTool('clickup_tasks', { project: 'logistic' });
    assert.equal(noProj.ok, false);
    assert.match(noProj.error, /Core, Campo, Casa/);

    const nobody = await callTool('clickup_tasks', { person: 'joao' });
    assert.equal(nobody.ok, false);
    assert.match(nobody.error, /Ana Souza/);

    const bad = await callTool('clickup_tasks', { overdue: 'sim' });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /overdue: deve ser true ou false/);

    const one = await callTool('clickup_task', { id: 'https://app.clickup.com/t/t2' });
    assert.equal(one.ok, true);
    assert.match(one.summary, /Mapa de estiagem/);
  });

  await t.test('token errado: erro claro do ClickUp', async () => {
    await fs.writeFile(CONFIG, JSON.stringify({ token: 'pk_errado' }));
    const r = await getJson('/api/status');
    assert.equal(r.status, 502);
    assert.match(r.data.error, /token inválido/);
  });

  await t.test('CLICKUP_TOKEN (⚙ Configurações) vence o arquivo e funciona sem ele', async () => {
    process.env.CLICKUP_TOKEN = 'pk_teste';
    try {
      // arquivo com token errado (subteste anterior): o env vence — 200 em vez do 502 do pk_errado
      const comArquivo = await getJson('/api/status');
      assert.equal(comArquivo.status, 200);
      assert.equal(comArquivo.data.configured, true);
      await fs.rm(CONFIG, { force: true });
      const r = await getJson('/api/status');
      assert.equal(r.data.configured, true);
      assert.ok(!r.text.includes('pk_teste'));
    } finally {
      delete process.env.CLICKUP_TOKEN;
    }
  });

  server.close();
  api.close();
});


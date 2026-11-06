/**
 * clickup.ts — leitura do ClickUp (API v2), SÓ LEITURA: nada é criado ou
 * alterado no ClickUp a partir do vault.
 *
 * Token: env CLICKUP_TOKEN (editável em ⚙ Configurações, salvo cifrado no banco) ou o
 * "token" de app/clickup.config.json; o env vence. O arquivo continua opcional para teamId/spaceIds:
 *   { "token": "pk_...", "teamId": "opcional (padrão: 1º workspace)", "spaceIds": ["opcional: limita os espaços"] }
 * Relido a cada pedido. CLICKUP_CONFIG troca o caminho; CLICKUP_API_BASE troca a
 * URL da API (testes usam um servidor falso).
 *
 * Rotas (atrás do login do site):
 *   GET /api/clickup/status                  configurado? quem sou, workspace, espaços, pastas (projetos) com listas, membros
 *   GET /api/clickup/tasks?scope=me|team&assignee=<id>&space=<id>&folder=<id>&list=<id>&overdue=1&include_closed=1
 * space/folder/list precisam estar dentro dos espaços permitidos (spaceIds); tarefa
 * por id fora deles é recusada.
 *   GET /api/clickup/task/<id ou URL>
 * Cache em memória de 60 s por consulta (limite da API: ~100 pedidos/min por token).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError } from './vault-api.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const configPath = () => path.resolve(process.env.CLICKUP_CONFIG || path.join(HERE, '..', 'clickup.config.json'));
const apiBase = () => (process.env.CLICKUP_API_BASE || 'https://api.clickup.com/api/v2').replace(/\/+$/, '');
const CACHE_MS = 60_000;
const MAX_PAGES = 5; // 5 x 100 tarefas por consulta da equipe

interface ClickUpConfig {
  token: string;
  teamId?: string;
  spaceIds?: string[];
}

/* ---------- formas da API v2 (só o que usamos) ---------- */

interface RawUser {
  id: number;
  username: string | null;
  email?: string;
  color?: string | null;
  initials?: string;
  profilePicture?: string | null;
}

interface RawTask {
  id: string;
  name: string;
  url: string;
  status: { status: string; color: string; type: string };
  priority: { priority: string; color: string } | null;
  due_date: string | null;
  date_updated: string | null;
  assignees: RawUser[];
  tags?: { name: string }[];
  list?: { id: string; name: string };
  folder?: { id: string; name: string; hidden?: boolean };
  space?: { id: string };
  parent?: string | null;
  text_content?: string | null;
}

/* formas normalizadas (front e agente): server/clickup-types.ts */
import type { Dashboard, DashboardGroup, Folder, Person, Task, TaskDetail } from './clickup-types.ts';
export type { Dashboard, DashboardGroup, Folder, Person, Task, TaskDetail };


/* ---------- config e cliente ---------- */

async function loadConfig(): Promise<ClickUpConfig | null> {
  const envToken = process.env.CLICKUP_TOKEN?.trim();
  let cfg: Partial<ClickUpConfig> = {};
  let raw: string | null = null;
  try {
    raw = await fs.readFile(configPath(), 'utf8');
  } catch {
    /* sem arquivo: só o CLICKUP_TOKEN */
  }
  if (raw !== null) {
    try {
      cfg = JSON.parse(raw) as Partial<ClickUpConfig>;
    } catch (err) {
      throw new ApiError(500, `app/clickup.config.json inválido: ${(err as Error).message}`);
    }
  }
  const token = envToken || (typeof cfg.token === 'string' ? cfg.token.trim() : '');
  if (!token) return null;
  return {
    token,
    teamId: typeof cfg.teamId === 'string' && cfg.teamId ? cfg.teamId : undefined,
    spaceIds: Array.isArray(cfg.spaceIds) ? cfg.spaceIds.map(String) : undefined,
  };
}

const cache = new Map<string, { at: number; data: unknown }>();

/** GET na API do ClickUp com cache; o token nunca sai do servidor */
async function get<T>(cfg: ClickUpConfig, endpoint: string, params: [string, string][] = []): Promise<T> {
  const qs = params.length ? `?${new URLSearchParams(params).toString()}` : '';
  const key = `${cfg.token.slice(-6)}|${endpoint}${qs}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data as T;
  const res = await fetch(`${apiBase()}${endpoint}${qs}`, { headers: { Authorization: cfg.token } });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { err?: string };
    // 502: o erro é do ClickUp (ou do token), não do pedido do navegador
    const hint = res.status === 401 ? ' (token inválido ou revogado?)' : '';
    throw new ApiError(502, `ClickUp ${res.status}: ${body.err || res.statusText}${hint}`);
  }
  const data = (await res.json()) as T;
  cache.set(key, { at: Date.now(), data });
  return data;
}

function person(u: RawUser): Person {
  const name = u.username || u.email || `#${u.id}`;
  return {
    id: u.id,
    name,
    initials: u.initials || name.slice(0, 2).toUpperCase(),
    color: u.color || '#7B7979',
    avatar: u.profilePicture || null,
  };
}

const isoDay = (ms: string | null): string | null => (ms ? new Date(Number(ms)).toISOString().slice(0, 10) : null);

function normalize(t: RawTask, spaces: Map<string, string>): Task {
  const due = isoDay(t.due_date);
  const closed = t.status.type === 'closed' || t.status.type === 'done';
  return {
    id: t.id,
    name: t.name,
    url: t.url,
    status: t.status.status,
    statusColor: t.status.color,
    closed,
    priority: t.priority?.priority ?? null,
    due,
    overdue: !!due && !closed && due < new Date().toISOString().slice(0, 10),
    updated: isoDay(t.date_updated),
    assignees: t.assignees.map(person),
    listId: t.list?.id ?? '',
    list: t.list?.name ?? '',
    folderId: t.folder && !t.folder.hidden ? t.folder.id : '',
    folder: t.folder && !t.folder.hidden ? t.folder.name : '',
    spaceId: t.space?.id ?? '',
    space: spaces.get(t.space?.id ?? '') ?? '',
    tags: (t.tags ?? []).map((x) => x.name),
    parent: t.parent ?? null,
  };
}

interface Context {
  cfg: ClickUpConfig;
  teamId: string;
  team: string;
  me: Person;
  members: Person[];
  spaces: { id: string; name: string }[];
  folders: Folder[];
}

async function context(): Promise<Context | null> {
  const cfg = await loadConfig();
  if (!cfg) return null;
  const [{ user }, { teams }] = await Promise.all([
    get<{ user: RawUser }>(cfg, '/user'),
    get<{ teams: { id: string; name: string; members: { user: RawUser }[] }[] }>(cfg, '/team'),
  ]);
  const team = (cfg.teamId ? teams.find((x) => x.id === cfg.teamId) : teams[0]) ?? null;
  if (!team) throw new ApiError(502, cfg.teamId ? `workspace ${cfg.teamId} não encontrado no ClickUp` : 'token sem workspace no ClickUp');
  const { spaces } = await get<{ spaces: { id: string; name: string }[] }>(cfg, `/team/${team.id}/space`, [['archived', 'false']]);
  const allowed = cfg.spaceIds?.length ? spaces.filter((sp) => cfg.spaceIds!.includes(sp.id)) : spaces;
  // pastas ("projetos") e listas de cada espaço permitido; pasta oculta = listas soltas do espaço, fica de fora
  const perSpace = await Promise.all(
    allowed.map((sp) =>
      get<{ folders: { id: string; name: string; hidden?: boolean; lists?: { id: string; name: string }[] }[] }>(cfg, `/space/${sp.id}/folder`, [['archived', 'false']]).then(
        (r) => r.folders.filter((f) => !f.hidden).map((f) => ({ id: f.id, name: f.name, spaceId: sp.id, lists: (f.lists ?? []).map((l) => ({ id: l.id, name: l.name })) })),
      ),
    ),
  );
  return {
    cfg,
    teamId: team.id,
    team: team.name,
    me: person(user),
    members: team.members.map((m) => person(m.user)),
    spaces: allowed.map((sp) => ({ id: sp.id, name: sp.name })),
    folders: perSpace.flat(),
  };
}

/* ---------- consultas (usadas pelas rotas e pelo agente) ---------- */

export interface TaskQuery {
  scope?: 'me' | 'team';
  assignee?: number;
  spaceId?: string;
  /** pasta do ClickUp ("projeto") */
  folderId?: string;
  listId?: string;
  overdue?: boolean;
  includeClosed?: boolean;
}

export async function clickupStatus() {
  const ctx = await context();
  if (!ctx) return { ok: true, configured: false };
  return { ok: true, configured: true, me: ctx.me, team: ctx.team, spaces: ctx.spaces, folders: ctx.folders, members: ctx.members };
}

export async function listTasks(q: TaskQuery = {}): Promise<{ tasks: Task[]; me: Person; truncated: boolean }> {
  const ctx = await context();
  if (!ctx) throw new ApiError(503, 'ClickUp não configurado: defina o token em ⚙ Configurações (CLICKUP_TOKEN) ou em app/clickup.config.json');
  const params: [string, string][] = [
    ['subtasks', 'true'],
    ['order_by', 'due_date'],
    ['include_closed', q.includeClosed ? 'true' : 'false'],
  ];
  const assignee = q.scope === 'me' ? ctx.me.id : q.assignee;
  if (assignee) params.push(['assignees[]', String(assignee)]);
  // filtro mais específico vence (lista > pasta > espaço); todos presos aos espaços permitidos
  if (q.spaceId && !ctx.spaces.some((sp) => sp.id === q.spaceId)) throw new ApiError(400, `espaço ${q.spaceId} fora dos espaços permitidos`);
  const folder = q.folderId ? ctx.folders.find((f) => f.id === q.folderId) : undefined;
  if (q.folderId && !folder) throw new ApiError(400, `pasta ${q.folderId} fora dos espaços permitidos`);
  if (q.listId && !(folder ? [folder] : ctx.folders).some((f) => f.lists.some((l) => l.id === q.listId))) {
    throw new ApiError(400, `lista ${q.listId} fora ${folder ? 'da pasta escolhida' : 'dos espaços permitidos'}`);
  }
  if (q.listId) params.push(['list_ids[]', q.listId]);
  else if (folder) params.push(['project_ids[]', folder.id]);
  else {
    const spaceIds = q.spaceId ? [q.spaceId] : ctx.cfg.spaceIds?.length ? ctx.spaces.map((sp) => sp.id) : [];
    for (const id of spaceIds) params.push(['space_ids[]', id]);
  }
  if (q.overdue) params.push(['due_date_lt', String(Date.now())]);

  const spaceNames = new Map(ctx.spaces.map((sp) => [sp.id, sp.name]));
  const tasks: Task[] = [];
  let truncated = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await get<{ tasks: RawTask[]; last_page?: boolean }>(ctx.cfg, `/team/${ctx.teamId}/task`, [...params, ['page', String(page)]]);
    tasks.push(...data.tasks.map((t) => normalize(t, spaceNames)));
    if (data.last_page === true || data.tasks.length < 100) break;
    if (page === MAX_PAGES - 1) truncated = true;
  }
  return { tasks: q.overdue ? tasks.filter((t) => t.overdue) : tasks, me: ctx.me, truncated };
}

/* ---------- painel (dashboard): contagem dos cards abertos ---------- */

/** agrupa os abertos por uma chave (pessoa, projeto); uma tarefa com dois
 * responsáveis entra nas duas linhas — soma ≠ total de cards */
function group(tasks: Task[], key: (t: Task) => string[]): DashboardGroup[] {
  const map = new Map<string, DashboardGroup>();
  for (const t of tasks) {
    for (const name of key(t)) {
      const g = map.get(name) ?? { name, open: 0, overdue: 0 };
      g.open += 1;
      if (t.overdue) g.overdue += 1;
      map.set(name, g);
    }
  }
  return [...map.values()].sort((a, b) => b.open - a.open || a.name.localeCompare(b.name));
}

/** recebe SÓ cards abertos (status não fechado) e devolve os números do painel */
export function summarize(tasks: Task[], team: string, me: Person): Dashboard {
  const open = tasks.filter((t) => !t.closed);
  const today = new Date().toISOString().slice(0, 10);
  const week = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  return {
    team,
    me,
    date: today,
    open: open.length,
    overdue: open.filter((t) => t.overdue).length,
    dueToday: open.filter((t) => t.due === today).length,
    dueSoon: open.filter((t) => t.due && !t.overdue && t.due > today && t.due <= week).length,
    noDue: open.filter((t) => !t.due).length,
    noAssignee: open.filter((t) => !t.assignees.length).length,
    people: group(open, (t) => (t.assignees.length ? t.assignees.map((p) => p.name) : ['Sem responsável'])),
    projects: group(open, (t) => [t.folder || 'Sem projeto']),
    truncated: false,
  };
}

export async function clickupDashboard(q: TaskQuery = {}): Promise<Dashboard> {
  const ctx = await context();
  if (!ctx) throw new ApiError(503, 'ClickUp não configurado: defina o token em ⚙ Configurações (CLICKUP_TOKEN) ou em app/clickup.config.json');
  const out = await listTasks({ ...q, includeClosed: false });
  return { ...summarize(out.tasks, ctx.team, ctx.me), truncated: out.truncated };
}

/** aceita o id ("abc123") ou a URL ("https://app.clickup.com/t/abc123") */
export function taskIdOf(raw: string): string {
  const m = /\/t\/(?:\d+\/)?([A-Za-z0-9_-]+)/.exec(raw);
  const id = (m ? m[1] : raw).trim();
  if (!/^[A-Za-z0-9_-]{2,40}$/.test(id)) throw new ApiError(400, `id de tarefa inválido: ${raw}`);
  return id;
}

export async function getTask(raw: string): Promise<TaskDetail> {
  const ctx = await context();
  if (!ctx) throw new ApiError(503, 'ClickUp não configurado: defina o token em ⚙ Configurações (CLICKUP_TOKEN) ou em app/clickup.config.json');
  const t = await get<RawTask>(ctx.cfg, `/task/${taskIdOf(raw)}`);
  if (ctx.cfg.spaceIds?.length && !ctx.spaces.some((sp) => sp.id === t.space?.id)) {
    throw new ApiError(403, 'tarefa fora dos espaços permitidos (spaceIds do clickup.config.json)');
  }
  return { ...normalize(t, new Map(ctx.spaces.map((sp) => [sp.id, sp.name]))), description: (t.text_content ?? '').slice(0, 4000) };
}

/* ---------- HTTP ---------- */

function json(res: ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

export async function handleClickUp(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'ClickUp no vault é só leitura' });
  const url = new URL(req.url ?? '/', 'http://vault');

  if (pathname === '/api/clickup/status') return json(res, 200, await clickupStatus());

  if (pathname === '/api/clickup/tasks') {
    const scope = url.searchParams.get('scope') === 'me' ? 'me' : 'team';
    const assignee = Number(url.searchParams.get('assignee')) || undefined;
    const out = await listTasks({
      scope,
      assignee,
      spaceId: url.searchParams.get('space') || undefined,
      folderId: url.searchParams.get('folder') || undefined,
      listId: url.searchParams.get('list') || undefined,
      overdue: url.searchParams.get('overdue') === '1',
      includeClosed: url.searchParams.get('include_closed') === '1',
    });
    return json(res, 200, { ok: true, ...out });
  }

  if (pathname === '/api/clickup/dashboard') {
    const out = await clickupDashboard({
      scope: url.searchParams.get('scope') === 'me' ? 'me' : 'team',
      spaceId: url.searchParams.get('space') || undefined,
      folderId: url.searchParams.get('folder') || undefined,
    });
    return json(res, 200, { ok: true, ...out });
  }

  if (pathname.startsWith('/api/clickup/task/')) {
    return json(res, 200, { ok: true, task: await getTask(decodeURIComponent(pathname.slice('/api/clickup/task/'.length))) });
  }

  return json(res, 404, { ok: false, error: `rota desconhecida: ${pathname}` });
}

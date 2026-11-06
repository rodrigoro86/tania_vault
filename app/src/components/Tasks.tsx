import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { expireSession, vaultApi } from '../api';
import { notes, reloadVault } from '../vault';
import { downloadMarcaDocx, downloadText } from '../exportHtmlDoc';
import { reportElement, reportMarkdown, reportTitle, type ReportInput } from '../taskReport';
import { SLIDE_MODEL, buildTaskDeck } from '../taskSlides';

const encodePath = (p: string) => p.split('/').map(encodeURIComponent).join('/');
/** nome ASCII do arquivo do relatório/apresentação (AGENTS.md §3.3) */
const fileBase = (r: ReportInput, kind: string) =>
  `${r.date}-${kind}-${r.scope.normalize('NFD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '')}`;
// mesmos tipos que o servidor devolve: mudou lá, o build quebra aqui
import type { Folder, Person, Task } from '../../server/clickup-types.ts';

/**
 * Tasks.tsx — tarefas do ClickUp (SÓ LEITURA): minhas ou da equipe, filtradas
 * por espaço, projeto (pasta) e lista, agrupadas por pessoa, projeto, status ou prazo. Dados vêm de /api/clickup/* (o
 * token fica no servidor). Também exporta o card usado nas Propriedades.
 */

interface Status {
  configured: boolean;
  me?: Person;
  team?: string;
  spaces?: { id: string; name: string }[];
  folders?: Folder[];
  members?: Person[];
  error?: string;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  expireSession(res);
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

const today = () => new Date().toISOString().slice(0, 10);
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

function dueLabel(due: string | null): string {
  if (!due) return 'sem prazo';
  if (due === today()) return 'hoje';
  if (due === inDays(1)) return 'amanhã';
  const [y, m, d] = due.split('-');
  return y === today().slice(0, 4) ? `${d}/${m}` : `${d}/${m}/${y}`;
}

/** nota do vault ligada à tarefa (frontmatter clickup: <id ou URL>) */
function noteFor(task: Task): string | null {
  for (const n of notes) {
    const v = n.frontmatter.clickup;
    if (typeof v === 'string' && (v === task.id || v.endsWith(`/${task.id}`))) return n.path;
  }
  return null;
}

export function Avatar({ p }: { p: Person }) {
  return p.avatar ? (
    <img className="cu-avatar" src={p.avatar} alt="" title={p.name} referrerPolicy="no-referrer" />
  ) : (
    <span className="cu-avatar" style={{ background: p.color }} title={p.name}>
      {p.initials}
    </span>
  );
}

function TaskRow({ task }: { task: Task }) {
  const note = noteFor(task);
  return (
    <li className={`cu-task${task.overdue ? ' cu-overdue' : ''}`}>
      <span className="cu-status" style={{ background: task.statusColor }} title={task.status} />
      <span className="cu-main">
        {note ? (
          <Link to={`/${note.split('/').map(encodeURIComponent).join('/')}`} title="abrir a nota ligada">
            {task.name}
          </Link>
        ) : (
          <a href={task.url} target="_blank" rel="noopener" title="abrir no ClickUp">
            {task.name}
          </a>
        )}
        <span className="cu-where">
          {task.status} · {[task.space, task.folder, task.list].filter(Boolean).join(' › ')}
          {note && (
            <>
              {' · '}
              <a href={task.url} target="_blank" rel="noopener">
                ClickUp ↗
              </a>
            </>
          )}
        </span>
      </span>
      <span className={`cu-due${task.overdue ? ' cu-late' : ''}`}>{task.overdue ? `⚠ ${dueLabel(task.due)}` : dueLabel(task.due)}</span>
      {task.priority && <span className={`cu-prio cu-prio-${task.priority}`}>⚑ {task.priority}</span>}
      <span className="cu-people">
        {task.assignees.map((p) => (
          <Avatar key={p.id} p={p} />
        ))}
      </span>
    </li>
  );
}

type GroupBy = 'pessoa' | 'projeto' | 'status' | 'prazo';

function groupTasks(tasks: Task[], by: GroupBy): [string, Task[]][] {
  const groups = new Map<string, Task[]>();
  const add = (k: string, t: Task) => groups.set(k, [...(groups.get(k) ?? []), t]);
  for (const t of tasks) {
    if (by === 'pessoa') {
      if (!t.assignees.length) add('Sem responsável', t);
      for (const p of t.assignees) add(p.name, t);
    } else if (by === 'projeto') {
      add([t.folder, t.list].filter(Boolean).join(' › ') || 'Sem projeto', t);
    } else if (by === 'status') {
      add(t.status, t);
    } else {
      add(
        t.overdue ? '⚠ Atrasadas' : !t.due ? 'Sem prazo' : t.due === today() ? 'Hoje' : t.due <= inDays(7) ? 'Próximos 7 dias' : 'Depois',
        t,
      );
    }
  }
  const order = ['⚠ Atrasadas', 'Hoje', 'Próximos 7 dias', 'Depois', 'Sem prazo'];
  return [...groups.entries()].sort(([a], [b]) =>
    by === 'prazo'
      ? order.indexOf(a) - order.indexOf(b)
      : /^Sem (responsável|projeto)$/.test(a)
        ? 1
        : /^Sem (responsável|projeto)$/.test(b)
          ? -1
          : a.localeCompare(b),
  );
}

export function TasksPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [scope, setScope] = useState<'me' | 'team'>(() => (localStorage.getItem('cu.scope') === 'me' ? 'me' : 'team'));
  const [assignee, setAssignee] = useState('');
  // espaço, projeto e lista ficam salvos: quem acompanha um projeto volta direto nele
  const [space, setSpace] = useState(() => localStorage.getItem('cu.space') ?? '');
  const [folder, setFolder] = useState(() => localStorage.getItem('cu.folder') ?? '');
  const [list, setList] = useState(() => localStorage.getItem('cu.list') ?? '');
  const [groupBy, setGroupBy] = useState<GroupBy>(() => (localStorage.getItem('cu.group') as GroupBy) || 'pessoa');
  const [onlyLate, setOnlyLate] = useState(false);
  const [closed, setClosed] = useState(false);
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    getJson<Status>('/api/clickup/status').then(setStatus, (e) => setStatus({ configured: false, error: (e as Error).message }));
  }, []);

  useEffect(() => {
    localStorage.setItem('cu.scope', scope);
    localStorage.setItem('cu.group', groupBy);
    localStorage.setItem('cu.space', space);
    localStorage.setItem('cu.folder', folder);
    localStorage.setItem('cu.list', list);
  }, [scope, groupBy, space, folder, list]);

  // filtro salvo que não existe mais (pasta arquivada, spaceIds mudou): volta para "todos"
  useEffect(() => {
    if (!status?.configured) return;
    if (space && !status.spaces?.some((sp) => sp.id === space)) setSpace('');
    const f = status.folders?.find((x) => x.id === folder);
    if (folder && !f) setFolder('');
    if (list && !(f ? [f] : (status.folders ?? [])).some((x) => x.lists.some((l) => l.id === list))) setList('');
  }, [status, space, folder, list]);

  const folders = useMemo(() => (status?.folders ?? []).filter((f) => !space || f.spaceId === space), [status, space]);
  const lists = folders.find((f) => f.id === folder)?.lists ?? [];

  useEffect(() => {
    if (!status?.configured) return;
    setTasks(null);
    setError('');
    const q = new URLSearchParams({ scope: assignee ? 'team' : scope });
    if (assignee) q.set('assignee', assignee);
    if (space) q.set('space', space);
    if (folder) q.set('folder', folder);
    if (list) q.set('list', list);
    if (onlyLate) q.set('overdue', '1');
    if (closed) q.set('include_closed', '1');
    getJson<{ tasks: Task[] }>(`/api/clickup/tasks?${q}`).then(
      (r) => setTasks(r.tasks),
      (e) => setError((e as Error).message),
    );
  }, [status, scope, assignee, space, folder, list, onlyLate, closed, reloadKey]);

  const groups = useMemo(() => (tasks ? groupTasks(tasks, groupBy) : []), [tasks, groupBy]);
  const [reporting, setReporting] = useState(false);

  /** recorte atual da tela, com nomes legíveis para o relatório */
  function reportInput(): ReportInput | null {
    if (!tasks || !status) return null;
    const sp = status.spaces?.find((x) => x.id === space)?.name;
    const f = status.folders?.find((x) => x.id === folder);
    const l = f?.lists.find((x) => x.id === list)?.name;
    const person = status.members?.find((m) => String(m.id) === assignee)?.name;
    return {
      tasks,
      groups,
      groupLabel: `por ${groupBy}`,
      scope: [sp ?? (f ? status.spaces?.find((x) => x.id === f.spaceId)?.name : undefined), f?.name, l].filter(Boolean).join(' › ') || status.team || 'ClickUp',
      who: person ?? (scope === 'me' ? `Minhas (${status.me?.name ?? 'eu'})` : 'Equipe'),
      flags: [onlyLate && 'só atrasadas', closed && 'com concluídas'].filter((x): x is string => !!x),
      date: today(),
    };
  }

  /**
   * apresentação sobre o modelo oficial de slides. save: grava em
   * 99-Meta/attachments/Apresentacoes/ (commit no servidor) e abre numa aba nova;
   * download: só baixa o .html
   */
  async function exportDeck(kind: 'save' | 'download') {
    const r = reportInput();
    if (!r) return;
    // aba aberta já no clique: depois do await o navegador bloquearia o pop-up
    const win = kind === 'save' ? window.open('', '_blank') : null;
    setReporting(true);
    try {
      const res = await fetch(`/files/${encodePath(SLIDE_MODEL)}`);
      expireSession(res);
      if (!res.ok) throw new Error(`modelo de slides não encontrado em ${SLIDE_MODEL} (${res.status})`);
      const html = buildTaskDeck(await res.text(), r);
      const hhmm = new Date().toTimeString().slice(0, 5).replace(':', '');
      const name = `${fileBase(r, 'Tarefas')}-${hhmm}`;
      if (kind === 'download') return downloadText(html, `${name}.html`, 'text/html;charset=utf-8');
      const path = `99-Meta/attachments/Apresentacoes/${name}.html`;
      await vaultApi.uploadFile(path, new Blob([html], { type: 'text/html' }));
      await reloadVault();
      if (win) win.location.href = `/files/${encodePath(path)}`;
    } catch (err) {
      win?.close();
      alert(`Não foi possível gerar a apresentação: ${(err as Error).message}`);
    } finally {
      setReporting(false);
    }
  }

  async function exportReport(kind: 'docx' | 'md') {
    const r = reportInput();
    if (!r) return;
    const name = fileBase(r, 'Relatorio-tarefas');
    if (kind === 'md') return downloadText(reportMarkdown(r), `${name}.md`);
    setReporting(true);
    try {
      const meta = {
        title: reportTitle(r),
        date: r.date,
        frontmatter: { description: `${r.who} · ${r.tasks.length} tarefa(s)`, cliente: r.scope, responsavel: status?.me?.name ?? '' },
      };
      await downloadMarcaDocx(reportElement(document, r), meta, `${name}-capa`);
    } catch (err) {
      alert(`Não foi possível gerar o relatório: ${(err as Error).message}`);
    } finally {
      setReporting(false);
    }
  }

  if (!status) return <p className="muted">Carregando ClickUp…</p>;
  if (!status.configured) {
    return (
      <div className="note">
        <h1>☑ Tarefas (ClickUp)</h1>
        {status.error ? (
          <p className="flash">{status.error}</p>
        ) : (
          <>
            <p>ClickUp ainda não configurado. No servidor, crie <code>app/clickup.config.json</code> (fora do git):</p>
            <pre className="code-block">{'{\n  "token": "pk_...",\n  "teamId": "opcional",\n  "spaceIds": ["opcional"]\n}'}</pre>
            <p className="muted">Token: ClickUp → Settings → Apps → API Token. A integração é só de leitura.</p>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="cu-page">
      <h1>
        ☑ Tarefas <span className="muted cu-team">{status.team} · só leitura</span>
      </h1>
      <div className="cu-filters">
        <div className="cu-tabs" role="tablist">
          {(['me', 'team'] as const).map((s) => (
            <button key={s} type="button" role="tab" aria-selected={scope === s && !assignee} onClick={() => (setScope(s), setAssignee(''))}>
              {s === 'me' ? 'Eu' : 'Equipe'}
            </button>
          ))}
        </div>
        <select value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="Pessoa">
          <option value="">Pessoa…</option>
          {status.members?.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        <select value={space} onChange={(e) => (setSpace(e.target.value), setFolder(''), setList(''))} aria-label="Espaço">
          <option value="">Todos os espaços</option>
          {status.spaces?.map((sp) => (
            <option key={sp.id} value={sp.id}>
              {sp.name}
            </option>
          ))}
        </select>
        <select value={folder} onChange={(e) => (setFolder(e.target.value), setList(''))} aria-label="Projeto" disabled={!folders.length}>
          <option value="">Todos os projetos</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
              {!space && (status.spaces?.length ?? 0) > 1 ? ` (${status.spaces?.find((sp) => sp.id === f.spaceId)?.name ?? ''})` : ''}
            </option>
          ))}
        </select>
        {folder && (
          <select value={list} onChange={(e) => setList(e.target.value)} aria-label="Lista">
            <option value="">Todas as listas</option>
            {lists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        )}
        <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)} aria-label="Agrupar por">
          <option value="pessoa">por pessoa</option>
          <option value="projeto">por projeto</option>
          <option value="status">por status</option>
          <option value="prazo">por prazo</option>
        </select>
        <label className="cu-check">
          <input type="checkbox" checked={onlyLate} onChange={(e) => setOnlyLate(e.target.checked)} /> atrasadas
        </label>
        <label className="cu-check">
          <input type="checkbox" checked={closed} onChange={(e) => setClosed(e.target.checked)} /> concluídas
        </label>
        <button type="button" className="btn ghost" onClick={() => setReloadKey((k) => k + 1)} title="Atualizar (cache de 1 min no servidor)">
          ↻
        </button>
        <details className="export-menu">
          <summary className={`btn ghost${!tasks?.length || reporting ? ' disabled' : ''}`} title="Relatório das tarefas filtradas">
            {reporting ? '…' : '⬇ Relatório'}
          </summary>
          {!!tasks?.length && (
            <div className="export-options" onClick={(e) => (e.currentTarget.parentElement as HTMLDetailsElement).removeAttribute('open')}>
              <button type="button" onClick={() => void exportReport('docx')} title="Capa, ficha, resumo, atrasadas e lista — identidade visual">
                Word com capa
              </button>
              <button type="button" onClick={() => void exportReport('md')} title="Nota .md (type journal) para guardar em 01-Agenda">
                Markdown (.md)
              </button>
              <button type="button" onClick={() => void exportDeck('save')} title="Slides no modelo com capa: salva em 99-Meta/attachments/Apresentacoes/ e abre numa aba nova">
                Apresentação (abrir)
              </button>
              <button type="button" onClick={() => void exportDeck('download')} title="Slides no modelo com capa, só o arquivo .html">
                Apresentação (.html)
              </button>
            </div>
          )}
        </details>
      </div>

      {error && <p className="flash">{error}</p>}
      {!tasks && !error && <p className="muted">Carregando tarefas…</p>}
      {tasks && !tasks.length && <p className="muted">Nenhuma tarefa com esses filtros.</p>}
      {groups.map(([name, list]) => (
        <section key={name} className="cu-group">
          <h2>
            {name} <span className="muted">({list.length})</span>
          </h2>
          <ul className="cu-list">
            {list.map((t) => (
              <TaskRow key={`${name}-${t.id}`} task={t} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** card da tarefa ligada à nota (frontmatter clickup:), no painel de Propriedades */
export function ClickUpCard({ id }: { id: string }) {
  const [task, setTask] = useState<(Task & { description: string }) | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setTask(null);
    setError('');
    getJson<{ task: Task & { description: string } }>(`/api/clickup/task/${encodeURIComponent(id)}`).then(
      (r) => setTask(r.task),
      (e) => setError((e as Error).message),
    );
  }, [id]);
  return (
    <section className="panel-section cu-card">
      <h2>ClickUp</h2>
      {error && <p className="muted">{error}</p>}
      {!task && !error && <p className="muted">carregando…</p>}
      {task && (
        <>
          <p className="cu-card-status">
            <span className="cu-status" style={{ background: task.statusColor }} /> {task.status}
            {task.priority && <span className={`cu-prio cu-prio-${task.priority}`}> ⚑ {task.priority}</span>}
          </p>
          <p className="cu-card-name">{task.name}</p>
          <p className="cu-card-meta">
            <span className="cu-people">
              {task.assignees.map((p) => (
                <Avatar key={p.id} p={p} />
              ))}
            </span>
            {task.assignees.map((p) => p.name).join(', ') || 'sem responsável'}
          </p>
          <p className={`cu-card-meta${task.overdue ? ' cu-late' : ''}`}>
            📅 {dueLabel(task.due)}
            {task.overdue && ' (atrasada)'}
          </p>
          <p className="cu-card-meta muted">{[task.space, task.folder, task.list].filter(Boolean).join(' › ')}</p>
          <a className="btn ghost" href={task.url} target="_blank" rel="noopener">
            ↗ Abrir no ClickUp
          </a>
        </>
      )}
    </section>
  );
}

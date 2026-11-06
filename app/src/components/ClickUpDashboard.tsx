import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { expireSession } from '../api';
// mesmos tipos que o servidor devolve: mudou lá, o build quebra aqui
import type { Dashboard, DashboardGroup, Folder, Person } from '../../tools/clickup/clickup-types.ts';

/**
 * ClickUpDashboard.tsx — painel (dashboard) do ClickUp, SÓ LEITURA e SEPARADO
 * da página ☑ Tarefas: conta os cards ABERTOS (status não fechado), quantos
 * estão atrasados e abre o recorte por pessoa e por projeto (pasta).
 * Dados: /api/clickup/dashboard (o token continua só no servidor).
 */

interface Status {
  configured: boolean;
  me?: Person;
  team?: string;
  spaces?: { id: string; name: string }[];
  folders?: Folder[];
  error?: string;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  expireSession(res);
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

/** filtros do painel em chaves próprias (cu.dash…): não bagunçam os filtros
 * que a pessoa já deixou salvos na página ☑ Tarefas */
const saved = (key: string) => localStorage.getItem(key) ?? '';

function Kpi({ n, label, tone }: { n: number; label: string; tone?: 'late' | 'soon' | 'muted' }) {
  return (
    <div className={`dash-kpi${tone ? ` dash-kpi-${tone}` : ''}`}>
      <span className="dash-kpi-num">{n}</span>
      <span className="dash-kpi-label">{label}</span>
    </div>
  );
}

/** barras horizontais: comprimento proporcional ao maior grupo do recorte */
function BarList({ rows, noun }: { rows: DashboardGroup[]; noun: string }) {
  const max = Math.max(1, ...rows.map((r) => r.open));
  if (!rows.length) return <p className="muted">Nenhum card aberto neste recorte.</p>;
  return (
    <ul className="dash-bars">
      {rows.map((r) => (
        <li className="dash-bar-row" key={r.name}>
          <span className="dash-bar-name" title={r.name}>
            {r.name}
          </span>
          <span className="dash-bar" aria-hidden="true">
            <span className="dash-bar-fill" style={{ width: `${Math.max(4, (r.open / max) * 100)}%` }} />
          </span>
          <span className="dash-bar-num" title={`${r.open} ${noun}(s) aberto(s)`}>{r.open}</span>
          <span className={`dash-bar-late${r.overdue ? '' : ' dash-bar-ok'}`} title={r.overdue ? `${r.overdue} atrasado(s)` : 'nenhum atrasado'}>
            {r.overdue ? `⚠ ${r.overdue}` : '✓'}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function ClickUpDashboardPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [error, setError] = useState('');
  const [scope, setScope] = useState<'me' | 'team'>(() => (saved('cu.dashScope') === 'me' ? 'me' : 'team'));
  const [space, setSpace] = useState(() => saved('cu.dashSpace'));
  const [folder, setFolder] = useState(() => saved('cu.dashFolder'));
  const [reloadKey, setReloadKey] = useState(0);
  const navigate = useNavigate();

  useEffect(() => {
    getJson<Status>('/api/clickup/status').then(setStatus, (e) => setStatus({ configured: false, error: (e as Error).message }));
  }, []);

  useEffect(() => {
    localStorage.setItem('cu.dashScope', scope);
    localStorage.setItem('cu.dashSpace', space);
    localStorage.setItem('cu.dashFolder', folder);
  }, [scope, space, folder]);

  // filtro salvo que não existe mais (pasta arquivada, spaceIds mudou): volta para "todos"
  useEffect(() => {
    if (!status?.configured) return;
    if (space && !status.spaces?.some((sp) => sp.id === space)) setSpace('');
    if (folder && !status.folders?.some((f) => f.id === folder)) setFolder('');
  }, [status, space, folder]);

  useEffect(() => {
    if (!status?.configured) return;
    setDash(null);
    setError('');
    const q = new URLSearchParams({ scope });
    if (space) q.set('space', space);
    if (folder) q.set('folder', folder);
    getJson<Dashboard>(`/api/clickup/dashboard?${q}`).then(setDash, (e) => setError((e as Error).message));
  }, [status, scope, space, folder, reloadKey]);

  const folders = useMemo(() => (status?.folders ?? []).filter((f) => !space || f.spaceId === space), [status, space]);
  const where = [status?.spaces?.find((sp) => sp.id === space)?.name, status?.folders?.find((f) => f.id === folder)?.name].filter(Boolean).join(' › ');

  /** abrir a ☑ Tarefas já no recorte do painel (a página lê os filtros do localStorage) */
  function openList(f?: Folder) {
    localStorage.setItem('cu.scope', scope);
    localStorage.setItem('cu.space', f ? f.spaceId : space);
    localStorage.setItem('cu.folder', f?.id ?? '');
    localStorage.setItem('cu.list', '');
    navigate('/tarefas');
  }


  if (!status) return <p className="muted">Carregando ClickUp…</p>;
  if (!status.configured) {
    return (
      <div className="note">
        <h1>📊 Painel ClickUp</h1>
        <p className="flash">{status.error || 'ClickUp não configurado — veja ☑ Tarefas.'}</p>
      </div>
    );
  }

  return (
    <div className="cu-page dash-page">
      <h1>
        📊 Painel <span className="muted cu-team">{status.team} · só leitura</span>
      </h1>

      <div className="cu-filters">
        <div className="cu-tabs" role="tablist">
          {(['team', 'me'] as const).map((s) => (
            <button key={s} type="button" role="tab" aria-selected={scope === s} onClick={() => setScope(s)}>
              {s === 'me' ? `Eu (${status.me?.name ?? 'eu'})` : 'Equipe'}
            </button>
          ))}
        </div>
        <select value={space} onChange={(e) => (setSpace(e.target.value), setFolder(''))} aria-label="Espaço">
          <option value="">Todos os espaços</option>
          {(status.spaces ?? []).map((sp) => (
            <option key={sp.id} value={sp.id}>
              {sp.name}
            </option>
          ))}
        </select>
        <select value={folder} onChange={(e) => setFolder(e.target.value)} aria-label="Projeto">
          <option value="">Todos os projetos</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {f.spaceId ? `${status.spaces?.find((x) => x.id === f.spaceId)?.name} › ${f.name}` : f.name}
            </option>
          ))}
        </select>
        <button type="button" className="cu-check" onClick={() => setReloadKey((k) => k + 1)}>
          ↻ atualizar
        </button>
        <span className="muted">
          {where || 'todos'} · referência {dash?.date ?? new Date().toISOString().slice(0, 10)}
        </span>
      </div>

      {error && <p className="flash">{error}</p>}
      {!dash && !error && <p className="muted">Contando cards…</p>}


      {dash && (
        <>
          <div className="dash-kpis">
            <Kpi n={dash.open} label="cards abertos" />
            <Kpi n={dash.overdue} label="atrasados" tone="late" />
            <Kpi n={dash.dueToday} label="para hoje" tone="soon" />
            <Kpi n={dash.dueSoon} label="próximos 7 dias" tone="soon" />
            <Kpi n={dash.noDue} label="sem prazo" tone="muted" />
            <Kpi n={dash.noAssignee} label="sem responsável" tone="muted" />
          </div>

          <div className="dash-panels">
            <section className="dash-panel">
              <h2>
                Abertos por pessoa
                <button type="button" className="dash-link" onClick={() => openList()} title="ver a lista na página ☑ Tarefas">
                  lista ↗
                </button>
              </h2>
              <BarList rows={dash.people} noun="card" />
            </section>
            <section className="dash-panel">
              <h2>Abertos por projeto</h2>
              <BarList rows={dash.projects} noun="card" />
            </section>
          </div>

          <p className="muted dash-foot">
            Aberto = status não fechado. Uma tarefa com dois responsáveis conta nas duas pessoas, então a soma por pessoa
            pode passar do total de cards.
            {dash.truncated && <span className="cu-late"> · lista truncada pelo limite de páginas do ClickUp</span>}
            {' '}
            <Link to="/tarefas">lista completa ☑</Link>
          </p>
        </>
      )}
    </div>
  );
}


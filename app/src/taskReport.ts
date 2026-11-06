/**
 * taskReport.ts — relatório das tarefas do ClickUp filtradas na página ☑ Tarefas.
 *
 * Mesmos dados, duas saídas:
 *   reportElement  → HTML no formato de nota renderizada, que o docMarca.ts
 *                    transforma no documento A4 (Word com capa: capa, ficha, rodapé)
 *   reportMarkdown → nota .md (type journal) para guardar no vault
 *
 * Seções: Resumo (números + alerta de atrasadas), Por status, Por responsável,
 * Atrasadas e Tarefas (agrupadas como na tela). Sem rede nem React: testado em
 * server/tests/task-report.test.mjs.
 */
import type { Task } from '../tools/clickup/clickup-types.ts';

export interface ReportInput {
  tasks: Task[];
  /** grupos como estão na tela (por pessoa, projeto, status ou prazo) */
  groups: [string, Task[]][];
  groupLabel: string;
  /** ex.: "Empresa › Projeto Core › Cliente A" */
  scope: string;
  /** ex.: "Equipe", "Minhas", "Ana Souza" */
  who: string;
  /** ex.: ["só atrasadas", "com concluídas"] */
  flags: string[];
  date: string; // AAAA-MM-DD
}

export const inDays = (date: string, n: number) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const br = (iso: string | null) => (iso ? iso.split('-').reverse().join('/') : '—');
export const people = (t: Task) => t.assignees.map((p) => p.name).join(', ') || '—';
const PRIORITY: Record<string, string> = { urgent: 'Urgente', high: 'Alta', normal: 'Normal', low: 'Baixa' };
export const prio = (t: Task) => (t.priority ? PRIORITY[t.priority] ?? t.priority : '—');
export const where = (t: Task) => [t.folder, t.list].filter(Boolean).join(' › ') || t.space || '—';

export function reportTitle(r: ReportInput): string {
  return `Relatório de tarefas — ${r.scope}`;
}

/** números do recorte (usados pelo relatório e pela apresentação, taskSlides.ts) */
export function stats(r: ReportInput) {
  const open = r.tasks.filter((t) => !t.closed);
  const week = inDays(r.date, 7);
  const byStatus = new Map<string, number>();
  for (const t of r.tasks) byStatus.set(t.status, (byStatus.get(t.status) ?? 0) + 1);
  const byPerson = new Map<string, { total: number; late: number; week: number }>();
  for (const t of open) {
    for (const name of t.assignees.length ? t.assignees.map((p) => p.name) : ['Sem responsável']) {
      const s = byPerson.get(name) ?? { total: 0, late: 0, week: 0 };
      s.total++;
      if (t.overdue) s.late++;
      else if (t.due && t.due <= week) s.week++;
      byPerson.set(name, s);
    }
  }
  const late = open.filter((t) => t.overdue).sort((a, b) => (a.due ?? '').localeCompare(b.due ?? ''));
  return {
    total: r.tasks.length,
    open: open.length,
    closed: r.tasks.length - open.length,
    late,
    week: open.filter((t) => !t.overdue && t.due && t.due <= week).length,
    noOwner: open.filter((t) => !t.assignees.length).length,
    noDue: open.filter((t) => !t.due).length,
    byStatus: [...byStatus.entries()].sort((a, b) => b[1] - a[1]),
    byPerson: [...byPerson.entries()].sort((a, b) => (a[0] === 'Sem responsável' ? 1 : b[0] === 'Sem responsável' ? -1 : b[1].total - a[1].total)),
  };
}

/* ---------- HTML (Word com capa) ---------- */

export function reportElement(doc: Document, r: ReportInput): Element {
  const s = stats(r);
  const root = doc.createElement('div');
  const el = (tag: string, text?: string, cls?: string) => {
    const e = doc.createElement(tag);
    if (text !== undefined) e.textContent = text;
    if (cls) e.className = cls;
    return e;
  };
  const table = (head: string[], rows: (string | Node)[][]) => {
    const t = el('table');
    const thead = el('thead');
    const tr = el('tr');
    for (const h of head) tr.append(el('th', h));
    thead.append(tr);
    const tbody = el('tbody');
    for (const row of rows) {
      const r2 = el('tr');
      for (const c of row) {
        const td = el('td');
        td.append(typeof c === 'string' ? doc.createTextNode(c) : c);
        r2.append(td);
      }
      tbody.append(r2);
    }
    t.append(thead, tbody);
    return t;
  };
  const link = (t: Task) => {
    const a = el('a', t.name) as HTMLAnchorElement;
    a.href = t.url;
    return a;
  };
  const p = (text: string) => el('p', text);
  const h2 = (text: string) => root.append(el('h2', text));

  h2('Resumo');
  root.append(
    p(`Recorte: ${r.scope} · ${r.who}${r.flags.length ? ` · ${r.flags.join(' · ')}` : ''}. Dados do ClickUp em ${br(r.date)}.`),
    table(
      ['Indicador', 'Quantidade'],
      [
        ['Tarefas no recorte', String(s.total)],
        ['Abertas', String(s.open)],
        ...(s.closed ? [['Concluídas', String(s.closed)]] : []),
        ['Atrasadas', String(s.late.length)],
        ['Vencem nos próximos 7 dias', String(s.week)],
        ['Sem responsável', String(s.noOwner)],
        ['Sem prazo', String(s.noDue)],
      ],
    ),
  );
  if (s.late.length) {
    const box = el('div', undefined, 'alerta');
    box.append(el('strong', 'Atenção:'), doc.createTextNode(` ${s.late.length} tarefa(s) atrasada(s) — detalhes na seção "Atrasadas".`));
    root.append(box);
  }
  if (s.noOwner) {
    const box = el('div', undefined, 'ponto-aberto');
    box.append(el('strong', 'Ponto em aberto:'), doc.createTextNode(` ${s.noOwner} tarefa(s) aberta(s) sem responsável.`));
    root.append(box);
  }

  h2('Por status');
  root.append(table(['Status', 'Tarefas'], s.byStatus.map(([k, n]) => [k, String(n)])));

  h2('Por responsável');
  root.append(
    table(
      ['Responsável', 'Abertas', 'Atrasadas', 'Próx. 7 dias'],
      s.byPerson.map(([k, v]) => [k, String(v.total), String(v.late), String(v.week)]),
    ),
  );

  if (s.late.length) {
    h2('Atrasadas');
    root.append(table(['Tarefa', 'Responsável', 'Prazo', 'Projeto › lista', 'Status'], s.late.map((t) => [link(t), people(t), br(t.due), where(t), t.status])));
  }

  h2(`Tarefas (${r.groupLabel})`);
  for (const [name, list] of r.groups) {
    root.append(el('h3', `${name} (${list.length})`));
    root.append(
      table(
        ['Tarefa', 'Status', 'Prazo', 'Responsável', 'Prioridade'],
        // "(atrasada)" por extenso: o ⚠ não existe em várias fontes do Word/LibreOffice
        list.map((t) => [link(t), t.status, `${br(t.due)}${t.overdue ? ' (atrasada)' : ''}`, people(t), prio(t)]),
      ),
    );
  }
  return root;
}

/* ---------- Markdown (nota do vault) ---------- */

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
function mdTable(head: string[], rows: string[][]): string {
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');
}

export function reportMarkdown(r: ReportInput): string {
  const s = stats(r);
  const title = reportTitle(r);
  // o escape do | fica com mdTable (escapar aqui também dobraria a barra)
  const linkMd = (t: Task) => `[${t.name.replace(/[[\]]/g, '')}](${t.url})`;
  const out = [
    '---',
    'type: journal',
    `created: ${r.date}`,
    'tags: [agenda/revisao]',
    'status: done',
    `description: "${r.scope} · ${r.who}"`,
    'source: ClickUp',
    '---',
    '',
    `# ${title}`,
    '',
    'Gerado na página ☑ Tarefas do vault (ClickUp, só leitura). Integração: [[Agente-do-terminal]].',
    '',
    '## Resumo',
    '',
    `Recorte: ${r.scope} · ${r.who}${r.flags.length ? ` · ${r.flags.join(' · ')}` : ''}. Dados do ClickUp em ${r.date}.`,
    '',
    mdTable(
      ['Indicador', 'Quantidade'],
      [
        ['Tarefas no recorte', String(s.total)],
        ['Abertas', String(s.open)],
        ...(s.closed ? [['Concluídas', String(s.closed)]] : []),
        ['Atrasadas', String(s.late.length)],
        ['Vencem nos próximos 7 dias', String(s.week)],
        ['Sem responsável', String(s.noOwner)],
        ['Sem prazo', String(s.noDue)],
      ],
    ),
    '',
    ...(s.late.length ? [`> [!warning] ${s.late.length} tarefa(s) atrasada(s) — ver "Atrasadas".`, ''] : []),
    ...(s.noOwner ? [`> [!note] ${s.noOwner} tarefa(s) aberta(s) sem responsável.`, ''] : []),
    '## Por status',
    '',
    mdTable(['Status', 'Tarefas'], s.byStatus.map(([k, n]) => [k, String(n)])),
    '',
    '## Por responsável',
    '',
    mdTable(['Responsável', 'Abertas', 'Atrasadas', 'Próx. 7 dias'], s.byPerson.map(([k, v]) => [k, String(v.total), String(v.late), String(v.week)])),
    '',
  ];
  if (s.late.length) {
    out.push('## Atrasadas', '', mdTable(['Tarefa', 'Responsável', 'Prazo', 'Projeto › lista', 'Status'], s.late.map((t) => [linkMd(t), people(t), t.due ?? '—', where(t), t.status])), '');
  }
  out.push(`## Tarefas (${r.groupLabel})`, '');
  for (const [name, list] of r.groups) {
    out.push(`### ${name} (${list.length})`, '', mdTable(['Tarefa', 'Status', 'Prazo', 'Responsável', 'Prioridade'], list.map((t) => [linkMd(t), t.status, `${t.overdue ? '⚠ ' : ''}${t.due ?? '—'}`, people(t), prio(t)])), '');
  }
  return out.join('\n');
}

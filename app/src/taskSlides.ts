/**
 * taskSlides.ts — apresentação (reveal.js) das tarefas do ClickUp filtradas na
 * página ☑ Tarefas, montada sobre o modelo oficial de slides
 * (99-Meta/attachments/Apresentacoes/Modelo-apresentacao.html):
 * o <head>, o fundo animado e o <script> vêm do modelo; só as <section> são
 * geradas aqui. Sem LLM: qualquer quantidade de tarefas (listas longas viram
 * vários slides de até ROWS linhas).
 *
 * Slides: capa · visão geral (KPIs) · por status · por responsável ·
 * atrasadas · próximos 7 dias · pontos de atenção · próximos passos.
 * Testado em server/tests/task-slides.test.mjs.
 */
import type { Task } from '../tools/clickup/clickup-types.ts';
import { br, inDays, people, stats, where, type ReportInput } from './taskReport.ts'; // com extensão: os testes rodam este arquivo direto no Node

export const SLIDE_MODEL = '99-Meta/attachments/Apresentacoes/Modelo-apresentacao.html';
const ROWS = 8;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function chunks<T>(list: T[], size = ROWS): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out.length ? out : [[]];
}

function section(kicker: string, title: string, body: string): string {
  return `    <section>
      <p class="kicker">${esc(kicker)}</p>
      <h2>${esc(title)}</h2>
      <div class="regua"></div>
${body}
    </section>
`;
}

function table(head: string[], rows: string[][]): string {
  const th = head.map((h) => `<th>${esc(h)}</th>`).join('');
  const tr = rows.map((r) => `          <tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('\n');
  return `      <table>
        <thead><tr>${th}</tr></thead>
        <tbody>
${tr}
        </tbody>
      </table>`;
}

const link = (t: Task) => `<a href="${esc(t.url)}" target="_blank" rel="noopener">${esc(t.name)}</a>`;
const page = (title: string, i: number, n: number) => (n > 1 ? `${title} (${i + 1}/${n})` : title);

/** as <section> da apresentação */
export function taskSections(r: ReportInput): string {
  const s = stats(r);
  const open = r.tasks.filter((t) => !t.closed);
  const week = inDays(r.date, 7);
  const soon = open.filter((t) => !t.overdue && t.due && t.due <= week).sort((a, b) => a.due!.localeCompare(b.due!));
  const short = r.scope.split(' › ').pop() || r.scope;
  const out: string[] = [];

  out.push(`    <section class="capa">
      <div class="barra-topo"></div>
      <img class="logo" src="/brand/logo-capa.png" alt="Tania">
      <div class="bloco-texto">
        <h1>Tarefas — ${esc(short)}</h1>
        <p class="subtitulo">${esc(r.scope)}</p>
        <p class="tagline">${esc(r.who)} · ${s.open} aberta(s)${r.flags.length ? ` · ${esc(r.flags.join(' · '))}` : ''}</p>
      </div>
      <p class="rodape">${esc(r.date)} · Tania · dados do ClickUp</p>
      <div class="barra-base"></div>
    </section>
`);

  out.push(
    section(
      'visão geral',
      'O recorte em números',
      `      <div class="kpis">
        <div class="kpi"><p class="valor">${s.open}</p><p class="rotulo">tarefas abertas${s.closed ? ` (+${s.closed} concluída(s))` : ''}</p></div>
        <div class="kpi"><p class="valor">${s.late.length}</p><p class="rotulo">atrasadas</p></div>
        <div class="kpi"><p class="valor">${s.week}</p><p class="rotulo">vencem nos próximos 7 dias</p></div>
      </div>`,
    ),
  );

  const byStatus = chunks(s.byStatus);
  byStatus.forEach((rows, i) =>
    out.push(section('visão geral · status', page('Por status', i, byStatus.length), table(['Status', 'Tarefas'], rows.map(([k, n]) => [esc(k), String(n)])))),
  );

  const byPerson = chunks(s.byPerson);
  byPerson.forEach((rows, i) =>
    out.push(
      section(
        'equipe',
        page('Por responsável', i, byPerson.length),
        table(['Responsável', 'Abertas', 'Atrasadas', 'Próx. 7 dias'], rows.map(([k, v]) => [esc(k), String(v.total), String(v.late), String(v.week)])),
      ),
    ),
  );

  if (s.late.length) {
    const late = chunks(s.late);
    late.forEach((rows, i) =>
      out.push(
        section(
          'atenção',
          page('Atrasadas', i, late.length),
          table(['Tarefa', 'Responsável', 'Prazo', 'Projeto › lista'], rows.map((t) => [link(t), esc(people(t)), br(t.due), esc(where(t))])),
        ),
      ),
    );
  }

  if (soon.length) {
    const next = chunks(soon);
    next.forEach((rows, i) =>
      out.push(
        section(
          'agenda',
          page('Vencem nos próximos 7 dias', i, next.length),
          table(['Tarefa', 'Responsável', 'Prazo', 'Status'], rows.map((t) => [link(t), esc(people(t)), br(t.due), esc(t.status)])),
        ),
      ),
    );
  }

  const boxes: string[] = [];
  if (s.late.length) boxes.push(`      <div class="alerta">\n        <p class="rotulo-caixa">Alerta</p>\n        <p>${s.late.length} tarefa(s) atrasada(s); a mais antiga venceu em ${br(s.late[0].due)}.</p>\n      </div>`);
  if (s.noOwner) boxes.push(`      <div class="ponto-aberto">\n        <p class="rotulo-caixa">Ponto em aberto</p>\n        <p>${s.noOwner} tarefa(s) aberta(s) sem responsável.</p>\n      </div>`);
  if (s.noDue) boxes.push(`      <div class="ponto-aberto">\n        <p class="rotulo-caixa">Ponto em aberto</p>\n        <p>${s.noDue} tarefa(s) aberta(s) sem prazo definido.</p>\n      </div>`);
  out.push(
    section(
      'atenção',
      'Pontos de atenção',
      boxes.length ? boxes.join('\n') : '      <p>Nenhuma tarefa atrasada, sem responsável ou sem prazo neste recorte.</p>',
    ),
  );

  // próximos passos: atrasadas primeiro, depois as que vencem logo
  const steps = [...s.late, ...soon].slice(0, 5);
  out.push(
    section(
      'próximos passos',
      'Próximos passos',
      steps.length
        ? `      <ul class="proximos">\n${steps
            .map((t) => `        <li><span class="acao">${esc(t.name)}</span> — ${esc(people(t))} · ${t.overdue ? `atrasada desde ${br(t.due)}` : `até ${br(t.due)}`}</li>`)
            .join('\n')}\n      </ul>`
        : '      <p>Sem prazos vencendo nos próximos 7 dias.</p>',
    ),
  );
  return out.join('\n');
}

/** HTML completo: o modelo com as <section> trocadas pelas da apresentação */
export function buildTaskDeck(model: string, r: ReportInput): string {
  const start = model.search(/<div class="slides">/);
  const end = model.search(/<\/div>\s*<\/div>\s*(<!--[\s\S]*?-->\s*)*<script/);
  if (start < 0 || end < 0 || end < start) throw new Error('modelo de slides sem <div class="slides"> no formato esperado');
  const open = model.indexOf('>', start) + 1;
  const title = `Tarefas — ${r.scope.split(' › ').pop() || r.scope} — Tania`;
  return `${model.slice(0, open)}\n\n${taskSections(r)}\n  ${model.slice(end)}`.replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(title)}</title>`);
}

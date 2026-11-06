/**
 * task-slides.test.mjs — apresentação das tarefas do ClickUp (src/taskSlides.ts).
 *
 * Roda:  node --test server/tests/task-slides.test.mjs   (Node >= 22.18: type stripping)
 *
 * Usa o modelo real de slides. Cobre: <head>, fundo animado e <script> do
 * modelo preservados; capa e slides gerados; listas longas em vários slides;
 * HTML escapado (nome de tarefa com <, &, "). Grava em DECK_OUT, se definido.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { buildTaskDeck, SLIDE_MODEL } from '../../src/taskSlides.ts';

const VAULT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MODEL_PATH = path.join(VAULT, SLIDE_MODEL);
const person = (id, name) => ({ id, name, initials: name.slice(0, 2), color: '#40A8C4', avatar: null });
const ANA = person(2, 'Ana Souza');
const ROD = person(1, 'Rodrigo');
const task = (i, extra = {}) => ({
  id: `t${i}`, name: `Tarefa ${i}`, url: `https://app.clickup.com/t/t${i}`, status: 'em andamento', statusColor: '#40A8C4',
  closed: false, priority: 'high', due: '2026-10-29', overdue: false, updated: null, assignees: [ANA], listId: 'L1',
  list: 'Cliente A', folderId: 'F1', folder: 'Projeto Core', spaceId: 'S1', space: 'Empresa', tags: [], parent: null, ...extra,
});
const TASKS = [
  ...Array.from({ length: 19 }, (_, i) => task(i, { overdue: true, due: `2026-10-${String(i + 1).padStart(2, '0')}`, assignees: [ROD] })),
  task(50, { name: 'Revisar <spec> & "ajustes"' }),
  task(51, { assignees: [], due: null, status: 'a fazer' }),
];
const INPUT = { tasks: TASKS, groups: [], groupLabel: 'por pessoa', scope: 'Empresa › Projeto Core › Cliente A', who: 'Equipe', flags: [], date: '2026-10-27' };

test('apresentação sobre o modelo real: capa, slides, paginação e escape', { skip: !existsSync(MODEL_PATH) ? 'modelo com capa ausente (fixture do vault)' : false }, async () => {
  const model = await fs.readFile(MODEL_PATH, 'utf8');
  const html = buildTaskDeck(model, INPUT);
  if (process.env.DECK_OUT) await fs.writeFile(process.env.DECK_OUT, html);
  const doc = new JSDOM(html).window.document;

  // do modelo: fundo animado, reveal e estilos
  assert.ok(doc.querySelector('.fundo .grade'), 'fundo animado do modelo');
  assert.ok([...doc.scripts].some((s) => /reveal\.js/.test(s.src)));
  assert.ok(/Reveal\.initialize/.test(html));
  assert.equal(doc.title, 'Tarefas — Cliente A — Tania');
  assert.ok(!html.includes('{{'), 'nenhum marcador do modelo sobra');

  const sections = [...doc.querySelectorAll('.slides > section')];
  const titles = sections.map((s) => s.querySelector('h2, h1')?.textContent);
  assert.equal(titles[0], 'Tarefas — Cliente A');
  assert.ok(sections[0].classList.contains('capa'));
  assert.ok(titles.includes('O recorte em números'));
  assert.deepEqual(titles.filter((t) => t.startsWith('Atrasadas')), ['Atrasadas (1/3)', 'Atrasadas (2/3)', 'Atrasadas (3/3)']);
  assert.ok(titles.includes('Vencem nos próximos 7 dias'));
  assert.equal(titles.at(-1), 'Próximos passos');

  const kpis = [...doc.querySelectorAll('.kpi .valor')].map((k) => k.textContent);
  assert.deepEqual(kpis, ['21', '19', '1']);
  assert.ok(doc.querySelector('.alerta') && doc.querySelectorAll('.ponto-aberto').length === 2, 'atrasadas + sem responsável + sem prazo');
  assert.equal(doc.querySelectorAll('.proximos li').length, 5);

  // escape: o nome vira texto, não marcação
  assert.ok(html.includes('Revisar &lt;spec&gt; &amp; "ajustes"') || html.includes('Revisar &lt;spec&gt; &amp; &quot;ajustes&quot;'));
  assert.ok(!doc.querySelector('spec'));
});

test('modelo fora do formato: erro claro', () => {
  assert.throws(() => buildTaskDeck('<html><body>sem slides</body></html>', INPUT), /modelo de slides/);
});

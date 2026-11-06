/**
 * task-report.test.mjs — relatório das tarefas do ClickUp (src/taskReport.ts).
 *
 * Roda:  node --test server/tests/task-report.test.mjs   (Node >= 22.18: type stripping)
 *
 * Cobre: números do resumo (abertas, atrasadas, 7 dias, sem responsável),
 * seções e grupos, Word com capa (capa, ficha, alerta, tabelas, links) e o
 * Markdown passando nas regras de nota do vault (01-Agenda, type journal).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { Packer } from 'docx';
import JSZip from 'jszip';
import { reportElement, reportMarkdown, reportTitle } from '../../src/taskReport.ts';
import { noteToMarcaDoc } from '../../src/docMarca.ts';
import { htmlToDocx } from '../../src/htmlToDocx.ts';
import { checkNote, linkTargets } from '../agent/rules.ts';

const FRONT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ana = { id: 2, name: 'Ana Souza', initials: 'AS', color: '#40A8C4', avatar: null };
const rod = { id: 1, name: 'Rodrigo', initials: 'RO', color: '#40A8C4', avatar: null };
const task = (id, name, assignees, due, extra = {}) => ({
  id, name, url: `https://app.clickup.com/t/${id}`, status: 'em andamento', statusColor: '#40A8C4', closed: false,
  priority: 'high', due, overdue: false, updated: null, assignees, listId: 'L1', list: 'Cliente A',
  folderId: 'F1', folder: 'Projeto Core', spaceId: 'S1', space: 'Empresa', tags: [], parent: null, ...extra,
});
const TASKS = [
  task('t1', 'Revisar spec | inundação', [rod], '2026-10-20', { overdue: true }),
  task('t2', 'Mapa de estiagem', [ana], '2026-10-29'),
  task('t3', 'Validar alagamento', [], null, { status: 'a fazer' }),
  task('t4', 'Entregue', [ana], '2026-10-01', { closed: true, status: 'concluído' }),
];
const INPUT = {
  tasks: TASKS,
  groups: [['Ana Souza', [TASKS[1], TASKS[3]]], ['Rodrigo', [TASKS[0]]], ['Sem responsável', [TASKS[2]]]],
  groupLabel: 'por pessoa',
  scope: 'Empresa › Projeto Core › Cliente A',
  who: 'Equipe',
  flags: ['com concluídas'],
  date: '2026-10-26',
};

test('markdown: resumo, seções, links e regras do vault', () => {
  const md = reportMarkdown(INPUT);
  assert.match(md, /^---\ntype: journal\ncreated: 2026-10-26\n/);
  assert.match(md, /# Relatório de tarefas — Empresa › Projeto Core › Cliente A/);
  assert.match(md, /\| Abertas \| 3 \|/);
  assert.match(md, /\| Concluídas \| 1 \|/);
  assert.match(md, /\| Atrasadas \| 1 \|/);
  assert.match(md, /\| Vencem nos próximos 7 dias \| 1 \|/);
  assert.match(md, /\| Sem responsável \| 1 \|/);
  assert.match(md, /> \[!warning\] 1 tarefa\(s\) atrasada/);
  assert.match(md, /## Atrasadas[\s\S]*\[Revisar spec \\\| inundação\]\(https:\/\/app\.clickup\.com\/t\/t1\)/);
  assert.match(md, /### Ana Souza \(2\)/);
  const check = checkNote('01-Agenda/2026-10-26-Relatorio-tarefas.md', md, linkTargets(['04-Agentes/Agentes/Agente-do-terminal.md']));
  assert.deepEqual(check.errors, []);
});

test('Word com capa: capa, ficha, alerta e tabelas do relatório', async () => {
  const doc = new JSDOM('<!doctype html><body></body>').window.document;
  const content = reportElement(doc, INPUT);
  noteToMarcaDoc(doc, content, {
    title: reportTitle(INPUT),
    date: INPUT.date,
    frontmatter: { description: 'Equipe · 4 tarefa(s)', cliente: INPUT.scope, responsavel: 'Rodrigo' },
  });
  const loadImage = async (src) => {
    const name = new URL(src, 'https://x/').pathname.match(/^\/brand\/(.+)$/)?.[1];
    const data = name && (await fs.readFile(path.join(FRONT, 'public/brand', name)).catch(() => null));
    return data ? { data: new Uint8Array(data), type: 'png', width: data.readUInt32BE(16), height: data.readUInt32BE(20) } : null;
  };
  const buffer = await Packer.toBuffer(await htmlToDocx(doc, loadImage, { sectionBreaks: false }));
  if (process.env.DOCX_OUT) await fs.writeFile(process.env.DOCX_OUT, buffer);
  const body = await (await JSZip.loadAsync(buffer)).file('word/document.xml').async('string');
  assert.match(body, /<w:titlePg\/>/);
  assert.ok(body.includes('Relatório de tarefas'));
  assert.ok(body.includes('RESPONSÁVEL'), 'ficha');
  for (const h of ['Resumo', 'Por status', 'Por responsável', 'Atrasadas', 'Tarefas (por pessoa)']) {
    assert.match(body, new RegExp(`<w:pStyle w:val="Heading1"/>(?:(?!</w:p>).)*${h.replace(/[()]/g, '\\$&')}`, 's'), h);
  }
  assert.match(body, /<w:pStyle w:val="Heading2"\/>(?:(?!<\/w:p>).)*Ana Souza \(2\)/s);
  assert.match(body, /w:fill="FFF7E0"/, 'alerta de atrasadas');
  assert.ok(body.includes('w:hyperlink'), 'tarefa com link para o ClickUp');
  assert.ok(body.includes('26/10/2026'));
});

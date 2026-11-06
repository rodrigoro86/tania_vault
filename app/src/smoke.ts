/**
 * smoke.ts — renderiza de verdade (SSR) para conferir wikilinks, callouts,
 * frontmatter e backlinks sem navegador.
 * Build:  vite build --ssr src/smoke.ts --outDir dist-smoke
 * Run:    node dist-smoke/smoke.js
 */
import React from 'react';
import { renderToString } from 'react-dom/server';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { wikilinks, callouts } from './plugins';
import {
  notes,
  byPath,
  backlinks,
  allTags,
  tree,
  attachmentUrls,
  embeddedAttachments,
  attachmentEmbeds,
  noteEmbeds,
  relatedAttachments,
  noteAttachments,
  danglingAttachments,
  stripCode,
  type Note,
} from './vault';
import { StaticRouter } from 'react-router-dom/server';
import { resolveTarget } from './vault';
import Properties from './components/Properties';

console.log(
  'debug resolve:',
  resolveTarget('2026-10-28-Apresentacao.pptx'),
  resolveTarget('Sprints.base'),
  resolveTarget('link-que-nao-existe'),
  [...attachmentUrls.keys()].slice(0, 4)
);

function render(note: { raw: string; body: string; frontmatter: Record<string, unknown> }) {
  return renderToString(
    React.createElement(Markdown, { remarkPlugins: [remarkGfm, wikilinks, callouts] }, note.body)
  );
}

console.log(`notas: ${notes.length}`);
console.log(`anexos: ${attachmentUrls.size} ->`, [...attachmentUrls.values()].slice(0, 3));
console.log(`tags: ${allTags.size}`);
console.log(
  'folders:',
  [...tree.children.keys()],
  'root notes:',
  tree.notes.map((n) => n.name)
);

const agents = byPath.get('AGENTS.md')!;
const html = render(agents);
console.log('\n--- AGENTS.md (trecho) ---');
console.log(html.match(/<table>[\s\S]*?<\/table>/)?.[0]?.slice(0, 400));
console.log('link quebrado presente?', /wikilink broken/.test(html));

/* anexos binários: embed/link direto devem virar URL de asset */
const deck = byPath.get('01-Agenda/Sprints/Apresentacoes/2026-10-28-Apresentacao.md');
if (deck) {
  const deckHtml = render(deck);
  console.log('\n--- anexos da nota de apresentação ---');
  console.log('relacionados:', relatedAttachments(deck));
  console.log('link de anexo no HTML:', deckHtml.match(/<a[^>]*class="wikilink attachment"[^>]*>/)?.[0] ?? 'nenhum');
  console.log('mesclados (noteAttachments):', noteAttachments(deck));
  const panel = renderToString(
    React.createElement(StaticRouter, { location: '/' + deck.path },
      React.createElement(Properties, { note: deck })),
  );
  console.log('painel de anexos:', panel.match(/<section class="panel-section"><h2>Anexos[\s\S]*?<\/section>/)?.[0]);
  console.log('embeds não resolvidos:', (panel.match(/<h2>Embeds não resolvidos \(\d+\)<\/h2>/) ?? ['nenhum'])[0]);
}

/* nota com imagem embedada: painel deve trazer embed + relacionados, sem duplicar */
const mapa = byPath.get('03-Aprendizados/GIS/Mapa-3D-de-Porto-Alegre.md');
if (mapa) {
  const panel2 = renderToString(
    React.createElement(StaticRouter, { location: '/' + mapa.path },
      React.createElement(Properties, { note: mapa })),
  );
  console.log('\n--- painel de', mapa.path, '---');
  console.log(panel2.match(/<section class="panel-section"><h2>Anexos[\s\S]*?<\/section>/)?.[0] ?? 'sem anexos');
  console.log('dangling:', danglingAttachments(mapa.body));
}

/* merge sintético: embed + relacionados do mesmo nome não deve duplicar */
const fake: Note = {
  path: '01-Agenda/Deck/v9.md',
  name: 'v9',
  folder: '01-Agenda/Deck',
  ext: 'md',
  raw: '',
  frontmatter: {},
  body: '![[v9.pptx]] e ![[v9.pptx]] e ![[Home.md]] e ![[logo-da-empresa.png]]\n`![[dentro-de-code.png]]`',
  title: 'v9',
};
console.log('\n--- merge sintético (embed + relacionados) ---');
console.log(noteAttachments(fake), danglingAttachments(fake.body));
console.log(
  renderToString(
    React.createElement(StaticRouter, { location: '/' + fake.path },
      React.createElement(Properties, { note: fake })),
  ).match(/<section class="panel-section"><h2>(Anexos|Embeds não resolvidos)[\s\S]*?<\/section>/g),
);

/* --- classificação de embeds: anexo binário vs nota/base vs dangling ---
   notas reais do vault que usam ![[...]] de formas diferentes */
for (const path of [
  '01-Agenda/Sprints/Sprints.md',
  '03-Aprendizados/Obsidian/Bases-e-Properties.md',
  '01-Agenda/Sprints/Apresentacoes/2026-10-28-Apresentacao.md',
  fake.path,
]) {
  const n = path === fake.path ? fake : byPath.get(path);
  if (!n) continue;
  console.log(`\n--- classificação de embeds: ${n.path} ---`);
  console.log('binários :', attachmentEmbeds(n.body).map((e) => `${e.target} -> ${e.url}`));
  console.log('notas    :', noteEmbeds(n.body).map((e) => `${e.target} -> ${e.url}`));
  console.log('dangling :', danglingAttachments(n.body).map((e) => e.target));
  const panel = renderToString(
    React.createElement(StaticRouter, { location: '/' + n.path },
      React.createElement(Properties, { note: n })),
  );
  console.log('seções do painel:', (panel.replace(/<!-- -->/g, '').match(/<h2>[\s\S]*?<\/h2>/g) ?? []).join(' | '));
  console.log('link de nota embedada:', (panel.match(/<a href="\/[^"]+"[^>]*>[^<]*<\/a>/) ?? []).slice(0, 3).join(' | '));
}

const home = byPath.get('Home.md')!;
const homeHtml = render(home);
console.log('\n--- Home.md ---');
console.log(homeHtml.slice(0, 1200));

const synth = `
> [!warning] Atenção
> texto do callout com [[Home|casa]], [[Sprints.base]] e [[link-que-nao-existe]]

![[2026-10-28-Apresentacao.pptx|deck da sprint]]
![[imagem-que-nao-existe.png]]
[[v9.pptx]]
`;
console.log('\n--- sintaxe Obsidian (callout + embeds) ---');
console.log(render({ raw: synth, body: synth, frontmatter: {} }));

console.log('\nbacklinks de Convencoes.md:', (backlinks.get('99-Meta/Convencoes.md') ?? []).map((n) => n.path));
console.log('frontmatter de Inbox.md:', byPath.get('00-Inbox/Inbox.md')?.frontmatter);

/* --- auditoria: todos os wikilinks/embeds do vault ---
   code fences e inlineCode são ignorados: texto dentro de código não é link. */
const LINK_RE = /(!)?\[\[([^\]\|]+?)(?:\|[^\]]*)?\]\]/g;
const broken: string[] = [];
const danglingEmbeds: string[] = [];
for (const n of notes) {
  const prose = stripCode(n.body);
  for (const m of prose.matchAll(LINK_RE)) {
    const embed = m[1] === '!';
    const target = m[2].split('#')[0].split('|')[0].trim();
    const url = resolveTarget(target);
    if (!url) {
      broken.push(`${embed ? '!' : ''}[[${target}]]  <-  ${n.path}`);
      if (embed) danglingEmbeds.push(`${n.path} -> ${target}`);
    }
  }
}
console.log('\nlinks/embeds quebrados no vault:', broken.length);
console.log(broken.slice(0, 25).join('\n'));
console.log('embeds de anexos resolvidos:', notes.reduce((acc, n) => acc + embeddedAttachments(n.body).filter((e) => e.url && !/\.(md|base)$/.test(e.url)).length, 0));

#!/usr/bin/env node
/**
 * browser-smoke.mjs — rendera o bundle de produção dentro de um DOM headless
 * (jsdom), exatamente como um browser faria, e reporta o que aparece na tela.
 *
 * Serve para separar duas causas de "página em branco":
 *   1. erro de inicialização/ordem em src/vault.ts  -> aqui aparece stack trace
 *   2. problema de CSS/servidor (nginx, publicDir)  -> aqui o DOM vem populado
 *
 * Uso:
 *   npm run build
 *   npm run browser-smoke            # usa dist/ + http://localhost:5173
 *   BASE=http://localhost:5174 npm run browser-smoke
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const BASE = process.env.BASE || 'http://localhost:5173';
const HASH = process.env.HASH || '';
const WAIT = Number(process.env.WAIT || 1200);
// jsdom não tem viewport real: fixamos um para poder testar o modo gaveta.
// VIEWPORT=420 npm run browser-smoke  -> simula um celular de 420px
const VIEWPORT = Number(process.env.VIEWPORT || 1024);
const MOBILE = VIEWPORT <= 760;

const dist = path.resolve('dist');
if (!fs.existsSync(dist)) {
  console.error('dist/ não existe — rode `npm run build` primeiro.');
  process.exit(1);
}

const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
const jsdomErrors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (err) => jsdomErrors.push(`jsdom: ${err.message}`));
vc.on('error', (msg) => jsdomErrors.push(`console.error: ${msg}`));
const dom = new JSDOM(html, {
  url: `${BASE}/#${HASH}`,
  pretendToBeVisual: true,
  runScripts: 'outside-only',
  virtualConsole: vc,
});
const win = dom.window;

// O bundle usa `document`/`window` globais; jsdom não os expõe dentro de Node.
globalThis.window = win;
globalThis.document = win.document;
globalThis.navigator = win.navigator;
// jsdom não implementa MutationObserver (usado pelo polyfill de modulepreload do Vite)
if (!globalThis.MutationObserver) {
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
}

// matchMedia: jsdom não tem viewport, então devolvemos o resultado do VIEWPORT
// escolhido. Precisa estar antes do mount, porque App.tsx decide "gaveta ou
// rail" na primeira renderização.
const matchMedia = (query) => {
  const m = /\(max-width:\s*(\d+)px\)/.exec(query);
  const matches = m ? VIEWPORT <= Number(m[1]) : false;
  return { matches, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} };
};
win.matchMedia = matchMedia;
globalThis.matchMedia = matchMedia;

// fetch do Node não aceita URL relativa; encaminha /api/* para o servidor.
const nativeFetch = globalThis.fetch;
globalThis.fetch = (url, init) =>
  nativeFetch(/^https?:\/\//.test(String(url)) ? url : BASE + String(url), init);

win.addEventListener('error', (e) => jsdomErrors.push(`window error: ${e.message}`));

const assets = fs.readdirSync(path.join(dist, 'assets'));
const bundle = assets.find((f) => f.endsWith('.js'));
const css = assets.find((f) => f.endsWith('.css'));
if (!bundle) {
  console.error('Nenhum JS em dist/assets — build incompleto.');
  process.exit(1);
}

// CSS quebrado também "embranca" a página num browser real: valida balanceamento.
if (css) {
  const cssText = fs.readFileSync(path.join(dist, 'assets', css), 'utf8');
  const open = (cssText.match(/\{/g) || []).length;
  const close = (cssText.match(/\}/g) || []).length;
  console.log(`css: ${css} (${cssText.length} chars, ${open} regras abertas, ${close} fechadas)`);
  if (open !== close) console.warn(`AVISO: CSS desbalanceado — { ${open} vs } ${close}`);

  // layout esperado: explorer e props são rails roláveis (height:100% do grid
  // area, cabeçalho sticky); doc é uma coluna flex travada no viewport com
  // .topbar fixa e .main rolável. O CSS vem minificado em dist, então
  // procuramos selector -> corpo de regra (whitespace removido)
  const bodies = new Map();
  for (const m of cssText.matchAll(/([^\{}]+)\{([^{}]*)\}/g)) {
    const dec = m[2].replace(/\s+/g, '');
    // uma regra pode ter vários selectores ("a.sidebar,a.panel"): indexa cada um
    for (const raw of m[1].split(',')) {
      const key = raw.trim().replace(/\s+/g, '').replace(/^[+>~]/, '');
      if (!key) continue;
      if (!bodies.has(key)) bodies.set(key, []);
      bodies.get(key).push(dec);
    }
  }
  const layout = {
    '.app': ['height:100vh', 'height:100dvh', 'overflow:hidden', 'grid-template-rows:minmax(0,1fr)', 'grid-template-areas:"explorerdocprops"'],
    '.sidebar': ['grid-area:explorer', 'height:100%', 'overflow-y:auto', 'overscroll-behavior:contain'],
    '.sidebar-head': ['position:sticky', 'top:0'],
    '.content': ['grid-area:doc', 'height:100vh', 'height:100dvh', 'min-height:0', 'display:flex', 'flex-direction:column'],
    '.topbar': ['position:sticky', 'top:0', 'flex:00auto'],
    '.main': ['flex:11auto', 'min-height:0', 'overflow-y:auto', 'overscroll-behavior:contain'],
    '.panel': ['grid-area:props', 'height:100%', 'overflow-y:auto', 'overscroll-behavior:contain'],
    '.panel-head': ['position:sticky', 'top:0'],
  };
  const layoutFail = [];
  for (const [sel, props] of Object.entries(layout)) {
    const list = bodies.get(sel) ?? [];
    for (const p of props) if (!list.some((b) => b.includes(p))) layoutFail.push(`${sel} { ${p} }`);
  }
  // regressão histórica 1: min-height:100vh em .app fazia a linha do grid crescer
  // com o conteúdo e a página inteira rolava junto
  for (const b of bodies.get('.app') ?? []) {
    if (b.includes('min-height:100vh')) layoutFail.push('.app NÃO pode ter min-height:100vh');
  }
  // regressão histórica 2: as rails do explorador/propriedades não podem usar
  // height:100vh — nos breakpoints 1100px/760px o grid empilha e 100vh
  // estouraria a altura da linha (conteúdo cortado por .app overflow:hidden)
  for (const sel of ['.sidebar', '.panel']) {
    if ((bodies.get(sel) ?? []).some((b) => b.includes('height:100vh'))) {
      layoutFail.push(`${sel} deve usar height:100%, não height:100vh`);
    }
  }
  // .content pode travar no viewport (100vh/100dvh) só enquanto a linha do doc
  // é o viewport inteiro; precisa de override height:100% nos breakpoints
  if (!(bodies.get('.content') ?? []).some((b) => b.includes('height:100%'))) {
    layoutFail.push('.content precisa de override height:100% nos breakpoints (1100/760px)');
  }
  // regressão histórica 3: scroll aninhado (rail + corpo) gera duas barras e
  // conteúdo unreachable; o scroll vive na rail ou em .main
  for (const sel of ['.sidebar-body', '.panel-inner']) {
    if ((bodies.get(sel) ?? []).some((b) => b.includes('overflow-y:auto'))) {
      layoutFail.push(`${sel} não deve rolar (o scroll é da rail)`);
    }
  }
  // gavetas mobile (breakpoint 760px): cinco regras obrigatórias.
  // Se alguma falta, a "gaveta" vira faixa e o documento perde tela no celular
  const drawerSpec = [
    ['.app', 'grid-template-areas:"doc"'],
    ['.sidebar', 'position:fixed'],
    ['.panel', 'position:fixed'],
    ['.drawer-backdrop', 'display:block'],
    ['.drawer-toggle', 'width:34px'],
  ];
  const missingDrawer = drawerSpec.filter(([sel, prop]) =>
    !(bodies.get(sel) ?? []).some((b) => b.includes(prop))
  );
  console.log(`drawer rules: ${drawerSpec.length - missingDrawer.length}/5 -> drawer css ok=${missingDrawer.length === 0}`);
  if (missingDrawer.length) layoutFail.push('gaveta: ' + missingDrawer.map(([s, p]) => `${s}{${p}}`).join(', '));
  console.log(`layout fixo: rails roláveis + doc flex (topbar fixa, .main rolável)=${layoutFail.length === 0}`);
  if (layoutFail.length) {
    console.error('FAIL: regras de layout ausentes -> ' + layoutFail.join(', '));
    process.exit(1);
  }
}

try {
  await import(pathToFileURL(path.join(dist, 'assets', bundle)).href);
} catch (err) {
  console.error(`FAIL mount: ${err.stack}`);
  process.exit(1);
}

// useEffects (health + snapshot) são assíncronos: espera o reload chegar.
await new Promise((r) => setTimeout(r, WAIT));

/* no celular as gavetas nascem fechadas: abrir ☰ antes de auditar a árvore,
   senão "sidebar sem pastas" seria um falso FAIL */
if (MOBILE) {
  const drawerBtn = win.document.querySelector('.drawer-toggle[aria-label="Explorador"]');
  if (!drawerBtn) {
    console.error('FAIL: modo mobile sem botão de gaveta ☰ na topbar.');
    process.exit(1);
  }
  drawerBtn.click();
  await new Promise((r) => setTimeout(r, 150));
  console.log('modo mobile: gaveta ☰ aberta para auditar o explorador');
}

const root = win.document.getElementById('root');
const text = (root?.textContent || '').replace(/\s+/g, ' ').trim();
const count = (sel) => win.document.querySelectorAll(sel).length;

console.log(`bundle: ${bundle} | css: ${css ?? 'nenhum'} | base: ${BASE} | hash: ${HASH || '(raiz)'}`);
console.log(`#root children: ${root ? root.children.length : 0}`);
console.log(
  `sidebar=${count('.sidebar')} pastas=${count('.folder-row')} notas=${count('.file-row')}` +
  ` editor=${count('.editor')} markdown=${count('.markdown')} topbar=${count('.topbar')}` +
  ` panel=${count('.panel')} backlinks=${count('.backlinks li')} props=${count('.prop')}` +
  ` tags=${count('.tag')}`
);
console.log(`texto (${text.length} chars): ${text.slice(0, 320)}`);

/* árvore invertida: todas as pastas nascem FECHADAS; só os ancestrais da
   nota aberta (currentPath) são renderados expandidos. */
const folderLabels = [...win.document.querySelectorAll('.folder-label')];
const segs = HASH.split('/').filter(Boolean);
const expectedOpen = new Set();
for (let i = 1; i < segs.length; i++) expectedOpen.add(segs.slice(0, i).join('/'));
const openFolders = folderLabels.filter((b) => b.getAttribute('aria-expanded') === 'true');
console.log(`árvore: pastas renderadas=${folderLabels.length} abertas=${openFolders.length} (esperado ${expectedOpen.size})`);
if (folderLabels.length === 0) {
  console.error('FAIL: explorador montado sem nenhuma pasta.');
  process.exit(1);
}
if (openFolders.length !== expectedOpen.size) {
  console.error(`FAIL: expansão padrão incorreta — abertas=${openFolders.length}, ancestrais da nota=${expectedOpen.size}`);
  process.exit(1);
}
const closedLabel = folderLabels.find((b) => b.getAttribute('aria-expanded') === 'false');
if (!closedLabel) {
  console.error('FAIL: nenhuma pasta fechada — padrão de "tudo fechado" não aplicado.');
  process.exit(1);
}
const nodesBefore = count('.folder-row') + count('.file-row');
closedLabel.click();
await new Promise((r) => setTimeout(r, 150));
const nodesOpen = count('.folder-row') + count('.file-row');
closedLabel.click();
await new Promise((r) => setTimeout(r, 150));
const nodesClosed = count('.folder-row') + count('.file-row');
console.log(`toggle de pasta: ${nodesBefore} -> ${nodesOpen} -> ${nodesClosed} nós da árvore`);
if (nodesOpen <= nodesBefore || nodesClosed !== nodesBefore) {
  console.error('FAIL: clique na pasta não expandiu/colapsou a subárvore.');
  process.exit(1);
}

/* navegar para uma nota de subpasta deve reabrir só os ancestrais dela */
const NEXT = '01-Agenda/Diario/2026-10-22.md';
if (HASH !== NEXT) {
  win.location.hash = `/${NEXT}`;
  await new Promise((r) => setTimeout(r, 250));
  /* no celular navegar fecha as gavetas (App.tsx: useEffect em location.pathname).
     Regra a auditar: fecha mesmo. Reabrir ☰ para poder ver a árvore. */
  if (MOBILE) {
    const closedAfterNav = win.document.querySelector('.drawer-toggle')?.getAttribute('aria-expanded');
    console.log(`navegar no celular fechou a gaveta: aria-expanded=${closedAfterNav} (esperado false)`);
    if (closedAfterNav !== 'false') {
      console.error('FAIL: navegar não fechou as gavetas no modo mobile.');
      process.exit(1);
    }
    win.document.querySelector('.drawer-toggle[aria-label="Explorador"]')?.click();
    await new Promise((r) => setTimeout(r, 150));
  }
  const expectedAfter = NEXT.split('/').length - 1;
  const openAfterNav = [...win.document.querySelectorAll('.folder-label')]
    .filter((b) => b.getAttribute('aria-expanded') === 'true').length;
  const activeVisible = !!win.document.querySelector('.file-active');
  console.log(`navegação -> ${NEXT}: nota ativa na árvore=${activeVisible}, abertas=${openAfterNav} (esperado ${expectedAfter})`);
  if (!activeVisible || openAfterNav !== expectedAfter) {
    console.error('FAIL: ancestrais da nota navegada não reabriram automaticamente.');
    process.exit(1);
  }
}

/* helpers de tempo/teclado: usados pelos testes de rail (desktop) e pelo
   teste das gavetas (mobile), por isso vivem fora dos blocos condicionais */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = (k) => win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: k }));

/* painéis retráteis (desktop): clicar nos botões ◀ ▶ deve colapsar e expandir.
   No celular as rails não existem — o teste é o das gavetas, mais abaixo */
if (!MOBILE) {
const appEl = win.document.querySelector('.app');
const toggles = [...win.document.querySelectorAll('.rail-toggle')];
console.log(`rails: app="${appEl?.className}" botões=${toggles.length}`);
if (toggles.length !== 2) {
  console.error('FAIL: esperava 2 botões de retracção (sidebar + panel).');
  process.exit(1);
}
for (const t of toggles) t.click();
await new Promise((r) => setTimeout(r, 150));
const collapsed = win.document.querySelector('.app')?.className || '';
const railOk = collapsed.includes('sidebar-collapsed') && collapsed.includes('panel-collapsed')
  && win.document.querySelectorAll('.sidebar-body').length === 0
  && win.document.querySelectorAll('.panel-inner').length === 0;
console.log(`rails após retrair: app="${collapsed}" conteúdo oculto=${railOk}`);
if (!railOk) {
  console.error('FAIL: retracção não colapsou os painéis.');
  process.exit(1);
}
for (const t of toggles) t.click();
await new Promise((r) => setTimeout(r, 150));
const expanded = win.document.querySelector('.app')?.className || '';
const backOk = !expanded.includes('collapsed')
  && win.document.querySelectorAll('.sidebar-body').length === 1;
console.log(`rails após expandir: app="${expanded}" conteúdo visível=${backOk}`);
if (!backOk) {
  console.error('FAIL: expansão não restaurou os painéis.');
  process.exit(1);
}

/* atalhos de teclado: [ explorador, ] propriedades (key/sleep definidos acima) */
key('[');
await new Promise((r) => setTimeout(r, 150));
const kbLeft = win.document.querySelector('.app')?.className || '';
console.log(`atalho [: app="${kbLeft}"`);
if (!kbLeft.includes('sidebar-collapsed')) {
  console.error('FAIL: atalho [ não retraiu o explorador.');
  process.exit(1);
}
key(']');
await new Promise((r) => setTimeout(r, 150));
const kbBoth = win.document.querySelector('.app')?.className || '';
console.log(`atalho ]: app="${kbBoth}"`);
if (!kbBoth.includes('panel-collapsed')) {
  console.error('FAIL: atalho ] não retraiu as propriedades.');
  process.exit(1);
}
key('[');
key(']');
await new Promise((r) => setTimeout(r, 150));
console.log(`rails restaurados: app="${win.document.querySelector('.app')?.className}"`);
}

/* gavetas no celular: botões ☰/ⓘ na topbar, backdrop escuro e aria-expanded.
   VIEWPORT<=760 ativa o modo gaveta (matchMedia é simulado acima) */
console.log(`viewport simulado: ${VIEWPORT}px -> modo gaveta=${MOBILE}`);
if (MOBILE) {
  const appCls = win.document.querySelector('.app')?.className || '';
  const drawerActions = win.document.querySelector('.drawer-actions');
  if (!drawerActions) {
    console.error('FAIL: topbar sem .drawer-actions no viewport mobile.');
    process.exit(1);
  }
  console.log(`mobile detectado: app="${appCls}" drawer-actions presente=${!!drawerActions}`);
  const drawerBtns = [...win.document.querySelectorAll('.drawer-toggle')];
  if (drawerBtns.length !== 2) {
    console.error(`FAIL: drawer-toggle=${drawerBtns.length} (esperado 2: ☰ e ⓘ).`);
    process.exit(1);
  }
  const leftBtn = drawerBtns.find((b) => b.getAttribute('aria-label') === 'Explorador');
  const rightBtn = drawerBtns.find((b) => b.getAttribute('aria-label') === 'Propriedades');
  const state = () => `☰=${leftBtn.getAttribute('aria-expanded')} ⓘ=${rightBtn.getAttribute('aria-expanded')} backdrop=${win.document.querySelectorAll('.drawer-backdrop').length}`;
  // a auditoria da árvore abriu ☰ antes; fechar tudo para testar o ciclo completo
  const bd0 = win.document.querySelector('.drawer-backdrop');
  if (bd0) bd0.click();
  await sleep(150);
  console.log(`gavetas após fechar: ${state()}`);
  if (leftBtn.getAttribute('aria-expanded') !== 'false' || win.document.querySelectorAll('.drawer-backdrop').length !== 0) {
    console.error('FAIL: no celular as gavetas deveriam nascer fechadas e sem backdrop.');
    process.exit(1);
  }

  leftBtn.click();
  await sleep(150);
  const openOk = leftBtn.getAttribute('aria-expanded') === 'true'
    && !win.document.querySelector('.sidebar').classList.contains('is-collapsed')
    && win.document.querySelectorAll('.drawer-backdrop').length === 1;
  console.log(`gaveta ☰ aberta: ${state()} gaveta dentro da tela=${openOk}`);
  if (!openOk) {
    console.error('FAIL: botão ☰ não abriu a gaveta (aria-expanded/backdrop fora de sync).');
    process.exit(1);
  }

  rightBtn.click();
  await sleep(150);
  console.log(`gaveta ⓘ aberta: ${state()}`);

  win.document.querySelector('.drawer-backdrop').click();
  await sleep(150);
  const closedOk = leftBtn.getAttribute('aria-expanded') === 'false'
    && rightBtn.getAttribute('aria-expanded') === 'false'
    && win.document.querySelectorAll('.drawer-backdrop').length === 0
    && win.document.querySelector('.sidebar').classList.contains('is-collapsed')
    && win.document.querySelector('.panel').classList.contains('is-collapsed');
  console.log(`backdrop fechou as duas gavetas: ${state()} ok=${closedOk}`);
  if (!closedOk) {
    console.error('FAIL: tocar no backdrop não fechou as gavetas.');
    process.exit(1);
  }

  key('[');
  await sleep(150);
  console.log(`atalho [ no celular abre a gaveta: ${state()}`);
  if (leftBtn.getAttribute('aria-expanded') !== 'true') {
    console.error('FAIL: atalho [ não abriu a gaveta no celular.');
    process.exit(1);
  }
  key('Escape');
  await sleep(150);
  console.log(`Esc fecha a gaveta: ${state()}`);
  if (leftBtn.getAttribute('aria-expanded') !== 'false') {
    console.error('FAIL: Escape não fechou a gaveta aberta no celular.');
    process.exit(1);
  }
}

if (!root || root.children.length === 0) {
  console.error('FAIL: #root vazio — app não montou.');
  if (jsdomErrors.length) console.error('ERROS:', jsdomErrors.join('\n'));
  process.exit(1);
}
if (count('.file-row') === 0 && count('.markdown') === 0) {
  console.error('FAIL: app montou, mas nenhuma nota apareceu — reloadVault() não populou.');
  if (jsdomErrors.length) console.error('ERROS:', jsdomErrors.join('\n'));
  process.exit(1);
}
if (jsdomErrors.length) {
  console.error('WARN: erros capturados durante a execução:');
  for (const e of jsdomErrors) console.error('  - ' + e);
  process.exit(1);
}
console.log('OK: app renderizado headless, sidebar e editor populados.');
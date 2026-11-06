/**
 * SSR smoke test (sem browser): carrega vault.ts e os componentes via Vite SSR
 * e renderiza cada um para string. Serve para isolar erros de inicialização/
 * render (página em branco) de problemas de DOM/CSS do navegador.
 * Rodar: npm run ssr-smoke
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const React = require('react');
const { renderToString } = require('react-dom/server');
const { MemoryRouter } = require('react-router-dom');

const server = await createServer({
  root: path.resolve(import.meta.dirname, '..'),
  server: { middlewareMode: true },
  logLevel: 'error',
});

const vault = await server.ssrLoadModule('/src/vault.ts');
const Sidebar = (await server.ssrLoadModule('/src/components/Sidebar.tsx')).default;
const NoteView = (await server.ssrLoadModule('/src/components/NoteView.tsx')).default;
const Properties = (await server.ssrLoadModule('/src/components/Properties.tsx')).default;
const SearchBox = (await server.ssrLoadModule('/src/components/SearchBox.tsx')).default;

console.log('notes:', vault.notes.length, '| pastas na raiz:', vault.tree.children.size, '| backlinks:', vault.backlinks.size, '| tags:', vault.allTags.size);

const note = vault.notes.find((n) => n.path === 'Home.md') ?? vault.notes[0];
console.log('nota inicial:', note?.path);

// sem VAULT_ROOT/bucket acessível o vault vem vazio: as checagens que dependem
// de nota não têm o que renderizar (não é bug do front, é falta de dado)
const vaultVazio = vault.notes.length === 0;
if (vaultVazio) console.log('AVISO: vault vazio — checagens de nota serão puladas');

let failures = 0;
for (const [name, comp, props] of [
  ['Sidebar', Sidebar, { tree: vault.tree, currentPath: note?.path ?? '', writable: false, reload: vault.reloadVault }],
  ['NoteView', NoteView, { note }],
  ['Properties', Properties, { note }],
  ['SearchBox', SearchBox, {}],
]) {
  try {
    const html = renderToString(React.createElement(MemoryRouter, null, React.createElement(comp, props)));
    if (!html && vaultVazio) {
      console.log('SKIP', name, '(vault vazio)');
      continue;
    }
    console.log('OK  ', name, '->', html.length, 'chars');
    if (!html) {
      console.log('FAIL', name, 'renderizou vazio');
      failures++;
    }
  } catch (e) {
    console.log('FAIL', name, e.message);
    failures++;
  }
}

/* App inteiro usa HashRouter, que exige um `window`/`document` mínimo fora do browser */
const stubDocument = {
  addEventListener: () => {},
  removeEventListener: () => {},
  getElementById: () => null,
  querySelector: () => null,
  body: {},
};
const stubWindow = {
  location: {
    href: `http://localhost:5173/#/${encodeURIComponent(note?.path ?? '')}`,
    origin: 'http://localhost:5173',
    hash: `#/${encodeURIComponent(note?.path ?? '')}`,
  },
  history: { state: {}, replaceState: () => {}, pushState: () => {} },
  addEventListener: () => {},
  removeEventListener: () => {},
  document: stubDocument,
};
stubDocument.defaultView = stubWindow;
globalThis.window = stubWindow;
globalThis.document = stubDocument;
/* App.tsx lê abas/contexto do localStorage já no estado inicial (useState(() => …)):
 * sem isto o render do App explode com "localStorage is not defined" */
const memoryStore = new Map();
globalThis.localStorage = {
  getItem: (k) => (memoryStore.has(k) ? memoryStore.get(k) : null),
  setItem: (k, v) => memoryStore.set(k, String(v)),
  removeItem: (k) => memoryStore.delete(k),
  clear: () => memoryStore.clear(),
};
const App = (await server.ssrLoadModule('/src/App.tsx')).default;

try {
  const html = renderToString(React.createElement(App));
  const hasSidebar = html.includes('class="sidebar"');
  const hasNote = html.includes('class="note"') || html.includes('class="note-body"');
  const hasFiles = html.includes('class="file"');
  console.log('OK   App ->', html.length, 'chars | sidebar:', hasSidebar, '| arquivos na sidebar:', hasFiles, '| nota:', hasNote);
  if (!hasSidebar || (!hasFiles && !vaultVazio)) {
    console.log('FAIL App renderou sem sidebar/arquivos');
    console.log(html.slice(0, 400));
    failures++;
  }
} catch (e) {
  console.log('FAIL App', e.message);
  console.log((e.stack || '').split('\n').slice(1, 6).join('\n'));
  failures++;
}

await server.close();
process.exit(failures ? 1 : 0);

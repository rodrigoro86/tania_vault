import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { HashRouter, Routes, Route, Link, Navigate, useLocation, useParams } from 'react-router-dom';
import { notes, byPath, tree, allTags, resolveTarget, reloadVault, subscribeVault, vaultWritable, type Note } from './vault';
import Sidebar from './components/Sidebar';
import NoteView from './components/NoteView';
import { FilePage } from './components/Media';
import ToolFrame from './components/ToolFrame';
import UsersPage from './components/Users';
import ResizeHandle from './components/ResizeHandle';
import SettingsPage from './components/Settings';
import ToolsPage from './components/ToolsPage';
import TokensPage from './components/Tokens';
import AgentsPage from './components/Agents';
import Properties from './components/Properties';
import Terminal from './components/Terminal';
import SearchBox, { SearchPage } from './components/SearchBox';

function encode(path: string): string {
  return path.split('/').map((p) => encodeURIComponent(p)).join('/');
}

/** estado dos painéis retráteis, persistido (SSR não tem localStorage) */
function readRail(key: string): boolean {
  try {
    return globalThis.localStorage?.getItem(key) !== 'closed';
  } catch {
    return true;
  }
}
/** largura ajustada pelo usuário (px); null = padrão do CSS */
function readWidth(key: string): number | null {
  try {
    const n = Number(globalThis.localStorage?.getItem(key));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}
function writeWidth(key: string, w: number | null): void {
  try {
    if (w === null) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, String(w));
  } catch {
    /* storage indisponível: só perde a persistência */
  }
}
const LEFT_DEFAULT = 260;
const RIGHT_DEFAULT = 300;

function writeRail(key: string, open: boolean): void {
  try {
    globalThis.localStorage?.setItem(key, open ? 'open' : 'closed');
  } catch {
    /* storage indisponível (privado/SSR): só perde a persistência */
  }
}

/** mobile = viewport <=760px, o mesmo breakpoint das gavetas no CSS.
 *  matchMedia não existe em SSR (ssr-smoke): devolve false = layout desktop. */
function isMobileViewport(): boolean {
  try {
    return !!globalThis.matchMedia?.('(max-width: 760px)').matches;
  } catch {
    return false;
  }
}

function findNote(raw: string): Note | null {
  if (!raw) return byPath.get('Home.md') ?? notes[0] ?? null;
  const decoded = decodeURIComponent(raw);
  const direct = byPath.get(decoded);
  if (direct) return direct;
  const target = resolveTarget(decoded);
  return target ? byPath.get(target) ?? null : null;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** nome da página de índice no breadcrumb (as rotas que não são notas) */
function indexLabel(rawPath: string, filePath: string): string {
  if (rawPath.startsWith('tag/')) return `#${safeDecode(rawPath.slice(4))}`;
  if (rawPath.startsWith('tarefas')) return 'Tarefas';
  if (rawPath.startsWith('painel')) return 'Painel ClickUp';
  if (rawPath.startsWith('usuarios')) return 'Usuários';
  if (rawPath.startsWith('configuracoes')) return 'Configurações';
  if (rawPath.startsWith('agentes')) return 'Agents';
  if (filePath) return filePath.split('/').pop() ?? filePath;
  return 'Busca';
}

function Layout() {
  // qualquer mutation (create/edit/delete) dispara um rebuild -> re-render
  const [, setVaultVersion] = useState(0);
  useEffect(() => subscribeVault(() => setVaultVersion((v) => v + 1)), []);

  const location = useLocation();
  const rawPath = location.pathname.replace(/^\//, '');
  // /tag/x e /busca/x não são notas: sem esta guarda, findNote('tag/x')
  // resolve para uma nota chamada "x" e o breadcrumb mostra a nota errada
  const isIndexRoute = /^(tag|busca|arquivo|tarefas|painel|t|tools-admin|tokens|usuarios|configuracoes|agentes)(\/|$)/.test(rawPath);
  const filePath = rawPath.startsWith('arquivo/') ? safeDecode(rawPath.slice('arquivo/'.length)) : '';
  const note = isIndexRoute ? null : findNote(rawPath);

  // painéis retráteis: no desktop o aberto/fechado é persistido entre sessões;
  // no celular as gavetas começam fechadas e NÃO são gravadas — senão o estado
  // salvo no desktop vazaria para o mobile (problema 6 do diagnóstico)
  const mobile = useMemo(isMobileViewport, []);
  const [leftOpen, setLeftOpen] = useState(() => (mobile ? false : readRail('ui.sidebar')));
  const [rightOpen, setRightOpen] = useState(() => (mobile ? false : readRail('ui.panel')));
  // larguras arrastáveis (só desktop); null = padrão do CSS (o terminal tem o seu, mais largo)
  const [leftW, setLeftW] = useState(() => readWidth('ui.sidebarW'));
  const [rightW, setRightW] = useState(() => readWidth('ui.panelW'));
  const [resizing, setResizing] = useState(false);
  const changeLeftW = (w: number | null) => {
    setLeftW(w);
    writeWidth('ui.sidebarW', w);
  };
  const changeRightW = (w: number | null) => {
    setRightW(w);
    writeWidth('ui.panelW', w);
  };

  // qual gaveta foi mexida por último: necessário para devolver o foco ao botão
  const lastDrawer = useRef<'left' | 'right' | null>(null);
  const leftBtnRef = useRef<HTMLButtonElement>(null);
  const rightBtnRef = useRef<HTMLButtonElement>(null);

  function openDrawer(side: 'left' | 'right', open: boolean): void {
    if (side === 'left') {
      if (!mobile) writeRail('ui.sidebar', open);
      setLeftOpen(open);
    } else {
      if (!mobile) writeRail('ui.panel', open);
      setRightOpen(open);
    }
    lastDrawer.current = side;
  }

  const toggleLeft = () => openDrawer('left', !leftOpen);
  const toggleRight = () => openDrawer('right', !rightOpen);
  // painel da direita: Propriedades ou Terminal do agente (só com servidor de escrita)
  const [panelTab, setPanelTab] = useState<'props' | 'terminal'>(() =>
    localStorage.getItem('ui.panelTab') === 'terminal' ? 'terminal' : 'props',
  );
  const tab = vaultWritable ? panelTab : 'props';
  // nota em foco do terminal ("💬 Terminal" na nota); null = conversa geral
  const [agentContext, setAgentContext] = useState<string | null>(() => localStorage.getItem('agent.context'));
  const changeContext = (path: string | null) => {
    setAgentContext(path);
    if (path) localStorage.setItem('agent.context', path);
    else localStorage.removeItem('agent.context');
  };
  const openTerminalFor = (path: string) => {
    changeContext(path);
    chooseTab('terminal');
  };
  const chooseTab = (t: 'props' | 'terminal') => {
    setPanelTab(t);
    localStorage.setItem('ui.panelTab', t);
    if (!rightOpen) openDrawer('right', true);
  };
  const closeDrawers = () => {
    setLeftOpen(false);
    setRightOpen(false);
  };

  // atalhos: [ = explorador, ] = propriedades; Esc fecha a gaveta aberta no celular
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (e.key === 'Escape' && mobile) {
        closeDrawers();
        return;
      }
      if (e.key === '[') toggleLeft();
      else if (e.key === ']') toggleRight();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [leftOpen, rightOpen, mobile]);

  // navegar fecha as gavetas: senão a nota seguinte fica escondida atrás delas
  useEffect(() => {
    if (mobile) closeDrawers();
  }, [location.pathname, mobile]);

  // foco: ao abrir a gaveta ela recebe o foco (fecha com Esc, e o leitor de
  // tela entra nela); ao fechar, o foco volta ao botão que a abriu
  useEffect(() => {
    if (!mobile) return;
    const side = lastDrawer.current;
    if (!side) return;
    if (side === 'left') {
      if (leftOpen) (document.querySelector('.sidebar') as HTMLElement | null)?.focus();
      else leftBtnRef.current?.focus();
    } else {
      if (rightOpen) (document.querySelector('.panel') as HTMLElement | null)?.focus();
      else rightBtnRef.current?.focus();
    }
  }, [leftOpen, rightOpen, mobile]);

  // ao mudar de nota, apenas .main volta ao topo: os rails (explorador e
  // propriedades) conservam a própria posição de scroll, que é independente
  useEffect(() => {
    const rail = document.querySelector('.main') as HTMLElement | null;
    if (rail) rail.scrollTop = 0;
  }, [location.pathname]);

  return (
    <div
      className={`app${leftOpen ? '' : ' sidebar-collapsed'}${rightOpen ? '' : ' panel-collapsed'}${
        rightOpen && tab === 'terminal' ? ' panel-wide' : ''
      }${resizing ? ' resizing' : ''}`}
      // só o painel aberto recebe a largura do usuário: fechado é a rail de 44px do CSS
      style={
        {
          ...(leftOpen && leftW ? { '--sidebar-w': `${leftW}px` } : {}),
          ...(rightOpen && rightW ? { '--panel-w': `${rightW}px` } : {}),
        } as CSSProperties
      }
    >
      {!mobile && leftOpen && (
        <ResizeHandle
          side="left"
          width={leftW ?? LEFT_DEFAULT}
          other={rightOpen ? (rightW ?? RIGHT_DEFAULT) : 44}
          min={180}
          max={520}
          label="Largura do explorador"
          onChange={changeLeftW}
          onDragging={setResizing}
        />
      )}
      {!mobile && rightOpen && (
        <ResizeHandle
          side="right"
          width={rightW ?? (tab === 'terminal' ? Math.min(480, window.innerWidth * 0.4) : RIGHT_DEFAULT)}
          other={leftOpen ? (leftW ?? LEFT_DEFAULT) : 44}
          min={240}
          max={900}
          label="Largura do painel da direita"
          onChange={changeRightW}
          onDragging={setResizing}
        />
      )}
      <Sidebar
        tree={tree}
        currentPath={note?.path ?? filePath}
        writable={vaultWritable}
        reload={reloadVault}
        open={leftOpen}
        onToggle={toggleLeft}
      />

      <div className="content">
        <header className="topbar">
          <div className="breadcrumb">
            {isIndexRoute ? (
              <>
                <Link to="/">🏠 Home</Link>
                <span className="crumb crumb-name">{indexLabel(rawPath, filePath)}</span>
              </>
            ) : note ? (
              <>
                <Link to="/">🏠 Home</Link>
                {note.folder && <span className="crumb">/ {note.folder}</span>}
                <span className="crumb crumb-name">{note.name}</span>
                <span className="crumb crumb-ext">.{note.ext}</span>
              </>
            ) : (
              <span>Nota não encontrada</span>
            )}
          </div>

          {/* gavetas no celular: os botões só são montados no viewport mobile
             (no desktop as rails já têm o próprio ▶/◀ na cabeça) */}
          {mobile && (
            <div className="drawer-actions">
              <button
                ref={leftBtnRef}
                type="button"
                className="drawer-toggle"
                onClick={toggleLeft}
                aria-expanded={leftOpen}
                aria-label="Explorador"
                title="Explorador [">
                ☰
              </button>
              <button
                ref={rightBtnRef}
                type="button"
                className="drawer-toggle"
                onClick={toggleRight}
                aria-expanded={rightOpen}
                aria-label="Propriedades"
                title="Propriedades ]">
                ⓘ
              </button>
            </div>
          )}

          <SearchBox />
          <span className="count" title={`front v${__APP_VERSION__}`}>{notes.length} notas</span>
        </header>

        <main className="main">
          <Routes>
            <Route path="/" element={<NoteView key={note?.path ?? 'none'} note={note} onTerminal={vaultWritable ? openTerminalFor : undefined} />} />
            <Route path="/tag/:tag" element={<TagPage />} />
            <Route path="/busca/:q" element={<SearchPage />} />
            <Route path="/arquivo/*" element={<FilePage key={filePath} path={filePath} />} />
            <Route path="/t/:id/:pagina" element={<ToolFrame />} />
            <Route path="/tarefas" element={<Navigate to="/t/clickup/tarefas" replace />} />
            <Route path="/painel" element={<Navigate to="/t/clickup/painel" replace />} />
            <Route path="/usuarios" element={<UsersPage />} />
            <Route path="/configuracoes" element={<SettingsPage />} />
            <Route path="/tools-admin" element={<ToolsPage />} />
            <Route path="/tokens" element={<TokensPage />} />
            <Route path="/agentes" element={<AgentsPage />} />
            <Route path="*" element={<NoteView key={note?.path ?? 'none'} note={note} onTerminal={vaultWritable ? openTerminalFor : undefined} />} />
          </Routes>
        </main>
        {/* rodapé fixo: estado de escrita + sair | versão, commit e data do build (vite.config.ts) */}
        <footer className="statusbar">
          <span className="statusbar-state">
            {vaultWritable ? (
              <>
                <span className="statusbar-long">escrita ativa · </span>
                <a href="/logout">sair</a>
              </>
            ) : (
              'somente leitura · sem servidor de escrita'
            )}
          </span>
          <span title={`build ${__APP_COMMIT__} de ${__APP_BUILT__}`}>Vault v{__APP_VERSION__}</span>
          <span className="statusbar-build">
            {__APP_COMMIT__} · {__APP_BUILT__}
          </span>
        </footer>
      </div>

      {/* fundo escuro atrás da gaveta aberta (só no celular): tocar nele fecha.
          Botão e não div por acessibilidade: é acionável por teclado/leitor de tela */}
      {mobile && (leftOpen || rightOpen) && (
        <button type="button" className="drawer-backdrop" aria-label="Fechar gavetas" onClick={closeDrawers} />
      )}

      <aside
        className={`panel${rightOpen ? '' : ' is-collapsed'}`}
        aria-label={tab === 'terminal' ? 'Terminal do agente' : 'Propriedades da nota'}
        tabIndex={-1}
      >
        <div className="panel-head">
          {vaultWritable ? (
            <div className="panel-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={tab === 'props'} className="panel-tab" onClick={() => chooseTab('props')}>
                Propriedades
              </button>
              <button type="button" role="tab" aria-selected={tab === 'terminal'} className="panel-tab" onClick={() => chooseTab('terminal')}>
                &gt;_ Terminal
              </button>
            </div>
          ) : (
            <span className="panel-title">Propriedades</span>
          )}
          <button
            type="button"
            className="rail-toggle"
            onClick={toggleRight}
            aria-expanded={rightOpen}
            aria-label={rightOpen ? 'Retrair propriedades' : 'Expandir propriedades'}
            title={`${rightOpen ? 'Retrair' : 'Expandir'} propriedades — ]`}
          >
            {rightOpen ? '▶' : '◀'}
          </button>
        </div>
        {rightOpen && tab === 'props' && (
          <div className="panel-inner">
            <Properties note={note} />
          </div>
        )}
        {/* montado sempre que aberto: trocar de aba não perde o que está rodando */}
        {rightOpen && vaultWritable && (
          <div className="panel-inner panel-terminal" hidden={tab !== 'terminal'}>
            <Terminal
              key={agentContext ?? 'geral'}
              reload={reloadVault}
              context={agentContext}
              contextType={String(byPath.get(agentContext ?? '')?.frontmatter.type ?? '')}
              onContextChange={changeContext}
            />
          </div>
        )}
      </aside>
    </div>
  );
}

function TagPage() {
  const { tag } = useParams();
  const list = useMemo(() => allTags.get(tag ?? '') ?? [], [tag]);
  return (
    <div className="tag-page">
      <h1>#{tag}</h1>
      <p className="muted">{list.length} nota(s) com esta tag</p>
      <ul className="result-list">
        {list.map((n) => (
          <li key={n.path}>
            <Link to={`/${encode(n.path)}`}>{n.title}</Link>
            <span className="muted">{n.path}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function App() {
  // relê o vault do disco: traz pastas vazias e detecta se existe servidor de escrita
  useEffect(() => {
    void reloadVault();
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        document.getElementById('vault-search')?.focus();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  return (
    <HashRouter>
      <Layout />
    </HashRouter>
  );
}

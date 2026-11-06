import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import type { TreeNode, VaultFile, FileKind } from '../vault';
import { vaultApi } from '../api';
import UserMenu from './UserMenu';
import Ribbon, { type LeftView } from './Ribbon';

function encode(path: string): string {
  return path.split('/').map((p) => encodeURIComponent(p)).join('/');
}

/** nome -> slug ASCII, como manda a regra do vault (AGENTS.md §3) */
export function slug(name: string): string {
  const clean = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return clean || 'nova-nota';
}

const TYPE_BY_FOLDER: Record<string, string> = {
  '00-Inbox': 'inbox',
  '01-Agenda': 'journal',
  '01-Diario': 'journal',
  '02-Comandos': 'command',
  '02-Estudos': 'learning',
  '03-Comandos': 'command',
  '04-Projetos': 'project',
  '05-Ideias': 'idea',
  '03-Aprendizados': 'learning',
  '04-Agentes': 'agent',
  '05-Templates': 'template',
  '06-Projetos': 'project',
  '07-Ideias': 'idea',
  '99-Meta': 'meta',
};

/** frontmatter inicial conforme AGENTS.md §2 */
function defaultContent(title: string, folder: string): string {
  const type = TYPE_BY_FOLDER[folder.split('/')[0]] ?? 'inbox';
  return [
    '---',
    `type: ${type}`,
    `created: ${new Date().toISOString().slice(0, 10)}`,
    'tags: []',
    'status: draft',
    '---',
    '',
    `# ${title}`,
    '',
  ].join('\n');
}

const FILE_ICON: Record<FileKind, string> = {
  image: '🖼',
  html: '🎞',
  pdf: '📄',
  office: '📎',
  text: '📃',
  video: '🎬',
  audio: '🎵',
};

/** anexo no explorador: abre a página de pré-visualização (#/arquivo/<caminho>) */
function FileRow({ file, currentPath }: { file: VaultFile; currentPath: string }) {
  return (
    <div className="file-row">
      <Link
        className={`file file-attachment${file.path === currentPath ? ' file-active' : ''}`}
        to={`/arquivo/${encode(file.path)}`}
        title={file.path}
      >
        <span className="file-icon" aria-hidden="true">{FILE_ICON[file.kind]}</span>
        {file.name}
      </Link>
    </div>
  );
}

function countDescendants(node: TreeNode): number {
  let total = 0;
  for (const child of node.children.values()) total += child.notes.length + countDescendants(child);
  return total;
}

/**
 * pastas ancestrais de uma nota (inclui a pasta que a contém):
 * "01-Agenda/Diario/2026-10-22.md" -> ["01-Agenda", "01-Agenda/Diario"]
 * nota na raiz ("Home.md") -> [] (nenhuma pasta precisa abrir)
 */
const TREE_KEY = 'ui.tree';

/** pastas abertas/fechadas salvas: [[caminho, aberta], …] */
function loadTree(): Map<string, boolean> {
  try {
    const raw = JSON.parse(localStorage.getItem(TREE_KEY) ?? '[]') as [string, boolean][];
    return new Map(raw.filter(([k, v]) => typeof k === 'string' && typeof v === 'boolean'));
  } catch {
    return new Map();
  }
}

function saveTree(map: Map<string, boolean>) {
  try {
    localStorage.setItem(TREE_KEY, JSON.stringify([...map]));
  } catch {
    /* sem localStorage (modo privado cheio): só não persiste */
  }
}

function ancestorsOf(path: string): string[] {
  const parts = path.split('/');
  const out: string[] = [];
  // i = 1..n-1: cada prefixo até a penúltima parte é uma pasta-mãe
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('/'));
  return out;
}

interface Actions {
  writable: boolean;
  createNote: (folder: string, name: string) => void;
  createFolder: (folder: string, name: string) => void;
  deleteFolder: (path: string) => void;
  deleteNote: (path: string) => void;
  /** abre o seletor de arquivos e envia para a pasta */
  uploadFiles: (folder: string) => void;
  /** arquivos soltos (arrastar do computador) em cima de uma pasta */
  dropFiles: (folder: string, files: File[]) => void;
  /** abre o menu de contexto (botão direito, toque longo ou "⋯") */
  openMenu: (e: MouseEvent, kind: MenuKind, path: string) => void;
}

type MenuKind = 'root' | 'folder' | 'note';
interface MenuState {
  kind: MenuKind;
  path: string;
  x: number;
  y: number;
  /** quem abriu: recebe o foco de volta no Esc */
  anchor: HTMLElement | null;
}

function menuItems(menu: MenuState, actions: Actions): { label: string; danger?: boolean; run: () => void }[] {
  if (menu.kind === 'note') return [{ label: 'Excluir nota', danger: true, run: () => actions.deleteNote(menu.path) }];
  const create = [
    { label: 'Nova nota aqui', run: () => actions.createNote(menu.path, '') },
    { label: 'Nova pasta aqui', run: () => actions.createFolder(menu.path, '') },
    { label: menu.kind === 'root' ? 'Enviar arquivo ou imagem… (vai para 00-Inbox)' : 'Enviar arquivo ou imagem…', run: () => actions.uploadFiles(menu.path) },
  ];
  if (menu.kind === 'root') return create;
  return [...create, { label: 'Excluir pasta', danger: true, run: () => actions.deleteFolder(menu.path) }];
}

/**
 * menu flutuante (mouse) ou folha inferior (toque, via CSS pointer: coarse).
 * Portal no body: no celular a .sidebar é gaveta com transform, que viraria
 * o containing block do position: fixed e deslocaria o menu.
 */
function ContextMenu({ menu, actions, onClose }: { menu: MenuState; actions: Actions; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // mantém o menu inteiro dentro da viewport
    const r = el.getBoundingClientRect();
    el.style.setProperty('--mx', `${Math.max(8, Math.min(menu.x, window.innerWidth - r.width - 8))}px`);
    el.style.setProperty('--my', `${Math.max(8, Math.min(menu.y, window.innerHeight - r.height - 8))}px`);
    el.querySelector('button')?.focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      onClose();
      menu.anchor?.focus();
    };
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onClose);
    // capture: rolar o explorador (não a janela) também fecha
    window.addEventListener('scroll', onClose, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('scroll', onClose, true);
    };
  }, [menu, onClose]);

  return createPortal(
    <>
      {/* clique fora cai aqui e é engolido: não navega nem abre a nota de baixo */}
      <div
        className="ctx-backdrop"
        aria-hidden="true"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        ref={ref}
        className="ctx-menu"
        aria-label={menu.path || 'raiz do vault'}
        style={{ '--mx': `${menu.x}px`, '--my': `${menu.y}px` } as CSSProperties}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div className="ctx-title">{menu.path || 'raiz do vault'}</div>
        {menuItems(menu, actions).map((item) => (
          <button
            key={item.label}
            type="button"
            className={`ctx-item${item.danger ? ' danger' : ''}`}
            onClick={() => {
              onClose();
              item.run();
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </>,
    document.body,
  );
}

/** "⋯" da linha: no mouse só aparece em hover/foco; no toque fica sempre visível */
function MoreButton({ kind, path, label, actions }: { kind: MenuKind; path: string; label: string; actions: Actions }) {
  return (
    <button
      type="button"
      className="row-more"
      aria-label={`Ações: ${label}`}
      aria-haspopup="menu"
      onClick={(e) => actions.openMenu(e, kind, path)}
    >
      ⋯
    </button>
  );
}

function FolderNode({
  node,
  currentPath,
  isOpen,
  toggle,
  actions,
}: {
  node: TreeNode;
  currentPath: string;
  /** fechado por padrão; só os ancestrais da nota aberta (ou um clique) abrem */
  isOpen: (path: string) => boolean;
  toggle: (path: string) => void;
  actions: Actions;
}) {
  const open = isOpen(node.path);
  const hasActive = currentPath.startsWith(node.path + '/');
  const [dropping, setDropping] = useState(false);

  return (
    <div className={`folder${hasActive ? ' folder-active' : ''}`}>
      <div
        className={`folder-row${dropping ? ' folder-drop' : ''}`}
        onContextMenu={actions.writable ? (e) => actions.openMenu(e, 'folder', node.path) : undefined}
        onDragOver={(e) => {
          if (!actions.writable || !e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          setDropping(true);
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(e) => {
          setDropping(false);
          if (!actions.writable || !e.dataTransfer.files.length) return;
          e.preventDefault();
          actions.dropFiles(node.path, [...e.dataTransfer.files]);
        }}
      >
        <button
          type="button"
          className="folder-label"
          onClick={() => toggle(node.path)}
          aria-expanded={open}
        >
          <span className="folder-arrow">{open ? '▾' : '▸'}</span>
          <span className="folder-name">{node.name}</span>
          <span className="folder-count">{node.notes.length + countDescendants(node)}</span>
        </button>
        {actions.writable && <MoreButton kind="folder" path={node.path} label={node.name} actions={actions} />}
      </div>

      {open && (
        <>
          {[...node.children.values()].map((child) => (
            <FolderNode key={child.path} node={child} currentPath={currentPath} isOpen={isOpen} toggle={toggle} actions={actions} />
          ))}
          {node.notes.map((note) => (
            <div
              className="file-row"
              key={note.path}
              onContextMenu={actions.writable ? (e) => actions.openMenu(e, 'note', note.path) : undefined}
            >
              <Link
                className={`file${note.path === currentPath ? ' file-active' : ''}`}
                to={`/${encode(note.path)}`}
              >
                {note.name}
                {note.ext === 'base' && <span className="file-ext">.base</span>}
              </Link>
              {actions.writable && <MoreButton kind="note" path={note.path} label={note.name} actions={actions} />}
            </div>
          ))}
          {node.files.map((file) => (
            <FileRow key={file.path} file={file} currentPath={currentPath} />
          ))}
        </>
      )}
    </div>
  );
}
/**
 * 🤖 Agents: lista os provedores do agente (GET /api/agent/status) e troca o
 * ativo com POST /api/agent/config {active}. O link "Gerenciar agents" leva a
 * /agentes (a página cuida de quem pode editar).
 */
interface AgentProvider {
  name: string;
  model?: string | null;
  host?: string | null;
  hasKey?: boolean;
  active?: boolean;
}
interface AgentStatus {
  providers?: AgentProvider[];
  active?: string | null;
}

function AgentsPane() {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [flash, setFlash] = useState('');

  async function load() {
    try {
      const res = await fetch('/api/agent/status');
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setFlash(body?.error ?? 'Não deu para ler a configuração do agente.');
        setStatus(null);
        return;
      }
      setStatus((await res.json()) as AgentStatus);
    } catch (e) {
      setFlash((e as Error).message);
      setStatus(null);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function activate(name: string) {
    try {
      const res = await fetch('/api/agent/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: name }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setFlash(body?.error ?? `Não deu para ativar "${name}".`);
        return;
      }
      setFlash('');
      await load();
    } catch (e) {
      setFlash((e as Error).message);
    }
  }

  const providers = status?.providers ?? [];

  return (
    <div className="sidebar-body">
      {flash && <p className="flash" role="status" aria-live="polite">{flash}</p>}
      {providers.length === 0 && <p className="muted">Nenhum agente configurado.</p>}
      {providers.map((p) => {
        const active = p.name === status?.active;
        return (
          <button
            key={p.name}
            type="button"
            className={`sidebar-shortcut${active ? ' file-active' : ''}`}
            title={`${p.name} — ${p.model ?? 'sem modelo'}${p.hasKey ? '' : ' (sem chave)'}`}
            onClick={() => void activate(p.name)}
          >
            {active ? '● ' : ''}{p.name}
            <span className="muted">{p.model ?? 'sem modelo'}</span>
            {!p.hasKey && <span className="muted"> · sem chave</span>}
          </button>
        );
      })}
      {/* sempre visível: a página /agentes decide se mostra o formulário ou "sem permissão" */}
      <Link className="sidebar-shortcut" to="/agentes">⚙ Gerenciar agents</Link>
    </div>
  );
}

export default function Sidebar({
  tree,
  currentPath,
  writable,
  reload,
  open,
  onToggle,
}: {
  tree: TreeNode;
  currentPath: string;
  writable: boolean;
  reload: () => Promise<boolean>;
  open: boolean;
  onToggle: () => void;
}) {
  // TODAS as pastas nascem fechadas; `overrides` guarda o que o usuário abriu
  // ou fechou e é salvo no navegador (sobrevive a recarregar e ao PWA). Ao
  // abrir uma nota, as pastas do caminho dela ficam marcadas como abertas e
  // CONTINUAM abertas ao ir para outra nota: a árvore fica como você deixou.
  const ancestors = useMemo(() => new Set(ancestorsOf(currentPath)), [currentPath]);
  const [overrides, setOverrides] = useState<Map<string, boolean>>(() => loadTree());

  const isOpenIn = (map: Map<string, boolean>, path: string): boolean =>
    map.has(path) ? map.get(path) === true : ancestors.has(path);

  // navegou: o caminho da nota nova abre (e fica aberto); nada mais muda
  useEffect(() => {
    setOverrides((prev) => {
      if ([...ancestors].every((a) => prev.get(a) === true)) return prev;
      const next = new Map(prev);
      for (const a of ancestors) next.set(a, true);
      return next;
    });
  }, [ancestors]);

  useEffect(() => saveTree(overrides), [overrides]);

  // a lista é recriada quando o explorador abre (gaveta no celular): leva a
  // nota atual para a vista em vez de começar do topo
  useEffect(() => {
    if (!open || !currentPath) return;
    const id = requestAnimationFrame(() =>
      document.querySelector('.sidebar .file-active')?.scrollIntoView({ block: 'nearest' }),
    );
    return () => cancelAnimationFrame(id);
  }, [open, currentPath]);

  const isOpen = (path: string) => isOpenIn(overrides, path);
  const toggle = (path: string) =>
    setOverrides((prev) => {
      const next = new Map(prev);
      next.set(path, !isOpenIn(prev, path));
      return next;
    });
  const expand = (path: string) =>
    setOverrides((prev) => (prev.get(path) === true ? prev : new Map(prev).set(path, true)));
  const [form, setForm] = useState<{ kind: 'note' | 'folder'; folder: string; name: string } | null>(null);
  const [flash, setFlash] = useState('');
  const [menu, setMenu] = useState<MenuState | null>(null);
  // estável: o ContextMenu reinstala os listeners quando onClose muda
  const closeMenu = useMemo(() => () => setMenu(null), []);

  // vista do painel ao lado da faixa de ícones: salva no navegador (ui.leftView)
  const [view, setView] = useState<LeftView>(() => {
    try {
      const v = localStorage.getItem('ui.leftView');
      return v === 'clickup' || v === 'agents' ? v : 'vault';
    } catch {
      return 'vault';
    }
  });

  function select(v: LeftView) {
    // clicar no ícone da vista já aberta com o painel aberto = recolher
    if (open && v === view) {
      onToggle();
      return;
    }
    setView(v);
    try {
      localStorage.setItem('ui.leftView', v);
    } catch {
      /* sem localStorage: só não persiste */
    }
    if (!open) onToggle();
  }

  async function run(op: () => Promise<unknown>, message: string) {
    try {
      await op();
      await reload();
      setFlash(message);
    } catch (e) {
      setFlash((e as Error).message);
    }
  }

  const uploadInput = useRef<HTMLInputElement>(null);
  const uploadFolder = useRef('');

  /**
   * envia arquivos para `folder` (raiz -> 00-Inbox: o servidor não aceita a raiz).
   * Nome vira ASCII (AGENTS.md §3.3); já existe -> -1, -2…; .md vira nota.
   */
  async function sendFiles(folder: string, list: File[]) {
    if (!list.length) return;
    const dest = folder || '00-Inbox';
    expand(dest);
    const done: string[] = [];
    const failed: string[] = [];
    for (const file of list) {
      const m = /^(.*?)(?:\.([a-z0-9]+))?$/i.exec(file.name)!;
      const ext = (m[2] ?? '').toLowerCase();
      const base = slug(m[1] || 'arquivo');
      if (!ext) {
        failed.push(`${file.name}: sem extensão`);
        continue;
      }
      try {
        let sent = '';
        for (let n = 0; n < 20 && !sent; n++) {
          const target = `${dest}/${base}${n ? `-${n}` : ''}.${ext}`;
          try {
            if (ext === 'md') await vaultApi.createNote(target, await file.text());
            else await vaultApi.uploadFile(target, file);
            sent = target;
          } catch (e) {
            if (!/já existe/.test((e as Error).message)) throw e;
          }
        }
        if (sent) done.push(sent.split('/').pop()!);
        else failed.push(`${file.name}: nomes ocupados`);
      } catch (e) {
        failed.push(`${file.name}: ${(e as Error).message}`);
      }
    }
    await reload();
    setFlash(
      [done.length && `${done.length} enviado(s) para ${dest}/: ${done.join(', ')}`, failed.length && `falhou: ${failed.join('; ')}`]
        .filter(Boolean)
        .join(' · '),
    );
  }

  const actions: Actions = {
    writable,
    uploadFiles: (folder) => {
      uploadFolder.current = folder;
      uploadInput.current?.click();
    },
    dropFiles: (folder, files) => void sendFiles(folder, files),
    createNote: (folder, name) => setForm({ kind: 'note', folder, name }),
    createFolder: (folder, name) => setForm({ kind: 'folder', folder, name }),
    deleteFolder: (path) => {
      if (confirm(`Excluir a pasta "${path}" e todo o conteúdo? (permanente)`)) {
        void run(() => vaultApi.deleteFolder(path, true), `${path}/ excluída`);
      }
    },
    deleteNote: (path) => {
      if (confirm(`Excluir ${path}? (permanente)`)) {
        void run(() => vaultApi.deleteNote(path), `${path} excluída`);
      }
    },
    openMenu: (e, kind, path) => {
      e.preventDefault();
      const row = e.currentTarget as HTMLElement;
      // a linha (div) não é focável: o Esc devolve o foco ao link/botão dela
      const anchor = row.matches('button') ? row : row.querySelector<HTMLElement>('a, button') ?? row;
      // botão direito / toque longo: no ponteiro; "⋯" ou "+": embaixo do botão
      // (clientX 0 = clique via teclado, que não tem ponteiro)
      const fromPointer = e.type === 'contextmenu' && e.clientX > 0;
      const r = row.getBoundingClientRect();
      setMenu({ kind, path, anchor, x: fromPointer ? e.clientX : r.left, y: fromPointer ? e.clientY : r.bottom + 4 });
    },
  };

  async function submit() {
    if (!form) return;
    const name = form.name.trim();
    if (!name) {
      setFlash('Dê um nome primeiro.');
      return;
    }
    const target = form.folder ? `${form.folder}/${slug(name)}` : slug(name);
    const kind = form.kind;
    setForm(null);
    // o que foi criado precisa ficar visível: abre a pasta destino (e a
    // subpasta nova, quando for o caso) — fechar depois é escolha do usuário
    if (form.folder) expand(form.folder);
    if (kind === 'folder') expand(target);
    if (kind === 'note') {
      await run(() => vaultApi.createNote(`${target}.md`, defaultContent(name, form.folder)), `${target}.md criada`);
    } else {
      await run(() => vaultApi.createFolder(target), `${target}/ criada`);
    }
  }

  const VIEW_TITLE: Record<LeftView, string> = { vault: 'Explorador', clickup: 'ClickUp', agents: 'Agents' };

  return (
    <nav className={`sidebar${open ? '' : ' is-collapsed'}`} aria-label="Explorador do vault" tabIndex={-1}>
      {/* faixa de ícones (Ribbon.tsx): visível sempre, até com o painel recolhido */}
      <Ribbon view={view} open={open} onSelect={select} />

      {/* portal no body: funciona em qualquer vista e mesmo com o painel fechado */}
      {menu && <ContextMenu menu={menu} actions={actions} onClose={closeMenu} />}

      {open && (
        <div className="sidebar-pane">
          <div className="sidebar-head">
            <span className="sidebar-title">{VIEW_TITLE[view]}</span>
            <span className="sidebar-head-actions">
              {view === 'vault' && writable && (
                <button
                  type="button"
                  className="head-btn"
                  aria-label="Criar na raiz do vault"
                  aria-haspopup="menu"
                  title="Nova nota ou pasta"
                  onClick={(e) => actions.openMenu(e, 'root', '')}
                >
                  +
                </button>
              )}
              <button
                type="button"
                className="rail-toggle"
                onClick={onToggle}
                aria-expanded={open}
                aria-label="Retrair painel"
                title="Retrair painel — ["
              >
                ◀
              </button>
            </span>
          </div>

          {view === 'vault' && (
            <div className="sidebar-body">
              {form && (
                <div className="create-form">
                  <input
                    type="text"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void submit();
                      if (e.key === 'Escape') setForm(null);
                    }}
                    placeholder={form.kind === 'note' ? 'Nome da nota' : 'Nome da pasta'}
                    autoFocus
                  />
                  <span className="create-target">
                    destino: <code>{form.folder || 'raiz do vault'}</code>
                    {form.name && <span> → {slug(form.name)}{form.kind === 'note' ? '.md' : ''}</span>}
                  </span>
                  <div className="create-buttons">
                    <button type="button" className="btn" onClick={() => void submit()}>Criar</button>
                    <button type="button" className="btn ghost" onClick={() => setForm(null)}>Cancelar</button>
                  </div>
                </div>
              )}

              <input
                ref={uploadInput}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  void sendFiles(uploadFolder.current, [...(e.target.files ?? [])]);
                  e.target.value = '';
                }}
              />
              {flash && <p className="flash" role="status" aria-live="polite">{flash}</p>}

              <div className="tree">
                {[...tree.children.values()].map((child) => (
                  <FolderNode key={child.path} node={child} currentPath={currentPath} isOpen={isOpen} toggle={toggle} actions={actions} />
                ))}
                {tree.notes.map((note) => (
                  <div
                    className="file-row"
                    key={note.path}
                    onContextMenu={writable ? (e) => actions.openMenu(e, 'note', note.path) : undefined}
                  >
                    <Link className={`file${note.path === currentPath ? ' file-active' : ''}`} to={`/${encode(note.path)}`}>
                      {note.name}
                    </Link>
                    {writable && <MoreButton kind="note" path={note.path} label={note.name} actions={actions} />}
                  </div>
                ))}
                {tree.files.map((file) => (
                  <FileRow key={file.path} file={file} currentPath={currentPath} />
                ))}
              </div>
            </div>
          )}

          {view === 'clickup' && (
            <div className="sidebar-body">
              <Link className={`sidebar-shortcut${currentPath === '' && location.hash.startsWith('#/painel') ? ' file-active' : ''}`} to="/painel">
                📊 Painel <span className="muted">ClickUp</span>
              </Link>
              <Link className={`sidebar-shortcut${currentPath === '' && location.hash.startsWith('#/tarefas') ? ' file-active' : ''}`} to="/tarefas">
                ☑ Tarefas <span className="muted">ClickUp</span>
              </Link>
              {/* Financeiro e Investimentos escondidos do menu; as telas seguem em #/financeiro e #/investimentos */}
            </div>
          )}

          {view === 'agents' && <AgentsPane />}

          {/* estado de escrita + sair: no rodapé fixo (App.tsx, .statusbar) */}
          <UserMenu />
        </div>
      )}
    </nav>
  );
}



/**
 * vault.ts — estado das notas do vault.
 * Sem glob de build: as notas vivem no MinIO (ou numa pasta servida por
 * /api/notes) e `reloadVault()` popula no mount. Mantém o bundle sem o
 * conteúdo do vault e funciona com VAULT_STORAGE=rustfs.
 */
import { splitFrontmatter } from './frontmatter';
import { expireSession } from './api';

/*
 * anexos (imagens, html, pdf…) NÃO entram no bundle: vêm de /api/notes
 * (`files`) e são servidos do disco em /files/<caminho> (server/vault-api.mjs).
 * Arquivo novo aparece no próximo reloadVault, sem rebuild.
 */
export type FileKind = 'image' | 'html' | 'pdf' | 'office' | 'text' | 'video' | 'audio';
export interface VaultFile {
  path: string; // ex. "99-Meta/attachments/Sprints/deck.html"
  name: string; // ex. "deck.html"
  folder: string;
  kind: FileKind;
  size: number;
  url: string; // ex. "/files/99-Meta/attachments/Sprints/deck.html"
}

export function fileUrl(path: string): string {
  return `/files/${path.split('/').map(encodeURIComponent).join('/')}`;
}

/** ../../02-Comandos/Git/Git.md -> 02-Comandos/Git/Git.md */
function relPath(key: string): string {
  return key.replace(/^(\.\.\/)+/, '');
}

export interface Note {
  path: string; // ex. "02-Comandos/Git/Git.md"
  name: string; // ex. "Git"
  folder: string; // ex. "02-Comandos/Git" ("" = raiz)
  ext: 'md' | 'base';
  raw: string;
  frontmatter: Record<string, unknown>;
  body: string;
  title: string;
}

function buildNote(key: string, raw: string): Note {
  const path = relPath(key);
  const ext = path.endsWith('.base') ? 'base' : 'md';
  const base = path.split('/').pop() ?? path;
  const name = base.replace(/\.(md|base)$/, '');
  const folder = path.slice(0, path.length - base.length).replace(/\/$/, '');
  const { data, body } = splitFrontmatter(raw);
  const h1 = body.match(/^#\s+(.+)$/m);
  return {
    path,
    name,
    folder,
    ext,
    raw,
    frontmatter: data,
    body,
    title: typeof data.title === 'string' && data.title ? data.title : h1?.[1] ?? name,
  };
}

/* ---------------------------------------------------------------------------
 * Estado mutável do vault.
 * O glob do Vite é só o snapshot inicial (útil para build estático/SSR).
 * Toda criação/edição/exclusão chama reloadVault(), que relê o disco via
 * /api/notes e reconstrói notas, índices, backlinks e árvore do explorador.
 * --------------------------------------------------------------------------- */
const rawByPath = new Map<string, string>();

let folderPaths: string[] = [];
export let files: VaultFile[] = [];
let version = 0;
const listeners = new Set<() => void>();

export let notes: Note[] = [];
export let byPath = new Map<string, Note>();
export let vaultWritable = false;
let byName = new Map<string, Note[]>();

function rebuild() {
  notes = [...rawByPath.entries()]
    .map(([path, raw]) => buildNote(path, raw))
    .sort((a, b) => a.path.localeCompare(b.path));
  byPath = new Map(notes.map((n) => [n.path, n]));
  byName = new Map();
  for (const n of notes) {
    const k = n.name.toLowerCase();
    const list = byName.get(k);
    if (list) list.push(n);
    else byName.set(k, [n]);
  }
  rebuildIndices();
  version++;
  for (const fn of listeners) fn();
}

/** relê o vault do disco; false quando não existe servidor de escrita (/api) */
export async function reloadVault(): Promise<boolean> {
  try {
    const res = await fetch('/api/notes');
    expireSession(res);
    if (!res.ok) {
      vaultWritable = false;
      return false;
    }
    const data = (await res.json()) as {
      notes: { path: string; raw: string }[];
      folders: string[];
      files?: { path: string; kind: FileKind; size: number }[];
    };
    vaultWritable = true;
    rawByPath.clear();
    for (const n of data.notes) rawByPath.set(n.path, n.raw);
    folderPaths = data.folders ?? [];
    setFiles(data.files ?? []);
    rebuild();
    return true;
  } catch {
    vaultWritable = false;
    return false;
  }
}

export function subscribeVault(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function vaultVersion(): number {
  return version;
}


const attachmentUrls = new Map<string, string>();
const attachmentByBase = new Map<string, string>();
const fileByUrl = new Map<string, VaultFile>();

function setFiles(list: { path: string; kind: FileKind; size: number }[]) {
  files = list.map((f) => {
    const name = f.path.split('/').pop() ?? f.path;
    return { ...f, name, folder: f.path.slice(0, f.path.length - name.length).replace(/\/$/, ''), url: fileUrl(f.path) };
  });
  attachmentUrls.clear();
  attachmentByBase.clear();
  fileByUrl.clear();
  for (const f of files) {
    attachmentUrls.set(f.path, f.url);
    attachmentByBase.set(f.name.toLowerCase(), f.url);
    fileByUrl.set(f.url, f);
  }
}

export { attachmentUrls };

/** anexo pela URL resolvida (/files/…) ou pelo caminho do vault */
export function fileInfo(urlOrPath: string): VaultFile | null {
  return fileByUrl.get(urlOrPath) ?? fileByUrl.get(fileUrl(urlOrPath)) ?? null;
}

/**
 * src de imagem markdown padrão (![](...)) -> URL do anexo. Tenta, nesta ordem:
 * relativo à pasta da nota, relativo à raiz do vault e pelo nome do arquivo
 * (como o Obsidian). URL externa/data:/já resolvida passa direto.
 */
export function resolveMediaSrc(src: string, noteFolder: string): string {
  if (!src || /^(https?:|data:|blob:|\/)/i.test(src)) return src;
  let clean = src.split(/[?#]/)[0];
  try {
    clean = decodeURIComponent(clean);
  } catch {
    /* mantém como veio */
  }
  const parts: string[] = [];
  for (const seg of `${noteFolder}/${clean}`.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return attachmentUrls.get(parts.join('/')) ?? attachmentUrls.get(clean.replace(/^\.?\//, '')) ?? (getAssetUrl(clean) || src);
}

/** O caminho aponta para um anexo binário real (pdf, pptx, imagem…)? */
export function isAttachment(path: string): boolean {
  return attachmentUrls.has(path);
}

/** URL direta para um anexo: aceita caminho do vault ou URL de asset já resolvida. */
export function getAssetUrl(pathOrUrl: string): string {
  if (pathOrUrl.startsWith('/')) return pathOrUrl;
  return attachmentUrls.get(pathOrUrl) ?? attachmentByBase.get(pathOrUrl.split('/').pop()!.toLowerCase()) ?? '';
}

/**
 * Anexos "relacionados" a uma nota: arquivos binários no vault cujo nome bate
 * com o nome da nota (ex.: nota 2026-10-28-Apresentacao.md -> .../2026-10-28-Apresentacao.pptx).
 * Obsidian não faz isso; é um atalho para achar o deck/pdf de uma nota.
 */
export function relatedAttachments(note: Note): { path: string; url: string }[] {
  const stem = note.name.toLowerCase();
  if (!stem) return [];
  const out: { path: string; url: string }[] = [];
  for (const [path, url] of attachmentUrls) {
    const base = (path.split('/').pop() ?? '').replace(/\.[a-z0-9]+$/, '').toLowerCase();
    if (!base) continue;
    // match exato: "Git.md" nao puxa "git-cheatsheet.pdf" nem "gitlab-x.png"
    if (base === stem) out.push({ path, url });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

const EMBED_RE = /!\[\[([^\]\|]+?)(?:\|[^\]]*)?\]\]/g;
/* code fences e inline code: texto dentro de código não é um embed real */
const CODE_RE = /```[\s\S]*?```|`[^`\n]*`/g;
/** Remove cercas de código e código inline: texto dentro de código não é link. */
export function stripCode(text: string): string {
  return text.replace(CODE_RE, '');
}


/**
 * Embeds (![[...]]) do corpo, já resolvidos e dedupados.
 * Todo o texto dentro de código (cercas ou inline) é ignorado.
 */
export function embeddedAttachments(body: string): { target: string; url: string | null }[] {
  const out: { target: string; url: string | null }[] = [];
  const seen = new Set<string>();
  for (const m of stripCode(body).matchAll(EMBED_RE)) {
    const target = m[1].split('#')[0].split('|')[0].trim();
    if (!target || seen.has(target)) continue;
    seen.add(target);
    out.push({ target, url: resolveTarget(target) });
  }
  return out;
}

const isBinaryAsset = (url: string | null): boolean => !!url && url.startsWith('/') && !/\.(md|base)$/i.test(url);

/** Embeds de anexos binários reais (pdf, pptx, imagem…). */
export function attachmentEmbeds(body: string) {
  return embeddedAttachments(body).filter((e) => isBinaryAsset(e.url));
}

/** Embeds de outra nota ou base (ex.: ![[Sprints.base#Sprints]]). */
export function noteEmbeds(body: string) {
  return embeddedAttachments(body).filter((e) => !!e.url && /\.(md|base)$/i.test(e.url));
}

/** Embeds que não resolvem a nenhum arquivo do vault (dangling, como no Obsidian). */
export function danglingAttachments(body: string) {
  return embeddedAttachments(body).filter((e) => !e.url);
}

/**
 * Anexos de uma nota, sem duplicar:
 *  1. binários embedados no corpo  (![[deck.pptx]])
 *  2. binários "relacionados" — mesmo nome da nota (deck/pdf gerados para ela)
 * ordem: embeds primeiro, depois relacionados.
 */
export function noteAttachments(note: Note): { path: string; url: string }[] {
  const embedded = attachmentEmbeds(note.body);
  const seenPaths = new Set(embedded.map((e) => e.target));
  const seenUrls = new Set(embedded.map((e) => e.url!));
  const related = relatedAttachments(note).filter((a) => !seenPaths.has(a.path) && !seenUrls.has(a.url));
  return [...embedded.map((e) => ({ path: e.target, url: e.url! })), ...related];
}


/**
 * Resolve um alvo de wikilink/embed para um caminho do vault.
 * Aceita "Nota", "Nota|alias", "Nota#secao", "pasta/Nota", "arquivo.png".
 */
export function resolveTarget(target: string): string | null {
  const cleaned = target
    .split('#')[0]
    .split('|')[0]
    .trim()
    .replace(/^\/*/, '');
  if (!cleaned) return null;

  if (byPath.has(cleaned)) return cleaned;

  const base = cleaned.split('/').pop()!.toLowerCase();
  const ext = base.match(/\.(md|base)$/)?.[1] ?? null;

  // anexo (pdf, pptx, imagem, ...): devolve a URL do asset
  if (!ext) {
    const asset = attachmentByBase.get(base);
    if (asset) return asset;
  }

  const stem = base.replace(/\.(md|base)$/, '');
  const candidates = byName.get(stem) ?? [];
  if (!candidates.length) return attachmentByBase.get(base) ?? null;

  // [[Sprints.base]] deve resolver ao .base, não ao .md de mesmo nome
  if (ext) {
    const sameExt = candidates.find((n) => n.ext === ext);
    if (sameExt) return sameExt.path;
  }
  return candidates[0].path;
}

/** Índice invertido: path da nota -> lista de notas que a linkam. */
export let backlinks = new Map<string, Note[]>();
const WIKILINK_RE = /\[\[([^\]\n]+)\]\]/g;

/** Árvore do explorador (sidebar): pastas vazias também aparecem. */
export interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  notes: Note[];
  files: VaultFile[];
}

export let tree: TreeNode = { name: '', path: '', children: new Map(), notes: [], files: [] };
export let allTags = new Map<string, Note[]>();

function ensureFolder(path: string): TreeNode {
  let node = tree;
  for (const part of path.split('/').filter(Boolean)) {
    let child = node.children.get(part);
    if (!child) {
      child = { name: part, path: node.path ? `${node.path}/${part}` : part, children: new Map(), notes: [], files: [] };
      node.children.set(part, child);
    }
    node = child;
  }
  return node;
}

/** reconstrói backlinks, árvore e tags a partir do estado atual de `notes` */
export function rebuildIndices() {
  backlinks = new Map();
  for (const note of notes) {
    for (const m of stripCode(note.raw).matchAll(WIKILINK_RE)) {
      const target = resolveTarget(m[1]);
      if (!target || target === note.path) continue;
      const list = backlinks.get(target) ?? [];
      if (!list.some((n) => n.path === note.path)) list.push(note);
      backlinks.set(target, list);
    }
  }

  tree = { name: '', path: '', children: new Map(), notes: [], files: [] };
  for (const folder of folderPaths) ensureFolder(folder);
  for (const note of notes) ensureFolder(note.folder).notes.push(note);
  for (const file of files) ensureFolder(file.folder).files.push(file);

  allTags = new Map();
  for (const note of notes) {
    const tags = note.frontmatter.tags;
    if (!Array.isArray(tags)) continue;
    for (const tag of tags) {
      const key = String(tag);
      const list = allTags.get(key) ?? [];
      list.push(note);
      allTags.set(key, list);
    }
  }
}

/*
 * Ordem de inicialização importa: `rebuild()` chama `rebuildIndices()`, que lê
 * `backlinks`, `tree`, `allTags` e os maps de anexos. Todos precisam existir
 * antes do primeiro rebuild — por isso a chamada inicial fica aqui, no fim.
 */
rebuild();

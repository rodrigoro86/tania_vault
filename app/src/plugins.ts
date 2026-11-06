/**
 * plugins.ts — plugins remark para "cara de Obsidian":
 * wikilinks [[Nota]] / [[Nota|alias]], embeds ![[img.png]] e callouts > [!note].
 */
import { resolveTarget, fileInfo } from './vault';

type Node = any;

const WIKILINK_RE = /(!)?\[\[([^\]\n]+)\]\]/g;

function encodePath(path: string): string {
  return path.split('/').map((p) => encodeURIComponent(p)).join('/');
}

/** anexos que viram player embutido (os demais viram link) */
const EMBED_KINDS = new Set(['html', 'pdf', 'video', 'audio']);

/** resolveTarget já devolve a URL do asset para anexos; caminhos de nota são relativos ao vault. */
function isAsset(url: string): boolean {
  return url.startsWith('/');
}

function linkNode(url: string | null, label: string, broken: boolean, searchTerm?: string): Node {
  // link quebrado aponta para a busca do vault (Obsidian mostra como texto)
  return {
    type: 'link',
    url: url ?? `#/busca/${encodeURIComponent(searchTerm || label)}`,
    title: null,
    data: { hProperties: { class: broken ? 'wikilink broken' : 'wikilink' } },
    children: [{ type: 'text', value: label }],
  };
}
function transformText(node: Node): Node[] | Node {
  if (node.type === 'text') {
    const out: Node[] = [];
    let last = 0;
    for (const m of node.value.matchAll(WIKILINK_RE)) {
      if (m.index! > last) out.push({ type: 'text', value: node.value.slice(last, m.index) });
      const embed = m[1] === '!';
      const [targetRaw, alias] = m[2].split('|');
      const target = targetRaw.trim();
      const label = (alias ?? target).trim();
      const resolved = resolveTarget(target);

      const IMAGE_EXT = /\.(png|jpg|jpeg|gif|webp|svg|avif|bmp)$/i;
      if (embed && resolved && isAsset(resolved) && IMAGE_EXT.test(resolved)) {
        out.push({ type: 'image', url: resolved, alt: label, title: null });
      } else if (embed && resolved && isAsset(resolved) && EMBED_KINDS.has(fileInfo(resolved)?.kind ?? '')) {
        // ![[deck.html]], ![[doc.pdf]], ![[video.mp4]]: o NoteView troca este link pelo player
        out.push({
          type: 'link',
          url: resolved,
          title: null,
          data: { hProperties: { class: 'embed-file', 'data-kind': fileInfo(resolved)!.kind } },
          children: [{ type: 'text', value: label }],
        });
      } else if (embed && resolved && isAsset(resolved)) {
        // anexo não-imagem (pptx, docx, ...): link direto ao asset
        out.push({
          type: 'link',
          url: resolved,
          title: null,
          data: { hProperties: { class: 'attachment' } },
          children: [{ type: 'text', value: label }],
        });
      } else if (embed && resolved) {
        // embed de nota: vira link para a rota da nota
        out.push(linkNode('#/' + encodePath(resolved), label, false));
      } else if (embed) {
        out.push({ type: 'text', value: m[0] });
      } else if (resolved && isAsset(resolved)) {
        // [[arquivo.pptx]]: link direto ao anexo
        out.push({
          type: 'link',
          url: resolved,
          title: null,
          data: { hProperties: { class: 'attachment' } },
          children: [{ type: 'text', value: label }],
        });
      } else {
        out.push(linkNode(resolved ? '#/' + encodePath(resolved) : null, label, !resolved, target));
      }
      last = m.index! + m[0].length;
    }
    if (!out.length) return node;
    if (last < node.value.length) out.push({ type: 'text', value: node.value.slice(last) });
    return out;
  }

  if (node.children) node.children = node.children.flatMap(transformText);
  return node;
}

export function wikilinks() {
  return (tree: Node) => {
    const root = { ...tree, children: (tree.children ?? []).flatMap(transformText) };
    tree.children = root.children;
  };
}

const CALLOUT_TYPES: Record<string, string> = {
  note: 'note',
  info: 'info',
  todo: 'todo',
  tip: 'tip',
  warning: 'warning',
  caution: 'warning',
  danger: 'danger',
  question: 'question',
  example: 'example',
  quote: 'quote',
};

export function callouts() {
  return (tree: Node) => {
    const stack: Node[] = [tree];
    while (stack.length) {
      const node = stack.pop()!;
      if (node.type === 'blockquote') {
        const first = node.children?.[0];
        const textNode = first?.children?.[0];
        if (textNode?.type === 'text') {
          const m = textNode.value.match(/^\[!([a-zA-Z]+)\]\s*/);
          if (m) {
            const type = CALLOUT_TYPES[m[1].toLowerCase()] ?? 'note';
            node.data = { ...(node.data ?? {}), hProperties: { class: `callout callout-${type}` } };
            textNode.value = textNode.value.slice(m[0].length);
            if (!textNode.value) first.children.shift();
            if (!first.children.length) node.children.shift();
          }
        }
      }
      if (node.children && node.type !== 'code' && node.type !== 'inlineCode') {
        for (const c of node.children) stack.push(c);
      }
    }
  };
}

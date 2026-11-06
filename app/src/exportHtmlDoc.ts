/**
 * exportHtmlDoc.ts — exportar um documento HTML A4 do vault (anexo em /files)
 * como PDF (impressão do navegador) ou .docx editável (htmlToDocx.ts).
 *
 * Os dois caminhos leem o HTML como texto e o abrem SEM scripts: o PDF imprime
 * uma cópia limpa num iframe `sandbox="allow-same-origin allow-modals"` (sem
 * allow-scripts), então o JS do anexo nunca roda na origem do site. Apresentações
 * reveal.js precisam do JS para montar os slides — para elas o caminho continua
 * sendo ↗ Nova aba → Ctrl+P.
 */
import type { DocxOptions, ImageLoader, LoadedImage } from './htmlToDocx';
import { noteToMarcaDoc, type NoteMeta } from './docMarca';
import type { Note } from './vault';

async function fetchHtml(url: string): Promise<Document> {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`não consegui ler o arquivo (HTTP ${res.status})`);
  return new DOMParser().parseFromString(await res.text(), 'text/html');
}

function assertDocument(doc: Document): void {
  if (doc.querySelector('.reveal .slides')) {
    throw new Error('isto é uma apresentação (reveal.js). Use ↗ Nova aba → Ctrl+P para o PDF; Word vale para documentos A4.');
  }
}

/** imagens de /brand e /files vêm da origem atual (a URL absoluta do site não passa por CORS em dev) */
function localUrl(src: string, base: string): string {
  const u = new URL(src, new URL(base, location.href));
  if (/^\/(brand|files)\//.test(u.pathname)) return `${location.origin}${u.pathname}`;
  return u.href;
}

function baseName(url: string): string {
  const last = decodeURIComponent(new URL(url, location.href).pathname.split('/').pop() ?? 'documento');
  return last.replace(/\.html?$/i, '') || 'documento';
}

// ---------- PDF ----------

function sanitize(doc: Document, url: string): void {
  doc.querySelectorAll('script, iframe, object, embed, base, meta[http-equiv]').forEach((el) => el.remove());
  for (const el of doc.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      if (/^on/i.test(attr.name) || /^\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
    }
  }
  // caminhos relativos do anexo continuam valendo dentro do srcdoc
  const base = doc.createElement('base');
  base.href = new URL(url, location.href).href;
  doc.head.prepend(base);
}

async function settle(frameDoc: Document): Promise<void> {
  const imgs = [...frameDoc.images];
  await Promise.race([
    Promise.all([
      frameDoc.fonts?.ready,
      ...imgs.map((img) => (img.complete ? Promise.resolve() : img.decode().catch(() => undefined))),
    ]),
    new Promise((r) => setTimeout(r, 8000)),
  ]);
}

/** abre o diálogo de impressão com o documento; o nome do arquivo vira o nome sugerido do PDF */
export async function printHtmlDoc(url: string): Promise<void> {
  const doc = await fetchHtml(url);
  assertDocument(doc);
  sanitize(doc, url);
  const name = baseName(url);
  doc.title = name;

  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-same-origin allow-modals');
  frame.setAttribute('aria-hidden', 'true');
  frame.className = 'print-frame';
  const loaded = new Promise<void>((r) => frame.addEventListener('load', () => r(), { once: true }));
  frame.srcdoc = `<!doctype html>\n${doc.documentElement.outerHTML}`;
  document.body.append(frame);
  await loaded;
  const win = frame.contentWindow;
  if (!win || !frame.contentDocument) {
    frame.remove();
    throw new Error('o navegador não abriu a cópia para impressão');
  }
  await settle(frame.contentDocument);

  const previousTitle = document.title;
  document.title = name;
  const cleanup = () => {
    document.title = previousTitle;
    frame.remove();
  };
  win.addEventListener('afterprint', cleanup, { once: true });
  win.focus();
  win.print();
  // navegadores sem afterprint confiável: limpa depois
  setTimeout(cleanup, 60_000);
}

// ---------- DOCX ----------

async function loadImage(src: string): Promise<LoadedImage | null> {
  const res = await fetch(src, { credentials: 'same-origin' });
  if (!res.ok) return null;
  const blob = await res.blob();
  const kind = (blob.type || '').toLowerCase();
  const ext = /\.(\w+)(?:$|\?)/.exec(src)?.[1]?.toLowerCase() ?? '';
  const type = kind.includes('png') || ext === 'png' ? 'png' : kind.includes('jpeg') || /^jpe?g$/.test(ext) ? 'jpg' : kind.includes('gif') || ext === 'gif' ? 'gif' : kind.includes('bmp') || ext === 'bmp' ? 'bmp' : null;
  if (!type) return null; // svg/webp: o Word não lê sem conversão
  const bitmap = await createImageBitmap(blob);
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return { data: new Uint8Array(await blob.arrayBuffer()), type, ...size };
}

/** gera e baixa o .docx (o conversor e a lib docx só carregam no primeiro uso) */
async function saveDocx(doc: Document, base: string, name: string, opts?: DocxOptions): Promise<void> {
  const [{ htmlToDocx }, { Packer }] = await Promise.all([import('./htmlToDocx'), import('docx')]);
  const loader: ImageLoader = (src) => loadImage(localUrl(src, base));
  const blob = await Packer.toBlob(await htmlToDocx(doc, loader, opts));
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = `${name}.docx`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

/** documento A4 do vault (anexo .html) → .docx */
export async function downloadDocx(url: string): Promise<void> {
  const doc = await fetchHtml(url);
  assertDocument(doc);
  await saveDocx(doc, url, baseName(url));
}

/**
 * nota aberta → .docx, a partir do markdown já renderizado na tela (sem embeds).
 * simple: só o conteúdo com os estilos; marca: capa, ficha (se houver dados),
 * cabeçalho com logo e rodapé com página — o formato do documento A4 (docMarca.ts).
 */
export async function downloadNoteDocx(note: Note, mode: 'simple' | 'marca' = 'simple'): Promise<void> {
  const rendered = document.querySelector('.note .markdown');
  if (!rendered) throw new Error('a nota não está aberta na tela');
  const doc = document.implementation.createHTMLDocument(note.title);
  const name = note.path.split('/').pop()?.replace(/\.md$/i, '') || note.name;
  if (mode === 'marca') {
    return downloadMarcaDocx(rendered, { title: note.title, frontmatter: note.frontmatter, date: new Date().toISOString().slice(0, 10) }, `${name}-capa`);
  }
  // o título vai como Título 1, a menos que o markdown já comece com um "# "
  if (rendered.firstElementChild?.tagName !== 'H1') {
    const h1 = doc.createElement('h1');
    h1.textContent = note.title;
    doc.body.append(h1);
  }
  doc.body.append(doc.importNode(rendered, true));
  doc.querySelectorAll('.embed, .embed-media, .lightbox').forEach((el) => el.remove());
  await saveDocx(doc, location.href, name);
}

/** conteúdo qualquer (nota renderizada, relatório) → Word no formato do documento A4 */
export async function downloadMarcaDocx(content: Element, meta: NoteMeta, name: string): Promise<void> {
  const doc = document.implementation.createHTMLDocument(meta.title);
  noteToMarcaDoc(doc, content, meta);
  // seções curtas: seguem no fluxo, sem página nova por seção
  await saveDocx(doc, location.href, name, { sectionBreaks: false });
}

/** baixa um texto como arquivo */
export function downloadText(text: string, name: string, type = 'text/markdown;charset=utf-8'): void {
  const href = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

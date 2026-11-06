/**
 * htmlToDocx.ts — converte um documento HTML A4 (modelo com capa,
 * 99-Meta/attachments/Apresentacoes/Modelo-documento.html)
 * em .docx editável: estilos de Word de verdade (Título 1/2, tabelas, listas),
 * cabeçalho com logo e rodapé com número de página.
 *
 * Lê a estrutura do modelo:
 *   section.pagina.capa        → 1ª página (logo em sangria, título à direita, rodapé próprio)
 *   section.pagina             → quebra de página; .cabecalho/.rodape-pagina viram header/footer do Word
 *   .ficha-folha / .indice     → ficha técnica e índice com pontilhado até a página
 *   .alerta / .ponto-aberto    → parágrafo com fundo e borda esquerda (âmbar / teal)
 * HTML sem .pagina vira um documento simples (o body inteiro).
 *
 * Só depende do `docx` e de um Document (DOMParser no navegador, jsdom nos testes).
 */
import {
  AlignmentType,
  BorderStyle,
  Document as DocxDocument,
  ExternalHyperlink,
  Footer,
  Header,
  HeadingLevel,
  HorizontalPositionRelativeFrom,
  ImageRun,
  LevelFormat,
  LineRuleType,
  PageNumber,
  Paragraph,
  ShadingType,
  TabStopType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  TextWrappingType,
  VerticalAlign,
  VerticalPositionRelativeFrom,
  WidthType,
  type IBorderOptions,
  type IRunOptions,
  type ParagraphChild,
} from 'docx';

export type LoadedImage = { data: Uint8Array; width: number; height: number; type: 'png' | 'jpg' | 'gif' | 'bmp' };
/** baixa uma imagem do HTML (src já resolvido pelo chamador); null = pula a imagem */
export type ImageLoader = (src: string) => Promise<LoadedImage | null>;

type Block = Paragraph | Table;
type Fmt = { bold?: boolean; italics?: boolean; underline?: boolean; color?: string; size?: number; font?: string; href?: string; code?: boolean };
type Seg = { kind: 'text'; text: string; f: Fmt } | { kind: 'br' } | { kind: 'img'; run: ImageRun; f: Fmt };

// A4 e margens (mm) — espelham o CSS do modelo
const PAGE_W = 210;
const PAGE_H = 297;
const MARGIN_X = 20;
const TEXT_W = PAGE_W - 2 * MARGIN_X;
const twip = (mm: number) => Math.round(mm * 56.6929);
const emu = (mm: number) => Math.round(mm * 36000);
const px = (mm: number) => Math.round((mm * 96) / 25.4);
const pt = (n: number) => Math.round(n * 2); // half-points
const ptTwip = (n: number) => Math.round(n * 20);

/** paleta padrão da identidade visual; sobrescrita pelas variáveis do :root do próprio HTML */
const DEFAULT_COLORS: Record<string, string> = {
  teal: '40A8C4',
  'teal-escuro': '2E8AA6',
  grafite: '2B2929',
  cinza: '7B7979',
  fundo: 'F4F9FA',
  ambar: 'FFF7E0',
  'ambar-borda': 'D4A72C',
};
const LINHA = 'E6EEF0';
const TITLE_FONT = 'Poppins';
const BODY_FONT = 'Arial';

const ELEMENT = 1;
const TEXT = 3;
const SKIP = new Set(['script', 'style', 'noscript', 'template', 'head', 'iframe', 'object', 'embed', 'video', 'audio', 'canvas', 'svg', 'button', 'input', 'select', 'textarea']);
const BLOCK = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'table', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'figure', 'figcaption', 'blockquote', 'pre', 'hr', 'dl', 'dt', 'dd', 'li']);

function cls(el: Element, name: string): boolean {
  return el.classList?.contains(name) ?? false;
}

/** CSS do <style>: variáveis de cor e as medidas que o conversor precisa */
function readCss(doc: Document) {
  const css = [...doc.querySelectorAll('style')].map((s) => s.textContent ?? '').join('\n');
  const colors = { ...DEFAULT_COLORS };
  for (const m of css.matchAll(/--([\w-]+)\s*:\s*#([0-9a-f]{6})\b/gi)) colors[m[1]] = m[2].toUpperCase();
  const rule = (selector: RegExp) => selector.exec(css)?.[1] ?? '';
  const num = (text: string, re: RegExp, fallback: number) => {
    const v = re.exec(text)?.[1];
    return v ? Number(v) : fallback;
  };
  return {
    colors,
    // altura do logo da capa em % da folha e início do texto em % da largura
    coverLogoPct: num(rule(/\.capa\s+img\.logo\s*\{([^}]*)\}/), /height\s*:\s*([\d.]+)%/, 50),
    coverTextPct: num(css, /--inicio-texto\s*:\s*([\d.]+)%/, 60),
    headerLogoMm: num(rule(/\.cabecalho\s+img[\w.-]*\s*\{([^}]*)\}/), /height\s*:\s*([\d.]+)mm/, 18),
  };
}

/** sectionBreaks: cada h1 (seção) começa em página nova, como no CSS do modelo (padrão) */
export type DocxOptions = { sectionBreaks?: boolean };

export async function htmlToDocx(doc: Document, loadImage: ImageLoader, opts: DocxOptions = {}): Promise<DocxDocument> {
  const sectionBreaks = opts.sectionBreaks ?? true;
  const css = readCss(doc);
  const C = css.colors;
  // folhas do modelo (sem .pagina dentro de .pagina)
  const pages = [...doc.querySelectorAll('.pagina')].filter((p) => !p.parentElement?.closest('.pagina'));
  const cover = pages.find((p) => cls(p, 'capa')) ?? null;
  const inner = pages.find((p) => !cls(p, 'capa')) ?? null;
  // margem de cima: abaixo do logo do cabeçalho (16 mm + 18 mm no modelo)
  const TOP_MM = inner?.querySelector('.cabecalho') ? 36 : 25;
  const images = new Map<string, Promise<LoadedImage | null>>();
  const image = (src: string | null) => {
    if (!src) return Promise.resolve(null);
    if (!images.has(src)) images.set(src, loadImage(src).catch(() => null));
    return images.get(src)!;
  };

  // ---------- trechos de texto (inline) ----------

  async function collect(node: Node, f: Fmt, out: Seg[]): Promise<void> {
    if (node.nodeType === TEXT) {
      const text = (node.textContent ?? '').replace(/\s+/g, ' ');
      if (text) out.push({ kind: 'text', text, f });
      return;
    }
    if (node.nodeType !== ELEMENT) return;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (SKIP.has(tag)) return;
    if (tag === 'br') return void out.push({ kind: 'br' });
    if (tag === 'img') {
      const run = await imageRun(el, TEXT_W);
      if (run) out.push({ kind: 'img', run, f });
      return;
    }
    let g = f;
    if (tag === 'strong' || tag === 'b' || tag === 'th') g = { ...g, bold: true };
    if (tag === 'em' || tag === 'i') g = { ...g, italics: true };
    if (tag === 'u') g = { ...g, underline: true };
    if (tag === 'code' || tag === 'kbd' || tag === 'samp') g = { ...g, code: true };
    if (tag === 'a') {
      const href = el.getAttribute('href') ?? '';
      if (/^(https?:|mailto:)/i.test(href)) g = { ...g, href, color: C.teal, underline: true };
    }
    for (const child of el.childNodes) await collect(child, g, out);
  }

  function run(text: string, f: Fmt): TextRun {
    const opts: IRunOptions = {
      text,
      bold: f.bold,
      italics: f.italics,
      underline: f.underline ? {} : undefined,
      color: f.color,
      size: f.size,
      font: f.code ? 'Consolas' : f.font,
    };
    return new TextRun(opts);
  }

  /** junta os trechos em runs do Word, aparando espaço no início e no fim do parágrafo */
  function toRuns(segs: Seg[]): ParagraphChild[] {
    const first = segs.findIndex((s) => s.kind === 'text');
    if (first >= 0) (segs[first] as { text: string }).text = (segs[first] as { text: string }).text.replace(/^ /, '');
    for (let i = segs.length - 1; i >= 0; i--) {
      const s = segs[i];
      if (s.kind !== 'text') continue;
      s.text = s.text.replace(/ $/, '');
      break;
    }
    const out: ParagraphChild[] = [];
    let link: { href: string; children: ParagraphChild[] } | null = null;
    for (const s of segs) {
      const href = s.kind === 'br' ? undefined : s.f.href;
      if (link && link.href !== href) {
        out.push(new ExternalHyperlink({ link: link.href, children: link.children as TextRun[] }));
        link = null;
      }
      const child = s.kind === 'br' ? new TextRun({ break: 1 }) : s.kind === 'img' ? s.run : s.text ? run(s.text, s.f) : null;
      if (!child) continue;
      if (href) (link ??= { href, children: [] }).children.push(child);
      else out.push(child);
    }
    if (link) out.push(new ExternalHyperlink({ link: link.href, children: link.children as TextRun[] }));
    return out;
  }

  async function runsOf(el: Node, f: Fmt = {}): Promise<ParagraphChild[]> {
    const segs: Seg[] = [];
    await collect(el, f, segs);
    return toRuns(segs);
  }

  async function imageRun(el: Element, maxWidthMm: number, heightMm?: number): Promise<ImageRun | null> {
    const img = await image(el.getAttribute('src'));
    if (!img || !img.width || !img.height) return null;
    const ratio = img.width / img.height;
    let h = heightMm ?? (img.height * 25.4) / 96;
    let w = h * ratio;
    if (w > maxWidthMm) [w, h] = [maxWidthMm, maxWidthMm / ratio];
    return new ImageRun({ type: img.type, data: img.data, transformation: { width: px(w), height: px(h) }, altText: altOf(el) });
  }

  function altOf(el: Element) {
    const alt = el.getAttribute('alt') || 'imagem';
    return { name: alt, description: alt, title: alt };
  }

  // ---------- blocos ----------

  let breakNext = false;
  /** a 1ª coisa de cada .pagina (ou um h1) começa em página nova */
  function takeBreak(): boolean {
    const b = breakNext;
    breakNext = false;
    return b;
  }

  type Ctx = { listLevel: number; box?: 'alerta' | 'ponto-aberto'; indent?: number };

  const boxBorder = (color: string): IBorderOptions => ({ style: BorderStyle.SINGLE, size: 32, color, space: 8 });
  function boxProps(ctx: Ctx) {
    if (!ctx.box) return {};
    const alerta = ctx.box === 'alerta';
    return {
      shading: { type: ShadingType.CLEAR, color: 'auto', fill: alerta ? C.ambar : C.fundo },
      border: { left: boxBorder(alerta ? C['ambar-borda'] : C.teal) },
      indent: { left: ptTwip(10), right: ptTwip(10) },
      spacing: { before: ptTwip(4), after: ptTwip(4) },
      keepLines: true,
    };
  }

  async function blocks(el: Element, ctx: Ctx, out: Block[]): Promise<void> {
    // conteúdo solto (texto/inline) entre blocos vira um parágrafo
    let loose: Node[] = [];
    const flush = async () => {
      if (!loose.length) return;
      const segs: Seg[] = [];
      for (const n of loose) await collect(n, {}, segs);
      loose = [];
      if (ctx.box === 'ponto-aberto') colorStrong(segs);
      const children = toRuns(segs);
      if (!children.length) return;
      out.push(new Paragraph({ children, alignment: AlignmentType.JUSTIFIED, pageBreakBefore: takeBreak(), ...boxProps(ctx) }));
    };
    for (const node of el.childNodes) {
      if (node.nodeType === ELEMENT && BLOCK.has((node as Element).tagName.toLowerCase())) {
        await flush();
        await block(node as Element, ctx, out);
      } else if (node.nodeType === ELEMENT && (node as Element).tagName.toLowerCase() === 'img' && !loose.length) {
        const run = await imageRun(node as Element, TEXT_W);
        if (run) out.push(new Paragraph({ children: [run], alignment: AlignmentType.CENTER, pageBreakBefore: takeBreak() }));
      } else if (node.nodeType === TEXT || node.nodeType === ELEMENT) {
        loose.push(node);
      }
    }
    await flush();
  }

  async function block(el: Element, ctx: Ctx, out: Block[]): Promise<void> {
    const tag = el.tagName.toLowerCase();
    if (SKIP.has(tag) || cls(el, 'cabecalho') || cls(el, 'rodape-pagina')) return;

    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag[1]);
      const first = breakNext;
      // CSS do modelo: h1 { break-before: page }, menos o .primeiro e o que já abre a folha
      const pageBreak = takeBreak() || (level === 1 && sectionBreaks && pages.length > 0 && !first && !cls(el, 'primeiro'));
      out.push(
        new Paragraph({
          heading: level === 1 ? HeadingLevel.HEADING_1 : level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3,
          children: await runsOf(el),
          pageBreakBefore: pageBreak,
        }),
      );
      return;
    }
    if (tag === 'p' || tag === 'figcaption' || tag === 'dt' || tag === 'dd') {
      const muted = tag === 'figcaption' || cls(el, 'legenda') || cls(el, 'meta') || cls(el, 'nota');
      const f: Fmt = muted ? { color: C.cinza, size: pt(9) } : {};
      const segs: Seg[] = [];
      await collect(el, f, segs);
      if (ctx.box === 'ponto-aberto') colorStrong(segs);
      const children = toRuns(segs);
      if (!children.length) return;
      out.push(
        new Paragraph({
          children,
          alignment: muted ? AlignmentType.LEFT : AlignmentType.JUSTIFIED,
          indent: ctx.indent ? { left: ctx.indent } : undefined,
          pageBreakBefore: takeBreak(),
          ...boxProps(ctx),
        }),
      );
      return;
    }
    if (tag === 'ul' || tag === 'ol') {
      for (const li of el.children) {
        if (li.tagName.toLowerCase() !== 'li') continue;
        await listItem(li, tag === 'ol', ctx, out);
      }
      return;
    }
    if (tag === 'li') return listItem(el, false, ctx, out);
    if (tag === 'table') {
      const table = await tableOf(el);
      if (!table) return;
      if (takeBreak()) out.push(new Paragraph({ pageBreakBefore: true, spacing: { after: 0 } }));
      out.push(table);
      out.push(new Paragraph({ spacing: { after: 0 }, children: [] }));
      return;
    }
    if (tag === 'pre') {
      const lines = (el.textContent ?? '').replace(/\n$/, '').split('\n');
      out.push(
        new Paragraph({
          children: lines.flatMap((l, i) => [new TextRun({ text: l, font: 'Consolas', size: pt(9), break: i ? 1 : undefined })]),
          shading: { type: ShadingType.CLEAR, color: 'auto', fill: C.fundo },
          pageBreakBefore: takeBreak(),
        }),
      );
      return;
    }
    if (tag === 'hr') {
      out.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: LINHA, space: 1 } }, pageBreakBefore: takeBreak() }));
      return;
    }
    if (tag === 'blockquote') return blocks(el, { ...ctx, indent: (ctx.indent ?? 0) + twip(8) }, out);
    if (cls(el, 'alerta') || cls(el, 'ponto-aberto')) {
      const box = cls(el, 'alerta') ? 'alerta' : 'ponto-aberto';
      const hasBlocks = [...el.children].some((c) => BLOCK.has(c.tagName.toLowerCase()));
      if (!hasBlocks) {
        const segs: Seg[] = [];
        await collect(el, {}, segs);
        if (box === 'ponto-aberto') colorStrong(segs);
        out.push(new Paragraph({ children: toRuns(segs), alignment: AlignmentType.JUSTIFIED, pageBreakBefore: takeBreak(), ...boxProps({ ...ctx, box }) }));
        return;
      }
      return blocks(el, { ...ctx, box }, out);
    }
    // div, section, figure… → desce
    return blocks(el, ctx, out);
  }

  /** rótulo em negrito da caixa "ponto em aberto" fica teal escuro (CSS: .ponto-aberto strong) */
  function colorStrong(segs: Seg[]) {
    for (const s of segs) if (s.kind === 'text' && s.f.bold) s.f = { ...s.f, color: C['teal-escuro'] };
  }

  async function listItem(li: Element, ordered: boolean, ctx: Ctx, out: Block[]) {
    const level = Math.min(ctx.listLevel, 8);
    const inline: Node[] = [];
    const nested: Element[] = [];
    for (const n of li.childNodes) {
      if (n.nodeType === ELEMENT && ['ul', 'ol'].includes((n as Element).tagName.toLowerCase())) nested.push(n as Element);
      else inline.push(n);
    }
    const segs: Seg[] = [];
    for (const n of inline) await collect(n, {}, segs);
    out.push(
      new Paragraph({
        children: toRuns(segs),
        alignment: AlignmentType.JUSTIFIED,
        spacing: { after: ptTwip(2) },
        pageBreakBefore: takeBreak(),
        ...(ordered ? { numbering: { reference: 'numerada', level } } : { numbering: { reference: 'marcadores', level } }),
      }),
    );
    for (const sub of nested) await block(sub, { ...ctx, listLevel: ctx.listLevel + 1 }, out);
  }

  const cellBorder = { style: BorderStyle.SINGLE, size: 6, color: LINHA };
  const noBorder = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };

  /**
   * largura de cada coluna (mm): proporcional ao texto mais longo dela, mas nunca
   * menor que a palavra mais longa (cabeçalho incluso) — "Responsável" e datas
   * não quebram no meio; a folga sai das colunas largas
   */
  function columnWidths(rows: Element[], ncols: number): number[] {
    const longest = Array.from({ length: ncols }, () => 0);
    const word = Array.from({ length: ncols }, () => 0);
    for (const tr of rows) {
      let col = 0;
      for (const c of tr.children) {
        const span = Number(c.getAttribute('colspan') || 1);
        if (span === 1 && col < ncols) {
          const text = (c.textContent ?? '').trim();
          longest[col] = Math.max(longest[col], text.length);
          word[col] = Math.max(word[col], ...text.split(/\s+/).map((w) => Math.min(w.length, 18)));
        }
        col += span;
      }
    }
    // ~2,2 mm por caractere a 10 pt em negrito (cabeçalho) + padding da célula (7 pt de cada lado)
    const min = word.map((n) => n * 2.2 + 6);
    const weights = longest.map((n) => Math.min(Math.max(n, 6), 60) + 4);
    const total = weights.reduce((a, b) => a + b, 0);
    const widths = weights.map((w) => (TEXT_W * w) / total);
    if (min.reduce((a, b) => a + b, 0) >= TEXT_W) return widths;
    for (let pass = 0; pass < ncols; pass++) {
      const deficit = widths.reduce((d, w, i) => d + Math.max(0, min[i] - w), 0);
      if (deficit < 0.1) break;
      const spare = widths.map((w, i) => Math.max(0, w - min[i]));
      const pool = spare.reduce((a, b) => a + b, 0);
      for (let i = 0; i < ncols; i++) widths[i] = widths[i] < min[i] ? min[i] : widths[i] - (deficit * spare[i]) / pool;
    }
    return widths;
  }

  async function tableOf(el: Element, ficha = false): Promise<Table | null> {
    const rows = [...el.querySelectorAll('tr')].filter((tr) => tr.closest('table') === el);
    if (!rows.length) return null;
    const ncols = Math.max(...rows.map((tr) => [...tr.children].reduce((n, c) => n + Number(c.getAttribute('colspan') || 1), 0)));
    if (!ncols) return null;
    const widths = ficha ? [TEXT_W * 0.34, TEXT_W * 0.66] : columnWidths(rows, ncols);
    let bodyIndex = 0;
    const out: TableRow[] = [];
    for (const tr of rows) {
      const cells = [...tr.children].filter((c) => /^t[hd]$/i.test(c.tagName));
      const header = !ficha && cells.length > 0 && cells.every((c) => c.tagName.toLowerCase() === 'th');
      if (!header) bodyIndex++;
      const zebra = !ficha && !header && bodyIndex % 2 === 0;
      const tableCells: TableCell[] = [];
      let col = 0;
      for (const c of cells) {
        const span = Number(c.getAttribute('colspan') || 1);
        const isTh = c.tagName.toLowerCase() === 'th';
        const width = widths.slice(col, col + span).reduce((a, b) => a + b, 0);
        col += span;
        let f: Fmt = { size: pt(10) };
        if (isTh && !ficha) f = { ...f, bold: true, color: 'FFFFFF' };
        if (ficha) f = isTh ? { size: pt(9.5), color: C.cinza } : { size: pt(12) };
        if (ficha && cls(c, 'titulo-doc')) f = { size: pt(13), bold: true, font: TITLE_FONT };
        const content: Block[] = [];
        const hasBlocks = [...c.children].some((k) => BLOCK.has(k.tagName.toLowerCase()));
        if (hasBlocks) await blocks(c, { listLevel: 0 }, content);
        else {
          const segs: Seg[] = [];
          await collect(c, ficha && isTh ? { ...f, bold: false } : f, segs);
          if (ficha && isTh) for (const s of segs) if (s.kind === 'text') s.text = s.text.toUpperCase();
          content.push(new Paragraph({ children: toRuns(segs), spacing: { after: 0, line: 276, lineRule: LineRuleType.AUTO }, alignment: AlignmentType.LEFT }));
        }
        tableCells.push(
          new TableCell({
            children: content.length ? content : [new Paragraph({})],
            columnSpan: span > 1 ? span : undefined,
            rowSpan: Number(c.getAttribute('rowspan') || 1) > 1 ? Number(c.getAttribute('rowspan')) : undefined,
            width: { size: twip(width), type: WidthType.DXA },
            verticalAlign: ficha ? VerticalAlign.BOTTOM : VerticalAlign.CENTER,
            shading: header && isTh ? { type: ShadingType.CLEAR, color: 'auto', fill: C.grafite } : zebra ? { type: ShadingType.CLEAR, color: 'auto', fill: C.fundo } : undefined,
            margins: ficha ? { top: ptTwip(8), bottom: ptTwip(8), left: 0, right: ptTwip(7) } : { top: ptTwip(5), bottom: ptTwip(5), left: ptTwip(7), right: ptTwip(7) },
            borders: { top: noBorder, left: noBorder, right: noBorder, bottom: header ? noBorder : cellBorder },
          }),
        );
      }
      out.push(new TableRow({ children: tableCells, tableHeader: header, cantSplit: true }));
    }
    return new Table({
      rows: out,
      width: { size: twip(TEXT_W), type: WidthType.DXA },
      columnWidths: widths.map(twip),
      borders: { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder, insideHorizontal: noBorder, insideVertical: noBorder },
    });
  }

  // ---------- páginas do modelo ----------

  async function coverPage(sec: Element, out: Block[]) {
    const logoEl = sec.querySelector('img.logo') ?? sec.querySelector('img');
    const children: ParagraphChild[] = [];
    if (logoEl) {
      const img = await image(logoEl.getAttribute('src'));
      if (img?.width && img.height) {
        const h = (PAGE_H * css.coverLogoPct) / 100;
        const w = (h * img.width) / img.height;
        children.push(
          new ImageRun({
            type: img.type,
            data: img.data,
            transformation: { width: px(w), height: px(h) },
            altText: altOf(logoEl),
            floating: {
              horizontalPosition: { relative: HorizontalPositionRelativeFrom.PAGE, offset: 0 },
              verticalPosition: { relative: VerticalPositionRelativeFrom.PAGE, offset: emu((PAGE_H - h) / 2) },
              behindDocument: true,
              allowOverlap: true,
              wrap: { type: TextWrappingType.NONE },
            },
          }),
        );
      }
    }
    // texto a partir de --inicio-texto da largura, centrado na vertical
    const indent = { left: twip((PAGE_W * css.coverTextPct) / 100 - MARGIN_X), right: twip(PAGE_W * 0.12 - MARGIN_X) };
    const h1 = sec.querySelector('h1');
    const sub = sec.querySelector('.subtitulo');
    const tag = sec.querySelector('.tagline');
    out.push(
      new Paragraph({
        children: [...children, ...(h1 ? await runsOf(h1, { bold: true, size: pt(13), font: TITLE_FONT, color: C.grafite }) : [])],
        indent,
        spacing: { before: twip(PAGE_H / 2 - TOP_MM - 14), after: 0, line: 276, lineRule: LineRuleType.AUTO },
        keepNext: true,
      }),
    );
    if (sub) out.push(new Paragraph({ children: await runsOf(sub, { size: pt(13), font: TITLE_FONT, color: C.grafite }), indent, spacing: { before: twip(4), after: 0, line: 276, lineRule: LineRuleType.AUTO } }));
    if (tag && (tag.textContent ?? '').trim()) out.push(new Paragraph({ children: await runsOf(tag, { color: C.teal }), indent, spacing: { before: twip(10), after: 0 } }));
  }

  async function fichaPage(sec: Element, out: Block[]) {
    const table = sec.querySelector('table');
    if (!table) return blocks(sec, { listLevel: 0 }, out);
    const rows = table.querySelectorAll('tr').length;
    // centra a ficha na folha: ~11 mm por linha
    const tableH = rows * 11;
    out.push(new Paragraph({ pageBreakBefore: takeBreak(), spacing: { before: twip(Math.max(0, PAGE_H / 2 - TOP_MM - tableH / 2)), after: 0 } }));
    const t = await tableOf(table, true);
    if (t) out.push(t);
  }

  async function indexPage(sec: Element, out: Block[]) {
    const area = sec.querySelector('.area') ?? sec;
    for (const child of area.children) {
      const tag = child.tagName.toLowerCase();
      if (tag === 'h1') {
        out.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: await runsOf(child, { size: pt(16) }), pageBreakBefore: takeBreak(), spacing: { after: ptTwip(10) } }));
      } else if (tag === 'ol' || tag === 'ul') {
        for (const li of child.querySelectorAll('li')) {
          const num = li.querySelector('.num');
          const nome = li.querySelector('.nome');
          const pag = li.querySelector('.pag');
          const children: ParagraphChild[] = [];
          if (num) children.push(...(await runsOf(num, { bold: true, font: TITLE_FONT, color: C['teal-escuro'] })), new TextRun({ text: '\t' }));
          children.push(...(await runsOf(nome ?? li, { color: C.grafite })));
          if (pag) children.push(new TextRun({ text: '\t' }), ...(await runsOf(pag, { color: C.cinza })));
          out.push(
            new Paragraph({
              children,
              tabStops: [
                { type: TabStopType.LEFT, position: ptTwip(22) },
                { type: TabStopType.RIGHT, position: twip(TEXT_W), leader: 'dot' },
              ],
              border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: LINHA, space: 4 } },
              spacing: { before: ptTwip(5), after: ptTwip(5) },
              pageBreakBefore: takeBreak(),
            }),
          );
        }
      } else {
        await block(child, { listLevel: 0 }, out);
      }
    }
  }

  // ---------- montagem ----------

  const body: Block[] = [];
  if (pages.length) {
    for (const [i, sec] of pages.entries()) {
      breakNext = i > 0;
      if (sec === cover) await coverPage(sec, body);
      else if (cls(sec, 'ficha-folha')) await fichaPage(sec, body);
      else if (cls(sec, 'indice')) await indexPage(sec, body);
      else await blocks(sec.querySelector('.area') ?? sec, { listLevel: 0 }, body);
    }
  } else {
    await blocks(doc.body, { listLevel: 0 }, body);
  }

  // cabeçalho (logo à direita) e rodapé (texto + "página N") das páginas internas
  const headerImg = inner?.querySelector('.cabecalho img');
  let header: Header | undefined;
  if (headerImg) {
    const r = await imageRun(headerImg, TEXT_W, css.headerLogoMm);
    if (r) header = new Header({ children: [new Paragraph({ children: [r], alignment: AlignmentType.RIGHT, spacing: { after: 0, line: 240, lineRule: LineRuleType.AUTO } })] });
  }
  const rodape = inner?.querySelector('.rodape-pagina');
  let footer: Footer | undefined;
  if (rodape) {
    const label = rodape.querySelector('.pagina-numero');
    const textEl = [...rodape.children].find((c) => c !== label);
    footer = new Footer({
      children: [
        new Paragraph({
          children: [
            ...(textEl ? await runsOf(textEl, { size: pt(8), color: C.cinza }) : []),
            new TextRun({ text: '\t' }),
            new TextRun({ children: [(label?.textContent ?? '').replace(/\s+/g, ' ').replace(/^ /, ''), PageNumber.CURRENT], size: pt(8), color: C.cinza }),
          ],
          tabStops: [{ type: TabStopType.RIGHT, position: twip(TEXT_W) }],
          border: { top: { style: BorderStyle.SINGLE, size: 4, color: LINHA, space: 4 } },
          spacing: { after: 0 },
        }),
      ],
    });
  }
  const coverFooterEl = cover?.querySelector('.rodape');
  const coverFooter = new Footer({
    children: coverFooterEl
      ? [new Paragraph({ children: await runsOf(coverFooterEl, { size: pt(9), color: C.cinza }), alignment: AlignmentType.CENTER, spacing: { after: twip(8) } })]
      : [],
  });

  const title = (doc.querySelector('title')?.textContent ?? '').trim();
  return new DocxDocument({
    title,
    creator: 'Tania',
    styles: {
      default: {
        document: {
          run: { font: BODY_FONT, size: pt(11), color: C.grafite },
          // lineRule explícito: sem ele o LibreOffice lê a entrelinha como exata e corta imagens
          paragraph: { spacing: { after: ptTwip(8), line: 360, lineRule: LineRuleType.AUTO } },
        },
        heading1: {
          run: { font: TITLE_FONT, size: pt(12), bold: true, color: C['teal-escuro'] },
          paragraph: { spacing: { before: 0, after: ptTwip(6) }, keepNext: true },
        },
        heading2: {
          run: { font: TITLE_FONT, size: pt(11), bold: true, color: C.grafite },
          paragraph: { spacing: { before: ptTwip(12), after: ptTwip(4) }, keepNext: true },
        },
        heading3: {
          run: { font: TITLE_FONT, size: pt(11), bold: true, color: C.cinza },
          paragraph: { spacing: { before: ptTwip(10), after: ptTwip(4) }, keepNext: true },
        },
        hyperlink: { run: { color: C.teal, underline: {} } },
      },
    },
    numbering: {
      config: [
        {
          reference: 'marcadores',
          levels: Array.from({ length: 9 }, (_, level) => ({
            level,
            format: LevelFormat.BULLET,
            text: ['•', '◦', '▪'][level % 3],
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: twip(6 + level * 6), hanging: twip(4) } } },
          })),
        },
        {
          reference: 'numerada',
          levels: Array.from({ length: 9 }, (_, level) => ({
            level,
            format: [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN][level % 3],
            text: `%${level + 1}.`,
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: twip(7 + level * 6), hanging: twip(5) } } },
          })),
        },
      ],
    },
    sections: [
      {
        properties: {
          titlePage: !!cover,
          page: {
            size: { width: twip(PAGE_W), height: twip(PAGE_H) },
            margin: { top: twip(TOP_MM), bottom: twip(24), left: twip(MARGIN_X), right: twip(MARGIN_X), header: twip(16), footer: twip(12) },
          },
        },
        headers: { default: header ?? new Header({ children: [] }), ...(cover ? { first: new Header({ children: [] }) } : {}) },
        footers: { default: footer ?? new Footer({ children: [] }), ...(cover ? { first: coverFooter } : {}) },
        children: body.length ? body : [new Paragraph({})],
      },
    ],
  });
}

/**
 * docMarca.ts — monta uma nota já renderizada no formato do documento A4
 * Tania (as mesmas classes do modelo 99-Meta/attachments/Apresentacoes/
 * Modelo-documento.html), para o htmlToDocx.ts gerar o
 * Word com capa, cabeçalho e rodapé. Sem LLM: qualquer tamanho de nota.
 *
 *   capa      → logo Cloud, título, subtítulo (subtitle | purpose | description)
 *   ficha     → só se o frontmatter tiver cliente/responsável/versão
 *   conteúdo  → o markdown renderizado; "# Título" inicial sai (já está na capa),
 *               ## vira Título 1, ### vira Título 2…; callouts viram caixas
 */
export type NoteMeta = { title: string; frontmatter: Record<string, unknown>; date: string };

const LOGO_CAPA = '/brand/logo-capa.png';
const LOGO_CABECALHO = '/brand/logo.png';
/** > [!warning] e parecidos → caixa âmbar; o resto (note, tip, info…) → caixa teal */
const ALERTA = /callout-(warning|danger|caution|bug|failure)/;

function field(fm: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = fm[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return '';
}

export function noteToMarcaDoc(doc: Document, rendered: Element, meta: NoteMeta): Document {
  const fm = meta.frontmatter;
  const el = (tag: string, cls?: string, text?: string) => {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const img = (src: string, cls: string) => {
    const i = el('img', cls) as HTMLImageElement;
    i.src = src;
    i.alt = 'Tania';
    return i;
  };
  const rodapeLinha = `${meta.date} · Tania · uso interno`;
  const folha = (cls: string, area: Element) => {
    const sec = el('section', `pagina ${cls}`);
    const cab = el('div', 'cabecalho');
    cab.append(img(LOGO_CABECALHO, 'logo-horizontal'));
    const rod = el('div', 'rodape-pagina');
    rod.append(el('span', undefined, rodapeLinha), el('span', 'pagina-numero', 'página '));
    sec.append(cab, area, rod);
    return sec;
  };

  doc.title = `${meta.title} — Tania`;
  doc.body.replaceChildren();

  // capa
  const capa = el('section', 'pagina capa');
  const bloco = el('div', 'bloco-texto');
  bloco.append(el('h1', undefined, meta.title));
  const sub = field(fm, ['subtitle', 'subtitulo', 'purpose', 'description']);
  if (sub) bloco.append(el('p', 'subtitulo', sub));
  capa.append(img(LOGO_CAPA, 'logo'), bloco, el('p', 'rodape', `${meta.date} · Tania`));
  doc.body.append(capa);

  // ficha: só com dados de verdade
  const linhas: [string, string][] = [
    ['Cliente / área', field(fm, ['cliente', 'client', 'area'])],
    ['Responsável', field(fm, ['responsavel', 'owner', 'autor', 'author'])],
    ['Versão', field(fm, ['versao', 'version'])],
  ];
  if (linhas.some(([, v]) => v)) {
    const table = el('table');
    const rows: [string, string][] = [['Documento', meta.title], ...linhas.filter(([, v]) => v), ['Data', meta.date]];
    for (const [k, v] of rows) {
      const tr = el('tr');
      const td = el('td', k === 'Documento' ? 'titulo-doc' : undefined, v);
      tr.append(el('th', undefined, k), td);
      table.append(tr);
    }
    const ficha = el('div', 'ficha');
    ficha.append(table);
    const area = el('div', 'area');
    area.append(ficha);
    doc.body.append(folha('ficha-folha', area));
  }

  // conteúdo
  const area = el('div', 'area');
  area.append(...[...rendered.childNodes].map((n) => doc.importNode(n, true)));
  const first = area.firstElementChild;
  if (first?.tagName === 'H1') first.remove();
  area.querySelectorAll('.embed, .embed-media, .lightbox, .print-cover').forEach((e) => e.remove());
  // "## Seção" é o nível de seção das notas: sobe um nível (h1 do modelo = seção)
  if (!area.querySelector('h1')) {
    for (const h of [...area.querySelectorAll('h2, h3, h4, h5, h6')]) {
      const up = el(`h${Number(h.tagName[1]) - 1}`);
      up.append(...h.childNodes);
      h.replaceWith(up);
    }
  }
  area.querySelector('h1')?.classList.add('primeiro');
  for (const q of [...area.querySelectorAll('blockquote.callout')]) {
    const box = el('div', ALERTA.test(q.className) ? 'alerta' : 'ponto-aberto');
    box.append(...q.childNodes);
    q.replaceWith(box);
  }
  // tarefas "- [ ]" / "- [x]": o checkbox vira caractere
  for (const box of [...area.querySelectorAll('input[type="checkbox"]')]) {
    box.replaceWith(doc.createTextNode((box as HTMLInputElement).checked || box.hasAttribute('checked') ? '☑ ' : '☐ '));
  }
  doc.body.append(folha('conteudo', area));
  return doc;
}

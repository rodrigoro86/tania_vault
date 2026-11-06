/**
 * exportNote.ts — exportar a nota aberta: .md (download) ou PDF (impressão do
 * navegador → "Salvar como PDF"; nada roda no servidor).
 *
 * PDF: o CSS @media print (styles.css) esconde a interface e deixa a nota em
 * página clara. `body[data-print="marca"]` aplica a identidade visual do
 * AGENTS.md §8 (capa, Poppins/Arial, paleta) — ver 04-Agentes/Prompts/Identidade-Visual.md.
 */
import type { Note } from './vault';

export type PrintMode = 'simple' | 'marca';

/** baixa o markdown cru da nota (frontmatter incluído) */
export function downloadMarkdown(note: Note): void {
  const blob = new Blob([note.raw], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = note.path.split('/').pop() ?? `${note.name}.md`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const POPPINS = 'https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap';

function ensurePoppins(): Promise<void> {
  if (!document.querySelector(`link[href="${POPPINS}"]`)) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = POPPINS;
    document.head.append(link);
  }
  // espera a fonte de fato (máx. 3 s: sem rede, imprime com Arial)
  return Promise.race([
    document.fonts.load('600 16px Poppins').then(() => undefined),
    new Promise<void>((r) => setTimeout(r, 3000)),
  ]);
}

/** imagens com loading="lazy" fora da tela não carregam sozinhas antes da impressão */
async function loadImages(root: ParentNode): Promise<void> {
  const imgs = [...root.querySelectorAll<HTMLImageElement>('.note img')];
  for (const img of imgs) img.loading = 'eager';
  await Promise.race([
    Promise.all(imgs.map((img) => (img.complete ? Promise.resolve() : img.decode().catch(() => undefined)))),
    new Promise<void>((r) => setTimeout(r, 8000)),
  ]);
}

/** abre o diálogo de impressão com a nota formatada; o título vira o nome sugerido do PDF */
export async function printNote(note: Note, mode: PrintMode): Promise<void> {
  if (mode === 'marca') await ensurePoppins();
  await loadImages(document);
  const previousTitle = document.title;
  document.title = note.name;
  document.body.dataset.print = mode;
  const cleanup = () => {
    delete document.body.dataset.print;
    document.title = previousTitle;
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  window.print();
  // navegadores sem afterprint confiável (alguns móveis): limpa depois
  setTimeout(cleanup, 60_000);
}

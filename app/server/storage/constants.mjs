/**
 * constants.mjs — regras compartilhadas entre a API e os stores.
 * Ficam aqui (e não em vault-api) para o store não importar vault-api (ciclo).
 */

/** nota do vault = markdown ou base */
export const NOTE_EXT = /\.(md|base)$/i;

/** pastas que nunca fazem parte do vault */
export const SKIP_DIRS = new Set([
  '.obsidian',
  '.git',
  '.github',
  'node_modules',
  'app',
  'agents',
  'backend', // código Rust (inclui target/ do cargo)
  'front',
  'dist',
  'dist-smoke',
  'tmp',
  '.trash',
]);

/** anexos servidos em /files/<caminho>; lista fechada de extensões */
export const FILE_TYPES = {
  png: { mime: 'image/png', kind: 'image' },
  jpg: { mime: 'image/jpeg', kind: 'image' },
  jpeg: { mime: 'image/jpeg', kind: 'image' },
  gif: { mime: 'image/gif', kind: 'image' },
  webp: { mime: 'image/webp', kind: 'image' },
  avif: { mime: 'image/avif', kind: 'image' },
  bmp: { mime: 'image/bmp', kind: 'image' },
  svg: { mime: 'image/svg+xml', kind: 'image', sandbox: true, text: true },
  html: { mime: 'text/html; charset=utf-8', kind: 'html', sandbox: true, text: true },
  htm: { mime: 'text/html; charset=utf-8', kind: 'html', sandbox: true, text: true },
  pdf: { mime: 'application/pdf', kind: 'pdf' },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', kind: 'office' },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', kind: 'office' },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', kind: 'office' },
  csv: { mime: 'text/csv; charset=utf-8', kind: 'text', text: true },
  txt: { mime: 'text/plain; charset=utf-8', kind: 'text', text: true },
  mp4: { mime: 'video/mp4', kind: 'video' },
  webm: { mime: 'video/webm', kind: 'video' },
  mp3: { mime: 'audio/mpeg', kind: 'audio' },
};

export const fileType = (name) => FILE_TYPES[(/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase()] ?? null;

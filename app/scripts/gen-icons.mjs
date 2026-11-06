#!/usr/bin/env node
/**
 * gen-icons.mjs — gera os ícones do PWA em app/public/icons (sem dependências:
 * rasteriza o cristal com supersampling e codifica PNG com o zlib do Node).
 *
 * Uso: node scripts/gen-icons.mjs
 *   icon-192.png, icon-512.png           "any": cristal sobre quadrado arredondado
 *   icon-maskable-512.png                "maskable": fundo cheio, cristal na zona segura (80%)
 *   apple-touch-icon.png (180)           iOS (sem transparência)
 *   icon.svg                             favicon vetorial
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'public', 'icons');
const BG = [0x16, 0x19, 0x1b];
const DARK = [0x3a, 0x8a, 0x7c];
const MID = [0x4f, 0xab, 0x9a];
const LIGHT = [0x8f, 0xd3, 0xc7];

// cristal em coordenadas 0..1 (centro 0.5,0.5): topo, ombros, ponta de baixo, "cintura" das facetas
const P = { top: [0.5, 0.1], r: [0.8, 0.4], bot: [0.5, 0.92], l: [0.2, 0.4], c: [0.5, 0.46] };
const FACETS = [
  { pts: [P.top, P.c, P.l], color: LIGHT },
  { pts: [P.top, P.r, P.c], color: MID },
  { pts: [P.l, P.c, P.bot], color: MID },
  { pts: [P.c, P.r, P.bot], color: DARK },
];

function inPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inRoundRect(x, y, r) {
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** cor (rgba) de um ponto do ícone; `scale` encolhe o cristal em volta do centro */
function sample(x, y, { scale, radius, opaque }) {
  if (!opaque && !inRoundRect(x, y, radius)) return [0, 0, 0, 0];
  const u = (x - 0.5) / scale + 0.5;
  const v = (y - 0.5) / scale + 0.5;
  for (const f of FACETS) if (inPoly(u, v, f.pts)) return [...f.color, 255];
  return [...BG, 255];
}

function render(size, opts, ss = 4) {
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0, 0];
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = sample((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size, opts);
          // pré-multiplica pelo alpha para a borda arredondada não escurecer
          acc[0] += c[0] * c[3];
          acc[1] += c[1] * c[3];
          acc[2] += c[2] * c[3];
          acc[3] += c[3];
        }
      }
      const i = (y * size + x) * 4;
      const a = acc[3] / (ss * ss);
      px[i] = acc[3] ? Math.round(acc[0] / acc[3]) : 0;
      px[i + 1] = acc[3] ? Math.round(acc[1] / acc[3]) : 0;
      px[i + 2] = acc[3] ? Math.round(acc[2] / acc[3]) : 0;
      px[i + 3] = Math.round(a);
    }
  }
  return png(size, px);
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bits por canal
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function svg() {
  const hex = (c) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  const poly = (f) => `<polygon points="${f.pts.map(([x, y]) => `${x * 100},${y * 100}`).join(' ')}" fill="${hex(f.color)}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="${hex(BG)}"/><g transform="translate(50 50) scale(0.86) translate(-50 -50)">${FACETS.map(poly).join('')}</g></svg>\n`;
}

fs.mkdirSync(OUT, { recursive: true });
const any = { scale: 0.86, radius: 0.22, opaque: false };
const files = {
  'icon-192.png': render(192, any),
  'icon-512.png': render(512, any),
  // maskable: o SO recorta círculo/squircle; o conteúdo precisa caber nos 80% centrais
  'icon-maskable-512.png': render(512, { scale: 0.62, radius: 0, opaque: true }),
  'apple-touch-icon.png': render(180, { scale: 0.8, radius: 0, opaque: true }),
  'icon.svg': svg(),
};
for (const [name, data] of Object.entries(files)) {
  fs.writeFileSync(path.join(OUT, name), data);
  console.log(`${name.padEnd(24)} ${data.length} bytes`);
}

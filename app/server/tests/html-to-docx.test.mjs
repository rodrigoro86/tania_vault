/**
 * html-to-docx.test.mjs — conversão do documento A4 em .docx (src/htmlToDocx.ts).
 *
 * Roda:  node --test server/tests/html-to-docx.test.mjs   (Node >= 22.18: type stripping)
 *
 * Usa o modelo real (99-Meta/attachments/Apresentacoes/Modelo-documento.html)
 * e os logos de public/brand. Cobre: capa com logo em sangria e rodapé próprio,
 * cabeçalho com logo e rodapé com número de página nas internas, quebras por
 * .pagina e por h1, estilos de título, tabelas, caixas alerta/ponto em aberto,
 * índice com pontilhado e HTML sem .pagina. Grava o .docx em DOCX_OUT, se definido.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { Packer } from 'docx';
import JSZip from 'jszip';
import { htmlToDocx } from '../../src/htmlToDocx.ts';
import { noteToMarcaDoc } from '../../src/docMarca.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONT = path.resolve(HERE, '..', '..');
const MODELO = path.resolve(FRONT, '..', '99-Meta/attachments/Apresentacoes/Modelo-documento.html');

/** lê /brand/<arquivo> de public/brand; largura/altura do cabeçalho IHDR do PNG */
const requested = [];
async function loadImage(src) {
  requested.push(src);
  const name = new URL(src, 'https://x/').pathname.match(/^\/brand\/(.+)$/)?.[1];
  if (!name) return null;
  const data = await fs.readFile(path.join(FRONT, 'public/brand', name)).catch(() => null);
  if (!data) return null;
  return { data: new Uint8Array(data), type: 'png', width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

async function convert(html, prepare = (doc) => doc, opts) {
  const doc = prepare(new JSDOM(html).window.document);
  const buffer = await Packer.toBuffer(await htmlToDocx(doc, loadImage, opts));
  const zip = await JSZip.loadAsync(buffer);
  const read = (name) => zip.file(name)?.async('string') ?? Promise.resolve('');
  const files = Object.keys(zip.files);
  return { buffer, files, read };
}

test('modelo A4 vira docx com capa, cabeçalho, rodapé e estilos', { skip: !existsSync(MODELO) ? 'modelo com capa ausente (fixture do vault)' : false }, async () => {
  const html = await fs.readFile(MODELO, 'utf8');
  const { buffer, files, read } = await convert(html);
  if (process.env.DOCX_OUT) await fs.writeFile(process.env.DOCX_OUT, buffer);

  const body = await read('word/document.xml');
  const styles = await read('word/styles.xml');
  const headers = await Promise.all(files.filter((f) => /^word\/header\d+\.xml$/.test(f)).map(read));
  const footers = await Promise.all(files.filter((f) => /^word\/footer\d+\.xml$/.test(f)).map(read));

  // A4 e 1ª página com header/footer próprios
  assert.match(body, /<w:pgSz w:w="11906" w:h="16838"/);
  assert.match(body, /<w:titlePg\/>/);

  // capa: logo Cloud flutuando na borda esquerda da página, atrás do texto
  assert.ok(requested.some((s) => s.endsWith('/brand/logo-capa.png')));
  assert.match(body, /<wp:anchor[^>]*behindDoc="1"/);
  assert.match(body, /<wp:positionH relativeFrom="page"><wp:posOffset>0<\/wp:posOffset>/);
  assert.ok(body.includes('{{titulo}}') && body.includes('{{subtitulo}}'));

  // cabeçalho com o logo horizontal; rodapé com texto + campo PAGE; rodapé da capa
  assert.ok(headers.some((h) => h.includes('<pic:pic')), 'logo no cabeçalho');
  assert.ok(footers.some((f) => f.includes('PAGE') && f.includes('uso interno') && f.includes('página')), 'rodapé com número de página');
  assert.ok(footers.some((f) => !f.includes('PAGE') && f.includes('{{site}}')), 'rodapé da capa');

  // títulos com estilo de Word (navegação/sumário) e cores da identidade visual
  assert.match(body, /<w:pStyle w:val="Heading1"\/>/);
  assert.match(body, /<w:pStyle w:val="Heading2"\/>/);
  assert.match(styles, /Poppins/);
  assert.match(styles, /2E8AA6/);

  // capa + ficha + índice + conteúdo, e h1 do conteúdo (menos o .primeiro) em página nova
  const breaks = body.match(/<w:pageBreakBefore\/>/g)?.length ?? 0;
  assert.ok(breaks >= 3 + 3, `quebras de página: ${breaks}`);

  // tabelas: cabeçalho grafite que repete, zebra; ficha em maiúsculas
  assert.match(body, /<w:tblHeader\/>/);
  assert.match(body, /w:fill="2B2929"/);
  assert.match(body, /w:fill="F4F9FA"/);
  assert.ok(body.includes('CLIENTE / ÁREA'));

  // caixas: âmbar com borda D4A72C, ponto em aberto com borda teal
  assert.match(body, /w:fill="FFF7E0"/);
  assert.match(body, /<w:left w:val="single" w:color="D4A72C"/);
  assert.match(body, /<w:left w:val="single" w:color="40A8C4"/);

  // índice: tabulação à direita com pontilhado
  assert.match(body, /<w:tab w:val="right" w:pos="\d+" w:leader="dot"\/>/);
  assert.ok(body.includes('Próximos passos'));

  // nada do cabeçalho/rodapé HTML vaza no corpo
  assert.ok(!body.includes('pagina-numero'));
});

test('HTML sem .pagina vira documento simples, sem header/footer', async () => {
  const { read } = await convert(`<!doctype html><title>Nota</title><body>
    <h1>Título</h1><p>Um <strong>texto</strong> com <a href="https://marca.com">link</a>.</p>
    <ul><li>um<ul><li>dois</li></ul></li></ul><script>alert(1)</script></body>`);
  const body = await read('word/document.xml');
  assert.ok(!body.includes('<w:titlePg/>'));
  assert.ok(!body.includes('pageBreakBefore'), 'h1 inicial não quebra página');
  assert.ok(body.includes('w:hyperlink'));
  assert.match(body, /<w:ilvl w:val="1"\/>/);
  assert.ok(!body.includes('alert(1)'));
});

test('nota no padrão Tania: capa, ficha do frontmatter, seções sem página nova, callouts', async () => {
  const markdown = `<div class="markdown">
    <h1>Ata de alinhamento</h1>
    <p>Abertura.</p>
    <h2>Contexto</h2><p>Texto <strong>forte</strong>.</p>
    <h3>Detalhe</h3><p>Mais.</p>
    <blockquote class="callout callout-warning"><p><strong>Risco:</strong> prazo curto.</p></blockquote>
    <blockquote class="callout callout-note"><p><strong>Em aberto:</strong> orçamento.</p></blockquote>
    <h2>Tarefas</h2><ul><li><input type="checkbox" checked disabled> feito</li><li><input type="checkbox" disabled> pendente</li></ul>
    <figure class="embed embed-html"><iframe src="/files/x.html"></iframe></figure>
  </div>`;
  const meta = { title: 'Ata de alinhamento', frontmatter: { description: 'Projeto X', cliente: 'Delta' }, date: '2026-10-26' };
  const { read, files, buffer } = await convert(`<!doctype html><body>${markdown}</body>`, (doc) =>
    noteToMarcaDoc(doc, doc.querySelector('.markdown'), meta), { sectionBreaks: false });
  if (process.env.DOCX_OUT) await fs.writeFile(process.env.DOCX_OUT.replace(/\.docx$/, '-nota.docx'), buffer);
  const body = await read('word/document.xml');
  const footers = await Promise.all(files.filter((f) => /^word\/footer\d+\.xml$/.test(f)).map(read));

  assert.match(body, /<w:titlePg\/>/);
  assert.match(body, /<wp:anchor[^>]*behindDoc="1"/);
  assert.ok(body.includes('Projeto X'), 'subtítulo da capa');
  assert.ok(body.includes('DELTA') || body.includes('Delta'), 'ficha com o cliente');
  assert.ok(footers.some((f) => f.includes('PAGE') && f.includes('2026-10-26 · Tania · uso interno')));
  // título só na capa; ## → Título 1, ### → Título 2
  assert.equal(body.split('Ata de alinhamento').length - 1, 2, 'capa + ficha');
  assert.match(body, /<w:pStyle w:val="Heading1"\/>(?:(?!<\/w:p>).)*Contexto/s);
  assert.match(body, /<w:pStyle w:val="Heading2"\/>(?:(?!<\/w:p>).)*Detalhe/s);
  // capa | ficha | conteúdo: 2 quebras, sem página nova por seção
  assert.equal(body.match(/<w:pageBreakBefore\/>/g)?.length, 2);
  assert.match(body, /w:fill="FFF7E0"/);
  assert.match(body, /<w:left w:val="single" w:color="40A8C4"/);
  assert.ok(body.includes('☑') && body.includes('☐'));
  assert.ok(!body.includes('x.html'));
});

test('nota sem cliente/responsável/versão não ganha ficha', async () => {
  const meta = { title: 'Nota', frontmatter: {}, date: '2026-10-26' };
  const { read } = await convert('<!doctype html><body><div class="markdown"><p>oi</p></div></body>', (doc) =>
    noteToMarcaDoc(doc, doc.querySelector('.markdown'), meta), { sectionBreaks: false });
  const body = await read('word/document.xml');
  assert.ok(!body.includes('DOCUMENTO'));
  assert.equal(body.match(/<w:pageBreakBefore\/>/g)?.length, 1);
});

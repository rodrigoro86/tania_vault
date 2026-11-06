/**
 * context.test.mjs — orçamento de contexto do agente (server/agent/context.ts).
 *
 * Roda:  node --test server/tests/context.test.mjs   (Node >= 22.18: type stripping)
 *
 * Cobre: sumário de seções (ignora # dentro de código), leitura por seção e
 * offset cortando em fim de linha, max_tokens por host/config, compactação do
 * histórico sem separar tool_calls das respostas e sem perder o último pedido.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outlineOf, readPart, maxTokensFor, compactHistory, OLD_TOOL_KEEP } from '../agent/context.ts';

const NOTE = ['# Título', 'intro', '## Um', 'texto um', '```bash', '# comentario, não é título', '```', '### Um.1', 'sub', '## Dois', 'texto dois', ''].join('\n');

test('outline: níveis, intervalos e # dentro de código ignorado', () => {
  const o = outlineOf(NOTE);
  assert.deepEqual(o.map((s) => [s.level, s.heading]), [[1, 'Título'], [2, 'Um'], [3, 'Um.1'], [2, 'Dois']]);
  const um = o[1];
  assert.match(NOTE.slice(um.start, um.end), /^## Um[\s\S]*### Um\.1\nsub\n$/);
  assert.equal(o[0].end, NOTE.length);
});

test('readPart: seção sem acento/caixa, offset e corte em fim de linha', () => {
  const dois = readPart(NOTE, { section: 'dois' });
  assert.ok(dois.ok);
  assert.equal(dois.content, '## Dois\ntexto dois\n');
  assert.equal(dois.next_offset, undefined);
  assert.equal(readPart(NOTE, { section: 'nao existe' }).ok, false);

  const long = Array.from({ length: 100 }, (_, i) => `linha ${i} ${'x'.repeat(40)}`).join('\n');
  const p1 = readPart(long, {}, 1000);
  assert.ok(p1.ok && p1.content.endsWith('\n') && p1.content.length <= 1000);
  const p2 = readPart(long, { offset: p1.next_offset }, 1000);
  assert.ok(p2.ok && p2.content.startsWith('linha '));
  assert.equal(p1.content + p2.content, long.slice(0, p2.offset + p2.content.length));
});

test('maxTokensFor: config vence, DeepSeek tem padrão, resto sem limite', () => {
  assert.equal(maxTokensFor('https://api.deepseek.com/v1'), 8192);
  assert.equal(maxTokensFor('https://api.deepseek.com/v1', 2000), 2000);
  assert.equal(maxTokensFor('https://api.openai.com/v1'), undefined);
  assert.equal(maxTokensFor('lixo', 'abc'), undefined);
});

test('compactHistory: compacta turnos antigos, mantém o turno atual e corta pelo orçamento', () => {
  const big = 'y'.repeat(OLD_TOOL_KEEP + 500);
  const callArgs = JSON.stringify({ path: '99-Meta/attachments/x.html', content: 'z'.repeat(5000) });
  const msgs = [
    { role: 'user', content: 'primeiro' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'create_file', arguments: callArgs } }] },
    { role: 'tool', tool_call_id: 'a', content: big },
    { role: 'user', content: 'atual' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'b', type: 'function', function: { name: 'read_note', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'b', content: big },
  ];
  const out = compactHistory(msgs);
  assert.match(out[2].content, /compactado/);
  assert.match(out[1].tool_calls[0].function.arguments, /x\.html.*5\d{3} caracteres/);
  assert.equal(out[5].content, big, 'turno atual fica inteiro');

  // orçamento pequeno: o turno antigo sai inteiro, começando num "user"
  const cut = compactHistory(msgs, 100);
  assert.equal(cut[0].content, 'atual');
  assert.equal(cut.length, 3);
});

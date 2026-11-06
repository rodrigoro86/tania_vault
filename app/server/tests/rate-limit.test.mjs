/**
 * rate-limit.test.mjs — limitador em memória por IP (janela fixa).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimit } from '../rate-limit.mjs';

test('rate limit: cap por IP e janela independente', () => {
  const allow = createRateLimit({ windowMs: 60_000, max: 2 });
  assert.equal(allow('1.1.1.1'), true);
  assert.equal(allow('1.1.1.1'), true);
  assert.equal(allow('1.1.1.1'), false, 'terceira estoura o cap');
  assert.equal(allow('2.2.2.2'), true, 'outro IP tem a própria janela');
});

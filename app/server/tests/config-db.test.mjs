/**
 * config-db.test.mjs — carga da configuração do banco (spec F2d).
 *
 * Roda:  npm run test
 *
 * Cobre: decifrar o vetor AES-256-GCM do Rust (`v1:nonce‖cifrado‖tag`), loadDbConfig
 * com um pool falso (banco vence o env, segredo que não decifra é pulado), a
 * tabela ausente (42P01) e qualquer outro erro (só loga), e o isTrustedProxy
 * (x-tania-proxy + LEGACY_PROXY_SECRET) que libera o /api/internal/restart.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decifrar, loadDbConfig } from '../config-db.mjs';
import { isTrustedProxy } from '../auth.mjs';

// chave de desenvolvimento do compose: 32 × 0x01
const KEY = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';
// nonce 12 × 0x02, texto "segredo-123" (vetor da spec, idêntico ao teste do Rust)
const VETOR = 'v1:AgICAgICAgICAgICdLOuOy8zrtDi/o+FiZpSjLX0DVK6OayjlgMf';

test('decifrar: vetor da spec, chave errada e lixo', () => {
  assert.equal(decifrar(VETOR, KEY), 'segredo-123');
  assert.equal(decifrar(VETOR, Buffer.alloc(32, 3).toString('base64')), null); // tag não bate
  assert.equal(decifrar('lixo', KEY), null);
  assert.equal(decifrar(undefined, KEY), null);
  assert.equal(decifrar(VETOR, undefined), null); // sem TANIA_CONFIG_KEY
});

test('loadDbConfig: aplica no process.env e pula segredo que não decifra', async () => {
  const result = await loadDbConfig({
    key: KEY,
    query: async () => ({
      rows: [
        { chave: 'TESTE_PLANO', valor: 'abc', segredo: false },
        { chave: 'TESTE_SEG', valor: VETOR, segredo: true },
        { chave: 'TESTE_RUIM', valor: 'v1:xx', segredo: true },
      ],
    }),
  });
  assert.deepEqual(result, { aplicadas: 2 });
  assert.equal(process.env.TESTE_PLANO, 'abc'); // banco vence o env
  assert.equal(process.env.TESTE_SEG, 'segredo-123');
  assert.equal(process.env.TESTE_RUIM, undefined); // não decifrou -> não aplica
  delete process.env.TESTE_PLANO;
  delete process.env.TESTE_SEG;
});

test('loadDbConfig: tabela ausente (42P01) ou query quebrada não derrubam o server', async () => {
  const semTabela = await loadDbConfig({
    key: KEY,
    query: async () => {
      throw Object.assign(new Error('relation "configuracoes" does not exist'), { code: '42P01' });
    },
  });
  assert.deepEqual(semTabela, { aplicadas: 0 });

  const quebrada = await loadDbConfig({ key: KEY, query: async () => { throw new Error('connection refused'); } });
  assert.deepEqual(quebrada, { aplicadas: 0 });
});

test('isTrustedProxy: header certo passa, errado/ausente/secret vazio não', () => {
  assert.equal(isTrustedProxy({ headers: { 'x-tania-proxy': 's' } }, 's'), true);
  assert.equal(isTrustedProxy({ headers: { 'x-tania-proxy': 's' } }, 't'), false);
  assert.equal(isTrustedProxy({ headers: {} }, 's'), false);
  assert.equal(isTrustedProxy({ headers: { 'x-tania-proxy': '' } }, 's'), false);
  assert.equal(isTrustedProxy({ headers: { 'x-tania-proxy': 's' } }, ''), false);
});

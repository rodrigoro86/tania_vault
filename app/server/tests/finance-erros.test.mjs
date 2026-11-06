/**
 * finance-erros.test.mjs — erros do schema `alugueis` viram mensagem pronta
 * para a tela, com o mesmo status da API de aluguéis (core/errors.py).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { traduzErroBanco } from '../finance.mjs';

test('constraint e hint do gatilho têm prioridade sobre o SQLSTATE', () => {
  const sobreposto = traduzErroBanco({ code: '23P01', constraint: 'um_contrato_por_imovel' });
  assert.equal(sobreposto.status, 409);
  assert.match(sobreposto.message, /já tem um contrato/);

  const documento = traduzErroBanco({ code: '23505', constraint: 'inquilinos_documento_key' });
  assert.equal(documento.status, 409);

  const mes = traduzErroBanco({ code: 'P0001', hint: 'mes_fora_do_contrato' });
  assert.equal(mes.status, 422);
});

test('SQLSTATE genérico: uuid inválido e cadastro inexistente', () => {
  assert.equal(traduzErroBanco({ code: '22P02' }).status, 422);
  assert.equal(traduzErroBanco({ code: '23503' }).status, 404);
});

test('erro desconhecido passa intacto', () => {
  const err = new Error('conexão caiu');
  assert.equal(traduzErroBanco(err), err);
});

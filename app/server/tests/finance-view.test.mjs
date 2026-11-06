/**
 * finance-view.test.mjs — formatação/cálculos da tela 💰 Financeiro
 * (`src/financeView.ts`).
 *
 * Roda: node --test server/tests/finance-view.test.mjs   (Node >= 22.18: .ts por type stripping)
 *
 * Por que testar isso: a tela lê `numeric` do Postgres (que chega como string) e
 * escreve datas em AAAA-MM-DD. Se a conversão erra, o aluguel aparece com valor
 * trocado ou o recebimento cai no dia/mês errado — e o resumo do Carnê-Leão vai
 * junto. Nada aqui toca DOM, rede ou banco.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  MESES,
  TIPOS_RECEBIMENTO,
  alugueisDoMes,
  brl,
  documentoLabel,
  mesRefLabel,
  dataBR,
  hojeISO,
  mesAtual,
  mesLabel,
  mesVizinho,
  parseMoney,
  tipoLabel,
  vencimentoLabel,
} = await import('../../src/financeView.ts');

/** o Intl usa espaço não separável depois do "R$" */
const semNbsp = (s) => s.replace(/\u00a0/g, ' ');

test('brl formata número, string do pg e vazio', () => {
  assert.equal(semNbsp(brl(1800)), 'R$ 1.800,00');
  assert.equal(semNbsp(brl('1800.00')), 'R$ 1.800,00'); // numeric do pg vem string
  assert.equal(semNbsp(brl('2210.5')), 'R$ 2.210,50');
  assert.equal(semNbsp(brl(0)), 'R$ 0,00');
  assert.equal(brl(null), '—');
  assert.equal(brl(undefined), '—');
  assert.equal(brl(''), '—');
  assert.equal(brl('abc'), '—');
});

test('parseMoney entende o que o usuário digita em pt-BR', () => {
  assert.equal(parseMoney('1800'), 1800);
  assert.equal(parseMoney(1800), 1800);
  assert.equal(parseMoney('1800,50'), 1800.5);
  assert.equal(parseMoney('1.800,00'), 1800); // milhar com ponto + decimal com vírgula
  assert.equal(parseMoney('R$ 1.800'), 1800); // "R$" e espaço são ignorados
  assert.equal(parseMoney('1800.00'), 1800); // formato que vem do Postgres
  assert.equal(parseMoney('1.234.567'), 1234567); // só milhar, sem decimal
  assert.ok(Number.isNaN(parseMoney('')));
  assert.ok(Number.isNaN(parseMoney('abc')));
});

test('hojeISO usa o fuso local, não UTC', () => {
  // 31/10 às 21h local: toISOString() devolveria 2026-11-01 em UTC-3
  assert.equal(hojeISO(new Date(2026, 9, 31, 21, 30)), '2026-10-31');
  assert.equal(hojeISO(new Date(2026, 0, 1, 0, 5)), '2026-01-01');
  assert.equal(hojeISO(new Date(2026, 11, 9, 23, 59)), '2026-12-09');
});

test('mesAtual devolve mês 1..12 (getMonth é 0-based)', () => {
  assert.deepEqual(mesAtual(new Date(2026, 9, 31)), { ano: 2026, mes: 10 });
  assert.deepEqual(mesAtual(new Date(2026, 0, 1)), { ano: 2026, mes: 1 });
  assert.deepEqual(mesAtual(new Date(2026, 11, 31)), { ano: 2026, mes: 12 });
});

test('mesLabel escreve o mês em português', () => {
  assert.equal(mesLabel(2026, 10), 'outubro/2026');
  assert.equal(mesLabel(2027, 1), 'janeiro/2027');
  assert.equal(MESES.length, 12);
});

test('mesVizinho vira o ano nos dois sentidos', () => {
  assert.deepEqual(mesVizinho(2026, 1, -1), { ano: 2025, mes: 12 });
  assert.deepEqual(mesVizinho(2026, 12, 1), { ano: 2027, mes: 1 });
  assert.deepEqual(mesVizinho(2026, 10, -1), { ano: 2026, mes: 9 });
  assert.deepEqual(mesVizinho(2026, 6, 12), { ano: 2027, mes: 6 });
});

test('vencimentoLabel trata dia válido, nulo e texto', () => {
  assert.equal(vencimentoLabel(10), 'vence dia 10');
  assert.equal(vencimentoLabel('5'), 'vence dia 5');
  assert.equal(vencimentoLabel(null), 'sem vencimento');
  assert.equal(vencimentoLabel(undefined), 'sem vencimento');
  assert.equal(vencimentoLabel(0), 'sem vencimento');
});

test('dataBR converte AAAA-MM-DD sem passar por Date (não desloca fuso)', () => {
  assert.equal(dataBR('2026-10-31'), '31/10/2026');
  assert.equal(dataBR('2026-01-01'), '01/01/2026');
  assert.equal(dataBR(null), '—');
  assert.equal(dataBR('qualquer'), 'qualquer');
});

test('tipoLabel: boleto é reconhecido mas não está entre os tipos de recebimento', () => {
  assert.equal(tipoLabel('pix'), 'Pix');
  assert.equal(tipoLabel('transferencia'), 'Transferência');
  assert.equal(tipoLabel('dinheiro'), 'Dinheiro');
  assert.equal(tipoLabel('boleto'), 'Boleto');
  assert.equal(tipoLabel('outro'), 'Outro');
  assert.equal(tipoLabel('qualquer-coisa'), 'Outro');
  // regra do domínio: a tela não oferece boleto como recebimento
  assert.ok(!TIPOS_RECEBIMENTO.includes('boleto'));
  assert.deepEqual([...TIPOS_RECEBIMENTO], ['pix', 'dinheiro', 'transferencia', 'outro']);
});

test('alugueisDoMes: situação de cada aluguel, com o que pede atenção primeiro', () => {
  const contrato = (id, dia, extra = {}) => ({
    id, dia_vencimento: dia, valor_aluguel: '1000.00', status: 'ativo',
    data_inicio: '2026-01-01', data_fim: '2026-12-31', ...extra,
  });
  const lista = alugueisDoMes(
    [
      contrato('pago', 5),
      contrato('futuro', 28),
      contrato('atraso', 10),
      contrato('metade', 10),
      contrato('encerrado', 5, { status: 'encerrado' }),
      contrato('fora', 5, { data_inicio: '2026-11-01' }),
    ],
    [
      { contrato_id: 'pago', valor: '1000.00' },
      { contrato_id: 'metade', valor: '400.00' }, // valor diferente do contrato também quita o mês
    ],
    '2026-10',
    '2026-10-20',
  );
  assert.deepEqual(
    lista.map((a) => [a.contrato.id, a.situacao, a.falta]),
    [['atraso', 'atrasado', 1000], ['futuro', 'a_receber', 1000], ['pago', 'recebido', 0], ['metade', 'recebido', 0]],
  );
});

test('alugueisDoMes: dia 31 em mês curto vence no último dia', () => {
  const c = { id: 'x', dia_vencimento: 31, valor_aluguel: 1000, status: 'ativo', data_inicio: '2026-01-01', data_fim: '2026-12-31' };
  assert.equal(alugueisDoMes([c], [], '2026-02', '2026-02-28')[0].situacao, 'a_receber');
  assert.equal(alugueisDoMes([c], [], '2026-02', '2026-03-01')[0].situacao, 'atrasado');
});

test('documentoLabel e mesRefLabel', () => {
  assert.equal(documentoLabel('12345678901'), '123.456.789-01');
  assert.equal(documentoLabel('12345678000199'), '12.345.678/0001-99');
  assert.equal(documentoLabel('123'), '123');
  assert.equal(mesRefLabel('2026-10'), 'outubro/2026');
});

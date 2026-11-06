/**
 * investimentos-db.test.mjs — o ciclo inteiro contra um Postgres de verdade, com
 * mercado, LLM e WhatsApp falsos. Só roda com TEST_DATABASE_URL (banco descartável):
 * apaga o schema `investimentos`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { test } from 'node:test';

const url = process.env.TEST_DATABASE_URL;

test('ciclo completo de investimentos', { skip: !url && 'sem TEST_DATABASE_URL' }, async (t) => {
  process.env.DATABASE_URL = url;
  const { getPool, query } = await import('../db.mjs');
  await query('drop schema if exists investimentos cascade');
  for (const m of ['003_investimentos.sql', '004_acompanhadas.sql']) await query(await fs.readFile(new URL(`../migrations/${m}`, import.meta.url), 'utf8'));
  const inv = await import('../investimentos.mjs');
  const rot = await import('../investimentos-rotinas.mjs');
  t.after(() => getPool().end());

  const enviados = [];
  const pedidos = [];
  let abertura = 10;
  let fecho = 12;
  let respostas = {};
  const deps = {
    cotacao: async (ticker, op = {}) => ({
      ticker, preco: fecho, variacao: -4,
      historico: op.historico ? (deps.dias ?? []).map((data) => ({ data, abertura, fechamento: fecho })) : [],
      dividendos: ticker === 'PETR4' ? (deps.dividendos ?? []) : [],
    }),
    cdi: async () => [{ data: '2026-10-05', valor: 0.05 }],
    chat: async (sistema, usuario) => {
      pedidos.push({ sistema, usuario });
      if (sistema.includes('analista')) return 'resumo do dia';
      return JSON.stringify(respostas[JSON.parse(usuario).relatorios ? 'com' : 'sem'] ?? { analise: 'esperar', ordens: [] });
    },
    enviar: async (texto) => enviados.push(texto),
  };

  await t.test('lista de acompanhadas: valida, mostra preço e 30 dias, entra nas rotinas e sai', async () => {
    const antes = new Date(Date.now() - 40 * 864e5).toISOString().slice(0, 10);
    const consultar = async (ticker, op) => {
      assert.equal(op.historico, true);
      if (ticker === 'ZZZZ9') throw new Error('brapi ZZZZ9: HTTP 404');
      if (ticker === 'FORA3') throw new Error('brapi FORA3: HTTP 503');
      return { ticker, preco: 11, variacao: 1.5, historico: [{ data: antes, abertura: 10, fechamento: 10 }], dividendos: [] };
    };
    await assert.rejects(inv.acompanhar({ ticker: 'X' }, { consultar }), /ticker inválido/);
    await assert.rejects(inv.acompanhar({ ticker: 'zzzz9' }, { consultar }), /não encontrei ZZZZ9/);
    await inv.acompanhar({ ticker: 'wege3' }, { consultar });
    await inv.acompanhar({ ticker: 'WEGE3' }, { consultar });
    await inv.acompanhar({ ticker: 'FORA3' }, { consultar });
    assert.deepEqual((await inv.resumo()).acompanhadas.map((a) => [a.ticker, a.preco, a.variacao_30d]), [['FORA3', null, null], ['WEGE3', 11, 10]]);
    const vistos = [];
    await rot.ciclo('2026-10-05', { ...deps, cotacao: async (ticker) => { vistos.push(ticker); return { ticker, preco: 12, variacao: 0, historico: [], dividendos: [] }; } });
    assert.deepEqual(vistos.sort(), ['FORA3', 'WEGE3']);
    assert.equal((await inv.listarAcompanhadas()).find((a) => a.ticker === 'FORA3').preco, 12);
    await inv.deixarDeAcompanhar('fora3');
    await inv.deixarDeAcompanhar('WEGE3');
    await assert.rejects(inv.deixarDeAcompanhar('WEGE3'), /não está na lista/);
  });

  await t.test('aporte espelha; compra sem caixa gera aporte; venda além da posição falha', async () => {
    await inv.registrarMovimento({ tipo: 'aporte', valor: 1000, data: '2026-10-05' });
    for (const c of ['real', 'agente', 'agente_relatorios']) assert.equal((await inv.listarMovimentos(c)).length, 1, c);
    await inv.registrarMovimento({ tipo: 'compra', ticker: 'petr4', quantidade: 200, preco: 10, data: '2026-10-05' });
    const agente = await inv.listarMovimentos('agente');
    assert.deepEqual(agente.map((m) => Number(m.valor)), [1000, 1000], 'o agente recebe o mesmo aporte, não a compra');
    await assert.rejects(inv.registrarMovimento({ tipo: 'venda', ticker: 'PETR4', quantidade: 201, preco: 10, data: '2026-10-05' }), /posição insuficiente/);
    await assert.rejects(inv.registrarMovimento({ tipo: 'compra', ticker: 'X', quantidade: 1, preco: 1 }), /ticker inválido/);
    await assert.rejects(inv.registrarMovimento({ tipo: 'aporte', valor: 1, data: '2099-01-01' }), /futuro/);
  });

  await t.test('apagar aporte leva o espelho junto', async () => {
    await inv.registrarMovimento({ tipo: 'aporte', valor: 5, data: '2026-10-05' });
    const m = (await inv.listarMovimentos('real')).find((x) => Number(x.valor) === 5);
    await inv.removerMovimento(m.id);
    assert.ok(!(await inv.listarMovimentos('agente')).some((x) => Number(x.valor) === 5));
  });

  await t.test('sem pregão não decide', async () => {
    deps.dias = [];
    await rot.fechamento('2026-10-06', deps);
    assert.equal(pedidos.length, 0);
    assert.equal((await query("select 1 from investimentos.rotinas where chave = 'historico:2026-10-06'")).rowCount, 0, 'fechamento atrasado tenta de novo');
  });

  await t.test('decide no dia 1 sem ver a carteira real e executa na abertura do dia 2', async () => {
    await inv.criarRelatorio({ titulo: 'R', texto: 'compre', data: '2026-10-05' }, {
      chat: async () => JSON.stringify({ resumo: 'r', recomendacoes: [{ ticker: 'VALE3', acao: 'compra', motivo: 'm' }] }),
    });
    respostas = {
      sem: { analise: 'a', ordens: [{ lado: 'compra', ticker: 'VALE3', quantidade: 10, motivo: 'barata' }, { lado: 'compra', ticker: 'PETR4', quantidade: 9999, motivo: 'exagero' }] },
      com: { analise: 'b', ordens: [] },
    };
    deps.dias = ['2026-10-07'];
    await rot.fechamento('2026-10-07', deps);
    assert.equal((await inv.listarOrdens()).filter((o) => o.status === 'pendente').length, 2);
    const decisoes = pedidos.filter((p) => p.sistema.includes('FICTÍCIA'));
    assert.equal(decisoes.length, 2);
    assert.ok(!decisoes[0].usuario.includes('"relatorios"'), 'o independente não vê relatórios');
    assert.ok(decisoes[1].usuario.includes('VALE3') && JSON.parse(decisoes[1].usuario).relatorios.length === 1);
    assert.ok(decisoes.every((p) => !JSON.parse(p.usuario).posicoes.length), 'nenhuma posição real vazou');
    assert.equal(enviados.at(-1), 'resumo do dia');

    pedidos.length = 0;
    await rot.fechamento('2026-10-07', deps);
    assert.equal(pedidos.length, 0, 'mesma etapa não roda duas vezes');

    abertura = 11;
    fecho = 20;
    deps.dias = ['2026-10-07', '2026-10-08'];
    respostas = {};
    await rot.fechamento('2026-10-08', deps);
    const ordens = await inv.listarOrdens();
    const certa = ordens.find((o) => o.quantidade === 10);
    assert.equal(certa.status, 'executada');
    assert.equal(Number(certa.preco), 11, 'preço de abertura do dia seguinte, não o fechamento');
    assert.equal(ordens.find((o) => o.quantidade === 9999).status, 'recusada');
    const compra = (await inv.listarMovimentos('agente')).find((m) => m.tipo === 'compra');
    assert.equal(Number(compra.valor), 110.03);
  });

  await t.test('provento credita uma vez, para quem tinha na data-com', async () => {
    deps.dividendos = [{ dataCom: '2026-10-05', pagamento: '2026-10-08', valorPorAcao: 1, jcp: false }];
    deps.dias = ['2026-10-09'];
    await rot.fechamento('2026-10-09', deps);
    await query("delete from investimentos.rotinas where chave like 'historico:%'");
    await rot.fechamento('2026-10-09', deps);
    const prov = (await inv.listarMovimentos('real')).filter((m) => m.tipo === 'provento');
    assert.deepEqual(prov.map((m) => Number(m.valor)), [200]);
    assert.ok(!(await inv.listarMovimentos('agente')).some((m) => m.tipo === 'provento'), 'o agente não tinha PETR4');
  });

  await t.test('alerta dispara uma vez por dia', async () => {
    await inv.criarAlerta({ ticker: 'PETR4', tipo: 'queda_dia', valor: 3 });
    enviados.length = 0;
    await rot.ciclo('2026-10-09', deps);
    await rot.ciclo('2026-10-09', deps);
    assert.equal(enviados.length, 1);
    assert.match(enviados[0], /PETR4 caiu 4%/);
  });

  await t.test('resumo traz as três carteiras e comparação', async () => {
    const r = await inv.resumo();
    assert.equal(r.carteiras.length, 3);
    const real = r.carteiras[0];
    assert.equal(real.id, 'real');
    assert.equal(real.posicoes[0].quantidade, 200);
    assert.equal(real.patrimonio, 4200);
    assert.ok(real.retorno > 0);
    assert.ok(r.carteiras[1].patrimonio !== real.patrimonio);
  });

  await t.test('falha libera a etapa para tentar de novo', async () => {
    deps.dias = ['2026-10-12'];
    const chat = deps.chat;
    deps.chat = async () => 'sem json';
    await assert.rejects(rot.fechamento('2026-10-12', deps), /JSON válido/);
    deps.chat = chat;
    await rot.fechamento('2026-10-12', deps);
    assert.ok((await inv.listarAnalises({ tipo: 'decisao' })).some((a) => a.data === '2026-10-12'));
  });

  await t.test('relógio de São Paulo', () => {
    assert.deepEqual(rot.relogio(new Date('2026-11-03T21:30:00Z')), { dia: '2026-11-03', hora: '18:30', fimDeSemana: false });
    assert.equal(rot.relogio(new Date('2026-11-01T12:00:00Z')).fimDeSemana, true);
  });
});

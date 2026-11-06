/**
 * investimentos-calc.mjs — cálculos puros da carteira: posições, caixa,
 * rentabilidade e simulador. A IA só propõe ordens; quem decide o que é válido
 * e o resultado é este código, sem rede nem banco.
 */

/** emolumentos da B3, aproximado; corretagem zero (shortcut: revisar se a corretora cobrar) */
export const TAXA_SIMULADA = 0.0003;
export const MAX_ORDENS_DIA = 5;
const TICKER = /^[A-Z]{4}\d{1,2}$/;

export const tickerValido = (t) => TICKER.test(String(t ?? ''));
const cent = (n) => Math.round(n * 100) / 100;

const SINAL_CAIXA = { aporte: 1, retirada: -1, compra: -1, venda: 1, provento: 1 };

/** movimentos em ordem de data; `ate` inclusive */
export function estado(movimentos, ate = '9999-12-31') {
  const posicoes = new Map();
  let caixa = 0;
  let aportes = 0;
  for (const m of movimentos) {
    if (String(m.data).slice(0, 10) > ate) continue;
    const valor = Number(m.valor);
    caixa += SINAL_CAIXA[m.tipo] * valor;
    if (m.tipo === 'aporte') aportes += valor;
    if (m.tipo === 'retirada') aportes -= valor;
    if (m.tipo !== 'compra' && m.tipo !== 'venda') continue;
    const p = posicoes.get(m.ticker) ?? { ticker: m.ticker, quantidade: 0, custo: 0 };
    if (m.tipo === 'compra') {
      p.quantidade += m.quantidade;
      p.custo += valor;
    } else {
      // venda baixa o custo pelo preço médio
      p.custo -= p.quantidade ? (p.custo / p.quantidade) * m.quantidade : 0;
      p.quantidade -= m.quantidade;
    }
    posicoes.set(m.ticker, p);
  }
  const lista = [...posicoes.values()].filter((p) => p.quantidade > 0);
  return {
    caixa: cent(caixa),
    aportes: cent(aportes),
    posicoes: lista.map((p) => ({ ...p, custo: cent(p.custo), preco_medio: cent(p.custo / p.quantidade) })),
  };
}

/** valor da compra/venda já com as taxas: compra soma, venda desconta */
export const valorOperacao = (lado, quantidade, preco, taxas) => cent(quantidade * preco + (lado === 'compra' ? taxas : -taxas));

/**
 * simula uma ordem contra o estado atual. Devolve o movimento ou { erro }.
 * Nunca fica com caixa negativo nem vende o que não tem.
 */
export function simularOrdem(atual, ordem, preco) {
  if (!(preco > 0)) return { erro: `${ordem.ticker}: sem preço de abertura` };
  const taxas = cent(ordem.quantidade * preco * TAXA_SIMULADA);
  const valor = valorOperacao(ordem.lado, ordem.quantidade, preco, taxas);
  if (ordem.lado === 'compra' && valor > atual.caixa) return { erro: `caixa insuficiente: R$ ${atual.caixa} para R$ ${valor}` };
  if (ordem.lado === 'venda') {
    const tem = atual.posicoes.find((p) => p.ticker === ordem.ticker)?.quantidade ?? 0;
    if (ordem.quantidade > tem) return { erro: `posição insuficiente: ${tem} ${ordem.ticker}` };
  }
  return { movimento: { tipo: ordem.lado, ticker: ordem.ticker, quantidade: ordem.quantidade, preco, taxas, valor } };
}

/** extrai o JSON de resposta do LLM; o que não for válido é descartado */
export function lerDecisao(texto, tickers) {
  let dados;
  try {
    dados = JSON.parse(String(texto).slice(String(texto).indexOf('{'), String(texto).lastIndexOf('}') + 1));
  } catch {
    return { analise: '', ordens: [], erro: 'resposta sem JSON válido' };
  }
  const ordens = (Array.isArray(dados.ordens) ? dados.ordens : [])
    .filter((o) => ['compra', 'venda'].includes(o?.lado) && tickers.has(o?.ticker) && Number.isInteger(o?.quantidade) && o.quantidade > 0)
    .slice(0, MAX_ORDENS_DIA)
    .map((o) => ({ lado: o.lado, ticker: o.ticker, quantidade: o.quantidade, motivo: String(o.motivo ?? '').slice(0, 300) || 'sem motivo' }));
  return { analise: String(dados.analise ?? '').slice(0, 2000), ordens };
}

/** extrai o que interessa do relatório: só dados, nunca instruções */
export function lerRelatorio(texto) {
  let dados;
  try {
    dados = JSON.parse(String(texto).slice(String(texto).indexOf('{'), String(texto).lastIndexOf('}') + 1));
  } catch {
    return { resumo: '', recomendacoes: [] };
  }
  const recomendacoes = (Array.isArray(dados.recomendacoes) ? dados.recomendacoes : [])
    .filter((r) => tickerValido(r?.ticker) && ['compra', 'venda', 'manter'].includes(r?.acao))
    .slice(0, 30)
    .map((r) => ({
      ticker: r.ticker,
      acao: r.acao,
      preco_alvo: Number(r.preco_alvo) > 0 ? Number(r.preco_alvo) : null,
      motivo: String(r.motivo ?? '').slice(0, 200),
    }));
  return { resumo: String(dados.resumo ?? '').slice(0, 1500), recomendacoes };
}

/**
 * patrimônio dia a dia e rentabilidade por cotas: aporte não conta como ganho.
 * `precos`: { TICKER: [{data, fechamento}] } em ordem de data; índices idem.
 */
export function serie(movimentos, precos, { ibov = [], cdi = [] } = {}) {
  const movs = [...movimentos].sort((a, b) => String(a.data).localeCompare(String(b.data)));
  if (!movs.length) return [];
  const inicio = String(movs[0].data).slice(0, 10);
  // carteira só com caixa também precisa de pontos: as datas vêm de todo o mercado
  const todas = [...Object.values(precos).flat(), ...ibov, ...cdi].map((p) => String(p.data).slice(0, 10));
  const datas = [...new Set([inicio, ...todas.filter((d) => d >= inicio)])].sort();
  const pontos = [];
  const ultimo = {};
  const historico = Object.entries(precos).map(([t, l]) => [t, l, 0]);
  const ibovDe = indice(ibov);
  const cdiAte = compostoDiario(cdi, inicio);
  let cota = 1;
  let anterior = 0;
  for (const data of datas) {
    for (const h of historico) {
      while (h[2] < h[1].length && String(h[1][h[2]].data).slice(0, 10) <= data) ultimo[h[0]] = Number(h[1][h[2]++].fechamento);
    }
    const e = estado(movs, data);
    const patrimonio = cent(e.caixa + e.posicoes.reduce((s, p) => s + p.quantidade * (ultimo[p.ticker] ?? p.preco_medio), 0));
    const fluxo = movs
      .filter((m) => String(m.data).slice(0, 10) === data && (m.tipo === 'aporte' || m.tipo === 'retirada'))
      .reduce((s, m) => s + (m.tipo === 'aporte' ? 1 : -1) * Number(m.valor), 0);
    if (anterior > 0) cota *= (patrimonio - fluxo) / anterior;
    anterior = patrimonio;
    pontos.push({
      data,
      patrimonio,
      retorno: pct(cota),
      ibov: ibovDe(data, inicio),
      cdi: pct(cdiAte(data)),
    });
  }
  return pontos;
}

const pct = (fator) => Math.round((fator - 1) * 10000) / 100;

function indice(lista) {
  const ate = (d) => {
    let v = null;
    for (const p of lista) {
      if (String(p.data).slice(0, 10) > d) break;
      v = Number(p.valor);
    }
    return v;
  };
  return (data, inicio) => {
    const base = ate(inicio) ?? Number(lista[0]?.valor);
    const v = ate(data);
    return base && v ? pct(v / base) : null;
  };
}

/** CDI: taxa % ao dia, composta depois do início */
function compostoDiario(lista, inicio) {
  return (data) => lista.reduce((f, p) => {
    const d = String(p.data).slice(0, 10);
    return d > inicio && d <= data ? f * (1 + Number(p.valor) / 100) : f;
  }, 1);
}

/** provento: quem tinha na data-com recebe; JCP tem 15% retidos na fonte */
export function creditoProvento(movimentos, ticker, { dataCom, valorPorAcao, jcp }) {
  const q = estado(movimentos, dataCom).posicoes.find((p) => p.ticker === ticker)?.quantidade ?? 0;
  return cent(q * valorPorAcao * (jcp ? 0.85 : 1));
}

/** alerta disparou? `dados`: {preco, variacao} */
export function alertaDisparou(alerta, dados) {
  const valor = Number(alerta.valor);
  if (alerta.tipo === 'queda_dia') return Number(dados.variacao) <= -valor;
  if (alerta.tipo === 'preco_acima') return Number(dados.preco) >= valor;
  return Number(dados.preco) <= valor;
}

/**
 * investimentos-mercado.mjs — dados externos: cotações e proventos (brapi) e CDI
 * (Banco Central). BRAPI_TOKEN no .env; o plano gratuito tem atraso de 30 min e
 * um ticker por requisição. O token vai na URL: nunca logar a URL.
 */
const BRAPI = 'https://brapi.dev/api';
const SP = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' });

export const IBOV = '^BVSP';
export const mercadoConfigurado = () => Boolean(process.env.BRAPI_TOKEN);

/** data de pregão da brapi (epoch à meia-noite de São Paulo) -> AAAA-MM-DD */
export const dataPregao = (epoch) => SP.format(new Date(epoch * 1000));

export function lerCotacao(r) {
  return {
    ticker: r.symbol,
    preco: r.regularMarketPrice,
    variacao: r.regularMarketChangePercent ?? null,
    historico: (r.historicalDataPrice ?? [])
      .filter((h) => h.close > 0)
      .map((h) => ({ data: dataPregao(h.date), abertura: h.open ?? null, fechamento: h.close })),
    dividendos: (r.dividendsData?.cashDividends ?? [])
      .filter((d) => d.rate > 0 && d.lastDatePrior && d.paymentDate)
      .map((d) => ({
        dataCom: SP.format(new Date(d.lastDatePrior)),
        pagamento: SP.format(new Date(d.paymentDate)),
        valorPorAcao: d.rate,
        jcp: /jcp/i.test(d.label ?? ''),
      })),
  };
}

export async function cotacao(ticker, { historico = false } = {}) {
  const url = new URL(`${BRAPI}/quote/${encodeURIComponent(ticker)}`);
  if (historico) {
    url.searchParams.set('range', '3mo');
    url.searchParams.set('interval', '1d');
    url.searchParams.set('dividends', 'true');
  }
  url.searchParams.set('token', process.env.BRAPI_TOKEN ?? '');
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`brapi ${ticker}: HTTP ${res.status}`);
  const r = (await res.json()).results?.[0];
  if (!r) throw new Error(`brapi ${ticker}: sem resultado`);
  return lerCotacao(r);
}

/** CDI: % ao dia, série 12 do SGS. Devolve [{data, valor}] */
export async function cdi(desde) {
  const [a, m, d] = desde.split('-');
  const url = `https://api.bcb.gov.br/dados/serie/bcdata.sgs.12/dados?formato=json&dataInicial=${d}/${m}/${a}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`BCB: HTTP ${res.status}`);
  return (await res.json()).map((p) => ({ data: p.data.split('/').reverse().join('-'), valor: Number(p.valor) }));
}

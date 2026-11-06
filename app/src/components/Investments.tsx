import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent, PointerEvent } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  investApi,
  type AlertaInv,
  type AnaliseInv,
  type CarteiraInv,
  type MovimentoInv,
  type OrdemInv,
  type RelatorioInv,
  type ResumoInv,
} from '../api';
import { brl, dataBR, hojeISO, parseMoney } from '../financeView';
import { Campo, Janela } from './Finance';

/**
 * Investments.tsx — tela 📈 Investimentos (`/investimentos`): sua carteira contra
 * Ibovespa, CDI e dois agentes fictícios. A fonte de verdade é o schema
 * `investimentos` (`/api/investimentos/*`). A Tania não opera na corretora: aqui só
 * se registra o que já foi feito.
 */

const ABAS = [
  ['', 'Visão geral'],
  ['agentes', 'Agentes'],
  ['movimentos', 'Movimentos'],
  ['relatorios', 'Relatórios'],
  ['alertas', 'Alertas'],
] as const;

const TIPOS = ['compra', 'venda', 'aporte', 'retirada', 'provento'] as const;
const TIPO_ALERTA: Record<string, string> = { queda_dia: 'Queda no dia (%)', preco_acima: 'Preço acima de', preco_abaixo: 'Preço abaixo de' };
const NOME_CARTEIRA: Record<string, string> = { real: 'Minha carteira', agente: 'Agente independente', agente_relatorios: 'Agente com relatórios' };

const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${v.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`);
const sinal = (v: number) => (v > 0 ? 'fin-verde' : v < 0 ? 'fin-vermelho' : '');

/** cores validadas no fundo escuro do app; índices tracejados, para não depender só da cor */
const LINHAS = [
  { chave: 'real', nome: 'Minha carteira', cor: '#3987e5' },
  { chave: 'agente', nome: 'Agente independente', cor: '#d95926' },
  { chave: 'agente_relatorios', nome: 'Agente com relatórios', cor: '#199e70' },
  { chave: 'ibov', nome: 'Ibovespa', cor: '#c98500', tracejada: true },
  { chave: 'cdi', nome: 'CDI', cor: '#d55181', tracejada: true },
];

type Linha = Record<string, number | string | null>;

/** uma linha por data, com o retorno de cada carteira e dos índices */
function juntarSeries(carteiras: CarteiraInv[]): Linha[] {
  const datas = new Map<string, Linha>();
  for (const c of carteiras) {
    for (const p of c.serie) {
      const l = datas.get(p.data) ?? { data: p.data, ibov: p.ibov, cdi: p.cdi };
      l[c.id] = p.retorno;
      datas.set(p.data, l);
    }
  }
  return [...datas.values()].sort((a, b) => String(a.data).localeCompare(String(b.data)));
}

function Grafico({ linhas, temIbov }: { linhas: Linha[]; temIbov: boolean }) {
  const [foco, setFoco] = useState<number | null>(null);
  const series = LINHAS.filter((s) => s.chave !== 'ibov' || temIbov);
  const W = 720;
  const H = 260;
  const M = { t: 12, r: 12, b: 24, l: 48 };
  const valores = linhas.flatMap((l) => series.map((s) => l[s.chave])).filter((v): v is number => typeof v === 'number');
  const min = Math.min(0, ...valores);
  const max = Math.max(0, ...valores);
  const folga = (max - min || 1) * 0.08;
  const x = (i: number) => M.l + (linhas.length > 1 ? (i / (linhas.length - 1)) * (W - M.l - M.r) : 0);
  const y = (v: number) => H - M.b - ((v - (min - folga)) / (max - min + 2 * folga)) * (H - M.t - M.b);
  const marcas = [min, (min + max) / 2, max];

  function mover(e: PointerEvent<SVGSVGElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    setFoco(Math.max(0, Math.min(linhas.length - 1, Math.round(((px - M.l) / (W - M.l - M.r)) * (linhas.length - 1)))));
  }

  const atual = foco === null ? null : linhas[foco];
  return (
    <figure className="inv-grafico">
      <figcaption>Rentabilidade acumulada desde o primeiro aporte (aportes não contam como ganho)</figcaption>
      <ul className="inv-legenda">
        {series.map((s) => (
          <li key={s.chave}>
            <svg width="22" height="8" aria-hidden="true">
              <line x1="0" y1="4" x2="22" y2="4" stroke={s.cor} strokeWidth="2" strokeDasharray={s.tracejada ? '5 4' : undefined} />
            </svg>
            {s.nome}
          </li>
        ))}
      </ul>
      <div className="inv-plot">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Rentabilidade acumulada das carteiras e dos índices" onPointerMove={mover} onPointerLeave={() => setFoco(null)}>
          {marcas.map((m) => (
            <g key={m}>
              <line x1={M.l} x2={W - M.r} y1={y(m)} y2={y(m)} className={m === 0 ? 'inv-zero' : 'inv-grade'} />
              <text x={M.l - 6} y={y(m) + 4} textAnchor="end" className="inv-eixo">{pct(Math.round(m * 100) / 100)}</text>
            </g>
          ))}
          <text x={M.l} y={H - 6} className="inv-eixo">{dataBR(String(linhas[0].data))}</text>
          {linhas.length > 1 && <text x={W - M.r} y={H - 6} textAnchor="end" className="inv-eixo">{dataBR(String(linhas.at(-1)?.data))}</text>}
          {series.map((s) => {
            const pontos = linhas.flatMap((l, i) => (typeof l[s.chave] === 'number' ? [`${x(i)},${y(l[s.chave] as number)}`] : []));
            return <polyline key={s.chave} points={pontos.join(' ')} fill="none" stroke={s.cor} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" strokeDasharray={s.tracejada ? '5 4' : undefined} />;
          })}
          {foco !== null && <line x1={x(foco)} x2={x(foco)} y1={M.t} y2={H - M.b} className="inv-mira" />}
        </svg>
        {atual && (
          <div className="inv-tooltip" style={{ left: `${(x(foco ?? 0) / W) * 100}%` }} data-lado={(foco ?? 0) > linhas.length / 2 ? 'esq' : 'dir'}>
            <strong>{dataBR(String(atual.data))}</strong>
            {series.map((s) => (
              <span key={s.chave}>{s.nome}: {pct(atual[s.chave] as number | null)}</span>
            ))}
          </div>
        )}
      </div>
      <details>
        <summary>Ver em tabela</summary>
        <div className="inv-tabela">
          <table>
            <thead><tr><th>Data</th>{series.map((s) => <th key={s.chave}>{s.nome}</th>)}</tr></thead>
            <tbody>
              {linhas.slice(-30).reverse().map((l) => (
                <tr key={String(l.data)}><td>{dataBR(String(l.data))}</td>{series.map((s) => <td key={s.chave}>{pct(l[s.chave] as number | null)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

function Posicoes({ carteira }: { carteira: CarteiraInv }) {
  if (!carteira.posicoes.length) return <p className="muted">Sem ações em carteira.</p>;
  return (
    <div className="inv-tabela">
      <table>
        <thead><tr><th>Ação</th><th>Qtd.</th><th>Preço médio</th><th>Preço</th><th>Dia</th><th>Valor</th><th>Resultado</th></tr></thead>
        <tbody>
          {carteira.posicoes.map((p) => (
            <tr key={p.ticker}>
              <th scope="row">{p.ticker}</th>
              <td>{p.quantidade}</td>
              <td>{brl(p.preco_medio)}</td>
              <td>{brl(p.preco)}</td>
              <td className={sinal(Number(p.variacao))}>{pct(p.variacao)}</td>
              <td>{brl(p.valor)}</td>
              <td className={sinal(p.resultado)}>{brl(p.resultado)} ({pct(p.resultado_pct)})</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const MOV_VAZIO = { tipo: 'compra', ticker: '', quantidade: '', preco: '', valor: '', taxas: '', data: hojeISO(), motivo: '' };

export default function InvestmentsPage() {
  const aba = useLocation().pathname.split('/')[2] ?? '';
  const [resumo, setResumo] = useState<ResumoInv | null>(null);
  const [movimentos, setMovimentos] = useState<MovimentoInv[]>([]);
  const [ordens, setOrdens] = useState<OrdemInv[]>([]);
  const [analises, setAnalises] = useState<AnaliseInv[]>([]);
  const [alertas, setAlertas] = useState<AlertaInv[]>([]);
  const [relatorios, setRelatorios] = useState<RelatorioInv[]>([]);
  const [erro, setErro] = useState('');
  const [aviso, setAviso] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [janela, setJanela] = useState(false);
  const [mov, setMov] = useState(MOV_VAZIO);
  const [novaAcao, setNovaAcao] = useState('');
  const [alerta, setAlerta] = useState({ ticker: '', tipo: 'queda_dia', valor: '' });
  const [relatorio, setRelatorio] = useState({ titulo: '', fonte: '', data: hojeISO(), texto: '' });

  const carregar = useCallback(async () => {
    try {
      const [r, m, o, a, al, rel] = await Promise.all([
        investApi.resumo(), investApi.movimentos(), investApi.ordens(), investApi.analises(), investApi.alertas(), investApi.relatorios(),
      ]);
      setResumo(r);
      setMovimentos(m);
      setOrdens(o);
      setAnalises(a);
      setAlertas(al);
      setRelatorios(rel);
      setErro('');
    } catch (e) {
      setErro((e as Error).message);
    }
  }, []);

  useEffect(() => void carregar(), [carregar]);

  const real = resumo?.carteiras.find((c) => c.id === 'real');
  const linhas = useMemo(() => juntarSeries(resumo?.carteiras ?? []), [resumo]);
  const ultimaLinha = linhas.at(-1);
  const ultimoResumo = analises.find((a) => a.tipo === 'resumo');
  const comOperacao = mov.tipo === 'compra' || mov.tipo === 'venda';

  async function agir(fn: () => Promise<unknown>, ok: string) {
    setEnviando(true);
    setAviso('');
    try {
      await fn();
      await carregar();
      setAviso(ok);
      return true;
    } catch (e) {
      setAviso(`Erro: ${(e as Error).message}`);
      return false;
    } finally {
      setEnviando(false);
    }
  }

  async function registrar(e: FormEvent) {
    e.preventDefault();
    const corpo = comOperacao
      ? { tipo: mov.tipo, ticker: mov.ticker, quantidade: Number(mov.quantidade), preco: parseMoney(mov.preco), taxas: parseMoney(mov.taxas) || 0, data: mov.data, motivo: mov.motivo }
      : { tipo: mov.tipo, ticker: mov.ticker || undefined, valor: parseMoney(mov.valor), data: mov.data, motivo: mov.motivo };
    if (await agir(() => investApi.registrar(corpo), `${mov.tipo} registrado.`)) {
      setMov({ ...MOV_VAZIO, data: hojeISO() });
      setJanela(false);
    }
  }

  const avisoEl = aviso && <p className={`flash${aviso.startsWith('Erro') ? ' fin-erro' : ''}`} role="status">{aviso}</p>;

  return (
    <div className="fin-page">
      <div className="fin-toolbar">
        <h1 className="fin-titulo">📈 Investimentos</h1>
        <button type="button" className="btn" onClick={() => { setAviso(''); setJanela(true); }}>Registrar operação</button>
      </div>
      <nav className="fin-tabs" aria-label="Seções de investimentos">
        {ABAS.map(([slug, nome]) => (
          <NavLink key={slug} end to={slug ? `/investimentos/${slug}` : '/investimentos'} className={({ isActive }) => `fin-tab${isActive ? ' active' : ''}`}>{nome}</NavLink>
        ))}
      </nav>

      {erro && <p className="flash fin-erro" role="alert">Não consegui carregar os investimentos: {erro}</p>}
      {resumo && !resumo.mercado_configurado && <p className="flash fin-erro" role="alert">Cotações desligadas: falta BRAPI_TOKEN no servidor. Os agentes também ficam parados.</p>}
      {!janela && avisoEl}
      {!resumo && !erro && <p className="muted">Carregando…</p>}

      {resumo && aba === '' && real && (
        <>
          <div className="fin-kpis">
            <div className="fin-kpi"><span>Patrimônio</span><strong>{brl(real.patrimonio)}</strong></div>
            <div className="fin-kpi"><span>Rentabilidade</span><strong className={sinal(real.retorno)}>{pct(real.retorno)}</strong></div>
            <div className="fin-kpi"><span>Em caixa</span><strong>{brl(real.caixa)}</strong></div>
          </div>
          {!real.serie.length && <p className="muted">Registre seu primeiro aporte ou compra para começar. Os agentes recebem o mesmo valor, na mesma data.</p>}
          {linhas.length > 0 && <Grafico linhas={linhas} temIbov={resumo.tem_ibov} />}
          {ultimaLinha && (
            <div className="inv-tabela">
              <table>
                <thead><tr><th>Comparação</th><th>Patrimônio</th><th>Rentabilidade</th></tr></thead>
                <tbody>
                  {resumo.carteiras.map((c) => <tr key={c.id}><th scope="row">{c.nome}</th><td>{brl(c.patrimonio)}</td><td className={sinal(c.retorno)}>{pct(c.retorno)}</td></tr>)}
                  {resumo.tem_ibov && <tr><th scope="row">Ibovespa</th><td>—</td><td>{pct(ultimaLinha.ibov as number | null)}</td></tr>}
                  <tr><th scope="row">CDI</th><td>—</td><td>{pct(ultimaLinha.cdi as number | null)}</td></tr>
                </tbody>
              </table>
            </div>
          )}
          <h2 className="inv-secao">Minhas ações</h2>
          <Posicoes carteira={real} />
          <h2 className="inv-secao">Acompanhando</h2>
          <form className="fin-form" onSubmit={(e) => { e.preventDefault(); void agir(() => investApi.acompanhar(novaAcao), 'Ação adicionada à lista.').then((ok) => ok && setNovaAcao('')); }}>
            <Campo id="inv-acao" label="Ação"><input id="inv-acao" required placeholder="PETR4" value={novaAcao} onChange={(e) => setNovaAcao(e.target.value)} /></Campo>
            <button type="submit" className="btn" disabled={enviando}>Acompanhar</button>
          </form>
          {resumo.acompanhadas.length > 0 ? (
            <div className="inv-tabela">
              <table>
                <thead><tr><th>Ação</th><th>Preço</th><th>Dia</th><th>30 dias</th><th>Lista</th></tr></thead>
                <tbody>
                  {resumo.acompanhadas.map((a) => (
                    <tr key={a.ticker}>
                      <th scope="row">{a.ticker}</th>
                      <td>{a.preco === null ? '—' : brl(a.preco)}</td>
                      <td className={sinal(Number(a.variacao))}>{pct(a.variacao)}</td>
                      <td className={sinal(Number(a.variacao_30d))}>{pct(a.variacao_30d)}</td>
                      <td><button type="button" className="btn ghost" disabled={enviando} aria-label={`Remover ${a.ticker}`} onClick={() => void agir(() => investApi.deixarDeAcompanhar(a.ticker), `${a.ticker} removida da lista.`)}>Remover</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="muted">Nenhuma ação na lista.</p>}
          {ultimoResumo && (
            <>
              <h2 className="inv-secao">Último resumo da analista <span className="muted">{dataBR(ultimoResumo.data)}</span></h2>
              <p className="inv-texto">{ultimoResumo.texto}</p>
            </>
          )}
          <p className="fin-nota muted">
            {resumo.atualizado_em ? `Preços com atraso, atualizados em ${new Date(resumo.atualizado_em).toLocaleString('pt-BR')}. ` : ''}
            Sugestões da IA podem errar e não são recomendação profissional: a decisão é sua.
          </p>
        </>
      )}

      {resumo && aba === 'agentes' && (
        <>
          <p className="fin-nota muted">Carteiras fictícias, sem dinheiro real. Os agentes decidem depois do fechamento, sem ver a sua carteira, e as ordens executam na abertura seguinte com taxa simulada.</p>
          {resumo.carteiras.filter((c) => c.id !== 'real').map((c) => {
            const decisao = analises.find((a) => a.tipo === 'decisao' && a.carteira === c.id);
            return (
              <section key={c.id}>
                <h2 className="inv-secao">{c.nome} <span className="muted">{c.usa_relatorios ? 'lê os relatórios' : 'só dados de mercado'}</span></h2>
                <div className="fin-kpis">
                  <div className="fin-kpi"><span>Patrimônio</span><strong>{brl(c.patrimonio)}</strong></div>
                  <div className="fin-kpi"><span>Rentabilidade</span><strong className={sinal(c.retorno)}>{pct(c.retorno)}</strong></div>
                  <div className="fin-kpi"><span>Em caixa</span><strong>{brl(c.caixa)}</strong></div>
                </div>
                <Posicoes carteira={c} />
                {decisao && <p className="inv-texto"><strong>{dataBR(decisao.data)}:</strong> {decisao.texto}</p>}
              </section>
            );
          })}
          <h2 className="inv-secao">Ordens</h2>
          {ordens.length ? (
            <div className="inv-tabela">
              <table>
                <thead><tr><th>Decidida</th><th>Carteira</th><th>Ordem</th><th>Situação</th><th>Motivo</th></tr></thead>
                <tbody>
                  {ordens.map((o) => (
                    <tr key={o.id}>
                      <td>{dataBR(o.decidida_em)}</td>
                      <td>{NOME_CARTEIRA[o.carteira] ?? o.carteira}</td>
                      <th scope="row">{o.lado} {o.quantidade} {o.ticker}</th>
                      <td>{o.status}{o.preco ? ` a ${brl(o.preco)}` : ''}{o.erro ? `: ${o.erro}` : ''}</td>
                      <td>{o.motivo}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="muted">Nenhuma ordem ainda.</p>}
        </>
      )}

      {resumo && aba === 'movimentos' && (
        movimentos.length ? (
          <div className="inv-tabela">
            <table>
              <thead><tr><th>Data</th><th>Operação</th><th>Valor</th><th>Origem</th><th>Ação</th></tr></thead>
              <tbody>
                {[...movimentos].reverse().map((m) => (
                  <tr key={m.id}>
                    <td>{dataBR(m.data)}</td>
                    <th scope="row">{m.tipo}{m.quantidade ? ` ${m.quantidade}` : ''} {m.ticker ?? ''}{m.preco ? ` a ${brl(m.preco)}` : ''}</th>
                    <td>{brl(m.valor)}</td>
                    <td>{m.origem}</td>
                    <td><button type="button" className="btn ghost" disabled={enviando} onClick={() => { if (confirm(`Excluir ${m.tipo} de ${dataBR(m.data)}?`)) void agir(() => investApi.removerMovimento(m.id), 'Movimento excluído.'); }}>Excluir</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="muted">Nenhum movimento ainda.</p>
      )}

      {resumo && aba === 'relatorios' && (
        <>
          <form className="fin-form" onSubmit={(e) => { e.preventDefault(); void agir(() => investApi.criarRelatorio(relatorio), 'Relatório lido.').then((ok) => ok && setRelatorio({ titulo: '', fonte: '', data: hojeISO(), texto: '' })); }}>
            <Campo id="inv-rel-titulo" label="Título"><input id="inv-rel-titulo" required value={relatorio.titulo} onChange={(e) => setRelatorio({ ...relatorio, titulo: e.target.value })} /></Campo>
            <Campo id="inv-rel-fonte" label="Fonte"><input id="inv-rel-fonte" value={relatorio.fonte} onChange={(e) => setRelatorio({ ...relatorio, fonte: e.target.value })} /></Campo>
            <Campo id="inv-rel-data" label="Data"><input id="inv-rel-data" type="date" required value={relatorio.data} onChange={(e) => setRelatorio({ ...relatorio, data: e.target.value })} /></Campo>
            <Campo id="inv-rel-texto" label="Texto do relatório" wide><textarea id="inv-rel-texto" required rows={8} value={relatorio.texto} onChange={(e) => setRelatorio({ ...relatorio, texto: e.target.value })} /></Campo>
            <button type="submit" className="btn" disabled={enviando}>{enviando ? 'Lendo…' : 'Ler relatório'}</button>
          </form>
          {relatorios.map((r) => (
            <article key={r.id} className="inv-relatorio">
              <h2 className="inv-secao">{r.titulo} <span className="muted">{dataBR(r.data)}{r.fonte ? ` · ${r.fonte}` : ''}</span></h2>
              {r.resumo && <p className="inv-texto">{r.resumo}</p>}
              {r.recomendacoes.length > 0 && (
                <ul>{r.recomendacoes.map((x) => <li key={`${x.ticker}-${x.acao}`}><strong>{x.ticker}</strong>: {x.acao}{x.preco_alvo ? `, alvo ${brl(x.preco_alvo)}` : ''}. {x.motivo}</li>)}</ul>
              )}
            </article>
          ))}
        </>
      )}

      {resumo && aba === 'alertas' && (
        <>
          <form className="fin-form" onSubmit={(e) => { e.preventDefault(); void agir(() => investApi.criarAlerta({ ...alerta, valor: parseMoney(alerta.valor) }), 'Alerta criado.').then((ok) => ok && setAlerta({ ticker: '', tipo: 'queda_dia', valor: '' })); }}>
            <Campo id="inv-al-ticker" label="Ação"><input id="inv-al-ticker" required placeholder="PETR4" value={alerta.ticker} onChange={(e) => setAlerta({ ...alerta, ticker: e.target.value })} /></Campo>
            <Campo id="inv-al-tipo" label="Regra">
              <select id="inv-al-tipo" value={alerta.tipo} onChange={(e) => setAlerta({ ...alerta, tipo: e.target.value })}>
                {Object.entries(TIPO_ALERTA).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </Campo>
            <Campo id="inv-al-valor" label="Valor"><input id="inv-al-valor" required inputMode="decimal" value={alerta.valor} onChange={(e) => setAlerta({ ...alerta, valor: e.target.value })} /></Campo>
            <button type="submit" className="btn" disabled={enviando}>Criar alerta</button>
          </form>
          <p className="fin-nota muted">Alertas chegam no WhatsApp durante o pregão, no máximo um por regra e cinco por dia.</p>
          {alertas.length > 0 && (
            <ul className="fin-lista">
              {alertas.map((a) => (
                <li key={a.id}>
                  <span className="fin-lista-nome"><strong>{a.ticker}</strong><span className="muted">{TIPO_ALERTA[a.tipo]} {a.tipo === 'queda_dia' ? pct(Number(a.valor)).replace('+', '') : brl(a.valor)}</span></span>
                  <button type="button" className="btn ghost" disabled={enviando} onClick={() => void agir(() => investApi.removerAlerta(a.id), 'Alerta removido.')}>Remover</button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {janela && (
        <Janela titulo="Registrar operação" onClose={() => setJanela(false)}>
          <form className="fin-form" onSubmit={(e) => void registrar(e)}>
            {avisoEl}
            <Campo id="inv-tipo" label="Operação">
              <select id="inv-tipo" value={mov.tipo} onChange={(e) => setMov({ ...mov, tipo: e.target.value })}>
                {TIPOS.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </Campo>
            <Campo id="inv-data" label="Data"><input id="inv-data" type="date" required max={hojeISO()} value={mov.data} onChange={(e) => setMov({ ...mov, data: e.target.value })} /></Campo>
            {(comOperacao || mov.tipo === 'provento') && (
              <Campo id="inv-ticker" label="Ação"><input id="inv-ticker" required placeholder="PETR4" value={mov.ticker} onChange={(e) => setMov({ ...mov, ticker: e.target.value })} /></Campo>
            )}
            {comOperacao ? (
              <>
                <Campo id="inv-qtd" label="Quantidade"><input id="inv-qtd" required type="number" min="1" step="1" value={mov.quantidade} onChange={(e) => setMov({ ...mov, quantidade: e.target.value })} /></Campo>
                <Campo id="inv-preco" label="Preço por ação"><input id="inv-preco" required inputMode="decimal" value={mov.preco} onChange={(e) => setMov({ ...mov, preco: e.target.value })} /></Campo>
                <Campo id="inv-taxas" label="Taxas"><input id="inv-taxas" inputMode="decimal" value={mov.taxas} onChange={(e) => setMov({ ...mov, taxas: e.target.value })} /></Campo>
              </>
            ) : (
              <Campo id="inv-valor" label="Valor"><input id="inv-valor" required inputMode="decimal" value={mov.valor} onChange={(e) => setMov({ ...mov, valor: e.target.value })} /></Campo>
            )}
            <Campo id="inv-motivo" label="Motivo (opcional)" wide><input id="inv-motivo" value={mov.motivo} onChange={(e) => setMov({ ...mov, motivo: e.target.value })} /></Campo>
            <button type="submit" className="btn" disabled={enviando}>Registrar</button>
          </form>
        </Janela>
      )}
    </div>
  );
}

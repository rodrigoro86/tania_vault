import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import {
  financeApi,
  type Contrato,
  type Imobiliaria,
  type Imovel,
  type Inquilino,
  type Pagamento,
  type ResumoMensal,
} from '../api';
import {
  TIPOS_RECEBIMENTO,
  alugueisDoMes,
  brl,
  dataBR,
  documentoLabel,
  hojeISO,
  mesAtual,
  mesLabel,
  mesRefLabel,
  mesVizinho,
  parseMoney,
  statusContratoLabel,
  tipoLabel,
  vencimentoLabel,
} from '../financeView';

/**
 * Finance.tsx — tela 💰 Aluguéis (`/financeiro`): abre em quem pagou no mês;
 * histórico, contratos, imóveis e inquilinos ficam em abas (`/financeiro/<aba>`)
 * e os formulários abrem em janela.
 *
 * A fonte de verdade é o schema `alugueis` do Postgres (`/api/finance/*`, `server/finance.mjs`);
 * a nota `Financeiro/Aluguéis AAAA.md` do vault é só espelho de leitura.
 * Boleto não aparece como tipo de recebimento: boleto não é comprovante
 * (o servidor recusa com 422). Mesmo tema/CSS do resto do app (`--bg`, `.btn`).
 */

type Aviso = { tipo: 'ok' | 'erro'; texto: string } | null;

const ABAS = [
  ['', 'Mês'],
  ['historico', 'Histórico'],
  ['resumo', 'Resumo'],
  ['contratos', 'Contratos'],
  ['imoveis', 'Imóveis'],
  ['inquilinos', 'Inquilinos'],
] as const;

const SITUACAO = { atrasado: 'atrasado', a_receber: 'a receber', recebido: 'recebido' };

const IMOVEL_VAZIO = {
  apelido: '',
  tipo: 'casa',
  logradouro: '',
  numero: '',
  complemento: '',
  bairro: '',
  cidade: '',
  uf: 'SP',
  cep: '',
};
const INQUILINO_VAZIO = { nome: '', documento: '', telefone: '', email: '' };
const CONTRATO_VAZIO = {
  imovel_id: '',
  inquilino_id: '',
  imobiliaria_id: '',
  data_inicio: '',
  data_fim: '',
  dia_vencimento: '',
  valor_aluguel: '',
  indice: 'igpm',
  responsavel_iptu: 'inquilino',
};
const pagamentoVazio = () => ({
  contrato_id: '',
  data: hojeISO(),
  mes_referencia: hojeISO().slice(0, 7),
  valor: '',
  tipo: 'pix',
  observacao: '',
});

export function Campo({
  id,
  label,
  children,
  wide = false,
}: {
  id: string;
  label: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={`fin-field${wide ? ' fin-field-wide' : ''}`}>
      <label htmlFor={id}>{label}</label>
      {children}
    </div>
  );
}

/** formulário em `<dialog>` nativo: foco preso, Esc fecha e não perde a rolagem da lista */
export function Janela({ titulo, onClose, children }: { titulo: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => ref.current?.showModal(), []);
  return (
    <dialog ref={ref} className="fin-janela" aria-label={titulo} onClose={onClose}>
      <header>
        <h2>{titulo}</h2>
        <button type="button" className="btn ghost" aria-label="Fechar" onClick={() => ref.current?.close()}>
          ✕
        </button>
      </header>
      {children}
    </dialog>
  );
}

export default function FinancePage() {
  const aba = useLocation().pathname.split('/')[2] ?? '';
  const [carregando, setCarregando] = useState(true);
  const [erroCarga, setErroCarga] = useState('');
  const [aviso, setAviso] = useState<Aviso>(null);
  const [salvando, setSalvando] = useState('');
  const [janela, setJanela] = useState<'' | 'pagamento' | 'edicao' | 'imovel' | 'inquilino' | 'contrato'>('');
  const [arquivo, setArquivo] = useState<File | null>(null);

  const [imoveis, setImoveis] = useState<Imovel[]>([]);
  const [inquilinos, setInquilinos] = useState<Inquilino[]>([]);
  const [imobiliarias, setImobiliarias] = useState<Imobiliaria[]>([]);
  const [contratos, setContratos] = useState<Contrato[]>([]);
  const [pagamentos, setPagamentos] = useState<Pagamento[]>([]);
  const [totalRecebido, setTotalRecebido] = useState(0);
  const [pagamentosMes, setPagamentosMes] = useState<Pagamento[]>([]);
  const [resumo, setResumo] = useState<ResumoMensal | null>(null);
  const [mes, setMes] = useState(mesAtual());

  const [formImovel, setFormImovel] = useState(IMOVEL_VAZIO);
  const [formInquilino, setFormInquilino] = useState(INQUILINO_VAZIO);
  const [formContrato, setFormContrato] = useState(CONTRATO_VAZIO);
  const [formPagamento, setFormPagamento] = useState(pagamentoVazio);
  const [formEdicao, setFormEdicao] = useState({ id: '', contrato_id: '', data: '', mes_referencia: '', valor: '', descricao: '', comprovante: '' });

  /** recarrega as listas de uma vez (barato: são poucas linhas) */
  const carregar = useCallback(async () => {
    try {
      const [i, q, b, c, p] = await Promise.all([
        financeApi.imoveis(),
        financeApi.inquilinos(),
        financeApi.imobiliarias(),
        financeApi.contratos(),
        financeApi.pagamentos(),
      ]);
      setImoveis(i);
      setInquilinos(q);
      setImobiliarias(b);
      setContratos(c);
      setPagamentos(p.pagamentos);
      setTotalRecebido(p.total);
      setErroCarga('');
    } catch (err) {
      setErroCarga(err instanceof Error ? err.message : String(err));
    } finally {
      setCarregando(false);
    }
  }, []);

  const carregarMes = useCallback(async (ano: number, mesRef: number) => {
    try {
      const [{ pagamentos: doMes }, doResumo] = await Promise.all([
        financeApi.pagamentos({ mes: `${ano}-${String(mesRef).padStart(2, '0')}` }),
        financeApi.resumo(ano, mesRef),
      ]);
      setPagamentosMes(doMes);
      setResumo(doResumo);
    } catch (err) {
      setErroCarga(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  useEffect(() => setAviso(null), [aba]);

  useEffect(() => {
    void carregarMes(mes.ano, mes.mes);
  }, [mes.ano, mes.mes, carregarMes]);

  /** roda uma ação mostrando o aviso de sucesso/erro sem travar a tela */
  async function executar(chave: string, acao: () => Promise<string>) {
    setSalvando(chave);
    setAviso(null);
    try {
      setAviso({ tipo: 'ok', texto: await acao() });
      setJanela('');
    } catch (err) {
      setAviso({ tipo: 'erro', texto: err instanceof Error ? err.message : String(err) });
    } finally {
      setSalvando('');
    }
  }

  function salvarImovel(e: FormEvent) {
    e.preventDefault();
    const f = formImovel;
    if (!f.apelido.trim() || !f.logradouro.trim() || !f.numero.trim() || !f.bairro.trim() || !f.cidade.trim()) {
      setAviso({ tipo: 'erro', texto: 'Preencha o nome do imóvel, rua, número, bairro e cidade.' });
      return;
    }
    void executar('imovel', async () => {
      const novo = await financeApi.criarImovel({ ...f, complemento: f.complemento.trim() || undefined });
      setImoveis(await financeApi.imoveis()); // o endereço completo vem da consulta
      setFormImovel(IMOVEL_VAZIO);
      return `Imóvel "${novo.apelido}" cadastrado.`;
    });
  }

  function salvarInquilino(e: FormEvent) {
    e.preventDefault();
    const nome = formInquilino.nome.trim();
    const documento = formInquilino.documento.replace(/\D/g, '');
    if (!nome) {
      setAviso({ tipo: 'erro', texto: 'Informe o nome do inquilino.' });
      return;
    }
    if (documento.length !== 11 && documento.length !== 14) {
      setAviso({ tipo: 'erro', texto: 'Informe o CPF (11 dígitos) ou CNPJ (14 dígitos).' });
      return;
    }
    void executar('inquilino', async () => {
      const novo = await financeApi.criarInquilino({
        nome,
        documento,
        telefone: formInquilino.telefone.trim() || undefined,
        email: formInquilino.email.trim() || undefined,
      });
      setInquilinos((lista) => [...lista, novo].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR')));
      setFormInquilino(INQUILINO_VAZIO);
      return `Inquilino "${novo.nome}" cadastrado.`;
    });
  }

  function salvarContrato(e: FormEvent) {
    e.preventDefault();
    const { imovel_id, inquilino_id, imobiliaria_id, data_inicio, data_fim, indice, responsavel_iptu } = formContrato;
    const valor_aluguel = parseMoney(formContrato.valor_aluguel);
    const dia_vencimento = Number(formContrato.dia_vencimento);
    if (!imovel_id || !inquilino_id) {
      setAviso({ tipo: 'erro', texto: 'Escolha o imóvel e o inquilino do contrato.' });
      return;
    }
    if (!data_inicio || !data_fim || data_fim <= data_inicio) {
      setAviso({ tipo: 'erro', texto: 'Informe o início e um fim posterior ao início do contrato.' });
      return;
    }
    if (!Number.isFinite(valor_aluguel) || valor_aluguel <= 0) {
      setAviso({ tipo: 'erro', texto: 'O valor do aluguel precisa ser maior que zero.' });
      return;
    }
    if (!Number.isInteger(dia_vencimento) || dia_vencimento < 1 || dia_vencimento > 31) {
      setAviso({ tipo: 'erro', texto: 'O dia de vencimento precisa ser de 1 a 31.' });
      return;
    }
    void executar('contrato', async () => {
      await financeApi.criarContrato({
        imovel_id,
        inquilino_id,
        imobiliaria_id: imobiliaria_id || undefined,
        data_inicio,
        data_fim,
        dia_vencimento,
        valor_aluguel,
        indice,
        responsavel_iptu,
      });
      setContratos(await financeApi.contratos()); // volta com apelido/nome resolvidos
      setFormContrato(CONTRATO_VAZIO);
      return `Contrato criado (${brl(valor_aluguel)} · ${vencimentoLabel(dia_vencimento)}).`;
    });
  }

  function salvarPagamento(e: FormEvent) {
    e.preventDefault();
    const { contrato_id, mes_referencia } = formPagamento;
    const valor = parseMoney(formPagamento.valor);
    if (!contrato_id) {
      setAviso({ tipo: 'erro', texto: 'Escolha de qual aluguel é o recebimento.' });
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(formPagamento.data)) {
      setAviso({ tipo: 'erro', texto: 'Informe a data do recebimento.' });
      return;
    }
    if (!/^\d{4}-\d{2}$/.test(mes_referencia)) {
      setAviso({ tipo: 'erro', texto: 'Informe de qual mês é o aluguel.' });
      return;
    }
    if (!Number.isFinite(valor) || valor <= 0) {
      setAviso({ tipo: 'erro', texto: 'O valor recebido precisa ser maior que zero.' });
      return;
    }
    void executar('pagamento', async () => {
      const novo = await financeApi.criarPagamento({
        contrato_id,
        data: formPagamento.data,
        valor,
        tipo: formPagamento.tipo,
        mes_referencia,
        observacao: formPagamento.observacao.trim() || undefined,
      });
      // o recebimento já existe: falha no arquivo vira aviso, senão um novo envio duplicaria o lançamento
      const semArquivo = arquivo
        ? await financeApi.anexarComprovante(novo.id, arquivo).then(
            () => '',
            (err) => ` Não consegui guardar o comprovante: ${err instanceof Error ? err.message : err}. Tente de novo em Histórico › Editar.`,
          )
        : '';
      await recarregarRecebimentos();
      setFormPagamento(pagamentoVazio());
      const c = contratos.find((item) => item.id === contrato_id);
      const quem = c ? ` de ${c.inquilino_nome} (${c.imovel_apelido})` : '';
      return `Recebimento registrado: ${brl(novo.valor)}${quem} em ${dataBR(novo.data)}.${semArquivo}`;
    });
  }

  /** o insert devolve só as colunas do extrato; o nome do imóvel/inquilino da tabela vem do join */
  async function recarregarRecebimentos() {
    const lista = await financeApi.pagamentos();
    setPagamentos(lista.pagamentos);
    setTotalRecebido(lista.total);
    void carregarMes(mes.ano, mes.mes);
  }

  function abrirEdicao(p: Pagamento) {
    setFormEdicao({
      id: p.id,
      contrato_id: p.contrato_id,
      data: p.data,
      mes_referencia: p.mes_referencia,
      valor: String(Number(p.valor)),
      descricao: p.descricao ?? '',
      comprovante: p.comprovante ?? '',
    });
    setArquivo(null);
    setJanela('edicao');
  }

  function salvarEdicao(e: FormEvent) {
    e.preventDefault();
    const { id, contrato_id, data, mes_referencia, descricao } = formEdicao;
    const valor = parseMoney(formEdicao.valor);
    if (!data || !/^\d{4}-\d{2}$/.test(mes_referencia)) {
      setAviso({ tipo: 'erro', texto: 'Informe a data e o mês do aluguel.' });
      return;
    }
    if (!Number.isFinite(valor) || valor <= 0) {
      setAviso({ tipo: 'erro', texto: 'O valor recebido precisa ser maior que zero.' });
      return;
    }
    void executar('edicao', async () => {
      await financeApi.editarPagamento(id, { contrato_id, data, mes_referencia, valor, descricao });
      if (arquivo) await financeApi.anexarComprovante(id, arquivo);
      await recarregarRecebimentos();
      return 'Recebimento atualizado.';
    });
  }

  /** abre o formulário já no mês em tela; pela linha da lista, com o aluguel e o que falta */
  function abrirRecebimento(contrato_id = '', falta?: number) {
    const mes_referencia = `${mes.ano}-${String(mes.mes).padStart(2, '0')}`;
    setFormPagamento({ ...pagamentoVazio(), contrato_id, mes_referencia, valor: falta === undefined ? '' : String(falta) });
    setArquivo(null);
    setJanela('pagamento');
  }

  /** ao escolher o contrato, sugere o valor do aluguel */
  function escolherContrato(id: string) {
    const c = contratos.find((item) => item.id === id);
    setFormPagamento((f) => ({ ...f, contrato_id: id, valor: c ? String(Number(c.valor_aluguel)) : f.valor }));
  }

  const ativos = contratos.filter((c) => c.status !== 'encerrado');
  const referencia = `${mes.ano}-${String(mes.mes).padStart(2, '0')}`;
  const alugueis = alugueisDoMes(contratos, pagamentosMes, referencia);
  const recebidoMes = pagamentosMes.reduce((soma, p) => soma + Number(p.valor), 0);
  const faltaMes = alugueis.reduce((soma, a) => soma + a.falta, 0);
  const atrasados = alugueis.filter((a) => a.situacao === 'atrasado').length;
  const progresso = recebidoMes + faltaMes > 0 ? Math.round((recebidoMes / (recebidoMes + faltaMes)) * 100) : 0;
  const alugadoPara = new Map(
    contratos.filter((c) => c.status === 'ativo' || c.status === 'a_vencer').map((c) => [c.imovel_id, c.inquilino_nome]),
  );

  const campoComprovante = (rotulo: string) => (
    <Campo id="fin-comprovante" label={rotulo} wide>
      <input
        id="fin-comprovante"
        type="file"
        accept="image/jpeg,image/png,image/webp,application/pdf"
        onChange={(e) => setArquivo(e.target.files?.[0] ?? null)}
      />
    </Campo>
  );

  const seletorMes = (
    <span className="fin-mes">
      <button type="button" className="btn ghost" onClick={() => setMes(mesVizinho(mes.ano, mes.mes, -1))} aria-label="Mês anterior">
        ◀
      </button>
      <strong>{mesLabel(mes.ano, mes.mes)}</strong>
      <button type="button" className="btn ghost" onClick={() => setMes(mesVizinho(mes.ano, mes.mes, 1))} aria-label="Mês seguinte">
        ▶
      </button>
    </span>
  );

  const avisoEl = aviso && (
    <p className={`flash${aviso.tipo === 'erro' ? ' fin-erro' : ''}`} role={aviso.tipo === 'erro' ? 'alert' : 'status'}>
      {aviso.texto}
    </p>
  );
  const fecharJanela = () => {
    setJanela('');
    setAviso(null);
  };

  return (
    <div className="fin-page">
      <h1 className="fin-titulo">💰 Aluguéis</h1>

      <nav className="fin-tabs" aria-label="Seções de aluguéis">
        {ABAS.map(([slug, nome]) => (
          <NavLink key={slug} end to={slug ? `/financeiro/${slug}` : '/financeiro'} className={({ isActive }) => `fin-tab${isActive ? ' active' : ''}`}>
            {nome}
          </NavLink>
        ))}
      </nav>

      {erroCarga && (
        <p className="flash fin-erro" role="alert">
          Não consegui carregar os aluguéis: {erroCarga}
        </p>
      )}
      {!janela && avisoEl}
      {carregando && <p className="muted">Carregando…</p>}

      {aba === '' && (
        <section aria-label="Aluguéis do mês">
          <div className="fin-toolbar">
            {seletorMes}
            <button type="button" className="btn" onClick={() => abrirRecebimento()} disabled={ativos.length === 0}>
              + Registrar recebimento
            </button>
          </div>

          <div className="fin-kpis">
            <div className="fin-kpi">
              <span>Recebido</span>
              <strong className="fin-verde">{brl(recebidoMes)}</strong>
            </div>
            <div className="fin-kpi">
              <span>Falta receber</span>
              <strong>{brl(faltaMes)}</strong>
            </div>
            <div className="fin-kpi">
              <span>Em atraso</span>
              <strong className={atrasados ? 'fin-vermelho' : undefined}>{atrasados === 1 ? '1 aluguel' : `${atrasados} aluguéis`}</strong>
            </div>
          </div>
          <div className="fin-barra" role="img" aria-label={`${progresso}% do mês recebido`}>
            <span style={{ width: `${progresso}%` }} />
          </div>

          {alugueis.length > 0 ? (
            <ul className="fin-lista">
              {alugueis.map((a) => (
                <li key={a.contrato.id}>
                  <div className="fin-lista-nome">
                    <strong>{a.contrato.imovel_apelido}</strong>
                    <span className="muted">
                      {a.contrato.inquilino_nome} · {vencimentoLabel(a.contrato.dia_vencimento)}
                    </span>
                  </div>
                  <div className="fin-lista-valor">
                    <strong className="fin-num">{brl(a.recebido || a.contrato.valor_aluguel)}</strong>
                    {a.recebido > 0 && a.recebido !== Number(a.contrato.valor_aluguel) && (
                      <span className="muted fin-num fin-contrato">contrato {brl(a.contrato.valor_aluguel)}</span>
                    )}
                    <span className={`fin-badge fin-${a.situacao}`}>{SITUACAO[a.situacao]}</span>
                  </div>
                  {a.falta > 0 ? (
                    <button type="button" className="btn ghost" onClick={() => abrirRecebimento(a.contrato.id, a.falta)}>
                      Registrar
                    </button>
                  ) : (
                    <span className="fin-lista-ok" aria-hidden="true">
                      ✓
                    </span>
                  )}
                </li>
              ))}
            </ul>
          ) : !carregando && (
            <p className="fin-empty">
              Nenhum contrato vale para este mês. <Link to="/financeiro/contratos">Ver contratos</Link>
            </p>
          )}
        </section>
      )}

      {aba === 'historico' && (
        <section aria-label="Histórico de recebimentos">
          <div className="fin-toolbar">
            <span className="muted">
              {pagamentos.length === 1 ? '1 recebimento' : `${pagamentos.length} recebimentos`} · total {brl(totalRecebido)}
            </span>
            <button type="button" className="btn" onClick={() => abrirRecebimento()} disabled={ativos.length === 0}>
              + Registrar recebimento
            </button>
          </div>
          {pagamentos.length > 0 ? (
            <div className="fin-tabela">
              <table className="fin-table">
                <thead>
                  <tr>
                    <th>Data</th>
                    <th>Aluguel</th>
                    <th className="fin-num">Valor</th>
                    <th>Mês</th>
                    <th>Descrição</th>
                    <th>Comprovante</th>
                    <th aria-label="Ações" />
                  </tr>
                </thead>
                <tbody>
                  {pagamentos.map((p) => (
                    <tr key={p.id}>
                      <td>{dataBR(p.data)}</td>
                      <td>
                        <div className="fin-lista-nome">
                          <span>{p.imovel}</span>
                          <span className="muted">{p.inquilino}</span>
                        </div>
                      </td>
                      <td className="fin-num">{brl(p.valor)}</td>
                      <td>{mesRefLabel(p.mes_referencia)}</td>
                      <td>{p.descricao ?? '—'}</td>
                      <td>
                        {p.comprovante ? (
                          <a href={`/files/${p.comprovante}`} target="_blank" rel="noreferrer">
                            ver
                          </a>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        <button type="button" className="btn ghost" onClick={() => abrirEdicao(p)} aria-label={`Editar recebimento de ${p.inquilino} em ${dataBR(p.data)}`}>
                          Editar
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : !carregando && (
            <p className="fin-empty">Nenhum recebimento ainda. Os registrados pelo WhatsApp também aparecem aqui.</p>
          )}
        </section>
      )}

      {aba === 'resumo' && (
        <section aria-label="Resumo do mês por data de recebimento">
          <div className="fin-toolbar">{seletorMes}</div>
          <div className="fin-kpis fin-kpis-2">
            <div className="fin-kpi">
              <span>Recebido no mês</span>
              <strong className="fin-verde">{brl(resumo?.total ?? 0)}</strong>
            </div>
            <div className="fin-kpi">
              <span>Recebimentos</span>
              <strong>{resumo?.qtd ?? 0}</strong>
            </div>
          </div>
          <p className="muted fin-nota">Conta pela data em que o dinheiro entrou, seja qual for o mês do aluguel.</p>
          {resumo && resumo.por_imovel.length > 0 ? (
            <ul className="fin-lista">
              {resumo.por_imovel.map((linha) => (
                <li key={linha.imovel}>
                  <div className="fin-lista-nome">
                    <strong>{linha.imovel}</strong>
                    <span className="muted">{linha.qtd === 1 ? '1 recebimento' : `${linha.qtd} recebimentos`}</span>
                  </div>
                  <strong className="fin-num">{brl(linha.total)}</strong>
                </li>
              ))}
            </ul>
          ) : !carregando && <p className="fin-empty">Nenhum recebimento com data neste mês.</p>}
        </section>
      )}

      {aba === 'contratos' && (
        <section aria-label="Contratos">
          <div className="fin-toolbar">
            <span className="muted">{contratos.length === 1 ? '1 contrato' : `${contratos.length} contratos`}</span>
            <button type="button" className="btn" onClick={() => setJanela('contrato')}>
              + Novo contrato
            </button>
          </div>
          {contratos.length > 0 ? (
            <div className="fin-tabela">
              <table className="fin-table">
                <thead>
                  <tr>
                    <th>Imóvel</th>
                    <th>Inquilino</th>
                    <th className="fin-num">Aluguel</th>
                    <th>Vigência</th>
                    <th>Vencimento</th>
                    <th>Situação</th>
                  </tr>
                </thead>
                <tbody>
                  {contratos.map((c) => (
                    <tr key={c.id}>
                      <td>{c.imovel_apelido}</td>
                      <td>{c.inquilino_nome}</td>
                      <td className="fin-num">{brl(c.valor_aluguel)}</td>
                      <td>
                        {dataBR(c.data_inicio)} a {dataBR(c.data_fim)}
                      </td>
                      <td>{vencimentoLabel(c.dia_vencimento)}</td>
                      <td>
                        <span className={`fin-badge fin-${c.status}`}>{statusContratoLabel(c.status)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : !carregando && (
            <p className="fin-empty">Nenhum contrato ainda. Para criar um, cadastre antes o imóvel e o inquilino.</p>
          )}
        </section>
      )}

      {aba === 'imoveis' && (
        <section aria-label="Imóveis">
          <div className="fin-toolbar">
            <span className="muted">
              {imoveis.length === 1 ? '1 imóvel' : `${imoveis.length} imóveis`} · {alugadoPara.size} alugado(s)
            </span>
            <button type="button" className="btn" onClick={() => setJanela('imovel')}>
              + Novo imóvel
            </button>
          </div>
          {imoveis.length > 0 ? (
            <ul className="fin-lista">
              {imoveis.map((i) => (
                <li key={i.id}>
                  <div className="fin-lista-nome">
                    <strong>{i.apelido}</strong>
                    <span className="muted">{i.endereco}</span>
                  </div>
                  <span className={`fin-badge ${alugadoPara.has(i.id) ? 'fin-ativo' : 'fin-encerrado'}`}>
                    {alugadoPara.get(i.id) ?? 'vago'}
                  </span>
                </li>
              ))}
            </ul>
          ) : !carregando && <p className="fin-empty">Nenhum imóvel cadastrado ainda.</p>}
        </section>
      )}

      {aba === 'inquilinos' && (
        <section aria-label="Inquilinos">
          <div className="fin-toolbar">
            <span className="muted">{inquilinos.length === 1 ? '1 inquilino' : `${inquilinos.length} inquilinos`}</span>
            <button type="button" className="btn" onClick={() => setJanela('inquilino')}>
              + Novo inquilino
            </button>
          </div>
          {inquilinos.length > 0 ? (
            <ul className="fin-lista">
              {inquilinos.map((q) => (
                <li key={q.id}>
                  <div className="fin-lista-nome">
                    <strong>{q.nome}</strong>
                    <span className="muted">{[q.telefone, q.email].filter(Boolean).join(' · ') || 'sem contato'}</span>
                  </div>
                  <span className="muted fin-num">{documentoLabel(q.documento)}</span>
                </li>
              ))}
            </ul>
          ) : !carregando && <p className="fin-empty">Nenhum inquilino cadastrado ainda.</p>}
        </section>
      )}

      {janela === 'pagamento' && (
        <Janela titulo="Registrar recebimento" onClose={fecharJanela}>
          {avisoEl}
          <form className="fin-form" onSubmit={salvarPagamento}>
            <Campo id="fin-pag-contrato" label="Aluguel" wide>
              <select id="fin-pag-contrato" value={formPagamento.contrato_id} onChange={(e) => escolherContrato(e.target.value)}>
                <option value="">— escolha o aluguel —</option>
                {ativos.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.imovel_apelido} · {c.inquilino_nome} ({vencimentoLabel(c.dia_vencimento)})
                  </option>
                ))}
              </select>
            </Campo>
            <Campo id="fin-pag-data" label="Data em que recebeu">
              <input
                id="fin-pag-data"
                type="date"
                value={formPagamento.data}
                onChange={(e) => setFormPagamento({ ...formPagamento, data: e.target.value })}
              />
            </Campo>
            <Campo id="fin-pag-mes" label="Aluguel de qual mês?">
              <input
                id="fin-pag-mes"
                type="month"
                value={formPagamento.mes_referencia}
                onChange={(e) => setFormPagamento({ ...formPagamento, mes_referencia: e.target.value })}
              />
            </Campo>
            <Campo id="fin-pag-valor" label="Valor recebido (R$)">
              <input
                id="fin-pag-valor"
                inputMode="decimal"
                placeholder="1800,00"
                value={formPagamento.valor}
                onChange={(e) => setFormPagamento({ ...formPagamento, valor: e.target.value })}
              />
            </Campo>
            <Campo id="fin-pag-tipo" label="Como foi pago">
              <select
                id="fin-pag-tipo"
                value={formPagamento.tipo}
                onChange={(e) => setFormPagamento({ ...formPagamento, tipo: e.target.value })}
              >
                {TIPOS_RECEBIMENTO.map((tipo) => (
                  <option key={tipo} value={tipo}>
                    {tipoLabel(tipo)}
                  </option>
                ))}
              </select>
            </Campo>
            <Campo id="fin-pag-obs" label="Observação" wide>
              <input
                id="fin-pag-obs"
                placeholder="ex.: Pix do dia 05"
                value={formPagamento.observacao}
                onChange={(e) => setFormPagamento({ ...formPagamento, observacao: e.target.value })}
              />
            </Campo>
            {campoComprovante('Comprovante (opcional)')}
            <div className="fin-actions">
              <button type="submit" className="btn" disabled={salvando === 'pagamento' || ativos.length === 0}>
                {salvando === 'pagamento' ? 'Registrando…' : 'Registrar recebimento'}
              </button>
              {ativos.length === 0 && <span className="muted">crie um contrato primeiro</span>}
              <span className="muted">Boleto não é comprovante: registre o Pix ou a transferência.</span>
            </div>
          </form>
        </Janela>
      )}
      {janela === 'edicao' && (
        <Janela titulo="Editar recebimento" onClose={fecharJanela}>
          {avisoEl}
          <form className="fin-form" onSubmit={salvarEdicao}>
            <Campo id="fin-ed-contrato" label="Aluguel" wide>
              <select
                id="fin-ed-contrato"
                value={formEdicao.contrato_id}
                onChange={(e) => setFormEdicao({ ...formEdicao, contrato_id: e.target.value })}
              >
                {contratos.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.imovel_apelido} · {c.inquilino_nome} ({dataBR(c.data_inicio)} a {dataBR(c.data_fim)})
                  </option>
                ))}
              </select>
            </Campo>
            <Campo id="fin-ed-data" label="Data em que recebeu">
              <input id="fin-ed-data" type="date" value={formEdicao.data} onChange={(e) => setFormEdicao({ ...formEdicao, data: e.target.value })} />
            </Campo>
            <Campo id="fin-ed-mes" label="Aluguel de qual mês?">
              <input
                id="fin-ed-mes"
                type="month"
                value={formEdicao.mes_referencia}
                onChange={(e) => setFormEdicao({ ...formEdicao, mes_referencia: e.target.value })}
              />
            </Campo>
            <Campo id="fin-ed-valor" label="Valor recebido (R$)">
              <input id="fin-ed-valor" inputMode="decimal" value={formEdicao.valor} onChange={(e) => setFormEdicao({ ...formEdicao, valor: e.target.value })} />
            </Campo>
            <Campo id="fin-ed-descricao" label="Descrição">
              <input id="fin-ed-descricao" value={formEdicao.descricao} onChange={(e) => setFormEdicao({ ...formEdicao, descricao: e.target.value })} />
            </Campo>
            {campoComprovante(formEdicao.comprovante ? 'Trocar comprovante' : 'Adicionar comprovante')}
            <div className="fin-actions">
              <button type="submit" className="btn" disabled={salvando === 'edicao'}>
                {salvando === 'edicao' ? 'Salvando…' : 'Salvar alterações'}
              </button>
            </div>
          </form>
        </Janela>
      )}
      {janela === 'imovel' && (
        <Janela titulo="Novo imóvel" onClose={fecharJanela}>
          {avisoEl}
          <form className="fin-form" onSubmit={salvarImovel}>
            <Campo id="fin-imovel-apelido" label="Como você chama este imóvel *">
              <input
                id="fin-imovel-apelido"
                placeholder="Casa 2"
                value={formImovel.apelido}
                onChange={(e) => setFormImovel({ ...formImovel, apelido: e.target.value })}
              />
            </Campo>
            <Campo id="fin-imovel-tipo" label="Tipo">
              <select
                id="fin-imovel-tipo"
                value={formImovel.tipo}
                onChange={(e) => setFormImovel({ ...formImovel, tipo: e.target.value })}
              >
                <option value="casa">Casa</option>
                <option value="apartamento">Apartamento</option>
                <option value="sala">Sala</option>
                <option value="outro">Outro</option>
              </select>
            </Campo>
            <Campo id="fin-imovel-logradouro" label="Rua *" wide>
              <input
                id="fin-imovel-logradouro"
                placeholder="Rua das Flores"
                value={formImovel.logradouro}
                onChange={(e) => setFormImovel({ ...formImovel, logradouro: e.target.value })}
              />
            </Campo>
            <Campo id="fin-imovel-numero" label="Número *">
              <input
                id="fin-imovel-numero"
                value={formImovel.numero}
                onChange={(e) => setFormImovel({ ...formImovel, numero: e.target.value })}
              />
            </Campo>
            <Campo id="fin-imovel-complemento" label="Complemento">
              <input
                id="fin-imovel-complemento"
                value={formImovel.complemento}
                onChange={(e) => setFormImovel({ ...formImovel, complemento: e.target.value })}
              />
            </Campo>
            <Campo id="fin-imovel-bairro" label="Bairro *">
              <input
                id="fin-imovel-bairro"
                value={formImovel.bairro}
                onChange={(e) => setFormImovel({ ...formImovel, bairro: e.target.value })}
              />
            </Campo>
            <Campo id="fin-imovel-cidade" label="Cidade *">
              <input
                id="fin-imovel-cidade"
                value={formImovel.cidade}
                onChange={(e) => setFormImovel({ ...formImovel, cidade: e.target.value })}
              />
            </Campo>
            <Campo id="fin-imovel-uf" label="UF *">
              <input
                id="fin-imovel-uf"
                maxLength={2}
                value={formImovel.uf}
                onChange={(e) => setFormImovel({ ...formImovel, uf: e.target.value })}
              />
            </Campo>
            <Campo id="fin-imovel-cep" label="CEP *">
              <input
                id="fin-imovel-cep"
                inputMode="numeric"
                placeholder="18570-000"
                value={formImovel.cep}
                onChange={(e) => setFormImovel({ ...formImovel, cep: e.target.value })}
              />
            </Campo>
            <div className="fin-actions">
              <button type="submit" className="btn" disabled={salvando === 'imovel'}>
                {salvando === 'imovel' ? 'Salvando…' : 'Salvar imóvel'}
              </button>
            </div>
          </form>
        </Janela>
      )}
      {janela === 'inquilino' && (
        <Janela titulo="Novo inquilino" onClose={fecharJanela}>
          {avisoEl}
          <form className="fin-form" onSubmit={salvarInquilino}>
            <Campo id="fin-inq-nome" label="Nome *" wide>
              <input
                id="fin-inq-nome"
                placeholder="João Silva"
                value={formInquilino.nome}
                onChange={(e) => setFormInquilino({ ...formInquilino, nome: e.target.value })}
              />
            </Campo>
            <Campo id="fin-inq-documento" label="CPF ou CNPJ *">
              <input
                id="fin-inq-documento"
                inputMode="numeric"
                placeholder="000.000.000-00"
                value={formInquilino.documento}
                onChange={(e) => setFormInquilino({ ...formInquilino, documento: e.target.value })}
              />
            </Campo>
            <Campo id="fin-inq-telefone" label="Telefone">
              <input
                id="fin-inq-telefone"
                value={formInquilino.telefone}
                onChange={(e) => setFormInquilino({ ...formInquilino, telefone: e.target.value })}
              />
            </Campo>
            <Campo id="fin-inq-email" label="E-mail" wide>
              <input
                id="fin-inq-email"
                type="email"
                value={formInquilino.email}
                onChange={(e) => setFormInquilino({ ...formInquilino, email: e.target.value })}
              />
            </Campo>
            <div className="fin-actions">
              <button type="submit" className="btn" disabled={salvando === 'inquilino'}>
                {salvando === 'inquilino' ? 'Salvando…' : 'Salvar inquilino'}
              </button>
            </div>
          </form>
        </Janela>
      )}
      {janela === 'contrato' && (
        <Janela titulo="Novo contrato" onClose={fecharJanela}>
          {avisoEl}
          <form className="fin-form" onSubmit={salvarContrato}>
            <Campo id="fin-ct-imovel" label="Imóvel *">
              <select
                id="fin-ct-imovel"
                value={formContrato.imovel_id}
                onChange={(e) => setFormContrato({ ...formContrato, imovel_id: e.target.value })}
              >
                <option value="">— escolha —</option>
                {imoveis.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.apelido}
                  </option>
                ))}
              </select>
            </Campo>
            <Campo id="fin-ct-inquilino" label="Inquilino *">
              <select
                id="fin-ct-inquilino"
                value={formContrato.inquilino_id}
                onChange={(e) => setFormContrato({ ...formContrato, inquilino_id: e.target.value })}
              >
                <option value="">— escolha —</option>
                {inquilinos.map((q) => (
                  <option key={q.id} value={q.id}>
                    {q.nome}
                  </option>
                ))}
              </select>
            </Campo>
            <Campo id="fin-ct-imobiliaria" label="Imobiliária">
              <select
                id="fin-ct-imobiliaria"
                value={formContrato.imobiliaria_id}
                onChange={(e) => setFormContrato({ ...formContrato, imobiliaria_id: e.target.value })}
              >
                <option value="">locação direta</option>
                {imobiliarias.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.nome}
                  </option>
                ))}
              </select>
            </Campo>
            <Campo id="fin-ct-valor" label="Valor do aluguel (R$) *">
              <input
                id="fin-ct-valor"
                inputMode="decimal"
                placeholder="1800,00"
                value={formContrato.valor_aluguel}
                onChange={(e) => setFormContrato({ ...formContrato, valor_aluguel: e.target.value })}
              />
            </Campo>
            <Campo id="fin-ct-inicio" label="Começa em *">
              <input
                id="fin-ct-inicio"
                type="date"
                value={formContrato.data_inicio}
                onChange={(e) => setFormContrato({ ...formContrato, data_inicio: e.target.value })}
              />
            </Campo>
            <Campo id="fin-ct-fim" label="Termina em *">
              <input
                id="fin-ct-fim"
                type="date"
                value={formContrato.data_fim}
                onChange={(e) => setFormContrato({ ...formContrato, data_fim: e.target.value })}
              />
            </Campo>
            <Campo id="fin-ct-venc" label="Dia do vencimento *">
              <input
                id="fin-ct-venc"
                type="number"
                min={1}
                max={31}
                placeholder="10"
                value={formContrato.dia_vencimento}
                onChange={(e) => setFormContrato({ ...formContrato, dia_vencimento: e.target.value })}
              />
            </Campo>
            <Campo id="fin-ct-indice" label="Índice de reajuste">
              <select
                id="fin-ct-indice"
                value={formContrato.indice}
                onChange={(e) => setFormContrato({ ...formContrato, indice: e.target.value })}
              >
                <option value="igpm">IGP-M</option>
                <option value="ipca">IPCA</option>
                <option value="inpc">INPC</option>
                <option value="outro">Outro</option>
              </select>
            </Campo>
            <Campo id="fin-ct-iptu" label="IPTU por conta do">
              <select
                id="fin-ct-iptu"
                value={formContrato.responsavel_iptu}
                onChange={(e) => setFormContrato({ ...formContrato, responsavel_iptu: e.target.value })}
              >
                <option value="inquilino">Inquilino</option>
                <option value="proprietario">Proprietário</option>
              </select>
            </Campo>
            <div className="fin-actions">
              <button type="submit" className="btn" disabled={salvando === 'contrato' || imoveis.length === 0 || inquilinos.length === 0}>
                {salvando === 'contrato' ? 'Salvando…' : 'Salvar contrato'}
              </button>
              {(imoveis.length === 0 || inquilinos.length === 0) && (
                <span className="muted">cadastre um imóvel e um inquilino antes</span>
              )}
            </div>
          </form>
        </Janela>
      )}
    </div>
  );
}

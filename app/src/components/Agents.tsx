/**
 * Tela 🤖 Agents (rota `/agentes`, só admin): provedores do agente do terminal.
 *
 * - Backend Rust `/api/agents`: `GET` devolve `{ origem, config, chaves }`
 *   (origem "nenhum" = o modelo inicial, ainda não gravado) e `PUT` grava o
 *   documento inteiro (upsert), valendo na hora no terminal.
 * - A chave em si continua em ⚙ Configurações → LLM; aqui só se escolhe qual
 *   provedor usa qual chave (ou nenhuma, para um LLM local).
 * - Sem CSS novo: `fin-page`, `fin-titulo`, `fin-kpi`, `fin-form`, `fin-actions`,
 *   `btn`, `btn ghost`, `muted`, `flash`, `fin-erro`.
 */
import { useEffect, useState } from 'react';
import { Campo } from './Form';
import { agentsApi, type AgentConfig, type Provedor } from '../api';

interface AgentDados { origem: 'banco' | 'nenhum'; config: AgentConfig; chaves: string[] }

/** igual ao backend: 1 a 32 de a-z, 0-9, - ou _ */
const NOME_RE = /^[a-z0-9_-]{1,32}$/;
/** ponto de partida de um provedor novo: servidor local, modelo ainda não escolhido */
const PROVEDOR_NOVO: Provedor = { baseUrl: 'http://127.0.0.1:8080/v1', model: '' };

/** cópia editável: cada provedor é um objeto novo, para não mexer na resposta */
function copiar(config: AgentConfig): AgentConfig {
  return {
    active: config.active,
    providers: Object.fromEntries(
      Object.entries(config.providers).map(([nome, provedor]) => [nome, { ...provedor }]),
    ),
  };
}

/** provedores em ordem alfabética */
function emOrdem(providers: Record<string, Provedor>): [string, Provedor][] {
  return Object.entries(providers).sort((a, b) => a[0].localeCompare(b[0]));
}

export default function AgentsPage() {
  const [dados, setDados] = useState<AgentDados | null>(null);
  const [rascunho, setRascunho] = useState<AgentConfig | null>(null);
  const [novoNome, setNovoNome] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  function falha(e: unknown): void {
    // o backend Rust já responde com a mensagem do primeiro erro ("só admin"…)
    setErro(e instanceof Error ? e.message : String(e));
  }

  async function recarregar(): Promise<void> {
    try {
      const resposta = await agentsApi.get();
      setDados(resposta);
      setRascunho(copiar(resposta.config));
      setErro(null);
    } catch (e) {
      falha(e);
    }
  }

  useEffect(() => {
    void recarregar();
  }, []);

  function editar(nome: string, cambios: Partial<Provedor>): void {
    if (!rascunho) return;
    setRascunho({
      ...rascunho,
      providers: { ...rascunho.providers, [nome]: { ...rascunho.providers[nome], ...cambios } },
    });
  }

  /** max tokens vazio = sem limite (undefined), não zero */
  function mudarMaxTokens(nome: string, texto: string): void {
    const valor = texto.trim();
    editar(nome, { maxTokens: valor ? Number(valor) : undefined });
  }

  function remover(nome: string): void {
    if (!rascunho) return;
    const providers = { ...rascunho.providers };
    delete providers[nome];
    const sobras = Object.keys(providers).sort((a, b) => a.localeCompare(b));
    if (!sobras.length) return;
    // se o removido era o ativo, o ativo passa a ser o primeiro que sobra
    setRascunho({ active: rascunho.active === nome ? sobras[0] : rascunho.active, providers });
  }

  function adicionar(): void {
    const nome = novoNome.trim();
    if (!NOME_RE.test(nome)) {
      setErro('nome inválido: use a-z, 0-9, - e _');
      return;
    }
    if (rascunho?.providers[nome]) {
      setErro(`já existe um provedor chamado ${nome}`);
      return;
    }
    const base = rascunho ?? { active: nome, providers: {} };
    setRascunho({
      active: base.active || nome,
      providers: { ...base.providers, [nome]: { ...PROVEDOR_NOVO } },
    });
    setNovoNome('');
    setErro(null);
  }

  async function salvar(): Promise<void> {
    if (!rascunho || salvando) return;
    setSalvando(true);
    try {
      await agentsApi.salvar(rascunho);
      setOk('Salvo. O terminal já usa a nova configuração.');
      await recarregar();
    } catch (e) {
      setOk(null);
      falha(e);
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className="fin-page">
      <h1 className="fin-titulo">🤖 Agents</h1>
      <p className="muted">
        Provedores do agente do terminal. As chaves ficam em ⚙ Configurações → LLM; aqui você só escolhe qual usar.
      </p>

      {erro && (
        <p className="flash fin-erro" role="alert">
          {erro}
        </p>
      )}
      {ok && (
        <p className="flash" role="status">
          {ok}
        </p>
      )}

      {!rascunho ? (
        <p className="muted">Carregando…</p>
      ) : (
        <>
          {dados?.origem === 'nenhum' && (
            <p className="flash">Modelo inicial (ainda não salvo). Ajuste e clique em Salvar.</p>
          )}

          {emOrdem(rascunho.providers).map(([nome, provedor]) => (
            <section key={nome} className="fin-kpi" aria-label={`Provedor ${nome}`}>
              <h2>
                {nome}
                <label className={rascunho.active === nome ? 'fin-verde' : 'muted'} style={{ fontSize: '0.85rem', marginLeft: 10 }}>
                  <input
                    type="radio"
                    name="ag-ativo"
                    checked={rascunho.active === nome}
                    onChange={() => setRascunho({ ...rascunho, active: nome })}
                  />{' '}
                  {rascunho.active === nome ? 'Ativo' : 'Usar este'}
                </label>
              </h2>
              <div className="fin-form">
                <Campo id={`ag-url-${nome}`} label="URL" wide>
                  <input
                    id={`ag-url-${nome}`}
                    type="url"
                    autoComplete="off"
                    value={provedor.baseUrl}
                    onChange={(e) => editar(nome, { baseUrl: e.target.value })}
                  />
                </Campo>
                <Campo id={`ag-modelo-${nome}`} label="Modelo" wide>
                  <input
                    id={`ag-modelo-${nome}`}
                    type="text"
                    autoComplete="off"
                    value={provedor.model}
                    onChange={(e) => editar(nome, { model: e.target.value })}
                  />
                </Campo>
                <Campo id={`ag-max-${nome}`} label="Max tokens">
                  <input
                    id={`ag-max-${nome}`}
                    type="number"
                    min={1}
                    value={provedor.maxTokens ?? ''}
                    onChange={(e) => mudarMaxTokens(nome, e.target.value)}
                  />
                </Campo>
                <Campo id={`ag-chave-${nome}`} label="Chave">
                  <select
                    id={`ag-chave-${nome}`}
                    value={provedor.apiKeyEnv ?? ''}
                    onChange={(e) => editar(nome, { apiKeyEnv: e.target.value || undefined })}
                  >
                    <option value="">sem chave (local)</option>
                    {(dados?.chaves ?? []).map((chave) => (
                      <option key={chave} value={chave}>
                        {chave}
                      </option>
                    ))}
                  </select>
                </Campo>
                <div className="fin-actions">
                  <button
                    type="button"
                    className="btn ghost"
                    disabled={Object.keys(rascunho.providers).length <= 1}
                    onClick={() => remover(nome)}
                  >
                    Remover
                  </button>
                  <span className="muted">
                    {rascunho.active === nome ? 'usado pelo terminal' : 'inativo'}
                  </span>
                </div>
              </div>
            </section>
          ))}

          <div className="fin-actions">
            <input
              type="text"
              value={novoNome}
              placeholder="ex.: strata"
              aria-label="nome do novo provedor"
              onChange={(e) => setNovoNome(e.target.value)}
            />
            <button type="button" className="btn" onClick={adicionar}>
              + Provedor
            </button>
          </div>

          <div className="fin-actions">
            <button className="btn" type="button" disabled={salvando} onClick={() => void salvar()}>
              {salvando ? 'Salvando…' : 'Salvar'}
            </button>
            <span className="muted">
              {dados?.origem === 'banco' ? 'salvo no banco' : 'modelo inicial (não salvo)'}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

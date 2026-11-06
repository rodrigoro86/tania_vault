/**
 * Tela 🔑 Tokens (rota `/tokens`, aba em ⚙ Configurações).
 *
 * - Interruptores gerais MCP e Hook (só admin): ligam o canal para todos os tokens.
 * - Lista de tokens: admin vê todos; usuário, só os seus.
 * - Criar: o token em claro aparece uma única vez, com botão de copiar.
 * - Ativar/desativar, revogar. Reusa as classes `fin-*` e `btn` (sem CSS novo).
 */
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { ConfigTabs } from './Settings';
import { authApi, integracoesApi, tokensApi, type Integracoes, type TokenApi, type Usuario } from '../api';

export default function TokensPage() {
  // undefined = ainda carregando; null = sem usuário logado
  const [me, setMe] = useState<Usuario | null | undefined>(undefined);
  const [tokens, setTokens] = useState<TokenApi[]>([]);
  const [integ, setInteg] = useState<Integracoes | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [nome, setNome] = useState('');
  const [mcp, setMcp] = useState(true);
  const [hook, setHook] = useState(false);
  const [salvando, setSalvando] = useState(false);
  // token recém-criado: mostrado uma única vez
  const [novo, setNovo] = useState<string | null>(null);

  function falha(e: unknown): void {
    setErro(e instanceof Error ? e.message : String(e));
  }

  async function recarregar(): Promise<void> {
    try {
      setTokens(await tokensApi.list());
    } catch (e) {
      falha(e);
    }
  }

  useEffect(() => {
    void authApi.me().then(async (u) => {
      setMe(u);
      if (!u) return;
      await recarregar();
      if (u.admin) {
        try {
          setInteg(await integracoesApi.get());
        } catch (e) {
          falha(e);
        }
      }
    });
  }, []);

  async function criar(e: FormEvent): Promise<void> {
    e.preventDefault();
    setErro(null);
    setSalvando(true);
    try {
      const res = await tokensApi.create({ nome, mcp, hook });
      setNovo(res.token);
      setNome('');
      await recarregar();
    } catch (err) {
      falha(err);
    } finally {
      setSalvando(false);
    }
  }

  async function alternarCanal(canal: 'mcp' | 'hook', valor: boolean): Promise<void> {
    setErro(null);
    try {
      setInteg(await integracoesApi.salvar({ [canal]: valor }));
    } catch (e) {
      falha(e);
    }
  }

  async function alterar(t: TokenApi, mudanca: Partial<Pick<TokenApi, 'ativo' | 'mcp' | 'hook'>>): Promise<void> {
    setErro(null);
    try {
      await tokensApi.update(t.id, mudanca);
      await recarregar();
    } catch (e) {
      falha(e);
    }
  }

  async function revogar(t: TokenApi): Promise<void> {
    if (!window.confirm(`Revogar o token "${t.nome}"? Quem o usa perde o acesso.`)) return;
    setErro(null);
    try {
      await tokensApi.remove(t.id);
      await recarregar();
    } catch (e) {
      falha(e);
    }
  }

  async function copiar(texto: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(texto);
    } catch {
      setErro('não consegui copiar; selecione o texto e copie manualmente');
    }
  }

  if (me === undefined) return <p className="muted">Carregando…</p>;
  if (me === null) return <p className="flash">Entre para gerenciar os tokens.</p>;

  const semCanal = !mcp && !hook;

  return (
    <div className="fin-page">
      <h1 className="fin-titulo">⚙ Configurações</h1>
      <ConfigTabs />

      {erro && (
        <p className="flash fin-erro" role="alert">
          {erro}
        </p>
      )}

      {me.admin && integ && (
        <section aria-label="Canais de integração">
          <h2>Canais</h2>
          <p className="muted">Desligar um canal recusa os tokens dele, mesmo que o token esteja ativo.</p>
          <label>
            <input type="checkbox" checked={integ.mcp} onChange={(e) => void alternarCanal('mcp', e.target.checked)} /> MCP
          </label>{' '}
          <label>
            <input type="checkbox" checked={integ.hook} onChange={(e) => void alternarCanal('hook', e.target.checked)} /> Hook
          </label>
        </section>
      )}

      <section aria-label="Criar token">
        <h2>Novo token</h2>
        <form className="fin-form" onSubmit={(e) => void criar(e)}>
          <label>
            Nome{' '}
            <input value={nome} maxLength={60} onChange={(e) => setNome(e.target.value)} placeholder="notebook-trabalho" required />
          </label>{' '}
          <label>
            <input type="checkbox" checked={mcp} onChange={(e) => setMcp(e.target.checked)} /> MCP
          </label>{' '}
          <label>
            <input type="checkbox" checked={hook} onChange={(e) => setHook(e.target.checked)} /> Hook
          </label>{' '}
          <button type="submit" className="btn" disabled={salvando || semCanal || !nome.trim()}>
            {salvando ? 'Criando…' : 'Criar token'}
          </button>
        </form>

        {novo && (
          <div className="flash" role="status">
            <p>Copie agora. Este token não aparece de novo.</p>
            <code>{novo}</code>{' '}
            <button type="button" className="btn ghost" onClick={() => void copiar(novo)}>
              Copiar
            </button>
            <p className="muted">Claude Code, na sua máquina:</p>
            <pre>{`claude mcp add --transport http tania <URL-DA-TANIA>/mcp --header "Authorization: Bearer ${novo}"`}</pre>
            <button type="button" className="btn ghost" onClick={() => setNovo(null)}>
              Já copiei
            </button>
          </div>
        )}
      </section>

      <section aria-label="Tokens">
        <h2>Tokens</h2>
        {tokens.length === 0 ? (
          <p className="muted">Nenhum token ainda.</p>
        ) : (
          <table className="fin-tabela fin-table">
            <thead>
              <tr>
                <th>Nome</th>
                {me.admin && <th>Usuário</th>}
                <th>Canais</th>
                <th>Último uso</th>
                <th>Ativo</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => (
                <tr key={t.id}>
                  <td>{t.nome}</td>
                  {me.admin && <td>{t.usuario}</td>}
                  <td>
                    {t.mcp ? 'MCP' : ''}
                    {t.mcp && t.hook ? ' · ' : ''}
                    {t.hook ? 'Hook' : ''}
                  </td>
                  <td>{t.ultimoUso ? new Date(t.ultimoUso).toLocaleString('pt-BR') : 'nunca'}</td>
                  <td>
                    <input
                      type="checkbox"
                      checked={t.ativo}
                      aria-label={`Ativo: ${t.nome}`}
                      onChange={(e) => void alterar(t, { ativo: e.target.checked })}
                    />
                  </td>
                  <td>
                    <button type="button" className="btn ghost" onClick={() => void revogar(t)}>
                      Revogar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

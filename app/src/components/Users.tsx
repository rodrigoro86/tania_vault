/**
 * Tela 👥 Usuários (rota `/usuarios`).
 *
 * - Só quem é admin gerencia: lista, cria, edita (admin/ativo/senha) e apaga.
 * - Quem não é admin só consegue trocar a própria senha.
 * - Reusa as classes `fin-*` (fin-page, fin-titulo, fin-tabela, fin-table,
 *   fin-form, fin-actions) e `btn`/`btn ghost` do Financeiro: sem CSS novo.
 */
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Campo, Janela } from './Finance';
import { ConfigTabs } from './Settings';
import { authApi, usersApi, type Usuario } from '../api';

type JanelaEstado = null | 'novo' | { editar: Usuario } | 'senha';

const FORM_VAZIO = { username: '', password: '', admin: false, ativo: true, novaSenha: '', confirma: '' };

export default function UsersPage() {
  // undefined = ainda carregando; null = carregado e sem usuário logado
  const [me, setMe] = useState<Usuario | null | undefined>(undefined);
  const [users, setUsers] = useState<Usuario[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const [janela, setJanela] = useState<JanelaEstado>(null);
  const [salvando, setSalvando] = useState(false);
  const [form, setForm] = useState(FORM_VAZIO);
  // alvo da janela de edição (janela pode ser string, então não dá para usar `in`)
  const editando = janela && typeof janela !== 'string' ? janela.editar : null;

  function falha(e: unknown): void {
    // o backend Rust já responde a mensagem em português
    setErro(e instanceof Error ? e.message : String(e));
  }

  async function recarregar(): Promise<void> {
    try {
      setUsers(await usersApi.list());
    } catch (e) {
      falha(e);
    }
  }

  useEffect(() => {
    void authApi.me().then(async (u) => {
      setMe(u);
      if (u?.admin) await recarregar();
    });
  }, []);

  function abrir(nova: JanelaEstado, preenchido?: Partial<typeof FORM_VAZIO>): void {
    setErro(null);
    setForm({ ...FORM_VAZIO, ...preenchido });
    setJanela(nova);
  }
  const fechar = () => setJanela(null);

  async function salvarNovo(e: FormEvent): Promise<void> {
    e.preventDefault();
    setSalvando(true);
    try {
      await usersApi.create({ username: form.username.trim(), password: form.password, admin: form.admin });
      setJanela(null);
      setErro(null);
      await recarregar();
    } catch (err) {
      falha(err);
    } finally {
      setSalvando(false);
    }
  }

  async function salvarEdicao(e: FormEvent): Promise<void> {
    e.preventDefault();
    const alvo = editando;
    if (!alvo) return;

    const body: { password?: string; admin?: boolean; ativo?: boolean } = {};
    if (form.admin !== alvo.admin) body.admin = form.admin;
    if (form.ativo !== alvo.ativo) body.ativo = form.ativo;
    if (form.novaSenha) body.password = form.novaSenha;
    if (Object.keys(body).length === 0) {
      setJanela(null); // nada mudou: não chama a API
      return;
    }

    setSalvando(true);
    try {
      await usersApi.update(alvo.id, body);
      setJanela(null);
      setErro(null);
      await recarregar();
    } catch (err) {
      falha(err);
    } finally {
      setSalvando(false);
    }
  }

  async function salvarSenha(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!me) return;
    if (form.novaSenha !== form.confirma) {
      setErro('As senhas não conferem.');
      return; // não chega a chamar a API
    }
    setSalvando(true);
    try {
      await usersApi.update(me.id, { password: form.novaSenha });
      setJanela(null);
      setErro(null);
      if (me.admin) await recarregar();
    } catch (err) {
      falha(err);
    } finally {
      setSalvando(false);
    }
  }

  async function apagar(u: Usuario): Promise<void> {
    if (!confirm(`Apagar ${u.username}?`)) return;
    try {
      await usersApi.remove(u.id);
      setErro(null);
      await recarregar();
    } catch (e) {
      falha(e);
    }
  }

  // com a janela (dialog modal) aberta o erro precisa aparecer dentro dela, senão fica atrás do backdrop
  const erroEl = erro && (
    <p className="flash fin-erro" role="alert">
      {erro}
    </p>
  );

  return (
    <div className="fin-page">
      <h1 className="fin-titulo">{me?.admin ? '⚙ Configurações' : '👥 Usuários'}</h1>

      {/* admin chega aqui pelas abas da tela ⚙ Configurações */}
      {me?.admin && <ConfigTabs />}

      {!janela && erroEl}

      {me === undefined ? (
        <p className="muted">Carregando…</p>
      ) : me === null ? (
        <p className="muted">Faça login para gerenciar usuários.</p>
      ) : me.admin ? (
        <section aria-label="Usuários do sistema">
          <div className="fin-toolbar">
            <span className="muted">{users.length === 1 ? '1 usuário' : `${users.length} usuário(s)`}</span>
            <button type="button" className="btn" onClick={() => abrir('novo')}>
              + Novo usuário
            </button>
          </div>

          {users.length > 0 ? (
            <div className="fin-tabela">
              <table className="fin-table">
                <thead>
                  <tr>
                    <th>Usuário</th>
                    <th>Admin</th>
                    <th>Ativo</th>
                    <th>Criado em</th>
                    <th>Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id}>
                      <td>{u.username}</td>
                      <td>{u.admin ? 'Sim' : 'Não'}</td>
                      <td>{u.ativo ? 'Sim' : 'Não'}</td>
                      <td>{new Date(u.criadoEm).toLocaleDateString('pt-BR')}</td>
                      <td>
                        <button
                          type="button"
                          className="btn ghost"
                          onClick={() => abrir({ editar: u }, { admin: u.admin, ativo: u.ativo })}>
                          Editar
                        </button>
                        {u.id !== me.id && (
                          <button type="button" className="btn ghost" onClick={() => void apagar(u)}>
                            Apagar
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="fin-empty">Nenhum usuário cadastrado ainda.</p>
          )}
        </section>
      ) : (
        <div className="fin-toolbar">
          <span className="muted">Você não é admin: pode apenas trocar a sua própria senha.</span>
          <button type="button" className="btn" onClick={() => abrir('senha')}>
            Trocar minha senha
          </button>
        </div>
      )}

      {janela === 'novo' && (
        <Janela titulo="Novo usuário" onClose={fechar}>
          <form className="fin-form" onSubmit={salvarNovo}>
            {erroEl}
            <Campo id="usu-novo-username" label="Usuário" wide>
              <input
                id="usu-novo-username"
                value={form.username}
                autoComplete="off"
                required
                onChange={(e) => setForm({ ...form, username: e.target.value })}
              />
            </Campo>
            <Campo id="usu-novo-password" label="Senha" wide>
              <input
                id="usu-novo-password"
                type="password"
                minLength={8}
                autoComplete="new-password"
                required
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
              />
            </Campo>
            <Campo id="usu-novo-admin" label="Admin?">
              <input
                id="usu-novo-admin"
                type="checkbox"
                checked={form.admin}
                onChange={(e) => setForm({ ...form, admin: e.target.checked })}
              />
            </Campo>
            <div className="fin-actions">
              <button type="submit" className="btn" disabled={salvando}>
                {salvando ? 'Salvando…' : 'Criar usuário'}
              </button>
            </div>
          </form>
        </Janela>
      )}

      {editando && (
        <Janela titulo={`Editar ${editando.username}`} onClose={fechar}>
          <form className="fin-form" onSubmit={salvarEdicao}>
            {erroEl}
            <Campo id="usu-edit-admin" label="Admin?">
              <input
                id="usu-edit-admin"
                type="checkbox"
                checked={form.admin}
                onChange={(e) => setForm({ ...form, admin: e.target.checked })}
              />
            </Campo>
            <Campo id="usu-edit-ativo" label="Ativo?">
              <input
                id="usu-edit-ativo"
                type="checkbox"
                checked={form.ativo}
                onChange={(e) => setForm({ ...form, ativo: e.target.checked })}
              />
            </Campo>
            <Campo id="usu-edit-password" label="Nova senha (opcional)" wide>
              <input
                id="usu-edit-password"
                type="password"
                minLength={8}
                autoComplete="new-password"
                value={form.novaSenha}
                onChange={(e) => setForm({ ...form, novaSenha: e.target.value })}
              />
            </Campo>
            <div className="fin-actions">
              <button type="submit" className="btn" disabled={salvando}>
                {salvando ? 'Salvando…' : 'Salvar'}
              </button>
            </div>
          </form>
        </Janela>
      )}

      {janela === 'senha' && (
        <Janela titulo="Trocar minha senha" onClose={fechar}>
          <form className="fin-form" onSubmit={salvarSenha}>
            {erroEl}
            <Campo id="usu-senha-nova" label="Nova senha" wide>
              <input
                id="usu-senha-nova"
                type="password"
                minLength={8}
                autoComplete="new-password"
                required
                value={form.novaSenha}
                onChange={(e) => setForm({ ...form, novaSenha: e.target.value })}
              />
            </Campo>
            <Campo id="usu-senha-repetir" label="Repita a nova senha" wide>
              <input
                id="usu-senha-repetir"
                type="password"
                minLength={8}
                autoComplete="new-password"
                required
                value={form.confirma}
                onChange={(e) => setForm({ ...form, confirma: e.target.value })}
              />
            </Campo>
            <div className="fin-actions">
              <button type="submit" className="btn" disabled={salvando}>
                {salvando ? 'Salvando…' : 'Trocar senha'}
              </button>
            </div>
          </form>
        </Janela>
      )}
    </div>
  );
}

/**
 * Tela ⚙ Tools (rota `/tools-admin`, só para admin): tudo que o servidor
 * reconhece — as fixas do env e as cadastradas no banco, ativas e inativas —
 * o cadastro de tool externa e a config declarada no manifesto de cada tool.
 * Reusa as classes de Configurações: `fin-page`, `fin-titulo`, `fin-tabs`,
 * `fin-form`, `fin-actions`, `btn`, `btn ghost`, `muted`, `flash`, `fin-erro`.
 */
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { ConfigTabs } from './Settings';
import { Campo } from './Finance';
import { authApi } from '../api';
import { ID_OK, recarregarTools, type Manifesto } from '../tools';

interface ToolRow {
  id: string;
  origem: 'env' | 'banco';
  ativo: boolean;
  url?: string;
  erro?: string;
  manifest: Manifesto | null;
}

interface Chave {
  chave: string;
  segredo: boolean;
  descricao?: string;
  definido: boolean;
  valor?: string;
}

/** fetch com sessão e JSON, erro vira mensagem legível */
async function chamada(method: string, url: string, body?: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error((data as { error?: string })?.error || `${res.status} ${res.statusText}`);
  }
  return data;
}

export default function ToolsPage() {
  const [tools, setTools] = useState<ToolRow[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  // chaves de cada tool ativa, lidas de GET /api/tools/{id}/config
  const [chaves, setChaves] = useState<Record<string, Chave[]>>({});
  // texto digitado pelo admin, por `${id}:${chave}`; vazio = não mexer
  const [rascunho, setRascunho] = useState<Record<string, string>>({});
  const [gravando, setGravando] = useState<string | null>(null);
  const [nova, setNova] = useState({ id: '', url: '', segredo: '' });

  function falha(e: unknown): void {
    setErro(e instanceof Error ? e.message : String(e));
  }

  async function lerChaves(lista: ToolRow[]): Promise<void> {
    const resultado: Record<string, Chave[]> = {};
    for (const tool of lista) {
      if (!tool.ativo || !(tool.manifest?.config ?? []).length) continue;
      try {
        const data = await chamada('GET', `/api/tools/${tool.id}/config`);
        resultado[tool.id] = (data as { chaves?: Chave[] })?.chaves ?? [];
      } catch (e) {
        falha(e);
      }
    }
    setChaves(resultado);
  }

  async function listar(): Promise<void> {
    try {
      const res = await fetch('/api/tools', { credentials: 'same-origin' });
      if (res.status === 403) {
        setErro('Só admin gerencia as tools.');
        return;
      }
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error((data as { error?: string })?.error || `${res.status} ${res.statusText}`);
      }
      const lista = ((data as { tools?: ToolRow[] })?.tools ?? []).filter((t) => t && typeof t.id === 'string');
      setTools(lista);
      setErro(null);
      await lerChaves(lista);
    } catch (e) {
      falha(e);
    }
  }

  // depois de qualquer gravação: recarrega a tabela e a lista usada pelo resto do app
  async function depois(): Promise<void> {
    recarregarTools();
    await listar();
  }

  useEffect(() => {
    void (async () => {
      const eu = await authApi.me();
      if (eu && !eu.admin) {
        setErro('Só admin gerencia as tools.');
        return;
      }
      await listar();
    })();
  }, []);

  async function cadastrar(e: FormEvent): Promise<void> {
    e.preventDefault();
    const id = nova.id.trim();
    const url = nova.url.trim();
    const segredo = nova.segredo;
    if (!ID_OK.test(id)) {
      setErro('id: só letras minúsculas, números e hífen (até 32).');
      return;
    }
    if (!url || !segredo) {
      setErro('Preencha url e segredo.');
      return;
    }
    setGravando('nova');
    try {
      await chamada('POST', '/api/tools', { id, url, segredo });
      setNova({ id: '', url: '', segredo: '' });
      setErro(null);
      await depois();
    } catch (err) {
      falha(err);
    } finally {
      setGravando(null);
    }
  }

  async function ativar(id: string, ativo: boolean): Promise<void> {
    setGravando(id);
    try {
      await chamada('PUT', `/api/tools/${id}`, { ativo });
      setErro(null);
      await depois();
    } catch (err) {
      falha(err);
    } finally {
      setGravando(null);
    }
  }

  async function remover(id: string): Promise<void> {
    if (!window.confirm(`Remover a tool '${id}' do banco? Ela perde a config.`)) return;
    setGravando(id);
    try {
      await chamada('DELETE', `/api/tools/${id}`);
      setErro(null);
      await depois();
    } catch (err) {
      falha(err);
    } finally {
      setGravando(null);
    }
  }

  async function salvarConfig(id: string, e: FormEvent): Promise<void> {
    e.preventDefault();
    const valores: Record<string, string> = {};
    for (const c of chaves[id] ?? []) {
      const valor = (rascunho[`${id}:${c.chave}`] ?? (c.segredo ? '' : c.valor ?? '')).trim();
      if (valor) valores[c.chave] = valor;
    }
    if (!Object.keys(valores).length || gravando === id) return;

    setGravando(id);
    try {
      await chamada('PUT', `/api/tools/${id}/config`, { valores });
      setRascunho((r) => {
        const novo = { ...r };
        for (const chave of Object.keys(valores)) delete novo[`${id}:${chave}`];
        return novo;
      });
      setErro(null);
      await depois();
    } catch (err) {
      falha(err);
    } finally {
      setGravando(null);
    }
  }

  async function apagarChave(id: string, chave: string): Promise<void> {
    if (!window.confirm(`Apagar '${chave}' de ${id}? Volta ao valor do .env, se houver.`)) return;
    const alvo = `${id}:${chave}`;
    setGravando(alvo);
    try {
      await chamada('PUT', `/api/tools/${id}/config`, { valores: { [chave]: null } });
      setErro(null);
      await depois();
    } catch (err) {
      falha(err);
    } finally {
      setGravando(null);
    }
  }

  const comConfig = (tools ?? []).filter((t) => t.ativo && (t.manifest?.config ?? []).length);

  return (
    <div className="fin-page">
      <h1 className="fin-titulo">🛠 Tools</h1>
      <ConfigTabs />

      {erro && (
        <p className="flash fin-erro" role="alert">
          {erro}
        </p>
      )}

      <form className="fin-form" onSubmit={(e) => void cadastrar(e)}>
        <h2>Cadastrar tool externa</h2>
        <Campo id="tool-id" label="id" wide>
          <input
            id="tool-id"
            value={nova.id}
            autoComplete="off"
            placeholder="minha-tool"
            onChange={(e) => setNova({ ...nova, id: e.target.value })}
          />
        </Campo>
        <Campo id="tool-url" label="url" wide>
          <input
            id="tool-url"
            type="url"
            value={nova.url}
            autoComplete="off"
            placeholder="https://tool.exemplo.com"
            onChange={(e) => setNova({ ...nova, url: e.target.value })}
          />
        </Campo>
        <Campo id="tool-segredo" label="segredo" wide>
          <input
            id="tool-segredo"
            type="password"
            value={nova.segredo}
            autoComplete="off"
            onChange={(e) => setNova({ ...nova, segredo: e.target.value })}
          />
        </Campo>
        <div className="fin-actions">
          <button type="submit" className="btn" disabled={gravando === 'nova'}>
            {gravando === 'nova' ? 'Cadastrando…' : 'Cadastrar'}
          </button>
        </div>
      </form>

      {!tools ? (
        <p className="muted">Carregando…</p>
      ) : (
        <section aria-label="Tools registradas">
          <h2>Registradas ({tools.length})</h2>
          <table>
            <thead>
              <tr>
                <th>Ícone</th>
                <th>Nome</th>
                <th>id</th>
                <th>Origem</th>
                <th>Ativa</th>
                <th>Erro</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {tools.map((tool) => (
                <tr key={tool.id}>
                  <td>{tool.manifest?.icone || '🔌'}</td>
                  <td>{tool.manifest?.nome || tool.id}</td>
                  <td>{tool.id}</td>
                  <td className="muted">{tool.origem}</td>
                  <td>
                    <input
                      type="checkbox"
                      checked={tool.ativo}
                      disabled={tool.origem !== 'banco'}
                      onChange={(e) => void ativar(tool.id, e.target.checked)}
                    />
                  </td>
                  <td className="muted">{tool.erro || ''}</td>
                  <td>
                    {tool.origem === 'banco' && (
                      <button type="button" className="btn ghost" onClick={() => void remover(tool.id)}>
                        Remover
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {comConfig.map((tool) => (
        <section key={tool.id} aria-label={`Config de ${tool.id}`}>
          <h2>{tool.manifest?.nome || tool.id}</h2>
          <form className="fin-form" onSubmit={(e) => void salvarConfig(tool.id, e)}>
            {(chaves[tool.id] ?? tool.manifest?.config ?? []).map((c) => {
              const campo = `${tool.id}:${c.chave}`;
              return (
                <div key={c.chave}>
                  <Campo id={`tool-cfg-${c.chave}`} label={c.chave} wide>
                    <input
                      id={`tool-cfg-${c.chave}`}
                      type={c.segredo ? 'password' : 'text'}
                      autoComplete="off"
                      placeholder={c.segredo && c.definido ? 'definido' : undefined}
                      value={rascunho[campo] ?? (c.segredo ? '' : c.valor ?? '')}
                      onChange={(e) => setRascunho({ ...rascunho, [campo]: e.target.value })}
                    />
                  </Campo>
                  <span className="muted">
                    {c.descricao || ''}
                    {c.definido ? ' · definido' : ''}
                  </span>
                  {c.definido && (
                    <div className="fin-actions">
                      <button type="button" className="btn ghost" disabled={gravando === campo} onClick={() => void apagarChave(tool.id, c.chave)}>
                        apagar
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
            <div className="fin-actions">
              <button type="submit" className="btn" disabled={gravando === tool.id}>
                {gravando === tool.id ? 'Salvando…' : 'Salvar'}
              </button>
            </div>
          </form>
        </section>
      ))}
    </div>
  );
}

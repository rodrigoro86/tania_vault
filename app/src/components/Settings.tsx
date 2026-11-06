/**
 * Tela ⚙ Configurações (rota `/configuracoes`): as variáveis das integrações
 * editadas pelo admin e gravadas no Postgres (backend Rust, `/api/config`).
 *
 * - Abas Integrações | Usuários (`/usuarios`), reusadas na tela de usuários.
 * - Sem CSS novo: `fin-page`, `fin-titulo`, `fin-tabs`/`fin-tab`, `fin-form`,
 *   `fin-actions`, `btn`, `btn ghost`, `muted`, `flash`, `fin-erro`.
 */
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { NavLink } from 'react-router-dom';
import { Campo } from './Finance';
import { configApi, type ConfigItem } from '../api';

interface ConfigDados { pendente: boolean; cifra: boolean; itens: ConfigItem[] }

/** abas compartilhadas entre /configuracoes e /usuarios */
export function ConfigTabs() {
  const cls = ({ isActive }: { isActive: boolean }) => `fin-tab${isActive ? ' active' : ''}`;
  return (
    <nav className="fin-tabs" aria-label="Seções de configuração">
      <NavLink end to="/configuracoes" className={cls}>
        Integrações
      </NavLink>
      <NavLink end to="/usuarios" className={cls}>
        Usuários
      </NavLink>
      <NavLink end to="/tools-admin" className={cls}>
        Tools
      </NavLink>
    </nav>
  );
}

export default function SettingsPage() {
  const [dados, setDados] = useState<ConfigDados | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  // texto digitado pelo admin, por chave; vazio = não mexer no que já está
  const [rascunho, setRascunho] = useState<Record<string, string>>({});
  const [salvando, setSalvando] = useState<string | null>(null);
  const [reiniciando, setReiniciando] = useState(false);

  function falha(e: unknown): void {
    // o backend Rust já responde a mensagem em português ("só admin", "chave fora da lista"…)
    setErro(e instanceof Error ? e.message : String(e));
  }

  async function recarregar(): Promise<void> {
    try {
      setDados(await configApi.get());
      setErro(null);
    } catch (e) {
      falha(e);
    }
  }

  useEffect(() => {
    void recarregar();
  }, []);

  // grupos na ordem em que aparecem na resposta
  const grupos: [string, ConfigItem[]][] = [];
  for (const item of dados?.itens ?? []) {
    const found = grupos.find(([nome]) => nome === item.grupo);
    if (found) found[1].push(item);
    else grupos.push([item.grupo, [item]]);
  }

  async function salvar(chave: string, e: FormEvent): Promise<void> {
    e.preventDefault();
    const valor = (rascunho[chave] ?? '').trim();
    if (!valor || salvando === chave) return;

    setSalvando(chave);
    try {
      await configApi.salvar(chave, valor);
      setRascunho((r) => {
        const novo = { ...r };
        delete novo[chave];
        return novo;
      });
      await recarregar();
    } catch (err) {
      falha(err);
    } finally {
      setSalvando(null);
    }
  }

  async function remover(chave: string): Promise<void> {
    if (!confirm(`Remover ${chave} do banco? Volta a valer o .env.`)) return;
    setSalvando(chave);
    try {
      await configApi.remover(chave);
      setRascunho((r) => {
        const novo = { ...r };
        delete novo[chave];
        return novo;
      });
      await recarregar();
    } catch (err) {
      falha(err);
    } finally {
      setSalvando(null);
    }
  }

  async function reiniciar(): Promise<void> {
    if (!confirm('Reiniciar o servidor agora? O site fica fora por alguns segundos.')) return;
    try {
      await configApi.reiniciar();
      setReiniciando(true);
      setTimeout(() => location.reload(), 6000);
    } catch (e) {
      falha(e);
    }
  }

  return (
    <div className="fin-page">
      <h1 className="fin-titulo">⚙ Configurações</h1>
      <ConfigTabs />

      {erro && (
        <p className="flash fin-erro" role="alert">
          {erro}
        </p>
      )}

      {!dados ? (
        <p className="muted">Carregando…</p>
      ) : (
        <>
          {!dados.cifra && (
            <p className="flash">Defina TANIA_CONFIG_KEY no servidor para salvar chaves secretas.</p>
          )}

          {dados.pendente && (
            <p className="flash" role="status">
              Mudanças salvas; valem depois de reiniciar.{' '}
              <button type="button" className="btn" disabled={reiniciando} onClick={() => void reiniciar()}>
                {reiniciando ? 'Reiniciando…' : 'Aplicar e reiniciar'}
              </button>
            </p>
          )}

          {grupos.map(([grupo, itens]) => (
            <section key={grupo} aria-label={`Configurações de ${grupo}`}>
              <h2>{grupo}</h2>
              {itens.map((item) => {
                const chave = item.chave;
                const rascunhoAtual = rascunho[chave] ?? '';
                return (
                  <form key={chave} className="fin-form" onSubmit={(e) => void salvar(chave, e)}>
                    <Campo id={`cfg-${chave}`} label={chave} wide>
                      <input
                        id={`cfg-${chave}`}
                        type={item.segredo ? 'password' : 'text'}
                        autoComplete="off"
                        placeholder={item.segredo ? item.valor || 'não definido' : undefined}
                        value={rascunho[chave] ?? (item.segredo ? '' : item.valor)}
                        onChange={(e) => setRascunho({ ...rascunho, [chave]: e.target.value })}
                      />
                    </Campo>
                    <span className="muted">
                      {item.descricao} ·{' '}
                      {item.origem === 'banco' ? 'salvo no banco' : item.origem === 'env' ? 'vem do .env' : 'vazio'}
                    </span>
                    <div className="fin-actions">
                      <button type="submit" className="btn" disabled={!rascunhoAtual.trim() || salvando === chave}>
                        {salvando === chave ? 'Salvando…' : 'Salvar'}
                      </button>
                      {item.origem === 'banco' && (
                        <button type="button" className="btn ghost" disabled={salvando === chave} onClick={() => void remover(chave)}>
                          Remover
                        </button>
                      )}
                    </div>
                  </form>
                );
              })}
            </section>
          ))}
        </>
      )}
    </div>
  );
}

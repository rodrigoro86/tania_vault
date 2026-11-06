import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { authApi, type Usuario } from '../api';

/**
 * UserMenu.tsx — rodapé do sidebar esquerdo: bolinha com a inicial do usuário
 * logado (abre papel + Sair, para cima), o nome e ⚙: ⚙ Configurações para admin,
 * 👥 Usuários para os demais. Some se /api/auth/me não
 * responder (backend só Node, sem usuários).
 */
export default function UserMenu() {
  const [me, setMe] = useState<Usuario | null>(null);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void authApi.me().then(setMe);
  }, []);

  // fecha ao clicar fora ou com Esc
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!me) return null;

  return (
    <div className="user-menu" ref={ref}>
      <button
        type="button"
        className="user-avatar"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Conta de ${me.username}`}
        title={me.username}>
        {me.username.charAt(0).toUpperCase()}
      </button>
      <span className="user-name">{me.username}</span>
      <Link
        className="user-gear"
        to={me.admin ? '/configuracoes' : '/usuarios'}
        title="Configurações"
        aria-label="Configurações">
        ⚙
      </Link>
      {open && (
        <div className="user-pop" role="menu">
          <p className="user-pop-name">{me.username}</p>
          <p className="muted">{me.admin ? 'Admin' : 'Usuário'}</p>
          <Link role="menuitem" to={me.admin ? '/configuracoes' : '/usuarios'} onClick={() => setOpen(false)}>
            {me.admin ? 'Configurações' : 'Trocar minha senha'}
          </Link>
          {/* /logout é do backend (fora do SPA): navegação de página inteira */}
          <a role="menuitem" href="/logout">
            Sair
          </a>
        </div>
      )}
    </div>
  );
}

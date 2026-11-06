/**
 * Form.tsx — peças de formulário compartilhadas pelas telas de admin (Agents, Configurações, Tools, Usuários).
 * Classes `fin-*` em styles.css (o nome vem da antiga tela Financeiro, onde nasceram).
 */
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

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

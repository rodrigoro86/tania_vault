/**
 * Ribbon.tsx — faixa fixa de ícones (44px) no menu da esquerda, estilo Obsidian:
 * 📄 Vault (notas) | [tools ativas] | 🤖 Agents. O painel ao lado mostra a vista
 * ativa. Clicar no ativo com o painel aberto recolhe; clicar com o painel
 * recolhido abre naquela vista.
 *
 * `LeftView` é string: 'vault' | 'agents' | 'tool:<id>' (as tools vêm do
 * manifesto, então não dá para enumerar as vistas fixas).
 */
export type LeftView = string;

/** vistas que existem sempre, fora das tools */
export const BASE_VIEWS: { id: string; icon: string; label: string }[] = [
  { id: 'vault', icon: '📄', label: 'Vault (notas)' },
  { id: 'agents', icon: '🤖', label: 'Agents' },
];

export default function Ribbon({
  view,
  open,
  onSelect,
  views,
}: {
  view: LeftView;
  open: boolean;
  onSelect: (v: LeftView) => void;
  views: { id: string; icon: string; label: string }[];
}) {
  return (
    <div className="ribbon" role="toolbar" aria-label="Seções" aria-orientation="vertical">
      {views.map((v) => {
        const active = open && v.id === view;
        return (
          <button
            key={v.id}
            type="button"
            className={`ribbon-btn${active ? ' active' : ''}`}
            aria-label={v.label}
            title={v.label}
            aria-pressed={active}
            onClick={() => onSelect(v.id)}
          >
            <span aria-hidden="true">{v.icon}</span>
          </button>
        );
      })}
    </div>
  );
}

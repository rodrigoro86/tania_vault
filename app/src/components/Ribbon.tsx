/**
 * Ribbon.tsx — faixa fixa de ícones (44px) no menu da esquerda, estilo Obsidian:
 * 📄 Vault (notas) | ✅ ClickUp | 🤖 Agents. O painel ao lado mostra a vista ativa.
 * Clicar no ativo com o painel aberto recolhe; clicar com o painel recolhido
 * abre naquela vista.
 */
export type LeftView = 'vault' | 'clickup' | 'agents';

export const VIEWS: { id: LeftView; icon: string; label: string }[] = [
  { id: 'vault', icon: '📄', label: 'Vault (notas)' },
  { id: 'clickup', icon: '✅', label: 'ClickUp' },
  { id: 'agents', icon: '🤖', label: 'Agents' },
];

export default function Ribbon({
  view,
  open,
  onSelect,
}: {
  view: LeftView;
  open: boolean;
  onSelect: (v: LeftView) => void;
}) {
  return (
    <div className="ribbon" role="toolbar" aria-label="Seções" aria-orientation="vertical">
      {VIEWS.map((v) => {
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

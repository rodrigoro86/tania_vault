import { useRef, type KeyboardEvent, type PointerEvent } from 'react';

/** largura mínima do documento entre os dois painéis */
const DOC_MIN = 360;
const STEP = 16;

/**
 * ResizeHandle.tsx — alça na borda do explorador (side="left") ou do painel da
 * direita (side="right"). Arrastar muda a largura; setas ←/→ também; duplo
 * clique volta ao padrão (`onChange(null)`). Quem guarda o valor é o App.
 */
export default function ResizeHandle({
  side,
  width,
  other,
  min,
  max,
  label,
  onChange,
  onDragging,
}: {
  side: 'left' | 'right';
  /** largura atual do painel, em px */
  width: number;
  /** largura do painel do outro lado (para sobrar DOC_MIN ao documento) */
  other: number;
  min: number;
  max: number;
  label: string;
  onChange: (w: number | null) => void;
  onDragging: (on: boolean) => void;
}) {
  const start = useRef<{ x: number; w: number } | null>(null);

  const clamp = (w: number) => {
    const teto = Math.min(max, window.innerWidth - other - DOC_MIN);
    return Math.round(Math.max(min, Math.min(teto, w)));
  };

  function down(e: PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, w: width };
    onDragging(true);
  }
  function move(e: PointerEvent<HTMLDivElement>) {
    if (!start.current) return;
    const dx = e.clientX - start.current.x;
    onChange(clamp(start.current.w + (side === 'left' ? dx : -dx)));
  }
  function up() {
    if (!start.current) return;
    start.current = null;
    onDragging(false);
  }
  function key(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const maior = (e.key === 'ArrowRight') === (side === 'left');
    onChange(clamp(width + (maior ? STEP : -STEP)));
  }

  return (
    <div
      className={`resize-handle resize-${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title="Arraste para ajustar · duplo clique volta ao padrão"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onKeyDown={key}
      onDoubleClick={() => onChange(null)}
    />
  );
}

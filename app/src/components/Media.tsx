import { useEffect, useRef, useState } from 'react';
import { fileInfo, type FileKind, type VaultFile } from '../vault';
import { downloadDocx, printHtmlDoc } from '../exportHtmlDoc';

/**
 * Media.tsx — anexos servidos de /files (server/vault-api.mjs).
 *
 * HTML (apresentações) abre em iframe com `sandbox` SEM allow-same-origin:
 * os slides rodam JS, mas não alcançam o cookie de login nem a /api. O
 * servidor manda o mesmo isolamento por CSP, valendo também em aba nova.
 */
const HTML_SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-presentation';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function HtmlFrame({ url, title, tall = false }: { url: string; title: string; tall?: boolean }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [busy, setBusy] = useState<'' | 'pdf' | 'docx'>('');
  async function exportAs(kind: 'pdf' | 'docx') {
    setBusy(kind);
    try {
      await (kind === 'pdf' ? printHtmlDoc(url) : downloadDocx(url));
    } catch (err) {
      alert(`Não foi possível exportar: ${(err as Error).message}`);
    } finally {
      setBusy('');
    }
  }
  return (
    <figure className={`embed embed-html${tall ? ' embed-tall' : ''}`} data-title={title}>
      <div className="embed-bar">
        <span className="embed-title">{title}</span>
        <button type="button" className="btn ghost" onClick={() => void frame.current?.requestFullscreen?.()} title="Tela cheia (Esc sai)">
          ⛶ Tela cheia
        </button>
        <a className="btn ghost" href={url} target="_blank" rel="noopener" title="Abrir em nova aba">
          ↗ Nova aba
        </a>
        <button type="button" className="btn ghost" disabled={!!busy} onClick={() => void exportAs('pdf')} title="Documento A4 → Salvar como PDF">
          {busy === 'pdf' ? '…' : '⬇ PDF'}
        </button>
        <button type="button" className="btn ghost" disabled={!!busy} onClick={() => void exportAs('docx')} title="Documento A4 → Word (.docx) editável">
          {busy === 'docx' ? '…' : '⬇ Word'}
        </button>
      </div>
      <iframe ref={frame} src={url} title={title} sandbox={HTML_SANDBOX} allow="fullscreen" allowFullScreen loading="lazy" />
    </figure>
  );
}

/** ![[arquivo]] de html/pdf/vídeo/áudio dentro de uma nota */
export function FileEmbed({ url, kind, label }: { url: string; kind: FileKind; label: string }) {
  if (kind === 'html') return <HtmlFrame url={url} title={label} />;
  if (kind === 'pdf') {
    return (
      <figure className="embed embed-pdf" data-title={label}>
        <div className="embed-bar">
          <span className="embed-title">{label}</span>
          <a className="btn ghost" href={url} target="_blank" rel="noopener">
            ↗ Nova aba
          </a>
        </div>
        <iframe src={url} title={label} loading="lazy" />
      </figure>
    );
  }
  if (kind === 'video') return <video className="embed-media" src={url} controls preload="metadata" />;
  if (kind === 'audio') return <audio className="embed-media" src={url} controls preload="metadata" />;
  return (
    <a className="attachment" href={url} target="_blank" rel="noopener">
      {label}
    </a>
  );
}

/** imagem ampliada: clique fora, ✕ ou Esc fecha */
export function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="lightbox" role="dialog" aria-label={alt || 'imagem'} onClick={onClose}>
      <img src={src} alt={alt} onClick={(e) => e.stopPropagation()} />
      <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <span>{alt}</span>
        <a className="btn ghost" href={src} target="_blank" rel="noopener">
          ↗ Original
        </a>
        <button type="button" className="btn ghost" onClick={onClose} aria-label="Fechar">
          ✕
        </button>
      </div>
    </div>
  );
}

/** imagem de nota: clicável para ampliar */
export function ZoomableImage({ src, alt }: { src: string; alt: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <img className="note-img" src={src} alt={alt} loading="lazy" onClick={() => setOpen(true)} />
      {open && <Lightbox src={src} alt={alt} onClose={() => setOpen(false)} />}
    </>
  );
}

/** página de um anexo (#/arquivo/<caminho>): pré-visualização pelo tipo */
export function FilePage({ path }: { path: string }) {
  const file: VaultFile | null = fileInfo(path);
  if (!file) {
    return (
      <div className="note">
        <h1>Arquivo não encontrado</h1>
        <p className="muted">
          <code>{path}</code> não existe no vault (ou o explorador ainda não recarregou).
        </p>
      </div>
    );
  }
  return (
    <article className="note file-page">
      <h1>{file.name}</h1>
      <p className="note-meta">
        {file.path} · {formatSize(file.size)} ·{' '}
        <a href={file.url} target="_blank" rel="noopener">
          abrir original
        </a>
      </p>
      {file.kind === 'image' && <ZoomableImage src={file.url} alt={file.name} />}
      {file.kind === 'html' && <HtmlFrame url={file.url} title={file.name} tall />}
      {(file.kind === 'pdf' || file.kind === 'video' || file.kind === 'audio') && (
        <FileEmbed url={file.url} kind={file.kind} label={file.name} />
      )}
      {(file.kind === 'office' || file.kind === 'text') && (
        <p>
          <a className="btn" href={file.url} target="_blank" rel="noopener" download={file.kind === 'office' ? file.name : undefined}>
            {file.kind === 'office' ? '⬇ Baixar' : '↗ Abrir'} {file.name}
          </a>
        </p>
      )}
      <p className="muted">
        Para mostrar numa nota: <code>![[{file.name}]]</code>
      </p>
    </article>
  );
}

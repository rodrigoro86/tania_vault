import { useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { wikilinks, callouts } from '../plugins';
import { reloadVault, resolveMediaSrc, type FileKind, type Note } from '../vault';
import { vaultApi } from '../api';
import { slug } from './Sidebar';
import { FileEmbed, ZoomableImage } from './Media';
import { downloadMarkdown, printNote, type PrintMode } from '../exportNote';
import { downloadNoteDocx } from '../exportHtmlDoc';

/** o mesmo conjunto que o servidor aceita (FILE_TYPES em server/vault-api.mjs) */
const UPLOAD_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg|html?|pdf|pptx|docx|xlsx|csv|txt|mp4|webm|mp3)$/i;
const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

/** 99-Meta/attachments/AAAA-MM/<nome>-<AAAAMMDD-HHmmss>.<ext>: único, ASCII (AGENTS.md §3.3) */
function uploadPath(file: File, noteName: string, index: number): string | null {
  const fromName = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase();
  const ext = fromName ?? MIME_EXT[file.type];
  if (!ext || !UPLOAD_EXT.test(`.${ext}`)) return null;
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  // "image.png" colado do print não diz nada: usa o nome da nota
  const base = fromName && !/^image\.[a-z]+$/i.test(file.name) ? slug(file.name.replace(/\.[^.]+$/, '')) : slug(noteName);
  return `99-Meta/attachments/${now.getFullYear()}-${pad(now.getMonth() + 1)}/${base}-${stamp}${index ? `-${index}` : ''}.${ext}`;
}

export default function NoteView({ note, onTerminal }: { note: Note | null; onTerminal?: (path: string) => void }) {
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [flash, setFlash] = useState('');
  const [uploading, setUploading] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!note) {
    return (
      <div className="note">
        <h1>Nota não encontrada</h1>
        <p className="muted">
          O caminho informado não existe no vault. Use a busca (Ctrl+K) ou o explorador à esquerda.
        </p>
      </div>
    );
  }

  const current = note;

  async function save() {
    try {
      await vaultApi.saveNote(current.path, draft);
      await reloadVault();
      setEditing(false);
      setFlash('salvo');
    } catch (e) {
      setFlash((e as Error).message);
    }
  }

  async function remove() {
    if (!confirm(`Excluir ${current.path}? (permanente)`)) return;
    try {
      await vaultApi.deleteNote(current.path);
      await reloadVault();
      navigate('/');
    } catch (e) {
      setFlash((e as Error).message);
    }
  }

  /** envia arquivos e insere ![[nome]] no cursor do editor */
  async function attach(list: File[]) {
    if (!list.length) return;
    setUploading(true);
    const inserted: string[] = [];
    try {
      for (const [i, file] of list.entries()) {
        const target = uploadPath(file, current.name, i);
        if (!target) {
          setFlash(`${file.name || 'arquivo'}: tipo não suportado`);
          continue;
        }
        await vaultApi.uploadFile(target, file);
        inserted.push(`![[${target.split('/').pop()}]]`);
      }
    } catch (e) {
      setFlash((e as Error).message);
    } finally {
      setUploading(false);
    }
    if (!inserted.length) return;
    await reloadVault();
    const el = editorRef.current;
    const text = inserted.join('\n');
    setDraft((d) => {
      const at = el ? el.selectionStart : d.length;
      return `${d.slice(0, at)}${text}${d.slice(at)}`;
    });
    setFlash(`${inserted.length} anexo(s) enviado(s) · commit no servidor`);
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const pasted = [...e.clipboardData.files];
    if (!pasted.length) return;
    e.preventDefault();
    void attach(pasted);
  }

  function onDrop(e: DragEvent<HTMLTextAreaElement>) {
    const dropped = [...e.dataTransfer.files];
    if (!dropped.length) return;
    e.preventDefault();
    void attach(dropped);
  }

  // imagens com zoom, ![](relativo) resolvido e ![[deck.html]] como player
  const components: Components = {
    img: ({ src, alt }) => <ZoomableImage src={resolveMediaSrc(String(src ?? ''), current.folder)} alt={String(alt ?? '')} />,
    a: ({ href, className, children, node, ...rest }) => {
      const kind = (rest as Record<string, unknown>)['data-kind'] as FileKind | undefined;
      if (className?.includes('embed-file') && href && kind) {
        return <FileEmbed url={href} kind={kind} label={String(children ?? '')} />;
      }
      void node;
      return (
        <a href={href} className={className} {...rest}>
          {children}
        </a>
      );
    },
  };

  function exportAs(kind: 'md' | 'docx' | 'docx-marca' | PrintMode) {
    if (kind === 'md') downloadMarkdown(current);
    else if (kind === 'docx' || kind === 'docx-marca') downloadNoteDocx(current, kind === 'docx' ? 'simple' : 'marca').catch((err: Error) => alert(`Não foi possível exportar: ${err.message}`));
    else void printNote(current, kind);
  }

  const exportMenu = (
    <details className="export-menu">
      <summary className="btn ghost" title="Baixar .md, salvar em PDF ou Word">⬇ Exportar</summary>
      <div className="export-options" onClick={(e) => (e.currentTarget.parentElement as HTMLDetailsElement).removeAttribute('open')}>
        <button type="button" onClick={() => exportAs('md')}>Markdown (.md)</button>
        <button type="button" onClick={() => exportAs('simple')}>PDF</button>
        <button type="button" onClick={() => exportAs('marca')} title="Capa e identidade visual (AGENTS.md §8)">
          PDF com capa
        </button>
        <button type="button" onClick={() => exportAs('docx')} title="Word editável: só o conteúdo da nota">
          Word (.docx)
        </button>
        <button type="button" onClick={() => exportAs('docx-marca')} title="Word editável no padrão do documento A4: capa, cabeçalho com logo, rodapé com página (AGENTS.md §8)">
          Word com capa
        </button>
      </div>
    </details>
  );

  const actions = (
    <div className="note-actions">
      <button type="button" className="btn" onClick={() => { setEditing(true); setDraft(current.raw); }}>
        Editar
      </button>
      <button type="button" className="btn danger" onClick={() => void remove()}>
        Excluir
      </button>
      {exportMenu}
      {onTerminal && current.ext === 'md' && (
        <button
          type="button"
          className="btn term-open"
          onClick={() => onTerminal(current.path)}
          title={current.frontmatter.type === 'idea' ? 'Desenvolver esta ideia com o agente' : 'Conversar com o agente usando esta nota como contexto'}
        >
          💬 Terminal
        </button>
      )}
      {flash && <span className="flash-inline">{flash}</span>}
    </div>
  );

  if (editing) {
    return (
      <article className="note">
        <div className="note-actions">
          <button type="button" className="btn" onClick={() => void save()}>Salvar</button>
          <button type="button" className="btn ghost" onClick={() => { setEditing(false); setFlash(''); }}>Cancelar</button>
          <button type="button" className="btn danger" onClick={() => void remove()}>Excluir</button>
          <button type="button" className="btn ghost" disabled={uploading} onClick={() => fileInputRef.current?.click()} title="Ou cole (Ctrl+V) / arraste no texto">
            {uploading ? 'Enviando…' : '📎 Anexar'}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              void attach([...(e.target.files ?? [])]);
              e.target.value = '';
            }}
          />
          <span className="muted">Ctrl+Enter salva · cole ou arraste imagens · {draft.length} caracteres</span>
          {flash && <span className="flash-inline">{flash}</span>}
        </div>
        <textarea
          ref={editorRef}
          className="editor"
          value={draft}
          onPaste={onPaste}
          onDrop={onDrop}
          onDragOver={(e) => e.dataTransfer.types.includes('Files') && e.preventDefault()}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault();
              void save();
            }
          }}
          aria-label={`Conteúdo de ${current.path}`}
        />
      </article>
    );
  }

  if (current.ext === 'base') {
    return (
      <article className="note">
        {actions}
        <h1>{current.title}</h1>
        <p className="note-meta">{current.path}</p>
        <p className="muted">
          Arquivo <code>.base</code> (Bases do Obsidian). Renderizado como código — as views nativas
          não são interpretadas pelo front.
        </p>
        <pre className="code-block">{current.raw}</pre>
      </article>
    );
  }

  const subtitle = ['subtitle', 'purpose', 'description']
    .map((k) => current.frontmatter[k])
    .find((v): v is string => typeof v === 'string' && !!v);

  return (
    <article className="note">
      {/* capa: só existe na impressão "PDF com capa" (styles.css @media print) */}
      <section className="print-cover" aria-hidden="true">
        <img src="/brand/logo.png" alt="Tania" />
        <h1>{current.title}</h1>
        {subtitle && <p className="print-cover-sub">{subtitle}</p>}
        <p className="print-cover-foot">{new Date().toISOString().slice(0, 10)} · Tania</p>
      </section>
      {actions}
      <h1>{current.title}</h1>
      <p className="note-meta">
        {current.path}
        {typeof current.frontmatter.created === 'string' && ` · criado em ${current.frontmatter.created}`}
        {typeof current.frontmatter.status === 'string' && ` · status: ${current.frontmatter.status}`}
      </p>
      <div className="markdown">
        <Markdown remarkPlugins={[remarkGfm, wikilinks, callouts]} components={components}>
          {current.body}
        </Markdown>
      </div>
    </article>
  );
}

import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { notes, type Note } from '../vault';

function encode(path: string): string {
  return path.split('/').map((p) => encodeURIComponent(p)).join('/');
}

function score(note: Note, term: string): number {
  const t = term.toLowerCase();
  let s = 0;
  if (note.name.toLowerCase().includes(t)) s += 100;
  if (note.title.toLowerCase().includes(t)) s += 60;
  if (note.folder.toLowerCase().includes(t)) s += 20;
  if (note.frontmatter.tags && String(note.frontmatter.tags).toLowerCase().includes(t)) s += 15;
  if (note.body.toLowerCase().includes(t)) s += 5;
  return s;
}

/** Busca em toda a memória: nome, título, pasta, tags e corpo. */
export function searchNotes(term: string): Note[] {
  const t = term.trim();
  if (!t) return [];
  return notes
    .map((n) => ({ note: n, s: score(n, t) }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 50)
    .map((r) => r.note);
}

function snippet(note: Note, term: string): string {
  const t = term.toLowerCase();
  const idx = note.body.toLowerCase().indexOf(t);
  if (idx === -1) return note.folder || 'raiz do vault';
  const start = Math.max(0, idx - 60);
  return (start > 0 ? '…' : '') + note.body.slice(start, idx + 120).replace(/\s+/g, ' ').trim();
}

/** Página /#/busca/:q — lê o termo do proprio route (useParams), não do Layout. */
export function SearchPage() {
  const { q = '' } = useParams();
  const term = decodeURIComponent(q);
  const results = searchNotes(term);
  return (
    <article className="note">
      <h1>Resultados para “{term}”</h1>
      <p className="muted">{results.length} nota(s) encontradas em {notes.length}.</p>
      {results.length === 0 && (
        <p className="muted">Nada encontrado. Tente termos mais curtos.</p>
      )}
      <ul className="result-list">
        {results.map((n) => (
          <li key={n.path}>
            <Link to={`/${encode(n.path)}`}>{n.title}</Link>
            <span className="snippet">{snippet(n, term.trim())}</span>
          </li>
        ))}
      </ul>
    </article>
  );
}

export default function SearchBox() {
  const [term, setTerm] = useState('');
  const [open, setOpen] = useState(false);

  const results = term.trim() ? searchNotes(term) : [];

  return (
    <div className="search">
      <input
        id="vault-search"
        type="search"
        placeholder="Buscar notas…  (Ctrl+K)"
        value={term}
        onChange={(e) => {
          setTerm(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
          if (e.key === 'Enter') {
            setOpen(false);
            if (results[0]) window.location.hash = `/${encode(results[0].path)}`;
          }
        }}
      />
      {open && term.trim() && (
        <div className="search-results">
          {results.length === 0 && <p className="muted">Nada encontrado para “{term}”.</p>}
          <ul>
            {results.map((note) => (
              <li key={note.path}>
                <Link to={`/${encode(note.path)}`} onClick={() => setOpen(false)}>
                  {note.title}
                </Link>
                <span className="snippet">{snippet(note, term.trim())}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}


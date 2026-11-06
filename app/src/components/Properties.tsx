import { Link } from 'react-router-dom';
import {
  backlinks,
  danglingAttachments,
  getAssetUrl,
  noteAttachments,
  noteEmbeds,
  type Note,
} from '../vault';
import { formatValue } from '../frontmatter';
import { ClickUpCard } from './Tasks';

function encode(path: string): string {
  return path.split('/').map((p) => encodeURIComponent(p)).join('/');
}

export default function Properties({ note }: { note: Note | null }) {
  if (!note) return null;

  const entries = Object.entries(note.frontmatter).filter(([, v]) => v !== null && v !== undefined);
  const links = backlinks.get(note.path) ?? [];
  const tags = Array.isArray(note.frontmatter.tags) ? note.frontmatter.tags.map(String) : [];
  const attachments = noteAttachments(note);
  const embeds = noteEmbeds(note.body);
  const dangling = danglingAttachments(note.body);

  const clickup = typeof note.frontmatter.clickup === 'string' ? note.frontmatter.clickup.trim() : '';

  return (
    <div className="panel-inner">
      {clickup && <ClickUpCard key={clickup} id={clickup} />}
      <section className="panel-section">
        <h2>Propriedades</h2>
        {entries.length === 0 && <p className="muted">Sem frontmatter.</p>}
        <dl className="props">
          {entries.map(([key, value]) => (
            <div key={key} className="prop">
              <dt>{key}</dt>
              <dd>
                {key === 'tags'
                  ? (value as unknown[]).map((t) => {
                      const tag = String(t);
                      return (
                        <Link key={tag} className="tag" to={`/tag/${encodeURIComponent(tag)}`}>
                          #{tag}
                        </Link>
                      );
                    })
                  : formatValue(value)}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      {tags.length > 0 && (
        <section className="panel-section">
          <h2>Tags</h2>
          <div className="tag-cloud">
            {tags.map((t) => (
              <Link key={t} className="tag" to={`/tag/${encodeURIComponent(t)}`}>
                #{t}
              </Link>
            ))}
          </div>
        </section>
      )}

      {attachments.length > 0 && (
        <section className="panel-section">
          <h2>Anexos ({attachments.length})</h2>
          <ul className="attachments-list">
            {attachments.map((a) => (
              <li key={a.path}>
                <a className="attachment" href={getAssetUrl(a.url)} title={a.path}>
                  {a.path.split('/').pop()}
                </a>
                <span className="muted">{a.path.split('.').pop()?.toUpperCase()}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {embeds.length > 0 && (
        <section className="panel-section">
          <h2>Embeds ({embeds.length})</h2>
          <ul className="attachments-list">
            {embeds.map((e) => (
              <li key={e.target}>
                <Link to={`/${encode(e.target!)}`}>{e.target}</Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {dangling.length > 0 && (
        <section className="panel-section">
          <h2>Embeds não resolvidos ({dangling.length})</h2>
          <ul className="attachments-list">
            {dangling.map((e) => (
              <li key={e.target} className="dangling">
                {e.target}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="panel-section">
        <h2>Backlinks ({links.length})</h2>
        {links.length === 0 && <p className="muted">Nenhuma nota aponta para esta.</p>}
        <ul className="backlinks">
          {links.map((n) => (
            <li key={n.path}>
              <Link to={`/${encode(n.path)}`}>{n.title}</Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

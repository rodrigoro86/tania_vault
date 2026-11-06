import YAML from 'yaml';

/** Extrai o bloco YAML do frontmatter; devolve os dados e o corpo restante. */
export function splitFrontmatter(raw: string): {
  data: Record<string, unknown>;
  body: string;
} {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { data: {}, body: raw };
  let data: Record<string, unknown> = {};
  try {
    // templates do Obsidian ({{date:YYYY-MM-DD}}) não são YAML válido: neutraliza
    // antes de parsear para evitar warning/erro do parser.
    const yamlText = match[1].replace(/\{\{[^}]*\}\}/g, (m) => JSON.stringify(m));
    const parsed = YAML.parse(yamlText);
    if (parsed && typeof parsed === 'object') data = parsed as Record<string, unknown>;
  } catch {
    data = { _error: 'frontmatter YAML inválido' };
  }
  return { data, body: raw.slice(match[0].length) };
}

export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(formatValue).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

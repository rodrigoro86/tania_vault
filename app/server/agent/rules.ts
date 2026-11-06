/**
 * rules.ts — regras do vault (AGENTS.md + 99-Meta/Convencoes.md) como tipos
 * e validações. Toda escrita do agente passa por aqui: violação = erro que
 * volta ao LLM para ele corrigir; desvio leve = aviso (não bloqueia).
 */
import { s, check, type Infer, type Issues } from './schema.ts';
import { SKIP_DIRS } from '../storage/constants.mjs';

/* ---------- vocabulário (AGENTS.md §1-2) ---------- */

export const NOTE_TYPES = ['command', 'learning', 'journal', 'project', 'agent', 'prompt', 'workflow', 'run', 'inbox', 'idea'] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

export const STATUSES = ['draft', 'active', 'open', 'done', 'archived'] as const;
export const CONFIDENCE = ['low', 'medium', 'high'] as const;
export const OUTCOMES = ['success', 'partial', 'fail'] as const;

/** AGENTS.md §1: onde cada type costuma morar (recomendação, não bloqueio) */
export const FOLDER_BY_TYPE: Record<NoteType, string> = {
  command: '03-Comandos/',
  learning: '02-Estudos/',
  journal: '01-Diario/',
  project: '04-Projetos/',
  agent: '04-Agentes/Agentes/',
  prompt: '04-Agentes/Prompts/',
  workflow: '04-Agentes/Workflows/',
  run: '04-Agentes/Runs/',
  inbox: '00-Inbox/',
  idea: '05-Ideias/',
};

/** Convencoes.md: tags oficiais (lista fechada) */
export const OFFICIAL_TAGS = [
  'inbox', 'ideia', 'link',
  'agenda/diario', 'agenda/revisao', 'agenda/tarefa', 'agenda/sprint', 'apresentacao', 'projeto',
  'comando', 'comando/git', 'comando/shell', 'comando/gis', 'comando/docker', 'comando/python', 'comando/llm',
  'aprendizado', 'aprendizado/llm', 'aprendizado/obsidian', 'aprendizado/gis', 'aprendizado/dev',
  'agente', 'prompt', 'workflow', 'run',
] as const;
const TAG_ROOTS = new Set(OFFICIAL_TAGS.map((t) => t.split('/')[0]));

/* ---------- frontmatter tipado ---------- */

const isoDate = s.string({ pattern: /^\d{4}-\d{2}-\d{2}$/, patternMessage: 'data ISO AAAA-MM-DD' });
const text = s.string({ min: 1 });
const tag = s.string({ pattern: /^[a-z0-9][a-z0-9/_-]*$/, patternMessage: 'tag minúscula, sem # e sem espaço (ex.: comando/git)' });

const base = {
  created: isoDate,
  tags: s.array(tag, { min: 1 }),
  status: s.oneOf(STATUSES),
};

/** AGENTS.md §2: mínimo + "campos extras por tipo" */
export const FRONTMATTER: Record<NoteType, ReturnType<typeof s.object>> = {
  command: s.object(
    { type: s.oneOf(['command']), ...base, tool: text, command: text, confidence: s.oneOf(CONFIDENCE), source: s.optional(text) },
    { passthrough: true },
  ),
  learning: s.object(
    { type: s.oneOf(['learning']), ...base, area: text, confidence: s.oneOf(CONFIDENCE), source: s.optional(text) },
    { passthrough: true },
  ),
  project: s.object(
    { type: s.oneOf(['project']), ...base, due: isoDate, next_step: text, priority: text },
    { passthrough: true },
  ),
  agent: s.object({ type: s.oneOf(['agent']), ...base, model: text, owner: text }, { passthrough: true }),
  run: s.object(
    { type: s.oneOf(['run']), ...base, agent: text, outcome: s.oneOf(OUTCOMES), duration: text },
    { passthrough: true },
  ),
  journal: s.object({ type: s.oneOf(['journal']), ...base }, { passthrough: true }),
  prompt: s.object({ type: s.oneOf(['prompt']), ...base }, { passthrough: true }),
  workflow: s.object({ type: s.oneOf(['workflow']), ...base }, { passthrough: true }),
  inbox: s.object({ type: s.oneOf(['inbox']), ...base }, { passthrough: true }),
  idea: s.object({ type: s.oneOf(['idea']), ...base }, { passthrough: true }),
};

export type Frontmatter = Record<string, string | string[]>;

/**
 * parser do subconjunto de YAML usado no vault: `chave: valor`, listas
 * inline `[a, b]` e em bloco (`- a`), aspas simples/duplas. Sem dependência
 * (o container não instala node_modules); datas ficam como texto.
 */
export function parseFrontmatter(content: string): { data: Frontmatter; body: string } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  if (!m) return null;
  const data: Frontmatter = {};
  let listKey: string | null = null;
  const unquote = (v: string) => v.trim().replace(/^(['"])(.*)\1$/, '$2');
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const item = /^\s+-\s+(.*)$/.exec(line) ?? /^-\s+(.*)$/.exec(line);
    if (item && listKey) {
      (data[listKey] as string[]).push(unquote(item[1]));
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, raw] = kv;
    const value = raw.replace(/\s+#.*$/, '').trim();
    listKey = null;
    if (value === '') {
      data[key] = [];
      listKey = key;
    } else if (/^\[.*\]$/.test(value)) {
      data[key] = value.slice(1, -1).split(',').map(unquote).filter(Boolean);
    } else {
      data[key] = unquote(value);
    }
  }
  return { data, body: content.slice(m[0].length) };
}

/* ---------- caminhos ---------- */

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** AGENTS.md §3.3 + §6: pasta permitida e nomes ASCII com hyphens */
/** o plano é recusado antes de chegar ao usuário; o sanitize repete isto na escrita */
function outsideVault(rel: string): Issues {
  const parts = rel.split('/');
  const out = rel === 'AGENTS.md' || SKIP_DIRS.has(parts[0]) || parts.some((p) => p.startsWith('.'));
  return out ? [`${rel}: fora do vault ou protegido`] : [];
}

export function checkPath(path: string, kind: 'note' | 'folder' = 'note'): Issues {
  const rel = path.replace(/^\/+/, '');
  const issues = outsideVault(rel);
  for (const seg of rel.split('/')) {
    if (!SEGMENT.test(seg)) issues.push(`${rel}: "${seg}" precisa ser ASCII, sem espaço nem acento (use hyphens)`);
  }
  if (kind === 'note' && !rel.endsWith('.md')) issues.push(`${rel}: nota do agente termina em .md`);
  return issues;
}

/** AGENTS.md §1: type x pasta */
export function checkFolderForType(path: string, type: string): Issues {
  if (!(NOTE_TYPES as readonly string[]).includes(type)) return [`type "${type}" inválido: use ${NOTE_TYPES.join(' | ')}`];
  const folder = FOLDER_BY_TYPE[type as NoteType];
  return path.startsWith(folder) ? [] : [`${path}: type "${type}" mora em ${folder} (AGENTS.md §1)`];
}

/* ---------- nota movida ---------- */

/**
 * reaponta [[links]] e ![[embeds]] depois de mover from -> to (caminhos .md).
 * Link só pelo nome segue valendo se o nome não mudou.
 * shortcut: também troca dentro de bloco de código, separar se virar problema.
 */
export function retargetLinks(content: string, from: string, to: string): string {
  const stem = (p: string) => p.replace(/\.md$/i, '');
  const name = (p: string) => stem(p).split('/').pop() ?? '';
  const swap = (text: string, before: string, after: string) => {
    const escaped = before.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return text.replace(new RegExp(`\\[\\[${escaped}(?:\\.md)?(?=[\\]|#])`, 'gi'), () => `[[${after}`);
  };
  const byPath = from.includes('/') ? swap(content, stem(from), stem(to)) : content;
  return name(from) === name(to) ? byPath : swap(byPath, name(from), name(to));
}

/* ---------- nota inteira ---------- */

export interface NoteCheck {
  errors: Issues;
  warnings: Issues;
}

const DIARY_NOTE = /^01-Diario\/\d{4}-\d{2}-\d{2}\.md$/;
const RELATIVE_DATES = /\b(ontem|anteontem|amanh[ãa]|semana passada|m[eê]s passado|recentemente)\b/i;

/**
 * nomes resolvíveis por wikilink: nota "git" / "02-comandos/git/git" (sem .md)
 * e anexo "deck.html" / "99-meta/attachments/deck.html" (com extensão)
 */
export function linkTargets(paths: string[]): Set<string> {
  const out = new Set<string>();
  for (const p of paths) {
    const key = (/\.(md|base)$/i.test(p) ? p.replace(/\.(md|base)$/i, '') : p).toLowerCase();
    out.add(key);
    out.add(key.split('/').pop() ?? key);
  }
  return out;
}

/** wikilinks do corpo, ignorando exemplos dentro de código (cercas ``` e `inline`), como o front */
export function wikilinks(body: string): string[] {
  const text = body.replace(/```[\s\S]*?```|`[^`\n]*`/g, '');
  return [...text.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)].map((m) => m[1].trim());
}

/**
 * valida o conteúdo final de uma nota no caminho `path`.
 * `targets`: notas existentes (para os wikilinks), já incluindo a própria.
 */
export function checkNote(path: string, content: string, targets: Set<string>): NoteCheck {
  const errors: Issues = [...checkPath(path)];
  const warnings: Issues = [];

  const fm = parseFrontmatter(content);
  if (!fm) {
    errors.push('falta o frontmatter YAML no topo (--- ... ---) (AGENTS.md §2)');
    return { errors, warnings };
  }
  const type = typeof fm.data.type === 'string' ? fm.data.type : '';
  if (!type) errors.push('frontmatter.type: obrigatório');
  else if (!(NOTE_TYPES as readonly string[]).includes(type)) errors.push(`frontmatter.type: "${type}" inválido (${NOTE_TYPES.join(' | ')})`);
  else {
    const result = check(FRONTMATTER[type as NoteType], fm.data);
    if (!result.ok) errors.push(...result.issues.map((i) => `frontmatter.${i}`));
    warnings.push(...checkFolderForType(path, type));
  }

  const tags = Array.isArray(fm.data.tags) ? fm.data.tags : [];
  for (const t of tags) {
    const root = t.split('/')[0];
    if (!TAG_ROOTS.has(root)) errors.push(`tag "${t}": raiz fora da lista oficial (${[...TAG_ROOTS].join(', ')}) — Convencoes.md`);
    else if (!(OFFICIAL_TAGS as readonly string[]).includes(t)) warnings.push(`tag "${t}" não está na lista fechada do Convencoes.md`);
  }

  if (!/^#\s+\S/m.test(fm.body)) errors.push('falta o título H1 (# Título em português) (AGENTS.md §3.3)');
  if (type === 'command' && !/```bash\n[\s\S]*?```/.test(fm.body)) {
    errors.push('nota de comando precisa do comando exato num bloco ```bash (AGENTS.md §3.6)');
  }

  if (path.startsWith(FOLDER_BY_TYPE.journal) && !DIARY_NOTE.test(path)) {
    errors.push(`${path}: o diário tem um arquivo por dia (${FOLDER_BY_TYPE.journal}AAAA-MM-DD.md); acrescente o conteúdo no arquivo do dia`);
  }

  const links = wikilinks(fm.body);
  const resolved = links.filter((l) => targets.has(l.toLowerCase()) || targets.has(l.toLowerCase().replace(/\.md$/, '')));
  if (!resolved.length) {
    warnings.push(
      links.length
        ? `nenhum wikilink aponta para nota existente (${links.map((l) => `[[${l}]]`).join(', ')}); linke ao menos 1 quando houver (AGENTS.md §3.4)`
        : 'linke notas relacionadas com [[Nome-da-nota]] quando existirem (AGENTS.md §3.4)',
    );
  }
  for (const l of links) if (!resolved.includes(l)) warnings.push(`[[${l}]] não existe (link quebrado)`);

  if (RELATIVE_DATES.test(content)) warnings.push('data relativa ("ontem", "recentemente"…): use data ISO explícita (AGENTS.md §3.8)');
  return { errors, warnings };
}

/* ---------- arquivos (apresentações HTML, SVG) ---------- */

/** pasta padrão dos anexos */
export const FILE_DIR = '99-Meta/attachments/';
/** o agente só escreve arquivos de texto que o site abre: HTML (slides) e SVG (diagramas) */
export const AGENT_FILE_EXT = ['html', 'htm', 'svg'] as const;
export const MAX_FILE_CHARS = 1_500_000;

export function checkFilePath(path: string): Issues {
  const rel = path.replace(/^\/+/, '');
  const issues = outsideVault(rel);
  for (const seg of rel.split('/')) {
    if (!SEGMENT.test(seg)) issues.push(`${rel}: "${seg}" precisa ser ASCII, sem espaço nem acento (use hyphens)`);
  }
  const ext = /\.([a-z0-9]+)$/i.exec(rel)?.[1]?.toLowerCase() ?? '';
  if (!(AGENT_FILE_EXT as readonly string[]).includes(ext)) issues.push(`${rel}: o agente só cria ${AGENT_FILE_EXT.map((e) => `.${e}`).join(', ')}`);
  return issues;
}

/**
 * conteúdo de HTML/SVG. O site abre esses arquivos isolados (CSP sandbox, sem
 * login): CDN https e data: funcionam; caminho relativo do vault não carrega.
 */
export function checkFile(path: string, content: string): NoteCheck {
  const errors: Issues = [...checkFilePath(path)];
  const warnings: Issues = [];
  if (content.length > MAX_FILE_CHARS) errors.push(`arquivo grande demais (${content.length} caracteres; máx. ${MAX_FILE_CHARS})`);
  if (/\.svg$/i.test(path)) {
    if (!/<svg[\s>]/i.test(content)) errors.push('SVG precisa ter a tag <svg>');
  } else if (!/<!doctype html|<html[\s>]/i.test(content)) {
    errors.push('HTML precisa ser um documento completo (<!doctype html> ... </html>)');
  }
  const local = [...content.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)]
    .map((m) => m[1])
    // /brand/… (logos da identidade visual) é público: carrega mesmo isolado
    .filter((u) => !/^(https:|data:|blob:|#|mailto:|javascript:|about:|\/brand\/)/i.test(u));
  if (local.length) {
    warnings.push(`recursos locais não carregam no modo isolado (use CDN https:// ou data:): ${[...new Set(local)].slice(0, 5).join(', ')}`);
  }
  if (/\b(?:src|href)\s*=\s*["']http:/i.test(content)) warnings.push('recurso via http:// será bloqueado (site em https); use https://');
  return { errors, warnings };
}

/* ---------- plano de ações (decisão estruturada) ---------- */

export const PLAN_ACTIONS = ['create', 'append', 'update', 'move', 'create_folder', 'create_file', 'update_file'] as const;

export const PlanAction = s.object({
  action: s.oneOf(PLAN_ACTIONS, 'o que fazer'),
  path: s.string({ min: 1, description: 'nota/pasta alvo (origem, no move)' }),
  to: s.optional(s.string({ min: 1, description: 'destino (só no move)' })),
  type: s.optional(s.oneOf(NOTE_TYPES, 'type da nota resultante (obrigatório em create)')),
  reason: s.string({ min: 3, description: 'por que esta decisão (uma frase)' }),
});
export type PlanAction = Infer<typeof PlanAction>;

export const Plan = s.object({
  summary: s.string({ min: 3, description: 'resumo do plano para o usuário aprovar' }),
  actions: s.array(PlanAction, { min: 1, max: 30, description: 'ações, na ordem de execução' }),
});
export type Plan = Infer<typeof Plan>;

/** valida o plano contra as regras de caminho/pasta antes de mostrar ao usuário */
export function checkPlan(plan: Plan): Issues {
  const issues: Issues = [];
  plan.actions.forEach((a, i) => {
    const at = (m: string) => `actions[${i}] (${a.action} ${a.path}): ${m}`;
    if (a.action === 'create_folder') {
      issues.push(...checkPath(a.path, 'folder').map(at));
      return;
    }
    if (a.action === 'create_file' || a.action === 'update_file') {
      issues.push(...checkFilePath(a.path).map(at));
      return;
    }
    if (a.action === 'move') {
      if (!a.to) issues.push(at('move precisa de "to"'));
      else issues.push(...checkPath(a.to).map(at));
    } else {
      issues.push(...checkPath(a.path).map(at));
    }
    if (a.action === 'create' && !a.type) issues.push(at('informe o "type" da nota'));
  });
  return issues;
}

/** a ação de escrita está no plano aprovado? */
export function planAllows(plan: Plan | null, need: { action: PlanAction['action']; path: string; to?: string }): boolean {
  if (!plan) return false;
  const norm = (p?: string) => (p ?? '').replace(/^\/+/, '');
  return plan.actions.some(
    (a) => a.action === need.action && norm(a.path) === norm(need.path) && (need.action !== 'move' || norm(a.to) === norm(need.to)),
  );
}

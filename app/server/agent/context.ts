/**
 * context.ts — orçamento de contexto do agente (server/agent.ts).
 *
 * Três problemas, três peças:
 *   - leitura: nota grande vem em partes (sumário de seções + trecho), em vez
 *     de cortar em silêncio no limite do resultado da ferramenta;
 *   - histórico: resultados de ferramentas de turnos antigos viram uma linha e
 *     a conversa respeita um orçamento em caracteres (~4 por token);
 *   - saída: max_tokens por provedor (DeepSeek manda só ~4k se ninguém pedir).
 *
 * Funções puras: sem disco nem rede, testadas em server/tests/context.test.mjs.
 */

/** trecho máximo devolvido por leitura; fica abaixo do corte do resultado (MAX_TOOL_OUTPUT) com folga para o JSON */
export const READ_CHUNK = 15_000;
/** histórico enviado ao LLM (sem o system prompt): ~30k tokens */
export const HISTORY_BUDGET = 120_000;
/** resultado de ferramenta antigo acima disto vira resumo de uma linha */
export const OLD_TOOL_KEEP = 1_500;

/** limite de saída padrão por host, quando o agent.config.json não define maxTokens */
const DEFAULT_MAX_TOKENS: Record<string, number> = {
  'api.deepseek.com': 8192,
};

export function maxTokensFor(baseUrl: string, configured?: unknown): number | undefined {
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) return Math.floor(configured);
  try {
    return DEFAULT_MAX_TOKENS[new URL(baseUrl).host];
  } catch {
    return undefined;
  }
}

/* ---------- leitura em partes ---------- */

export interface Section {
  heading: string;
  level: number;
  start: number;
  end: number;
}

/** títulos markdown fora de blocos de código, com o intervalo [start, end) de cada seção */
export function outlineOf(text: string): Section[] {
  const out: Section[] = [];
  let fence = false;
  let pos = 0;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    else if (!fence) {
      const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (m) out.push({ heading: m[2], level: m[1].length, start: pos, end: text.length });
    }
    pos += line.length + 1;
  }
  for (let i = 0; i < out.length; i++) {
    const next = out.slice(i + 1).find((s) => s.level <= out[i].level);
    out[i].end = next ? next.start : text.length;
  }
  return out;
}

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/^#+\s*/, '')
    .trim()
    .toLowerCase();

/** sumário compacto para o LLM: nível, título e tamanho de cada seção */
export function briefOutline(text: string, max = 150) {
  return outlineOf(text)
    .slice(0, max)
    .map((s) => ({ level: s.level, heading: s.heading, chars: s.end - s.start }));
}

export type Part =
  | { ok: true; content: string; offset: number; size: number; section?: string; next_offset?: number; remaining?: number }
  | { ok: false; error: string };

/**
 * trecho de `text`: a seção pedida (título exato ou contido, sem acento/caixa)
 * e/ou a partir de `offset` (relativo à seção). Corta em fim de linha.
 */
export function readPart(text: string, opts: { section?: string; offset?: number } = {}, chunk = READ_CHUNK): Part {
  let slice = text;
  let section: string | undefined;
  if (opts.section) {
    const want = norm(opts.section);
    const all = outlineOf(text);
    const sec = all.find((s) => norm(s.heading) === want) ?? all.find((s) => norm(s.heading).includes(want));
    if (!sec) return { ok: false, error: `seção "${opts.section}" não encontrada` };
    slice = text.slice(sec.start, sec.end);
    section = sec.heading;
  }
  const offset = Math.max(0, Math.min(opts.offset ?? 0, slice.length));
  let end = Math.min(offset + chunk, slice.length);
  if (end < slice.length) {
    const nl = slice.lastIndexOf('\n', end);
    if (nl > offset + chunk / 2) end = nl + 1;
  }
  const content = slice.slice(offset, end);
  const remaining = slice.length - end;
  return {
    ok: true,
    content,
    offset,
    size: slice.length,
    ...(section ? { section } : {}),
    ...(remaining > 0 ? { next_offset: end, remaining } : {}),
  };
}

/* ---------- histórico ---------- */

export interface HistoryMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

const size = (m: HistoryMessage) => (m.content?.length ?? 0) + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0);

/** argumentos grandes de turnos antigos (ex.: o HTML inteiro de um create_file) também viram resumo */
function compactCall(call: NonNullable<HistoryMessage['tool_calls']>[number]) {
  const args = call.function.arguments ?? '';
  if (args.length <= OLD_TOOL_KEEP) return call;
  let pathArg = '';
  try {
    pathArg = String((JSON.parse(args) as { path?: unknown }).path ?? '');
  } catch {
    /* argumentos cortados: fica sem o caminho */
  }
  return { ...call, function: { ...call.function, arguments: JSON.stringify({ path: pathArg || undefined, compactado: `${args.length} caracteres de argumentos de um turno anterior` }) } };
}

/**
 * - turnos anteriores ao último pedido do usuário: resultados de ferramenta e
 *   argumentos grandes viram uma linha (a nota continua no disco: o agente relê
 *   se precisar);
 * - depois corta turnos inteiros pelo começo até caber em `budget`, sem separar
 *   tool_calls das respostas (o corte sempre recomeça numa mensagem do usuário).
 */
export function compactHistory<T extends HistoryMessage>(msgs: T[], budget = HISTORY_BUDGET): T[] {
  const lastUser = msgs.map((m) => m.role).lastIndexOf('user');
  const out = msgs.map((m, i) => {
    if (i >= lastUser) return m;
    if (m.role === 'tool' && (m.content?.length ?? 0) > OLD_TOOL_KEEP) {
      return { ...m, content: `[resultado de um turno anterior compactado: ${m.content!.length} caracteres. Releia com a ferramenta se precisar. Início: ${m.content!.slice(0, 300)}…]` };
    }
    if (m.role === 'assistant' && m.tool_calls?.some((c) => (c.function.arguments?.length ?? 0) > OLD_TOOL_KEEP)) {
      return { ...m, tool_calls: m.tool_calls.map(compactCall) };
    }
    return m;
  });
  let total = out.reduce((n, m) => n + size(m), 0);
  let start = 0;
  while (total > budget) {
    const next = out.findIndex((m, i) => i > start && m.role === 'user');
    if (next < 0 || next > lastUser) break; // o último pedido fica sempre
    for (let i = start; i < next; i++) total -= size(out[i]);
    start = next;
  }
  return out.slice(start);
}

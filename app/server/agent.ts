/**
 * agent.ts — agente LLM do vault (terminal do painel da direita).
 *
 * Roda direto no Node >= 22.18 (type stripping: só sintaxe TS "apagável",
 * checado por `erasableSyntaxOnly` em tsconfig.server.json).
 *
 * Provedor: qualquer API compatível com OpenAI `/chat/completions` + tools
 * (OpenAI, Gemini, OpenRouter, Groq, DeepSeek, Ollama…), cadastrados em
 * app/agent.config.json (fora do git: tem as chaves; modelo em
 * agent.config.example.json) ou na tabela `agentes_config` (id=1): havendo
 * linha no banco, ela vence o arquivo. "active" escolhe o provedor; a config
 * é relida a cada pedido e `/modelo <nome>` no terminal troca o ativo sem restart.
 *
 * Type-safe em três camadas (server/agent/schema.ts + rules.ts):
 *   1. argumentos de toda ferramenta validados por schema (o mesmo schema
 *      gera o tipo TS e o JSON Schema enviado ao LLM);
 *   2. decisão estruturada: antes de escrever, o LLM chama `propose_plan`
 *      com ações tipadas {action, path, to?, type?, reason}; o plano aparece no
 *      terminal, vale na hora e só as ações dele podem escrever;
 *   3. o conteúdo final de cada nota é validado contra o AGENTS.md
 *      (frontmatter por type, pasta x type, nome ASCII, H1, wikilink, tags).
 *      Erro volta ao LLM para corrigir; aviso não bloqueia.
 *
 * Ferramentas só enxergam o vault e passam pelo mesmo sanitize/commit da API
 * de escrita (AGENTS.md §6). Não existe ferramenta de apagar (AGENTS.md §3).
 *
 * Protocolo: POST /api/agent/chat {messages, approvedPlan?, contextPath?} -> NDJSON:
 *   {type:'assistant',text} {type:'tool',name,args} {type:'tool_result',name,ok,summary,wrote,issues?,warnings?}
 *   {type:'plan',plan}          (registrado; o agente segue executando)
 *   {type:'messages',messages}  (novas mensagens para o cliente guardar no histórico)
 *   {type:'error',error}
 * GET /api/agent/status (provedores sem as chaves) · POST /api/agent/config {active}
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { store, ApiError, sanitize, sanitizeFile, listVault, readJson, writeVaultFile } from './vault-api.mjs';
import { s, check, type Schema, type Issues } from './agent/schema.ts';
import {
  NOTE_TYPES,
  FOLDER_BY_TYPE,
  OFFICIAL_TAGS,
  Plan,
  checkPlan,
  retargetLinks,
  planAllows,
  checkNote,
  checkPath,
  checkFile,
  FILE_DIR,
  parseFrontmatter,
  linkTargets,
  type PlanAction,
} from './agent/rules.ts';
import { READ_CHUNK, briefOutline, compactHistory, maxTokensFor, readPart } from './agent/context.ts';
import { applyEdits } from './agent/edits.ts';
import { carregarTools, type FunctionSpec, type Remotas } from './agent/tools-remotas.ts';

/** teto de segurança contra loop; o agente trabalha até terminar, sem pedir para continuar */
const MAX_STEPS = 60;
/** respostas de texto cortadas no max_tokens que o servidor continua sozinho, por turno */
const MAX_CONTINUATIONS = 6;
const CONTINUE_PROMPT =
  '[continuação automática] Sua resposta anterior foi cortada pelo limite de saída. Continue exatamente de onde parou, sem repetir o que já escreveu e sem comentar o corte.';
const MAX_HISTORY = 60;
const MAX_TOOL_OUTPUT = 20_000;

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolOutput {
  ok: boolean;
  result: unknown;
  summary: string;
  wrote?: boolean;
  issues?: Issues;
  warnings?: Issues;
  /** propose_plan válido: autoriza as ações dele a partir daí */
  plan?: Plan;
}

interface ToolContext {
  /** plano em vigor neste pedido (null = nada pode escrever) */
  approved: Plan | null;
  /** funções MCP das tools registradas (Task 4); ausente = só as do núcleo */
  remotas?: Remotas | null;
}

interface Tool {
  description: string;
  parameters: Record<string, unknown>;
  execute: (raw: unknown, ctx: ToolContext) => Promise<ToolOutput>;
}

/* ---------- configuração (agent.config.json) ---------- */

const HERE = path.dirname(new URL(import.meta.url).pathname);
/** app/agent.config.json; AGENT_CONFIG troca o caminho (testes) */
export const CONFIG_PATH = path.resolve(process.env.AGENT_CONFIG || path.join(HERE, '..', 'agent.config.json'));

interface ProviderConfig {
  baseUrl: string;
  apiKey?: string;
  /** variável de ambiente com a chave (segredo fica no .env, fora do JSON) */
  apiKeyEnv?: string;
  model: string;
  /** limite de saída por resposta (max_tokens); omitido = padrão do host (context.ts) */
  maxTokens?: number;
}

interface AgentConfig {
  active?: string;
  providers?: Record<string, ProviderConfig>;
}

/* ---------- banco (agentes_config) como fonte da config ---------- */

/** query injetada pelos testes; null = usa o pool real quando o banco está configurado */
let dbQuery: ((sql: string, params?: unknown[]) => Promise<{ rows: any[] }>) | null = null;

export function setAgentDbQuery(fn: typeof dbQuery) {
  dbQuery = fn;
}

/** null = banco nenhum (nem injetado, nem configurado); erro do banco vira exceção */
async function runDb(sql: string, params: unknown[] = []): Promise<{ rows: any[] } | null> {
  if (dbQuery) return dbQuery(sql, params);
  const db = await import('./db.mjs');
  if (db.dbConfigured()) return db.getPool().query(sql, params);
  return null;
}

/** de onde veio a config da última loadConfig(): banco (agentes_config) ou arquivo */
let lastSource: 'banco' | 'arquivo' = 'arquivo';

export interface Provider {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
}

/**
 * config do agente: o banco (`agentes_config`, id=1) vence o arquivo; sem linha,
 * tabela ausente (42P01) ou erro do banco → o arquivo, como sempre.
 * null = arquivo também não existe; JSON inválido vira erro (melhor que ignorar em silêncio).
 * Relida a cada pedido, então trocar no banco vale na hora, sem restart.
 */
async function loadConfig(): Promise<AgentConfig | null> {
  try {
    const out = await runDb('select config from agentes_config where id = 1');
    if (out?.rows?.length) {
      lastSource = 'banco';
      return out.rows[0].config as AgentConfig;
    }
  } catch (err) {
    // 42P01 = tabela não existe ainda: esperado antes da migration 102, não alarma
    if ((err as { code?: string }).code !== '42P01') {
      console.warn('agent: config do banco indisponível:', (err as Error).message);
    }
  }
  lastSource = 'arquivo';
  let raw: string;
  try {
    raw = await fs.readFile(CONFIG_PATH, 'utf8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw) as AgentConfig;
  } catch (err) {
    throw new ApiError(500, `app/agent.config.json inválido: ${(err as Error).message}`);
  }
}

/** chave do provedor: `apiKeyEnv` lê do .env (segredo fora do JSON); `apiKey` inline é fallback */
function keyOf(p: { apiKey?: string; apiKeyEnv?: string }): string {
  if (typeof p.apiKeyEnv === 'string' && p.apiKeyEnv) return process.env[p.apiKeyEnv] ?? '';
  return typeof p.apiKey === 'string' ? p.apiKey : '';
}

function providerOf(cfg: AgentConfig | null, name = cfg?.active): Provider | null {
  const p = name ? cfg?.providers?.[name] : undefined;
  if (!name || !p || typeof p.baseUrl !== 'string' || typeof p.model !== 'string' || !p.model) return null;
  const baseUrl = p.baseUrl.replace(/\/+$/, '');
  return { name, baseUrl, apiKey: keyOf(p), model: p.model, maxTokens: maxTokensFor(baseUrl, p.maxTokens) };
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** status para o navegador: nunca inclui as chaves, só se existem */
async function publicStatus() {
  const cfg = await loadConfig();
  const active = providerOf(cfg);
  const providers = Object.entries(cfg?.providers ?? {}).map(([name, p]) => ({
    name,
    model: p?.model ?? null,
    host: hostOf(p?.baseUrl ?? ''),
    hasKey: !!keyOf(p),
    active: name === cfg?.active,
  }));
  return {
    ok: true,
    configured: !!active,
    hasConfig: !!cfg,
    source: lastSource,
    active: active?.name ?? null,
    model: active?.model ?? null,
    provider: active ? hostOf(active.baseUrl) : null,
    providers,
    tools: Object.keys(TOOLS),
  };
}

/** troca só o "active": no banco por jsonb_set, no arquivo por escrita atômica (tmp + rename, 600) */
async function setActive(name: string) {
  const cfg = await loadConfig();
  if (!cfg) throw new ApiError(404, 'sem configuração do agente: cadastre em 🤖 Agents ou crie app/agent.config.json');
  if (!providerOf(cfg, name)) throw new ApiError(400, `provedor "${name}" não existe ou está sem baseUrl/model`);
  if (lastSource === 'banco') {
    await runDb(
      "update agentes_config set config = jsonb_set(config, '{active}', to_jsonb($1::text)), atualizado_em = now() where id = 1",
      [name],
    );
    return;
  }
  cfg.active = name;
  const tmp = `${CONFIG_PATH}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, CONFIG_PATH);
}

/* ---------- ferramentas ---------- */

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new ApiError(400, `${name} é obrigatório`);
  return v;
};

const title = (raw: string): string => /^#\s+(.+)$/m.exec(raw)?.[1].trim() ?? '';

const fail = (summary: string, issues: Issues = [], warnings: Issues = [], extra: Record<string, unknown> = {}): ToolOutput => ({
  ok: false,
  summary,
  issues,
  warnings,
  result: { error: summary, issues, warnings, ...extra },
});

type WriteNeed = { action: PlanAction['action']; path: string; to?: string };

/**
 * ferramenta tipada: `args` valida e tipa os argumentos (e vira o JSON Schema
 * do LLM); `needs` declara qual ação do plano aprovado ela exige para escrever
 */
function defineTool<T>(def: {
  description: string;
  args: Schema<T>;
  needs?: (args: T) => WriteNeed;
  run: (args: T, ctx: ToolContext) => Promise<ToolOutput>;
}): Tool {
  return {
    description: def.description,
    parameters: def.args.json(),
    async execute(raw, ctx) {
      const parsed = check(def.args, raw);
      if (!parsed.ok) return fail('argumentos inválidos', parsed.issues);
      if (def.needs) {
        const need = def.needs(parsed.value);
        if (!planAllows(ctx.approved, need)) {
          return fail(
            ctx.approved
              ? `"${need.action} ${need.path}${need.to ? ` -> ${need.to}` : ''}" não está no plano aprovado: proponha um novo plano`
              : 'escrita sem plano: chame propose_plan antes',
          );
        }
      }
      return def.run(parsed.value, ctx);
    },
  };
}

async function existingTargets(extra: string[] = []): Promise<Set<string>> {
  const { notes, files } = await listVault();
  return linkTargets([...notes.map((n) => n.path), ...files.map((f) => f.path), ...extra]);
}

/** valida o conteúdo final; com erro, nada é gravado */
async function validated(rel: string, content: string): Promise<{ errors: Issues; warnings: Issues }> {
  return checkNote(rel, content, await existingTargets([rel]));
}

/** nota grande: trecho + sumário de seções (na 1ª leitura) + como continuar */
function partResult(rel: string, text: string, args: { section?: string; offset?: number }): ToolOutput {
  const part = readPart(text, args);
  if (!part.ok) return fail(part.error, [], [], { outline: briefOutline(text) });
  const { ok: _ok, ...rest } = part;
  const first = !args.section && !args.offset;
  const where = part.section ? `seção "${part.section}", ` : '';
  return {
    ok: true,
    summary: `${rel} (${where}caracteres ${part.offset}–${part.offset + part.content.length} de ${part.size})`,
    result: {
      path: rel,
      total_chars: text.length,
      ...rest,
      ...(first ? { outline: briefOutline(text) } : {}),
      ...(part.next_offset !== undefined
        ? { hint: `continua: read_note com ${part.section ? `section "${part.section}" e ` : ''}offset ${part.next_offset}, ou só a section que interessa` }
        : {}),
    },
  };
}

function fileResult(out: { path: string }, summary: string, warnings: Issues): ToolOutput {
  return {
    ok: true,
    wrote: true,
    summary: warnings.length ? `${summary} (${warnings.length} aviso(s))` : summary,
    warnings,
    result: { ok: true, path: out.path, warnings, embed: `![[${out.path.split('/').pop()}]]` },
  };
}

function writeResult(paths: string[], summary: string, warnings: Issues = []): ToolOutput {
  return {
    ok: true,
    wrote: true,
    summary: warnings.length ? `${summary} (${warnings.length} aviso(s))` : summary,
    warnings,
    result: { ok: true, paths, warnings },
  };
}

const notePath = s.string({ min: 1, description: 'caminho da nota no vault, ex.: "03-Comandos/Git/Git-log.md"' });
/** trechos procurar/substituir de edit_file/edit_note (agent/edits.ts) */
const edits = s.array(
  s.object({
    old: s.string({ min: 1, description: 'trecho atual, copiado EXATAMENTE do arquivo (com espaços e quebras de linha); precisa ser único' }),
    new: s.string({ description: 'texto que entra no lugar (vazio = remove o trecho)' }),
    all: s.optional(s.boolean('substitui todas as ocorrências (padrão: false, o trecho precisa ser único)')),
  }),
  { min: 1, max: 50, description: 'aplicadas em ordem, tudo ou nada' },
);
const content = s.string({ min: 1, description: 'conteúdo completo: frontmatter YAML + "# Título" + corpo com ao menos 1 [[wikilink]]' });

export const TOOLS: Record<string, Tool> = {
  list_notes: defineTool({
    description: 'Lista as notas do vault (caminho, type do frontmatter e título). Opcionalmente filtra por pasta.',
    args: s.object({ folder: s.optional(s.string({ description: 'pasta, ex.: "03-Comandos/Git"; omitido = vault inteiro' })) }),
    async run({ folder }) {
      const dir = (folder ?? '').replace(/^\/+|\/+$/g, '');
      const { notes, folders } = await listVault();
      const list = notes
        .filter((n) => !dir || n.path.startsWith(`${dir}/`))
        .map((n) => {
          const t = parseFrontmatter(n.raw)?.data.type;
          return { path: n.path, type: typeof t === 'string' ? t : '', title: title(n.raw) };
        });
      const subfolders = folders.filter((f) => !dir || f.startsWith(`${dir}/`));
      return { ok: true, summary: `${list.length} notas`, result: { notes: list, folders: subfolders } };
    },
  }),

  read_note: defineTool({
    description:
      `Lê uma nota (frontmatter + corpo). Até ${READ_CHUNK} caracteres vem inteira; maior que isso vem em partes: ` +
      'a 1ª leitura traz o sumário (outline: títulos e tamanho de cada seção) e o começo; peça o resto com section (título) e/ou offset (next_offset).',
    args: s.object({
      path: notePath,
      section: s.optional(s.string({ min: 1, description: 'título de uma seção do outline (ex.: "Próximos passos"); lê só ela' })),
      offset: s.optional(s.number({ min: 0, description: 'continua de next_offset (relativo à seção, se houver)' })),
    }),
    async run(args) {
      const { rel } = sanitize(args.path, 'note');
      if (!(await store.exists(rel))) return fail(`${rel} não existe`);
      const text = await store.readText(rel);
      if (text.length <= READ_CHUNK && !args.section && !args.offset) {
        return { ok: true, summary: `${rel} (${text.length} caracteres)`, result: { path: rel, content: text } };
      }
      return partResult(rel, text, args);
    },
  }),

  search_notes: defineTool({
    description: 'Busca texto (sem diferenciar maiúsculas) em todas as notas. Devolve caminho, linha e trecho.',
    args: s.object({
      query: s.string({ min: 1 }),
      limit: s.optional(s.number({ min: 1, max: 100, description: 'máximo de resultados (padrão 30)' })),
    }),
    async run({ query, limit = 30 }) {
      const q = query.toLowerCase();
      const { notes } = await listVault();
      const hits: { path: string; line: number; text: string }[] = [];
      for (const n of notes) {
        const lines = n.raw.split('\n');
        for (let i = 0; i < lines.length && hits.length < limit; i++) {
          if (lines[i].toLowerCase().includes(q)) hits.push({ path: n.path, line: i + 1, text: lines[i].slice(0, 200) });
        }
        if (hits.length >= limit) break;
      }
      return { ok: true, summary: `${hits.length} ocorrências de "${query}"`, result: { hits } };
    },
  }),

  check_note: defineTool({
    description: 'Valida um rascunho contra as regras do vault SEM gravar. Use antes de propor/criar para acertar frontmatter, pasta e links.',
    args: s.object({ path: notePath, content }),
    async run(args) {
      const v = await validated(args.path.replace(/^\/+/, ''), args.content);
      return {
        ok: v.errors.length === 0,
        summary: v.errors.length ? `${v.errors.length} erro(s)` : `válida${v.warnings.length ? ` (${v.warnings.length} aviso(s))` : ''}`,
        issues: v.errors,
        warnings: v.warnings,
        result: { valid: v.errors.length === 0, errors: v.errors, warnings: v.warnings },
      };
    },
  }),

  propose_plan: defineTool({
    description:
      'OBRIGATÓRIO antes de qualquer escrita: propõe ao usuário as ações (create/append/update/move/create_folder) com caminho, type e motivo. O turno termina e o usuário aprova ou rejeita no terminal.',
    args: Plan,
    async run(plan) {
      const issues = checkPlan(plan);
      if (issues.length) return fail('plano viola as regras do vault', issues);
      return { ok: true, plan, summary: `plano com ${plan.actions.length} ação(ões) registrado`, result: { status: 'registrado: execute as ações agora' } };
    },
  }),

  create_note: defineTool({
    description: 'Cria uma nota nova (falha se já existir). Exige ação "create" no plano aprovado; o conteúdo é validado contra o AGENTS.md.',
    args: s.object({ path: notePath, content }),
    needs: (a) => ({ action: 'create', path: a.path }),
    async run(args) {
      const { rel } = sanitize(args.path, 'note');
      if (await store.exists(rel)) return fail(`${rel} já existe: use append_to_note ou update_note`);
      const v = await validated(rel, args.content);
      if (v.errors.length) return fail(`${rel} não segue as regras do vault`, v.errors, v.warnings);
      await store.writeText(rel, args.content);
      return writeResult([rel], `criada ${rel}`, v.warnings);
    },
  }),

  append_to_note: defineTool({
    description: 'Acrescenta texto ao final de uma nota existente (preferido a reescrever: "append > rewrite"). Exige ação "append" no plano aprovado.',
    args: s.object({ path: notePath, text: s.string({ min: 1, description: 'markdown a acrescentar (sem frontmatter)' }) }),
    needs: (a) => ({ action: 'append', path: a.path }),
    async run(args) {
      const { rel } = sanitize(args.path, 'note');
      if (!(await store.exists(rel))) return fail(`${rel} não existe`);
      if (/^---\r?\n/.test(args.text)) return fail('o texto acrescentado não pode ter frontmatter (já existe no topo da nota)');
      const issues = checkPath(rel);
      if (issues.length) return fail(`${rel} fora do escopo do agente`, issues);
      const current = await store.readText(rel);
      await store.writeText(rel, `${current.replace(/\n*$/, '\n\n')}${args.text.replace(/\n*$/, '\n')}`);
      return writeResult([rel], `acrescentado em ${rel}`);
    },
  }),

  update_note: defineTool({
    description:
      'Substitui o conteúdo inteiro de uma nota existente. Só quando o usuário pedir para reescrever/corrigir; registre em "## Historial de ajustes". Exige ação "update" no plano aprovado; conteúdo validado.',
    args: s.object({ path: notePath, content }),
    needs: (a) => ({ action: 'update', path: a.path }),
    async run(args) {
      const { rel } = sanitize(args.path, 'note');
      if (!(await store.exists(rel))) return fail(`${rel} não existe: use create_note`);
      const v = await validated(rel, args.content);
      if (!/^##\s+Historial de ajustes/m.test(args.content)) v.warnings.push('sem seção "## Historial de ajustes" registrando a mudança (AGENTS.md §3.1)');
      if (v.errors.length) return fail(`${rel} não segue as regras do vault`, v.errors, v.warnings);
      await store.writeText(rel, args.content);
      return writeResult([rel], `editada ${rel}`, v.warnings);
    },
  }),

  edit_note: defineTool({
    description:
      'Ajusta trechos de uma nota existente sem reenviar a nota inteira (procurar/substituir). Preferido a update_note para correções pontuais. ' +
      'Leia antes com read_note e copie o trecho exato. Exige ação "update" no plano aprovado; o resultado é validado pelas regras do vault.',
    args: s.object({ path: notePath, edits }),
    needs: (a) => ({ action: 'update', path: a.path }),
    async run(args) {
      const { rel } = sanitize(args.path, 'note');
      if (!(await store.exists(rel))) return fail(`${rel} não existe: use create_note`);
      const r = applyEdits(await store.readText(rel), args.edits);
      if (!r.ok) return fail(`nenhuma edição aplicada em ${rel}`, r.errors);
      const v = await validated(rel, r.text);
      if (v.errors.length) return fail(`${rel} não segue as regras do vault depois das edições`, v.errors, v.warnings);
      await store.writeText(rel, r.text);
      return writeResult([rel], `${r.replaced} trecho(s) ajustado(s) em ${rel}`, v.warnings);
    },
  }),

  move_note: defineTool({
    description:
      'Move/renomeia uma nota (ex.: tirar do 00-Inbox para a pasta certa), sem sobrescrever. Se o type muda com a pasta, mande "content" já com o frontmatter novo. Exige ação "move" no plano aprovado.',
    args: s.object({
      from: notePath,
      to: notePath,
      content: s.optional(s.string({ min: 1, description: 'conteúdo novo para o destino (ex.: type inbox -> command)' })),
    }),
    needs: (a) => ({ action: 'move', path: a.from, to: a.to }),
    async run(args) {
      const from = sanitize(args.from, 'note');
      const to = sanitize(args.to, 'note');
      if (!(await store.exists(from.rel))) return fail(`${from.rel} não existe`);
      if (await store.exists(to.rel)) return fail(`${to.rel} já existe`);
      // só mover não muda o texto: nota antiga fora do padrão também pode ser organizada
      const v = args.content === undefined ? { errors: [], warnings: [] } : await validated(to.rel, args.content);
      if (v.errors.length) return fail(`${to.rel} não segue as regras do vault`, v.errors, v.warnings);
      await store.rename(from.rel, to.rel);
      if (args.content !== undefined) await store.writeText(to.rel, args.content);
      const linked: string[] = [];
      for (const n of (await listVault()).notes) {
        const next = retargetLinks(n.raw, from.rel, to.rel);
        if (next === n.raw) continue;
        await store.writeText(n.path, next);
        linked.push(n.path);
      }
      const summary = `movida ${from.rel} → ${to.rel}${linked.length ? ` (links em ${linked.length} nota(s))` : ''}`;
      return writeResult([from.rel, to.rel, ...linked], summary, v.warnings);
    },
  }),

  create_folder: defineTool({
    description: 'Cria uma pasta em qualquer lugar do vault. Exige ação "create_folder" no plano aprovado.',
    args: s.object({ path: s.string({ min: 1, description: 'ex.: "02-Estudos/Infra/Kubernetes"' }) }),
    needs: (a) => ({ action: 'create_folder', path: a.path }),
    async run(args) {
      const { rel } = sanitize(args.path, 'folder');
      const issues = checkPath(rel, 'folder');
      if (issues.length) return fail(`${rel}/ fora das regras`, issues);
      if (await store.dirExists(rel)) return fail(`${rel}/ já existe`);
      await store.mkdir(rel);
      return { ok: true, wrote: true, summary: `pasta ${rel}/ criada`, result: { ok: true, path: rel } };
    },
  }),

  list_files: defineTool({
    description: 'Lista os anexos do vault (imagens, apresentações .html, pdf, pptx, vídeo…) com tipo e tamanho. Opcionalmente filtra por pasta.',
    args: s.object({ folder: s.optional(s.string({ description: `pasta, ex.: "${FILE_DIR}Sprints"; omitido = vault inteiro` })) }),
    async run({ folder }) {
      const dir = (folder ?? '').replace(/^\/+|\/+$/g, '');
      const { files } = await listVault();
      const list = files.filter((f) => !dir || f.path.startsWith(`${dir}/`));
      return { ok: true, summary: `${list.length} arquivos`, result: { files: list } };
    },
  }),

  read_file: defineTool({
    description: `Lê um anexo de texto (.html, .htm, .svg, .csv, .txt), ex.: para revisar uma apresentação antes de update_file. Acima de ${READ_CHUNK} caracteres vem em partes: continue com offset = next_offset.`,
    args: s.object({
      path: s.string({ min: 1 }),
      offset: s.optional(s.number({ min: 0, description: 'continua de next_offset' })),
    }),
    async run(args) {
      const f = sanitizeFile(args.path);
      if (!f.type.text) return fail(`${f.rel} é binário (${f.type.kind}); só dá para ler arquivos de texto`);
      if (!(await store.exists(f.rel))) return fail(`${f.rel} não existe`);
      const text = await store.readText(f.rel);
      if (text.length <= READ_CHUNK && !args.offset) {
        return { ok: true, summary: `${f.rel} (${text.length} caracteres)`, result: { path: f.rel, content: text } };
      }
      const part = readPart(text, { offset: args.offset });
      if (!part.ok) return fail(part.error);
      const { ok: _ok, ...rest } = part;
      return {
        ok: true,
        summary: `${f.rel} (caracteres ${part.offset}–${part.offset + part.content.length} de ${part.size})`,
        result: { path: f.rel, ...rest, ...(part.next_offset !== undefined ? { hint: 'arquivo continua: chame read_file com offset = next_offset' } : {}) },
      };
    },
  }),

  create_file: defineTool({
    description: `Cria um arquivo HTML (apresentação de slides, página) ou SVG (diagrama), por padrão em ${FILE_DIR}. Documento completo e autocontido: o site abre isolado, então CSS/JS só via CDN https:// e imagens via data:. Exige ação "create_file" no plano aprovado.`,
    args: s.object({
      path: s.string({ min: 1, description: `ex.: "${FILE_DIR}Apresentacoes/2026-10-28-Sprint.html"` }),
      content: s.string({ min: 1, description: 'documento completo (<!doctype html>… ou <svg>…)' }),
    }),
    needs: (a) => ({ action: 'create_file', path: a.path }),
    async run(args) {
      const rel = args.path.replace(/^\/+/, '');
      const v = checkFile(rel, args.content);
      if (v.errors.length) return fail(`${rel} não segue as regras`, v.errors, v.warnings);
      const out = await writeVaultFile(rel, Buffer.from(args.content, 'utf8'));
      return fileResult(out, `criado ${rel}`, v.warnings);
    },
  }),

  update_file: defineTool({
    description:
      'Sobrescreve um HTML/SVG existente com o conteúdo completo novo (reescrever a apresentação/documento inteiro). Para ajustes pontuais prefira edit_file. ' +
      'Leia antes com read_file. Exige ação "update_file" no plano aprovado.',
    args: s.object({ path: s.string({ min: 1 }), content: s.string({ min: 1 }) }),
    needs: (a) => ({ action: 'update_file', path: a.path }),
    async run(args) {
      const rel = args.path.replace(/^\/+/, '');
      if (!(await store.exists(rel))) return fail(`${rel} não existe: use create_file`);
      const v = checkFile(rel, args.content);
      if (v.errors.length) return fail(`${rel} não segue as regras`, v.errors, v.warnings);
      const out = await writeVaultFile(rel, Buffer.from(args.content, 'utf8'), { overwrite: true });
      return fileResult(out, `editado ${rel}`, v.warnings);
    },
  }),

  edit_file: defineTool({
    description:
      'Ajusta trechos de um HTML/SVG existente (slides, documento A4) sem reenviar o arquivo inteiro: procurar/substituir, tudo ou nada. ' +
      'É o jeito certo de "atualizar a apresentação/o documento": edita o MESMO arquivo, sem criar cópia. Leia antes com read_file e copie o trecho exato. ' +
      'Exige ação "update_file" no plano aprovado.',
    args: s.object({ path: s.string({ min: 1 }), edits }),
    needs: (a) => ({ action: 'update_file', path: a.path }),
    async run(args) {
      const f = sanitizeFile(args.path.replace(/^\/+/, ''));
      if (!f.type.text) return fail(`${f.rel} é binário (${f.type.kind}); só dá para editar arquivos de texto`);
      if (!(await store.exists(f.rel))) return fail(`${f.rel} não existe: use create_file`);
      const r = applyEdits(await store.readText(f.rel), args.edits);
      if (!r.ok) return fail(`nenhuma edição aplicada em ${f.rel}`, r.errors);
      const v = checkFile(f.rel, r.text);
      if (v.errors.length) return fail(`${f.rel} não segue as regras depois das edições`, v.errors, v.warnings);
      const out = await writeVaultFile(f.rel, Buffer.from(r.text, 'utf8'), { overwrite: true });
      return fileResult(out, `${r.replaced} trecho(s) ajustado(s) em ${f.rel}`, v.warnings);
    },
  }),

  /* ---- Financeiro e lembretes (Postgres) ---- */

  cadastrar_imovel: defineTool({
    description: 'Cadastra um imóvel com o endereço completo para usar nos contratos.',
    args: s.object({
      apelido: s.string({ min: 1, description: 'apelido do imóvel (ex.: "Casa 2")' }),
      tipo: s.optional(s.oneOf(['casa', 'apartamento', 'sala', 'outro'], 'padrão: casa')),
      logradouro: s.string({ min: 1, description: 'rua/avenida' }),
      numero: s.string({ min: 1, description: 'número ("0" se não tiver)' }),
      complemento: s.optional(s.string({ min: 1, description: 'complemento' })),
      bairro: s.string({ min: 1, description: 'bairro' }),
      cidade: s.string({ min: 1, description: 'cidade' }),
      uf: s.string({ min: 2, description: 'UF (ex.: SP)' }),
      cep: s.string({ min: 8, description: 'CEP com 8 dígitos' }),
    }),
    async run(args) {
      const { createImovel } = await import('./finance.mjs');
      const imovel = await createImovel(args);
      return { ok: true, summary: `imóvel ${imovel.apelido} cadastrado`, result: imovel };
    },
  }),

  cadastrar_inquilino: defineTool({
    description: 'Cadastra um inquilino (CPF ou CNPJ obrigatório; telefone e e-mail opcionais).',
    args: s.object({
      nome: s.string({ min: 1, description: 'nome do inquilino' }),
      documento: s.string({ min: 11, description: 'CPF ou CNPJ' }),
      telefone: s.optional(s.string({ min: 1, description: 'telefone' })),
      email: s.optional(s.string({ min: 1, description: 'e-mail' })),
    }),
    async run(args) {
      const { createInquilino } = await import('./finance.mjs');
      const inquilino = await createInquilino(args);
      return { ok: true, summary: `inquilino ${inquilino.nome} cadastrado`, result: inquilino };
    },
  }),

  cadastrar_contrato: defineTool({
    description: 'Cria o contrato de aluguel ligando imóvel e inquilino (ids uuid dos cadastros/listagem).',
    args: s.object({
      imovel_id: s.string({ min: 36, description: 'id do imóvel' }),
      inquilino_id: s.string({ min: 36, description: 'id do inquilino' }),
      imobiliaria_id: s.optional(s.string({ min: 36, description: 'id da imobiliária (vazio = locação direta)' })),
      data_inicio: s.string({ min: 10, description: 'início AAAA-MM-DD' }),
      data_fim: s.string({ min: 10, description: 'fim AAAA-MM-DD' }),
      dia_vencimento: s.number({ min: 1, max: 31, description: 'dia do vencimento (1..31)' }),
      valor_aluguel: s.number({ min: 0.01, description: 'valor do aluguel' }),
      indice: s.optional(s.oneOf(['igpm', 'ipca', 'inpc', 'outro'], 'índice de reajuste; padrão: igpm')),
      responsavel_iptu: s.optional(s.oneOf(['inquilino', 'proprietario'], 'padrão: inquilino')),
    }),
    async run(args) {
      const { createContrato } = await import('./finance.mjs');
      const contrato = await createContrato(args);
      return { ok: true, summary: `contrato ${contrato.id} criado`, result: contrato };
    },
  }),

  listar_imoveis: defineTool({
    description: 'Lista os imóveis (id, apelido, tipo, endereço).',
    args: s.object({}),
    async run() {
      const { listImoveis } = await import('./finance.mjs');
      const imoveis = await listImoveis();
      return { ok: true, summary: `${imoveis.length} imóvel(is)`, result: { imoveis } };
    },
  }),

  listar_inquilinos: defineTool({
    description: 'Lista os inquilinos (id, nome, documento, telefone, e-mail).',
    args: s.object({}),
    async run() {
      const { listInquilinos } = await import('./finance.mjs');
      const inquilinos = await listInquilinos();
      return { ok: true, summary: `${inquilinos.length} inquilino(s)`, result: { inquilinos } };
    },
  }),

  listar_imobiliarias: defineTool({
    description: 'Lista as imobiliárias (id, nome) para usar em cadastrar_contrato.',
    args: s.object({}),
    async run() {
      const { listImobiliarias } = await import('./finance.mjs');
      const imobiliarias = await listImobiliarias();
      return { ok: true, summary: `${imobiliarias.length} imobiliária(s)`, result: { imobiliarias } };
    },
  }),

  situacao_mes: defineTool({
    description: 'Quem pagou, quem falta e quem atrasou em um mês do aluguel. Qualquer recebimento no mês conta como recebido.',
    args: s.object({ mes: s.string({ min: 7, description: 'mês do aluguel AAAA-MM' }) }),
    async run({ mes }) {
      const { listContratos, listPagamentos } = await import('./finance.mjs');
      const { alugueisDoMes } = await import('../src/financeView.ts');
      const [contratos, pagamentos] = await Promise.all([listContratos(), listPagamentos({ mes_referencia: mes })]);
      const alugueis = alugueisDoMes(contratos as Parameters<typeof alugueisDoMes>[0], pagamentos as { contrato_id: string; valor: string }[], mes).map(
        ({ contrato, recebido, falta, situacao }) => ({
          contrato_id: contrato.id,
          imovel: (contrato as unknown as { imovel_apelido: string }).imovel_apelido,
          inquilino: (contrato as unknown as { inquilino_nome: string }).inquilino_nome,
          dia_vencimento: contrato.dia_vencimento,
          valor_contrato: contrato.valor_aluguel,
          recebido,
          falta,
          situacao,
        }),
      );
      return { ok: true, summary: `${alugueis.length} aluguel(éis) em ${mes}`, result: { alugueis } };
    },
  }),

  listar_contratos: defineTool({
    description: 'Lista os contratos de aluguel (id, imóvel, inquilino, valor, vencimento, status). Use o id para registrar pagamentos.',
    args: s.object({}),
    async run() {
      const { listContratos } = await import('./finance.mjs');
      const contratos = await listContratos();
      return { ok: true, summary: `${contratos.length} contrato(s)`, result: { contratos } };
    },
  }),

  registrar_pagamento: defineTool({
    description:
      'Registra um recebimento de aluguel no extrato. Use o contrato_id de listar_contratos. ' +
      'Boleto NÃO é comprovante: registre o Pix/transferência que o usuário recebeu.',
    args: s.object({
      contrato_id: s.string({ min: 36, description: 'id do contrato (listar_contratos)' }),
      data: s.string({ min: 10, description: 'data ISO AAAA-MM-DD do recebimento' }),
      valor: s.number({ min: 0.01, description: 'valor recebido em reais' }),
      tipo: s.oneOf(['pix', 'dinheiro', 'transferencia', 'outro'], 'tipo do recebimento (boleto não é comprovante)'),
      mes_referencia: s.optional(s.string({ min: 7, description: 'mês do aluguel AAAA-MM (padrão: mês da data)' })),
      observacao: s.optional(s.string({ min: 1, description: 'observação opcional' })),
      comprovante: s.optional(s.string({ min: 1, description: 'caminho do comprovante guardado, quando houver' })),
    }),
    async run(args) {
      const { createPagamento } = await import('./finance.mjs');
      const p = await createPagamento(args);
      return { ok: true, summary: `pagamento de R$ ${Number(p.valor).toFixed(2)} registrado`, result: p };
    },
  }),

  editar_pagamento: defineTool({
    description: 'Corrige contrato, data, valor, mês do aluguel ou descrição de um recebimento (id de consultar_pagamentos). Envie só o que muda.',
    args: s.object({
      pagamento_id: s.string({ min: 36, description: 'id do recebimento' }),
      contrato_id: s.optional(s.string({ min: 36, description: 'id do contrato certo (listar_contratos)' })),
      data: s.optional(s.string({ min: 10, description: 'data AAAA-MM-DD' })),
      valor: s.optional(s.number({ min: 0.01, description: 'valor em reais' })),
      mes_referencia: s.optional(s.string({ min: 7, description: 'mês do aluguel AAAA-MM' })),
      descricao: s.optional(s.string({ min: 1, description: 'descrição' })),
    }),
    async run({ pagamento_id, ...campos }) {
      const { updatePagamento } = await import('./finance.mjs');
      const p = await updatePagamento(pagamento_id, campos);
      return { ok: true, summary: 'recebimento atualizado', result: p };
    },
  }),

  anexar_comprovante: defineTool({
    description: 'Liga um comprovante guardado a um recebimento já lançado (id de consultar_pagamentos).',
    args: s.object({
      pagamento_id: s.string({ min: 36, description: 'id do recebimento' }),
      comprovante: s.string({ min: 1, description: 'caminho do comprovante guardado' }),
    }),
    async run(args) {
      const { anexarComprovante } = await import('./finance.mjs');
      const r = await anexarComprovante(args);
      return { ok: true, summary: 'comprovante anexado', result: r };
    },
  }),

  consultar_pagamentos: defineTool({
    description: 'Lista recebimentos (com o comprovante, se houver), por período da data (de/ate AAAA-MM-DD), mês do aluguel ou contrato.',
    args: s.object({
      de: s.optional(s.string({ min: 10, description: 'início AAAA-MM-DD' })),
      ate: s.optional(s.string({ min: 10, description: 'fim AAAA-MM-DD' })),
      mes_referencia: s.optional(s.string({ min: 7, description: 'mês do aluguel AAAA-MM' })),
      contrato_id: s.optional(s.string({ min: 36, description: 'id do contrato' })),
    }),
    async run(filtro) {
      const { listPagamentos } = await import('./finance.mjs');
      const pagamentos = (await listPagamentos(filtro)) as { valor: number | string }[];
      const total = pagamentos.reduce((acc: number, p) => acc + Number(p.valor), 0);
      return {
        ok: true,
        summary: `${pagamentos.length} pagamento(s), total R$ ${total.toFixed(2)}`,
        result: { pagamentos, total },
      };
    },
  }),

  resumo_mensal: defineTool({
    description: 'Resumo dos aluguéis recebidos no mês (total e por imóvel) — base para o Carnê-Leão.',
    args: s.object({
      ano: s.number({ min: 2000, max: 2100, description: 'ano (ex.: 2026)' }),
      mes: s.number({ min: 1, max: 12, description: 'mês 1..12' }),
    }),
    async run({ ano, mes }) {
      const { resumoMensal } = await import('./finance.mjs');
      const r = await resumoMensal(ano, mes);
      return { ok: true, summary: `R$ ${Number(r.total).toFixed(2)} em ${r.qtd} pagamento(s)`, result: r };
    },
  }),

  investimentos_carteira: defineTool({
    description: 'Mostra a carteira real, as carteiras fictícias dos agentes, a comparação com Ibovespa e CDI, as últimas análises e as recomendações extraídas dos relatórios.',
    args: s.object({}),
    async run() {
      const { resumo, listarAnalises, listarRelatorios, listarOrdens } = await import('./investimentos.mjs');
      const r = await resumo();
      const carteiras = r.carteiras.map(({ serie, ...c }: { serie: unknown[] }) => ({ ...c, ultimo: serie.at(-1) ?? null }));
      const [analises, relatorios, ordens] = await Promise.all([listarAnalises({ limite: 5 }), listarRelatorios(5), listarOrdens()]);
      return { ok: true, summary: `${carteiras.length} carteiras`, result: { ...r, carteiras, analises, relatorios, ordens: ordens.slice(0, 10) } };
    },
  }),

  investimentos_registrar: defineTool({
    description:
      'Registra na carteira real uma operação que o usuário JÁ fez na corretora: aporte, retirada, compra, venda ou provento. ' +
      'Não executa ordem nenhuma. Compra e venda exigem ticker, quantidade e preço; aporte, retirada e provento exigem valor.',
    args: s.object({
      tipo: s.oneOf(['aporte', 'retirada', 'compra', 'venda', 'provento'], 'o que foi feito'),
      ticker: s.optional(s.string({ min: 5, description: 'código da B3, ex.: PETR4' })),
      quantidade: s.optional(s.number({ min: 1, description: 'número de ações' })),
      preco: s.optional(s.number({ min: 0.01, description: 'preço por ação em reais' })),
      valor: s.optional(s.number({ min: 0.01, description: 'valor em reais (aporte, retirada, provento)' })),
      taxas: s.optional(s.number({ min: 0, description: 'taxas em reais, se o usuário informou' })),
      data: s.optional(s.string({ min: 10, description: 'data ISO AAAA-MM-DD (padrão: hoje)' })),
      motivo: s.optional(s.string({ min: 1, description: 'por que o usuário fez isso, se ele disse' })),
    }),
    async run(args) {
      const { registrarMovimento } = await import('./investimentos.mjs');
      const r = await registrarMovimento({ ...args, origem: 'agente' });
      return { ok: true, wrote: true, summary: `${args.tipo} registrado`, result: r };
    },
  }),

  investimentos_cotacao: defineTool({
    description: 'Consulta preço atual (com atraso) e variação do dia de ações da B3.',
    args: s.object({ tickers: s.array(s.string({ min: 5 }), { min: 1, max: 10, description: 'códigos, ex.: ["PETR4","VALE3"]' }) }),
    async run({ tickers }) {
      const { cotacao, mercadoConfigurado } = await import('./investimentos-mercado.mjs');
      if (!mercadoConfigurado()) return fail('cotações desligadas: falta BRAPI_TOKEN no servidor');
      const cotacoes = [];
      for (const t of tickers) {
        const { ticker, preco, variacao } = await cotacao(t.trim().toUpperCase());
        cotacoes.push({ ticker, preco, variacao });
      }
      return { ok: true, summary: `${cotacoes.length} cotação(ões)`, result: { cotacoes, aviso: 'preços com atraso' } };
    },
  }),

  investimentos_alerta: defineTool({
    description: 'Cria alerta no WhatsApp durante o pregão: queda_dia (valor em % de queda), preco_acima ou preco_abaixo (valor em reais).',
    args: s.object({
      ticker: s.string({ min: 5, description: 'código da B3' }),
      tipo: s.oneOf(['queda_dia', 'preco_acima', 'preco_abaixo'], 'regra do alerta'),
      valor: s.number({ min: 0.01, description: '% de queda ou preço em reais' }),
    }),
    async run(args) {
      const { criarAlerta } = await import('./investimentos.mjs');
      const a = await criarAlerta(args);
      return { ok: true, wrote: true, summary: `alerta de ${a.ticker} criado`, result: a };
    },
  }),

  investimentos_acompanhar: defineTool({
    description: 'Mostra, adiciona ou remove ações da lista "Acompanhando" do dashboard. Só observação: não registra compra nem cria alerta.',
    args: s.object({
      acao: s.oneOf(['listar', 'adicionar', 'remover'], 'o que fazer com a lista'),
      ticker: s.optional(s.string({ min: 5, description: 'código da B3, exigido para adicionar e remover' })),
    }),
    async run({ acao, ticker }) {
      const { acompanhar, deixarDeAcompanhar, listarAcompanhadas } = await import('./investimentos.mjs');
      if (acao === 'listar') {
        const acompanhadas = await listarAcompanhadas();
        return { ok: true, summary: `${acompanhadas.length} ação(ões) acompanhada(s)`, result: { acompanhadas, aviso: 'preços com atraso' } };
      }
      if (acao === 'adicionar') {
        const t = await acompanhar({ ticker });
        return { ok: true, wrote: true, summary: `${t} na lista`, result: { ticker: t } };
      }
      await deixarDeAcompanhar(ticker);
      return { ok: true, wrote: true, summary: `${ticker} fora da lista`, result: { ticker } };
    },
  }),

  criar_lembrete: defineTool({
    description: 'Cria um lembrete; o scheduler envia no WhatsApp no horário indicado.',
    args: s.object({
      texto: s.string({ min: 1, description: 'o que lembrar' }),
      quando: s.string({ min: 10, description: 'data/hora ISO (ex.: 2026-11-01T09:00:00-03:00)' }),
    }),
    async run(args) {
      const { createReminder } = await import('./reminders.mjs');
      const r = await createReminder({ ...args, canal: 'whatsapp' });
      return { ok: true, summary: `lembrete #${r.id} para ${r.quando}`, result: r };
    },
  }),

  listar_lembretes: defineTool({
    description: 'Lista lembretes (pendentes por padrão).',
    args: s.object({ status: s.optional(s.oneOf(['pending', 'sent', 'cancelled'], 'padrão: pending')) }),
    async run({ status = 'pending' }) {
      const { listReminders } = await import('./reminders.mjs');
      const lembretes = await listReminders({ status });
      return { ok: true, summary: `${lembretes.length} lembrete(s)`, result: { lembretes } };
    },
  }),

};

export const WRITE_TOOLS = new Set(['create_note', 'append_to_note', 'update_note', 'edit_note', 'move_note', 'create_folder', 'create_file', 'update_file', 'edit_file']);

export async function runTool(name: string, rawArgs: string, ctx: ToolContext): Promise<ToolOutput> {
  let args: unknown;
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return fail('argumentos não são JSON válido');
  }
  // funções das tools registradas (MCP) vêm antes das ferramentas do núcleo
  const remota = ctx.remotas?.call(name, args);
  if (remota) return await remota;
  const tool = TOOLS[name];
  if (!tool) return fail(`ferramenta desconhecida: ${name}`);
  try {
    return await tool.execute(args, ctx);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/* ---------- system prompt ---------- */

async function readOptional(rel: string): Promise<string> {
  try {
    return await store.readText(rel);
  } catch {
    return '';
  }
}

/** nota aberta quando o usuário clicou em "💬 Terminal": contexto principal da conversa */
export interface FocusNote {
  path: string;
  type: string;
  content: string;
}

/** relê a nota do disco a cada pedido (o cliente manda só o caminho, nunca o conteúdo) */
export async function loadFocus(raw: unknown): Promise<FocusNote | null> {
  if (raw === undefined || raw === null || raw === '') return null;
  const { rel } = sanitize(str(raw, 'contextPath'), 'note');
  if (!(await store.exists(rel))) throw new ApiError(404, `nota de contexto ${rel} não existe`);
  const content = await store.readText(rel);
  const t = parseFrontmatter(content)?.data.type;
  return { path: rel, type: typeof t === 'string' ? t : '', content };
}

/** modo ideia: parceiro de brainstorm que vai estruturando a nota */
const IDEA_MODE = [
  'MODO IDEIA: esta é uma ideia em construção. Atue como parceiro de brainstorm:',
  '- Comece resumindo em 1-2 linhas o que já está claro na nota.',
  '- Faça no máximo 2 perguntas curtas por vez para desenvolver o que falta: problema, para quem, proposta,',
  '  como funcionaria, o que já existe parecido, diferencial, riscos, primeiro experimento barato.',
  '- Sugira variações e ângulos inesperados quando ajudar; ideias malucas são bem-vindas.',
  '- Quando houver material (ou o usuário pedir), proponha um plano com append_to_note nesta nota, em seções',
  '  como "## Problema", "## Proposta", "## Perguntas em aberto", "## Próximos passos". Nunca apague o que existe.',
  '- Se a ideia amadurecer em algo com prazo, sugira virar projeto: move_note para 04-Projetos/ com type project.',
];

function focusSection(focus: FocusNote | null): string[] {
  if (!focus) return [];
  return [
    '===== NOTA EM FOCO =====',
    `O usuário abriu o terminal a partir de ${focus.path} (type: ${focus.type || 'sem type'}). Ela é o contexto principal:`,
    '"esta nota", "a ideia", "o texto" se referem a ela. Para escrever nela, use append_to_note (ou update_note',
    'se pedirem para reescrever) num plano, como sempre. O conteúdo abaixo é relido do disco a cada mensagem.',
    ...(focus.type === 'idea' ? IDEA_MODE : []),
    ...focusBody(focus),
    '--- fim da nota em foco ---',
    '',
  ];
}

/** nota em foco grande: o começo + o sumário; o resto o agente lê por seção (vai em todo pedido, então fica enxuto) */
function focusBody(focus: FocusNote): string[] {
  if (focus.content.length <= READ_CHUNK) return [`--- ${focus.path} ---`, focus.content];
  const part = readPart(focus.content);
  const outline = briefOutline(focus.content)
    .map((o) => `${'  '.repeat(o.level - 1)}- ${o.heading} (${o.chars} caracteres)`)
    .join('\n');
  return [
    `A nota tem ${focus.content.length} caracteres: abaixo vão o sumário e só o começo. Para o resto, use read_note com`,
    `path "${focus.path}" e section (título do sumário) ou offset. Não presuma o conteúdo de seções que não leu.`,
    'Sumário:',
    outline,
    `--- ${focus.path} (caracteres 0–${part.ok ? part.content.length : 0}) ---`,
    part.ok ? part.content : '',
  ];
}

/** bibliotecária: a organização é sugestão e pedido do usuário, nunca bloqueio */
const LIBRARIAN = [
  'Bibliotecária do vault (você também faz este papel): o usuário cria pastas e notas onde quiser; nada é proibido por pasta.',
  `- Mapa de referência (type -> pasta): ${Object.entries(FOLDER_BY_TYPE).map(([t, f]) => `${t} -> ${f}`).join(', ')}.`,
  '  00-Inbox guarda o que ainda não foi triado. As pastas que o usuário criou também valem: aprenda com a estrutura real antes de sugerir.',
  '- Diário: 01-Diario/ tem UM arquivo por dia, AAAA-MM-DD.md, com a data de hoje acima. Tudo o que foi feito no dia vai nesse arquivo: leia antes; se existir, use append_to_note; se não, create_note com type journal. Nunca crie outro arquivo para o mesmo dia.',
  '- Tópicos: organize do geral para o específico, em Categoria/Tópico/Assunto. Ex.: 04-Projetos/Pessoal/Tania/, 05-Ideias/Casa/Reformar-a-casa.md, 02-Estudos/Infra/Kubernetes/.',
  '  Vale também para nota nova: escolha o tópico ao criar, sem perguntar. Assunto com várias notas vira pasta própria; nota única fica direto no tópico.',
  '  Antes de criar uma pasta, veja em list_notes o campo folders e reaproveite o tópico que já existe, sem criar variações do mesmo nome. Tópico é curto, em português, com hyphens. O diário não usa tópicos.',
  '- SUGERIR ("como organizo?", "onde guardo isto?", "o que está fora do lugar?"): leia com list_notes/read_note e responda com sugestões e o motivo de cada uma. Não chame propose_plan e não altere nada.',
  '- ORGANIZAR (só quando pedirem): propose_plan com create_folder e move, cada um com o motivo em reason. Máximo de 30 ações por plano: em vault grande, faça por lotes e diga o que falta.',
  '  move_note já atualiza os [[links]] das outras notas. Você move notas, não anexos. Nunca apague nem altere o texto das notas ao organizar.',
];

async function systemPrompt(focus: FocusNote | null = null, remotasPrompt = ''): Promise<string> {
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' })
    .format(new Date());
  const [agents, conventions] = await Promise.all([readOptional('AGENTS.md'), readOptional('99-Meta/Convencoes.md')]);
  return [
    'Você é o agente do vault Obsidian do usuário, operando por um terminal no site do vault.',
    'Sua função: organizar e escrever documentos do vault usando APENAS as ferramentas disponíveis.',
    `Agora: ${today} (America/Sao_Paulo). Use datas ISO explícitas nas notas.`,
    '',
    'Fluxo obrigatório:',
    '1. Leia/busque o que for relevante (list_notes, search_notes, read_note).',
    '2. Você tem autonomia: não peça permissão para escrever. Antes de escrever, chame propose_plan com TODAS as ações (action, path, to, type, reason).',
    '   Ele só registra o que você vai fazer, aparece no terminal e NÃO espera resposta.',
    '3. No mesmo turno, execute as ações do plano. Para mudar o rumo, chame propose_plan de novo.',
    '4. Se uma escrita voltar com erros de regra, corrija o conteúdo e tente de novo (o caminho precisa continuar o do plano). Avisos não impedem nada: siga em frente.',
    '5. Responda em português, curto, listando os arquivos criados/alterados.',
    '6. Trabalhe até concluir a tarefa: NÃO pare para perguntar "posso continuar?" nem divida o trabalho em turnos à espera de confirmação.',
    '   Leia, busque e escreva quantas vezes precisar. Só pare para uma dúvida real que muda o resultado ou quando terminar.',
    '   Se a resposta for cortada pelo limite, o servidor pede a continuação.',
    '',
    ...LIBRARIAN,
    '',
    'Regras que o servidor valida (escrita fora delas é recusada):',
    '- Pastas: livres no vault, inclusive a raiz. O caminho só precisa estar no plano.',
    `- type: ${NOTE_TYPES.join(' | ')}. Frontmatter mínimo: type, created (AAAA-MM-DD), tags (lista), status (draft|active|open|done|archived).`,
    '- Extras: command -> tool, command, confidence (low|medium|high), source opcional; learning -> area, confidence;',
    '  project -> due, next_step, priority; agent -> model, owner; run -> agent, outcome (success|partial|fail), duration.',
    '- Nome de arquivo e pastas ASCII com hyphens, .md; "# Título" H1 em português; [[wikilink]] para notas relacionadas quando existirem (vault vazio não precisa).',
    '- Nota de comando: comando exato num bloco ```bash.',
    `- Tags da lista fechada: ${OFFICIAL_TAGS.join(', ')}.`,
    '- Nunca apague; para descartar, status: archived. Prefira append_to_note a update_note. Sem credenciais.',
    '- ATUALIZAR/AJUSTAR/CORRIGIR um arquivo que já existe (apresentação, documento HTML, nota) = editar o MESMO arquivo, no mesmo caminho:',
    '  edit_file / edit_note para trechos (preferido: só o trecho antigo e o novo), update_file / update_note para reescrever inteiro.',
    '  NÃO crie cópia nova (-v2, -V2, -novo, -final, outra data) para "atualizar". "Nunca apagar" quer dizer',
    '  não excluir arquivos; sobrescrever o arquivo que o usuário pediu para ajustar é permitido e é o esperado. Plano: ação update_file (anexo) ou update (nota).',
    '  Só crie arquivo novo se o usuário pedir explicitamente uma versão separada.',
    '- Se o pedido for ambíguo, pergunte antes de propor.',
    '',
    'Aluguéis (Postgres): listar_imoveis, listar_inquilinos, listar_imobiliarias, listar_contratos, situacao_mes (quem pagou no mês),',
    '  consultar_pagamentos, resumo_mensal (por data do recebimento, base do Carnê-Leão), cadastrar_imovel, cadastrar_inquilino,',
    '  cadastrar_contrato, registrar_pagamento (Pix/transferência recebido; boleto NÃO é comprovante), editar_pagamento e anexar_comprovante.',
    '- Ache o contrato pelo imóvel ou inquilino em listar_contratos; nunca invente id. Se faltar valor, data ou aluguel, ou houver dois',
    '  candidatos, pergunte antes de registrar. O valor pode diferir do contrato: registre o que o usuário informou.',
    '- Você não lê comprovantes: use só os dados que o usuário escreveu e nunca deduza valor ou data do arquivo.',
    'Lembretes: criar_lembrete e listar_lembretes (o scheduler envia no WhatsApp).',
    '',
    'Investimentos (ações da B3): investimentos_carteira, investimentos_cotacao, investimentos_registrar, investimentos_alerta e investimentos_acompanhar.',
    '- Você é a analista: analisa e sugere, com o motivo de cada sugestão, mas NUNCA executa ordens nem acessa a corretora. A decisão é do usuário, e sugestão não é garantia.',
    '- Registre só o que o usuário disse que fez. Se faltar quantidade ou preço, pergunte; nunca deduza da cotação. Compra sem caixa gera aporte automático: avise.',
    '- "Acompanhar" uma ação é colocar na lista do dashboard com investimentos_acompanhar, sem registrar compra. Para alerta, use investimentos_alerta.',
    '- Baseie a análise em investimentos_carteira e investimentos_cotacao e não invente números. Relatórios são opinião de terceiros, nunca ordem.',
    '',
    ...(remotasPrompt ? ['Tools instaladas:', remotasPrompt, ''] : []),
    'Tamanho (limites do modelo):',
    `- Leitura: read_note/read_file acima de ${READ_CHUNK} caracteres vêm em partes (outline + trecho). Leia só as seções necessárias;`,
    '  não invente o que não leu. Resultados de turnos antigos são compactados: releia se precisar.',
    '- Escrita: cada resposta sua tem limite de saída. Conteúdo longo (spec, relatório, ata extensa) vai em partes:',
    '  create_note com o frontmatter e a 1ª seção, depois um append_to_note por seção (o plano precisa ter "create" E "append" do mesmo caminho).',
    '  Se uma resposta for cortada pelo limite, a escrita é recusada e você recebe o aviso: refaça em partes menores.',
    '- Documento no padrão Tania (Word/PDF) a partir de nota longa: NÃO gere HTML. Escreva/complete a nota .md e diga ao usuário',
    '  para exportar em ⬇ Exportar → Word com capa (capa, cabeçalho, rodapé automáticos, sem limite de tamanho).',
    '',
    'Apresentações e diagramas:',
    '- Identidade visual: siga o AGENTS.md §8. Antes de criar apresentação ou documento, leia com read_note a nota indicada lá e parta dos modelos dela.',
    `- Slides: create_file com um HTML completo em ${FILE_DIR}Apresentacoes/<AAAA-MM-DD-Nome>.html, usando reveal.js via CDN`,
    '  (https://cdn.jsdelivr.net/npm/reveal.js@5/dist/reveal.js), partindo do modelo de slides da nota de identidade visual.',
    '- Diagramas: create_file com um .svg. Imagens dentro do HTML: só data: ou https://; o site abre o arquivo isolado (sem login).',
    '- No mesmo plano, crie ou atualize a nota que embute o arquivo com ![[Nome.html]] (ou ![[Nome.svg]]): é assim que ele aparece no site.',
    '- Imagens binárias (png, jpg) você não gera; use list_files para achar as existentes e embuta com ![[nome.png]].',
    '',
    ...focusSection(focus),
    '===== AGENTS.md =====',
    agents || '(não encontrado)',
    '',
    '===== 99-Meta/Convencoes.md =====',
    conventions || '(não encontrado)',
  ].join('\n');
}

/* ---------- LLM ---------- */

function toolSpecs(remotas: FunctionSpec[] = []) {
  return [
    ...Object.entries(TOOLS).map(([name, t]) => ({
      type: 'function',
      function: { name, description: t.description, parameters: t.parameters },
    })),
    ...remotas,
  ];
}

/** truncated: a resposta parou no max_tokens (finish_reason "length") — texto e argumentos podem estar pela metade */
async function complete(cfg: Provider, messages: ChatMessage[], signal: AbortSignal, remotas: FunctionSpec[] = []): Promise<{ reply: ChatMessage; truncated: boolean }> {
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      tools: toolSpecs(remotas),
      tool_choice: 'auto',
      ...(cfg.maxTokens ? { max_tokens: cfg.maxTokens } : {}),
    }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    choices?: { message?: ChatMessage; finish_reason?: string }[];
    error?: { message?: string } | string;
  };
  if (!res.ok) {
    const detail = typeof data.error === 'string' ? data.error : data.error?.message;
    throw new Error(`LLM ${res.status}: ${detail || res.statusText}`);
  }
  const choice = data.choices?.[0];
  const msg = choice?.message;
  if (!msg) throw new Error('LLM respondeu sem mensagem');
  return {
    reply: { role: 'assistant', content: msg.content ?? null, ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) },
    truncated: choice?.finish_reason === 'length',
  };
}

/**
 * histórico vindo do cliente: só user/assistant/tool (o system é sempre do
 * servidor), corta pelo começo sem separar tool_calls das respostas e compacta
 * os turnos antigos (compactHistory em agent/context.ts).
 */
export function cleanHistory(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) throw new ApiError(400, 'messages deve ser uma lista');
  let msgs = raw
    .filter((m): m is ChatMessage => !!m && typeof m === 'object' && ['user', 'assistant', 'tool'].includes((m as ChatMessage).role))
    .map((m) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : null,
      ...(m.role === 'assistant' && Array.isArray(m.tool_calls) ? { tool_calls: m.tool_calls } : {}),
      ...(m.role === 'tool' ? { tool_call_id: String(m.tool_call_id ?? '') } : {}),
    }));
  if (msgs.length > MAX_HISTORY) msgs = msgs.slice(-MAX_HISTORY);
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') throw new ApiError(400, 'a última mensagem deve ser do usuário');
  // turnos antigos: resultados grandes viram uma linha; a conversa cabe no orçamento (context.ts)
  return compactHistory(msgs);
}

function truncate(s: string): string {
  return s.length > MAX_TOOL_OUTPUT
    ? `${s.slice(0, MAX_TOOL_OUTPUT)}\n…[resultado cortado: faltam ${s.length - MAX_TOOL_OUTPUT} caracteres; peça em partes (section/offset) ou filtre]`
    : s;
}


export async function runAgent(
  provider: Provider,
  history: ChatMessage[],
  emit: (event: Record<string, unknown>) => void,
  signal: AbortSignal,
  approved: Plan | null = null,
  focus: FocusNote | null = null,
): Promise<ChatMessage[]> {
  const fresh: ChatMessage[] = [];
  const remotas = await carregarTools().catch((err) => {
    console.warn('agent: tools remotas indisponíveis:', (err as Error)?.message ?? err);
    return { specs: [], prompt: '', call: () => null } as Remotas;
  });
  const messages: ChatMessage[] = [{ role: 'system', content: await systemPrompt(focus, remotas.prompt) }, ...history];
  const ctx: ToolContext = { approved, remotas };

  let continuations = 0;
  for (let step = 0; step < MAX_STEPS; step++) {
    if (signal.aborted) break;
    const { reply, truncated } = await complete(provider, messages, signal, remotas.specs);
    const limit = provider.maxTokens ? ` (max_tokens ${provider.maxTokens})` : '';
    const textCut = truncated && !reply.tool_calls?.length;
    // texto cortado no limite: o servidor pede a continuação sozinho (até MAX_CONTINUATIONS vezes)
    const autoContinue = textCut && continuations < MAX_CONTINUATIONS;
    if (textCut && !autoContinue) reply.content = `${reply.content ?? ''}\n\n⚠ resposta cortada pelo limite de saída do modelo${limit}.`;
    messages.push(reply);
    fresh.push(reply);
    if (reply.content) emit({ type: 'assistant', text: reply.content });
    if (autoContinue) {
      continuations++;
      const more: ChatMessage = { role: 'user', content: CONTINUE_PROMPT };
      messages.push(more);
      fresh.push(more);
      continue;
    }
    if (!reply.tool_calls?.length) return fresh;

    // cortada no meio de uma chamada: os argumentos podem estar pela metade — nada roda, o LLM refaz em partes
    if (truncated) {
      emit({ type: 'assistant', text: `⚠ a resposta do modelo foi cortada pelo limite de saída${limit}; pedindo para refazer em partes menores.` });
      for (const call of reply.tool_calls) {
        const out = fail(
          `não executado: sua resposta foi cortada pelo limite de saída do modelo${limit} e os argumentos podem estar incompletos. ` +
            'Refaça em partes menores: create_note com a primeira seção e um append_to_note por seção (proponha um plano com create + append, se preciso).',
        );
        emit({ type: 'tool_result', name: call.function?.name ?? '', ok: false, summary: out.summary, wrote: false });
        const toolMsg: ChatMessage = { role: 'tool', tool_call_id: call.id, content: JSON.stringify(out.result) };
        messages.push(toolMsg);
        fresh.push(toolMsg);
      }
      continue;
    }

    for (const call of reply.tool_calls) {
      const name = call.function?.name ?? '';
      const args = call.function?.arguments ?? '';
      emit({ type: 'tool', name, args });
      const out = await runTool(name, args, ctx);
      emit({
        type: 'tool_result',
        name,
        ok: out.ok,
        summary: out.summary,
        wrote: !!out.wrote,
        ...(out.issues?.length ? { issues: out.issues } : {}),
        ...(out.warnings?.length ? { warnings: out.warnings } : {}),
      });
      if (out.plan) {
        ctx.approved = out.plan;
        emit({ type: 'plan', plan: out.plan });
      }
      const toolMsg: ChatMessage = { role: 'tool', tool_call_id: call.id, content: truncate(JSON.stringify(out.result)) };
      messages.push(toolMsg);
      fresh.push(toolMsg);
    }
  }
  const stop: ChatMessage = { role: 'assistant', content: `(parei após ${MAX_STEPS} passos, um teto contra loop; diga "continue" para seguir)` };
  emit({ type: 'assistant', text: stop.content });
  fresh.push(stop);
  return fresh;
}

/** chamada única sem tools (fluxos determinísticos, ex.: gerar nota de ideia no WhatsApp) */
export async function chatText(system: string, user: string, signal?: AbortSignal): Promise<string> {
  const provider = providerOf(await loadConfig());
  if (!provider) throw new ApiError(503, 'agente sem LLM: configure app/agent.config.json');
  const res = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    signal: signal ?? AbortSignal.timeout(60_000),
    headers: {
      'Content-Type': 'application/json',
      ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: provider.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      ...(provider.maxTokens ? { max_tokens: provider.maxTokens } : {}),
    }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    choices?: { message?: { content?: string } }[];
    error?: { message?: string } | string;
  };
  if (!res.ok) {
    const detail = typeof data.error === 'string' ? data.error : data.error?.message;
    throw new Error(`LLM ${res.status}: ${detail || res.statusText}`);
  }
  return data.choices?.[0]?.message?.content ?? '';
}

/** roda o agente para um texto (ex.: WhatsApp) e devolve a resposta em texto */
export async function runAgentText(
  userText: string,
  { history: anterior = [] as ChatMessage[] } = {},
): Promise<string> {
  const provider = providerOf(await loadConfig());
  if (!provider) throw new ApiError(503, 'agente sem LLM: configure app/agent.config.json');
  const history: ChatMessage[] = [...anterior, { role: 'user', content: userText }];
  const fresh = await runAgent(provider, history, () => {}, AbortSignal.timeout(120_000));
  return fresh
    .filter((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim())
    .map((m) => m.content as string)
    .join('\n\n')
    .trim();
}

/* ---------- HTTP ---------- */

function json(res: ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

/** plano aprovado vindo do navegador: revalidado aqui (o cliente não é fonte de verdade) */
export function parseApproved(raw: unknown): Plan | null {
  if (raw === undefined || raw === null) return null;
  const parsed = check(Plan, raw);
  if (!parsed.ok) throw new ApiError(400, `approvedPlan inválido: ${parsed.issues.join('; ')}`);
  const issues = checkPlan(parsed.value);
  if (issues.length) throw new ApiError(400, `approvedPlan viola as regras: ${issues.join('; ')}`);
  return parsed.value;
}

export async function handleAgent(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  if (pathname === '/api/agent/status' && req.method === 'GET') {
    return json(res, 200, await publicStatus());
  }

  if (pathname === '/api/agent/config' && req.method === 'POST') {
    const body = (await readJson(req)) as { active?: unknown };
    await setActive(str(body.active, 'active'));
    return json(res, 200, await publicStatus());
  }

  if (pathname === '/api/agent/chat' && req.method === 'POST') {
    const provider = providerOf(await loadConfig());
    if (!provider) {
      return json(res, 503, {
        ok: false,
        error: 'sem configuração do agente: cadastre em 🤖 Agents ou crie app/agent.config.json',
      });
    }
    const body = (await readJson(req)) as { messages?: unknown; approvedPlan?: unknown; contextPath?: unknown };
    const history = cleanHistory(body.messages);
    const approved = parseApproved(body.approvedPlan);
    const focus = await loadFocus(body.contextPath);

    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
    const emit = (event: Record<string, unknown>) => {
      if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
    };
    // fechou a aba / clicou em parar: interrompe a chamada ao LLM e o loop
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    try {
      const fresh = await runAgent(provider, history, emit, abort.signal, approved, focus);
      emit({ type: 'messages', messages: fresh });
    } catch (err) {
      if (!abort.signal.aborted) emit({ type: 'error', error: err instanceof Error ? err.message : String(err) });
    }
    res.end();
    return;
  }

  return json(res, 404, { ok: false, error: `rota desconhecida: ${pathname}` });
}

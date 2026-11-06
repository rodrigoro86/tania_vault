/**
 * tools-remotas.ts — as funções MCP das tools registradas viram ferramentas do
 * agente (spec 2026-11-06-tools, §Agente).
 *
 * Registro: env (`TANIA_TOOLS=id=url,...` + `TANIA_TOOL_SECRET_<ID>`) primeiro,
 * depois a tabela `tools` (só com banco configurado; segredo cifrado decifrado
 * com `TANIA_CONFIG_KEY`). Uma tool fora do ar, lenta ou com manifesto inválido
 * é pulada com aviso no log — nunca derruba as outras.
 *
 * Cache de 60 s (`limparCacheTools()` para os testes).
 */
import { decifrar } from '../config-db.mjs';

import type { ToolOutput } from '../agent.ts';

export interface FunctionSpec {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface Remotas {
  specs: FunctionSpec[];
  prompt: string;
  /** null quando o nome não é de uma tool (a chamada cai nas ferramentas do núcleo) */
  call: (name: string, args: unknown) => Promise<ToolOutput> | null;
}

interface Registro {
  id: string;
  url: string;
  segredo: string;
  origem: 'env' | 'banco';
}

/** função MCP de uma tool, pronta para chamar */
interface Funcao {
  name: string;
  toolId: string;
  url: string;
  segredo: string;
  /** nome de exibição do manifesto (summary) e nome real da função na tool */
  nome: string;
  fn: string;
  description: string;
  parameters: Record<string, unknown>;
  sessionId: string | null;
}

const ID_RE = /^[a-z0-9-]{1,32}$/;
const URL_RE = /^https?:\/\/[^\s]{1,300}$/;
const CACHE_MS = 60_000;
/** orçamento por tool: manifesto + initialize + tools/list */
const LOAD_MS = 5_000;
const CALL_MS = 30_000;
const PROTOCOL = '2025-06-18';

let seq = 0;
let cache: { at: number; remotas: Remotas } | null = null;

/** mesma forma de `fail` do agent.ts: erro curto, sem stack */
const fail = (summary: string, extra: Record<string, unknown> = {}): ToolOutput => ({
  ok: false,
  summary,
  issues: [],
  warnings: [],
  result: { error: summary, issues: [], warnings: [], ...extra },
});

/** `clickup__clickup_tasks`: só [a-zA-Z0-9_-], até 64, sem colisão entre tools */
export function nomeFuncao(toolId: string, nome: string, usados: Set<string>): string {
  const base = `${toolId}__${nome}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'tool';
  let out = base;
  let n = 2;
  while (usados.has(out)) {
    out = `${base.slice(0, 61)}_${n}`;
    n++;
  }
  usados.add(out);
  return out;
}

function envSegredo(id: string): string {
  return process.env[`TANIA_TOOL_SECRET_${id.toUpperCase().replace(/-/g, '_')}`] || '';
}

/** TANIA_TOOLS=a=http://x:1,b=http://y — entrada inválida ou sem segredo é pulada */
function registroEnv(): Registro[] {
  const out: Registro[] = [];
  for (const parte of (process.env.TANIA_TOOLS || '').split(',')) {
    const item = parte.trim();
    if (!item) continue;
    const eq = item.indexOf('=');
    const id = eq < 0 ? '' : item.slice(0, eq).trim();
    const url = eq < 0 ? '' : item.slice(eq + 1).trim();
    if (!ID_RE.test(id)) {
      console.warn('tools-remotas: tool ignorada (id inválido):', item);
      continue;
    }
    if (!URL_RE.test(url)) {
      console.warn(`tools-remotas: tool ${id} ignorada (url inválida):`, url);
      continue;
    }
    const segredo = envSegredo(id);
    if (!segredo) {
      console.warn(`tools-remotas: tool ${id} sem segredo (TANIA_TOOL_SECRET_${id.toUpperCase().replace(/-/g, '_')})`);
      continue;
    }
    out.push({ id, url, segredo, origem: 'env' });
  }
  return out;
}

/** tabela `tools` (migração 103): só ativas, segredo cifrado; query falida = só env */
async function registroBanco(): Promise<Registro[]> {
  const db = await import('../db.mjs');
  if (!db.dbConfigured()) return [];
  let rows: Array<{ id?: unknown; url?: unknown; segredo?: unknown }> = [];
  try {
    rows = (await db.query('select id, url, segredo from tools where ativo')).rows ?? [];
  } catch (err) {
    console.warn('tools-remotas: não leu a tabela tools:', (err as Error)?.message ?? err);
    return [];
  }
  const out: Registro[] = [];
  for (const row of rows) {
    const id = String(row.id ?? '');
    const url = String(row.url ?? '');
    if (!ID_RE.test(id) || !URL_RE.test(url)) {
      console.warn('tools-remotas: linha da tabela tools inválida:', id, url);
      continue;
    }
    const segredo = decifrar(row.segredo as string, process.env.TANIA_CONFIG_KEY);
    if (!segredo) {
      console.warn('tools-remotas: segredo ilegível da tool', id, '(TANIA_CONFIG_KEY?)');
      continue;
    }
    out.push({ id, url, segredo, origem: 'banco' });
  }
  return out;
}

/** POST {url}/mcp (JSON-RPC 2.0); aceita application/json ou a 1ª linha `data:` do SSE */
async function rpc(
  url: string,
  segredo: string,
  method: string,
  params: Record<string, unknown>,
  signal: AbortSignal,
  sessionId: string | null,
): Promise<{ payload: Record<string, unknown>; sessionId: string | null }> {
  const res = await fetch(`${url.replace(/\/$/, '')}/mcp`, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-tania-tool-secret': segredo,
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    // notificação (`notifications/*`) não leva id e não tem resposta
    body: JSON.stringify(method.startsWith('notifications/') ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: ++seq, method, params }),
  });
  const novaSessao = res.headers.get('mcp-session-id') || sessionId;
  if (!res.ok) throw new Error(`MCP respondeu HTTP ${res.status}`);
  if (res.status === 202 || res.status === 204) return { payload: {}, sessionId: novaSessao };

  const tipo = res.headers.get('content-type') || '';
  let payload: unknown;
  if (tipo.includes('application/json')) {
    payload = await res.json();
  } else {
    const texto = await res.text();
    const linha = texto.split('\n').map((l) => l.trim()).find((l) => l.startsWith('data:'));
    if (!linha) throw new Error('resposta do MCP sem JSON');
    payload = JSON.parse(linha.slice(5));
  }
  if (!payload || typeof payload !== 'object') throw new Error('resposta do MCP sem JSON');
  return { payload: payload as Record<string, unknown>, sessionId: novaSessao };
}

async function manifesto(reg: Registro, signal: AbortSignal): Promise<{ nome: string; prompt: string }> {
  const res = await fetch(`${reg.url.replace(/\/$/, '')}/manifest.json`, {
    signal,
    headers: { accept: 'application/json', 'x-tania-tool-secret': reg.segredo },
  });
  if (!res.ok) throw new Error(`manifesto: HTTP ${res.status}`);
  const m = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!m || typeof m !== 'object') throw new Error('manifesto não é JSON');
  if (m.id !== reg.id) throw new Error(`manifesto com id "${String(m.id)}" diferente de "${reg.id}"`);
  return {
    nome: typeof m.nome === 'string' && m.nome ? m.nome : reg.id,
    prompt: typeof m.prompt === 'string' ? m.prompt.trim() : '',
  };
}

/** manifesto + initialize + tools/list de uma tool, dentro de LOAD_MS */
async function carregarTool(reg: Registro): Promise<{ nome: string; prompt: string; funcoes: Omit<Funcao, 'name'>[] }> {
  const signal = AbortSignal.timeout(LOAD_MS);
  const info = await manifesto(reg, signal);

  const init = await rpc(
    reg.url,
    reg.segredo,
    'initialize',
    { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'tania', version: process.env.TANIA_VERSION || '1.0' } },
    signal,
    null,
  );
  if (init.payload.error) throw new Error(String((init.payload.error as Record<string, unknown>).message || 'initialize falhou'));
  const sessao = init.sessionId;

  await rpc(reg.url, reg.segredo, 'notifications/initialized', {}, signal, sessao);

  const list = await rpc(reg.url, reg.segredo, 'tools/list', {}, signal, sessao);
  if (list.payload.error) throw new Error(String((list.payload.error as Record<string, unknown>).message || 'tools/list falhou'));
  const tools = (list.payload.result as Record<string, unknown>)?.tools;
  if (!Array.isArray(tools)) throw new Error('tools/list sem lista de funções');

  const funcoes = tools
    .filter((t) => t && typeof (t as Record<string, unknown>).name === 'string')
    .map((t) => {
      const tool = t as Record<string, unknown>;
      const schema = tool.inputSchema;
      return {
        toolId: reg.id,
        url: reg.url,
        segredo: reg.segredo,
        nome: info.nome,
        fn: String(tool.name),
        description: typeof tool.description === 'string' ? tool.description : String(tool.name),
        parameters: schema && typeof schema === 'object' ? (schema as Record<string, unknown>) : {},
        sessionId: sessao,
      };
    });
  return { ...info, funcoes };
}

/** tools/call: texto dos content tipo text; isError vira falha da ferramenta */
async function chamada(f: Funcao, args: unknown): Promise<ToolOutput> {
  try {
    const res = await rpc(
      f.url,
      f.segredo,
      'tools/call',
      { name: f.fn, arguments: args === undefined || args === null ? {} : args },
      AbortSignal.timeout(CALL_MS),
      f.sessionId,
    );
    if (res.payload.error) {
      return fail(`tool ${f.toolId}: ${String((res.payload.error as Record<string, unknown>).message || 'erro do MCP')}`);
    }
    const out = (res.payload.result ?? {}) as Record<string, unknown>;
    const texto = (Array.isArray(out.content) ? out.content : [])
      .filter((c) => c && typeof (c as Record<string, unknown>).text === 'string')
      .map((c) => String((c as Record<string, unknown>).text))
      .join('\n');
    if (out.isError) return fail(texto || `tool ${f.toolId} falhou`);
    return { ok: true, summary: `${f.toolId}: ${f.nome}`, result: texto };
  } catch {
    return fail(`tool ${f.toolId} indisponível`);
  }
}

async function montar(): Promise<Remotas> {
  const env = registroEnv();
  const ids = new Set(env.map((r) => r.id));
  const banco = (await registroBanco()).filter((r) => {
    if (ids.has(r.id)) {
      console.warn(`tools-remotas: tool "${r.id}" do banco ignorada (já vem do env)`);
      return false;
    }
    ids.add(r.id);
    return true;
  });

  const registros = [...env, ...banco];
  const resultados = await Promise.allSettled(registros.map((r) => carregarTool(r)));

  const usadas = new Set<string>();
  const specs: FunctionSpec[] = [];
  const prompts: string[] = [];
  const porNome = new Map<string, Funcao>();

  for (const [i, res] of resultados.entries()) {
    const id = registros[i].id;
    if (res.status === 'rejected') {
      console.warn(`tools-remotas: tool ${id} indisponível:`, (res.reason as Error)?.message ?? res.reason);
      continue;
    }
    const { prompt, funcoes } = res.value;
    if (prompt) prompts.push(prompt);
    for (const f of funcoes) {
      const name = nomeFuncao(f.toolId, f.fn, usadas);
      porNome.set(name, { ...f, name });
      specs.push({
        type: 'function',
        function: { name, description: `${f.nome}: ${f.description}`, parameters: f.parameters },
      });
    }
  }

  return {
    specs,
    prompt: prompts.join('\n\n'),
    call: (name, args) => {
      const f = porNome.get(name);
      return f ? chamada(f, args) : null;
    },
  };
}

/** lista env + banco, specs e prompt prontos; cache de 60 s */
export async function carregarTools(): Promise<Remotas> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.remotas;
  const remotas = await montar();
  cache = { at: Date.now(), remotas };
  return remotas;
}

/** para os testes: força a leitura de novo */
export function limparCacheTools(): void {
  cache = null;
  seq = 0;
}

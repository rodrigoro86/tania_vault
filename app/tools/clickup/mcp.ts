/**
 * mcp.ts — a tool ClickUp fala MCP (JSON-RPC 2.0 em POST /mcp).
 *
 * As duas funções são as que estavam em server/agent.ts (`clickup_tasks`,
 * `clickup_task`): mesma descrição, mesmos `args` (schema de agent/schema.ts)
 * e mesma lógica de `run`. Só leitura: nada é criado ou alterado no ClickUp.
 *
 * O nome que o agente usa é `clickup__clickup_tasks` / `clickup__clickup_task`
 * (prefixo do id da tool); aqui as funções mantêm o nome original.
 */
import { s, check, type Schema, type Issues } from '../../server/agent/schema.ts';
import { clickupStatus, listTasks, getTask, type Task } from './clickup.ts';

const VERSAO = '1.0.0';

interface ToolOutput {
  ok: boolean;
  summary?: string;
  result?: unknown;
  error?: string;
  issues?: Issues;
  warnings?: Issues;
}

export interface FerramentaMcp {
  name: string;
  description: string;
  args: Schema<any>;
  run: (args: any) => Promise<ToolOutput>;
}

const fail = (error: string, issues: Issues = [], warnings: Issues = []): ToolOutput => ({ ok: false, error, issues, warnings });

/** "Empresa" ≈ "empresa", "Core" ≈ "core": ignora acentos e maiúsculas */
const norm = (x: string) => x.normalize('NFD').replace(/[\u0300-\u030f]/g, '').toLowerCase();

export const FERRAMENTAS: Record<string, FerramentaMcp> = {
  /* ---- ClickUp: só leitura (nenhuma ferramenta altera o ClickUp) ---- */

  clickup_tasks: {
    name: 'clickup_tasks',
    description:
      'Lê tarefas do ClickUp (só leitura). scope "me" = minhas; "team" = equipe. Filtre por pessoa (nome ou parte dele), espaço (nome), ' +
      'projeto (pasta do ClickUp, ex.: "Projeto Core"), lista (cliente/frente dentro do projeto, ex.: "Cliente A"), atrasadas ou prazo nos próximos N dias.',
    args: s.object({
      scope: s.optional(s.oneOf(['me', 'team'], 'padrão: team')),
      person: s.optional(s.string({ min: 1, description: 'nome/usuário de quem é responsável, ex.: "ana"' })),
      space: s.optional(s.string({ min: 1, description: 'nome do espaço, ex.: "EMPRESA"' })),
      project: s.optional(s.string({ min: 1, description: 'nome da pasta/projeto, ex.: "core", "campo"' })),
      list: s.optional(s.string({ min: 1, description: 'nome da lista dentro do projeto, ex.: "Cliente A"' })),
      overdue: s.optional(s.boolean('só atrasadas')),
      due_within_days: s.optional(s.number({ min: 0, max: 365, description: 'prazo até N dias a partir de hoje' })),
      include_closed: s.optional(s.boolean('inclui concluídas (padrão: false)')),
    }),
    async run(args) {
      const st = await clickupStatus();
      if (!st.configured) return fail('ClickUp não configurado: defina o CLICKUP_TOKEN em ⚙ Configurações → Tools');
      const personArg = args.person as string | undefined;
      const spaceArg = args.space as string | undefined;
      const projectArg = args.project as string | undefined;
      const listArg = args.list as string | undefined;
      let assignee: number | undefined;
      if (personArg) {
        const found = st.members!.filter((m) => norm(m.name).includes(norm(personArg)));
        if (!found.length) return fail(`ninguém chamado "${personArg}" no workspace`, [], [`membros: ${st.members!.map((m) => m.name).join(', ')}`]);
        if (found.length > 1) return fail(`"${personArg}" é ambíguo: ${found.map((m) => m.name).join(', ')}`);
        assignee = found[0].id;
      }
      let spaceId: string | undefined;
      if (spaceArg) {
        const sp = st.spaces!.find((x) => norm(x.name).includes(norm(spaceArg)));
        if (!sp) return fail(`espaço "${spaceArg}" não encontrado`, [], [`espaços: ${st.spaces!.map((x) => x.name).join(', ')}`]);
        spaceId = sp.id;
      }
      const folders = (st.folders ?? []).filter((f) => !spaceId || f.spaceId === spaceId);
      let folderId: string | undefined;
      if (projectArg) {
        const found = folders.filter((f) => norm(f.name).includes(norm(projectArg)));
        if (!found.length) return fail(`projeto "${projectArg}" não encontrado`, [], [`projetos: ${folders.map((f) => f.name).join(', ')}`]);
        if (found.length > 1) return fail(`"${projectArg}" é ambíguo: ${found.map((f) => f.name).join(', ')}`);
        folderId = found[0].id;
      }
      let listId: string | undefined;
      if (listArg) {
        const lists = folders.filter((f) => !folderId || f.id === folderId).flatMap((f) => f.lists.map((l) => ({ ...l, folder: f.name })));
        const found = lists.filter((l) => norm(l.name).includes(norm(listArg)));
        if (!found.length) return fail(`lista "${listArg}" não encontrada`, [], [`listas: ${lists.map((l) => `${l.folder} › ${l.name}`).join(', ')}`]);
        if (found.length > 1) return fail(`"${listArg}" é ambíguo: ${found.map((l) => `${l.folder} › ${l.name}`).join(', ')}`);
        listId = found[0].id;
      }
      const { tasks, truncated } = await listTasks({
        scope: args.scope === 'me' ? 'me' : 'team',
        assignee,
        spaceId,
        folderId,
        listId,
        overdue: args.overdue === true,
        includeClosed: args.include_closed === true,
      });
      let list: Task[] = tasks;
      if (args.due_within_days !== undefined) {
        const limit = new Date(Date.now() + Number(args.due_within_days) * 86_400_000).toISOString().slice(0, 10);
        list = list.filter((t) => t.due && t.due <= limit);
      }
      const rows = list.slice(0, 80).map((t) => ({
        id: t.id,
        tarefa: t.name,
        status: t.status,
        responsaveis: t.assignees.map((a) => a.name),
        prazo: t.due,
        atrasada: t.overdue || undefined,
        prioridade: t.priority ?? undefined,
        onde: [t.space, t.folder, t.list].filter(Boolean).join(' › '),
        url: t.url,
      }));
      return {
        ok: true,
        summary: `${list.length} tarefa(s)${list.length > rows.length ? ` (mostrando ${rows.length})` : ''}`,
        result: { tasks: rows, total: list.length, truncated: truncated || list.length > rows.length },
      };
    },
  },

  clickup_task: {
    name: 'clickup_task',
    description: 'Lê uma tarefa do ClickUp pelo id ou URL (só leitura): status, responsáveis, prazo, descrição. Notas podem ter "clickup: <id>" no frontmatter.',
    args: s.object({ id: s.string({ min: 3, description: 'id ("86abc123") ou URL da tarefa' }) }),
    async run(args) {
      const t = await getTask(String(args.id));
      return { ok: true, summary: `${t.name} (${t.status})`, result: t };
    },
  },
};

/* ---------- JSON-RPC 2.0 ---------- */

const erro = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

/**
 * Responde um pedido MCP. `notifications/initialized` não tem resposta:
 * devolve `null` e o servidor manda 202.
 */
export async function handleMcp(body: unknown): Promise<object | null> {
  const req = body as { id?: unknown; method?: string; params?: unknown } | null;
  const id = req?.id ?? null;
  if (!req || typeof req.method !== 'string') return erro(id, -32600, 'pedido JSON-RPC inválido');

  switch (req.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'tania-clickup', version: VERSAO },
        },
      };

    case 'notifications/initialized':
      return null;

    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: Object.values(FERRAMENTAS).map((f) => ({ name: f.name, description: f.description, inputSchema: f.args.json() })),
        },
      };

    case 'tools/call': {
      const params = (req.params ?? {}) as { name?: string; arguments?: unknown };
      const tool = FERRAMENTAS[params.name ?? ''];
      if (!tool) return erro(id, -32602, `ferramenta desconhecida: ${params.name ?? '(nenhuma)'}`);
      const parsed = check(tool.args, params.arguments ?? {});
      if (!parsed.ok) {
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `argumentos inválidos: ${parsed.issues.join('; ')}` }], isError: true } };
      }
      try {
        const out = await tool.run(parsed.value);
        if (!out.ok) {
          const msg = out.error + (out.warnings?.length ? ` (${out.warnings.join('; ')})` : '');
          return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: msg }], isError: true } };
        }
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out) }] } };
      } catch (err) {
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: (err as Error).message || 'erro na tool' }], isError: true } };
      }
    }

    default:
      return erro(id, -32601, `método desconhecido: ${req.method}`);
  }
}

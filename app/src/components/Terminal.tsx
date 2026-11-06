import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { expireSession } from '../api';
// mesmo tipo que o servidor valida: mudou lá, o build do front quebra aqui
import type { Plan, PlanAction } from '../../server/agent/rules.ts';

/**
 * Terminal do agente (painel da direita): conversa com o LLM do servidor
 * (server/agent.ts), que organiza e escreve notas usando só as ferramentas
 * do vault. O histórico (formato OpenAI) fica no navegador, em localStorage.
 */

interface ChatMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

type LineKind = 'user' | 'assistant' | 'tool' | 'ok' | 'fail' | 'issue' | 'warn' | 'error' | 'info' | 'plan';
interface Line {
  kind: LineKind;
  text: string;
}


const ACTION_LABEL: Record<PlanAction['action'], string> = {
  create: 'criar',
  append: 'acrescentar',
  update: 'reescrever',
  move: 'mover',
  create_folder: 'criar pasta',
  create_file: 'criar arquivo',
  update_file: 'reescrever arquivo',
};

function formatPlan(plan: Plan): string {
  const rows = plan.actions.map((a, i) => {
    const target = a.action === 'move' ? `${a.path} → ${a.to}` : a.path;
    return `  ${i + 1}. ${ACTION_LABEL[a.action]} ${target}${a.type ? `  [${a.type}]` : ''}\n     ${a.reason}`;
  });
  return [`PLANO: ${plan.summary}`, ...rows].join('\n');
}

interface ProviderInfo {
  name: string;
  model: string | null;
  host: string;
  hasKey: boolean;
  active: boolean;
}

interface AgentStatus {
  configured: boolean;
  hasConfig: boolean;
  active: string | null;
  model: string | null;
  provider: string | null;
  providers: ProviderInfo[];
  tools: string[];
}

const HISTORY_KEY = 'agent.history';
const LINES_KEY = 'agent.lines';
/** uma conversa por nota em foco: agent.history:07-Ideias/X.md (sem nota = conversa geral) */
const keyFor = (base: string, context: string | null) => (context ? `${base}:${context}` : base);

const IDEA_HELP = [
  'Terminal com esta nota como contexto. Ideias de pedido:',
  '  me ajude a desenvolver esta ideia',
  '  que perguntas ainda faltam responder?',
  '  quais os riscos e o primeiro experimento barato?',
  '  organize o que conversamos em seções na nota',
  '  isso já dá um projeto? como ficaria em 06-Projetos?',
].join('\n');

const NOTE_HELP = [
  'Terminal com esta nota como contexto. Ideias de pedido:',
  '  resuma esta nota',
  '  o que está faltando ou desatualizado aqui?',
  '  acrescente uma seção sobre …',
  '  quais notas do vault deveriam linkar com esta?',
].join('\n');
const MAX_LINES = 400;

const HELP = [
  'Peça em linguagem natural, por exemplo:',
  '  organize o 00-Inbox nas pastas certas',
  '  crie uma nota de comando para "git stash" e linke com as de git',
  '  resuma as notas de 03-Aprendizados/LLM numa nota nova',
  'O agente tem autonomia: mostra o PLANO e executa, sem pedir aprovação. Ele não apaga nada.',
  'Comandos: /modelo (lista provedores)  /modelo <nome> (troca)  /contexto  /geral  /clear  /help  /status',
  'Ctrl+C ou ■ interrompe.',
].join('\n');

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** argumentos da ferramenta numa linha: {"path":"x.md","content":"..."} -> path=x.md content=… */
function shortArgs(raw: string): string {
  try {
    const args = JSON.parse(raw || '{}') as Record<string, unknown>;
    return Object.entries(args)
      .map(([k, v]) => {
        const s = typeof v === 'string' ? v : JSON.stringify(v);
        return `${k}=${s.length > 60 ? `${s.slice(0, 57).replace(/\n/g, ' ')}…` : s.replace(/\n/g, ' ')}`;
      })
      .join(' ');
  } catch {
    return raw.slice(0, 80);
  }
}

/**
 * `context`: nota em foco (botão "💬 Terminal" da nota) ou null (conversa geral).
 * O App remonta o componente por contexto (key), então cada nota tem a própria
 * conversa salva e trocar de nota nunca mistura históricos.
 */
export default function Terminal({
  reload,
  context,
  contextType,
  onContextChange,
}: {
  reload: () => Promise<boolean>;
  context: string | null;
  contextType?: string;
  onContextChange: (path: string | null) => void;
}) {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [lines, setLines] = useState<Line[]>(() => load(keyFor(LINES_KEY, context), [] as Line[]));
  const [history, setHistory] = useState<ChatMessage[]>(() => load(keyFor(HISTORY_KEY, context), [] as ChatMessage[]));
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pastInputs = useRef<string[]>([]);
  const pastIndex = useRef(-1);

  async function refreshStatus(): Promise<AgentStatus | null> {
    try {
      const r = await fetch('/api/agent/status');
      expireSession(r);
      const s = r.ok ? ((await r.json()) as AgentStatus) : null;
      setStatus(s);
      return s;
    } catch {
      setStatus(null);
      return null;
    }
  }

  useEffect(() => {
    void refreshStatus();
  }, []);

  // trocou de nota (remontagem) ou fechou: cancela o pedido em andamento desta conversa
  useEffect(() => () => abortRef.current?.abort(), []);

  // celular: a gaveta acompanha a área VISÍVEL (o teclado virtual e a barra do
  // navegador não encolhem position: fixed). CSS usa --vv-height/--vv-top.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const update = () => {
      root.style.setProperty('--vv-height', `${vv.height}px`);
      root.style.setProperty('--vv-top', `${vv.offsetTop}px`);
      screenRef.current?.scrollTo({ top: screenRef.current.scrollHeight });
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      root.style.removeProperty('--vv-height');
      root.style.removeProperty('--vv-top');
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(keyFor(LINES_KEY, context), JSON.stringify(lines.slice(-MAX_LINES)));
    screenRef.current?.scrollTo({ top: screenRef.current.scrollHeight });
  }, [lines]);

  useEffect(() => {
    localStorage.setItem(keyFor(HISTORY_KEY, context), JSON.stringify(history));
  }, [history]);

  const print = (...add: Line[]) => setLines((prev) => [...prev, ...add].slice(-MAX_LINES));

  function statusLine(): string {
    if (!status) return 'agente: servidor sem /api/agent';
    if (!status.hasConfig) return 'agente sem LLM: crie app/agent.config.json no servidor (modelo: agent.config.example.json)';
    if (!status.configured) return 'agente sem LLM ativo: escolha um com /modelo <nome>';
    return `agente: ${status.active} · ${status.model} @ ${status.provider} · ${status.tools.length} ferramentas (/modelo troca)`;
  }

  function providerList(s: AgentStatus | null): string {
    if (!s?.providers.length) return 'nenhum provedor em app/agent.config.json';
    return s.providers
      .map((p) => `${p.active ? '●' : '○'} ${p.name.padEnd(12)} ${p.model ?? '?'} @ ${p.host}${p.hasKey ? '' : '  (sem apiKey)'}`)
      .join('\n');
  }

  async function chooseModel(name: string) {
    try {
      const r = await fetch('/api/agent/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: name }),
      });
      expireSession(r);
      const data = (await r.json()) as AgentStatus & { error?: string };
      if (!r.ok) throw new Error(data.error || `${r.status}`);
      setStatus(data);
      print({ kind: 'ok', text: `provedor ativo: ${data.active} · ${data.model} @ ${data.provider}` });
    } catch (e) {
      print({ kind: 'error', text: (e as Error).message });
    }
  }

  async function send(text: string) {
    const userMsg: ChatMessage = { role: 'user', content: text };
    const messages = [...history, userMsg];
    print({ kind: 'user', text });
    setBusy(true);
    const abort = new AbortController();
    abortRef.current = abort;
    let wrote = false;

    try {
      const res = await fetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, ...(context ? { contextPath: context } : {}) }),
        signal: abort.signal,
      });
      expireSession(res);
      if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `${res.status} ${res.statusText}`);
      }

      // NDJSON: um evento por linha, chega aos pedaços
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fresh: ChatMessage[] | null = null;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const raw = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!raw) continue;
          const ev = JSON.parse(raw) as Record<string, unknown>;
          if (ev.type === 'assistant') print({ kind: 'assistant', text: String(ev.text) });
          else if (ev.type === 'tool') print({ kind: 'tool', text: `${ev.name} ${shortArgs(String(ev.args ?? ''))}` });
          else if (ev.type === 'tool_result') {
            print({ kind: ev.ok ? 'ok' : 'fail', text: String(ev.summary) });
            // erros de regra/schema (o agente corrige sozinho) e avisos (não bloqueiam)
            for (const i of (ev.issues as string[] | undefined) ?? []) print({ kind: 'issue', text: i });
            for (const w of (ev.warnings as string[] | undefined) ?? []) print({ kind: 'warn', text: w });
            if (ev.wrote) wrote = true;
          } else if (ev.type === 'plan') {
            print({ kind: 'plan', text: formatPlan(ev.plan as Plan) });
          } else if (ev.type === 'error') print({ kind: 'error', text: String(ev.error) });
          else if (ev.type === 'messages') fresh = ev.messages as ChatMessage[];
        }
      }
      // só grava no histórico uma rodada completa (senão o próximo envio quebra a sequência de tool_calls)
      if (fresh) setHistory([...messages, ...fresh]);
    } catch (e) {
      if (abort.signal.aborted) print({ kind: 'info', text: '^C interrompido' });
      else print({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
      abortRef.current = null;
      if (wrote) await reload();
      inputRef.current?.focus();
    }
  }

  function submit() {
    const text = input.trim();
    if (!text || busy) return;
    pastInputs.current.push(text);
    pastIndex.current = -1;
    setInput('');
    if (text === '/clear') {
      setLines([]);
      setHistory([]);
      return;
    }
    if (text === '/geral') {
      onContextChange(null);
      return;
    }
    if (text === '/contexto') {
      print({ kind: 'info', text: context ? `contexto: ${context} (/geral volta para a conversa geral)` : 'conversa geral (sem nota em foco)' });
      return;
    }
    if (text === '/help') return print({ kind: 'info', text: HELP });
    if (text === '/status') return print({ kind: 'info', text: statusLine() });
    if (text === '/modelo' || text.startsWith('/modelo ')) {
      const name = text.slice('/modelo'.length).trim();
      if (name) void chooseModel(name);
      else void refreshStatus().then((s) => print({ kind: 'info', text: providerList(s) }));
      return;
    }
    void send(text);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === 'c' && e.ctrlKey && busy) {
      e.preventDefault();
      abortRef.current?.abort();
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !input.includes('\n')) {
      // histórico de comandos, como num shell
      const past = pastInputs.current;
      if (!past.length) return;
      e.preventDefault();
      let i = pastIndex.current === -1 ? past.length : pastIndex.current;
      i = e.key === 'ArrowUp' ? Math.max(0, i - 1) : i + 1;
      pastIndex.current = i >= past.length ? -1 : i;
      setInput(i >= past.length ? '' : past[i]);
    }
  }

  const PREFIX: Record<LineKind, string> = {
    user: '❯ ',
    assistant: '',
    tool: '⚙ ',
    ok: '  ✓ ',
    fail: '  ✗ ',
    issue: '      · ',
    warn: '      ⚠ ',
    plan: '',
    error: '! ',
    info: '',
  };

  return (
    <div className="terminal" onClick={() => window.getSelection()?.isCollapsed && inputRef.current?.focus()}>
      <div className="term-context">
        {context ? (
          <>
            <span className="term-context-label" title="a conversa usa esta nota como contexto">
              📝 <Link to={`/${context.split('/').map(encodeURIComponent).join('/')}`}>{context.split('/').pop()?.replace(/\.md$/, '')}</Link>
            </span>
            <button type="button" className="term-btn" onClick={() => onContextChange(null)} title="Voltar para a conversa geral (/geral)">
              ✕ geral
            </button>
          </>
        ) : (
          <span className="term-context-label">conversa geral · abra uma nota e clique em 💬 Terminal para usá-la como contexto</span>
        )}
      </div>
      <div className="term-screen" ref={screenRef} role="log" aria-live="polite">
        <div className="term-line term-info">{statusLine()}</div>
        {!lines.length && (
          <div className="term-line term-info">{context ? (contextType === 'idea' ? IDEA_HELP : NOTE_HELP) : HELP}</div>
        )}
        {lines.map((l, i) => (
          <div key={i} className={`term-line term-${l.kind}`}>
            {PREFIX[l.kind]}
            {l.text}
          </div>
        ))}
        {busy && <div className="term-line term-info term-busy">pensando…</div>}
      </div>
      <div className="term-input">
        <span className="term-prompt">❯</span>
        <textarea
          ref={inputRef}
          value={input}
          rows={Math.min(6, input.split('\n').length)}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={status?.configured ? 'peça algo ao agente… (/help)' : 'LLM não configurado (/status)'}
          aria-label="Comando para o agente"
          spellCheck={false}
        />
        {busy ? (
          <button type="button" className="term-btn" onClick={() => abortRef.current?.abort()} title="Interromper (Ctrl+C)">
            ■
          </button>
        ) : (
          <button type="button" className="term-btn" onClick={submit} disabled={!input.trim()} title="Enviar (Enter)">
            ↵
          </button>
        )}
      </div>
    </div>
  );
}

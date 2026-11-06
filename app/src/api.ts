/**
 * api.ts — cliente da API de escrita do vault (/api/*).
 * Se o front está servido estático sem servidor, health() falha e o UI
 * cai em modo "somente leitura".
 */
export interface VaultSnapshot {
  notes: { path: string; raw: string }[];
  folders: string[];
  root: string;
}

export interface ApiResult {
  ok: boolean;
  path?: string;
  error?: string;
}

/** sessão de login expirou (servidor com VAULT_AUTH): volta para a tela de login */
export function expireSession(res: Response): void {
  if (res.status === 401) globalThis.location?.assign('/login');
}

async function request<T = ApiResult>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expireSession(res);
  const data = (await res.json().catch(() => ({}))) as T;
  if (!res.ok) throw new Error((data as ApiResult)?.error || `${res.status} ${res.statusText}`);
  return data;
}

/** ../../00-Inbox/Nota.md -> 00-Inbox/Nota.md (caminho do vault, não do bundle) */
export function vaultPath(path: string): string {
  return path.replace(/^(?:\.\.\/)+/, '');
}

function encoded(path: string): string {
  return vaultPath(path).split('/').map(encodeURIComponent).join('/');
}

export const vaultApi = {
  health(): Promise<ApiResult> {
    return request('GET', '/api/health');
  },
  snapshot(): Promise<VaultSnapshot> {
    return request('GET', '/api/notes') as Promise<VaultSnapshot>;
  },
  createNote(path: string, content: string): Promise<ApiResult> {
    return request('POST', '/api/notes', { path: vaultPath(path), content });
  },
  saveNote(path: string, content: string): Promise<ApiResult> {
    return request('PUT', '/api/notes', { path: vaultPath(path), content });
  },
  deleteNote(path: string): Promise<ApiResult> {
    return request('DELETE', `/api/notes/${encoded(path)}`);
  },
  createFolder(path: string): Promise<ApiResult> {
    return request('POST', '/api/folders', { path: vaultPath(path) });
  },
  deleteFolder(path: string, recursive = false): Promise<ApiResult> {
    return request('DELETE', `/api/folders/${encoded(path)}${recursive ? '?recursive=1' : ''}`);
  },
  rename(from: string, to: string): Promise<ApiResult> {
    return request('POST', '/api/rename', { from: vaultPath(from), to: vaultPath(to) });
  },
  /** envia um anexo (corpo binário) para 99-Meta/attachments/…; commit no servidor */
  async uploadFile(path: string, file: Blob): Promise<ApiResult & { size?: number }> {
    const res = await fetch(`/api/files/${encoded(path)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    expireSession(res);
    const data = (await res.json().catch(() => ({}))) as ApiResult & { size?: number };
    if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
    return data;
  },
};

/* ---------- usuários (backend Rust: /api/auth, /api/users) ---------- */
export interface Usuario { id: string; username: string; admin: boolean; ativo: boolean; criadoEm: string }
export const authApi = {
  /** usuário logado; null se a rota não existe (backend só Node) ou deu erro */
  me: async (): Promise<Usuario | null> => {
    try { return (await request<{ user: Usuario }>('GET', '/api/auth/me')).user; } catch { return null; }
  },
};
export const usersApi = {
  list: async () => (await request<{ users: Usuario[] }>('GET', '/api/users')).users,
  create: (body: { username: string; password: string; admin: boolean }) => request<{ user: Usuario }>('POST', '/api/users', body),
  update: (id: string, body: { password?: string; admin?: boolean; ativo?: boolean }) => request<{ user: Usuario }>('PATCH', `/api/users/${id}`, body),
  remove: (id: string) => request('DELETE', `/api/users/${id}`),
};

/* ---------- configuração das integrações (backend Rust: /api/config) ---------- */
export interface ConfigItem { chave: string; grupo: string; descricao: string; segredo: boolean; origem: 'banco' | 'env' | 'vazio'; valor: string }
export const configApi = {
  get: () => request<{ pendente: boolean; cifra: boolean; itens: ConfigItem[] }>('GET', '/api/config'),
  salvar: (chave: string, valor: string) => request<{ item: ConfigItem }>('PUT', `/api/config/${chave}`, { valor }),
  remover: (chave: string) => request('DELETE', `/api/config/${chave}`),
  reiniciar: () => request('POST', '/api/config/restart'),
};

/* ---------- agents: provedores do agente LLM (backend Rust: /api/agents) ---------- */
export interface Provedor { baseUrl: string; model: string; maxTokens?: number; apiKeyEnv?: string }
export interface AgentConfig { active: string; providers: Record<string, Provedor> }
export const agentsApi = {
  get: () => request<{ origem: 'banco' | 'nenhum'; config: AgentConfig; chaves: string[] }>('GET', '/api/agents'),
  salvar: (config: AgentConfig) => request<{ config: AgentConfig }>('PUT', '/api/agents', { config }),
};

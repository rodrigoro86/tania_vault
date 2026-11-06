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

const COMPROVANTE_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

/* ---------- financeiro (Postgres): mesmas formas que server/finance.mjs devolve ---------- */

export interface Imovel {
  id: string; // uuid de alugueis.imoveis
  apelido: string;
  tipo: string;
  endereco: string;
}

export interface Inquilino {
  id: string;
  nome: string;
  documento: string;
  telefone: string | null;
  email: string | null;
}

export interface Imobiliaria {
  id: string;
  nome: string;
}

export interface Contrato {
  id: string;
  imovel_id: string;
  imovel_apelido: string;
  inquilino_id: string;
  inquilino_nome: string;
  imobiliaria_nome: string | null;
  data_inicio: string;
  data_fim: string;
  dia_vencimento: number;
  valor_aluguel: number | string;
  indice: string;
  responsavel_iptu: string;
  status: 'ativo' | 'a_vencer' | 'vencido' | 'encerrado';
}

export interface Pagamento {
  id: string;
  data: string;
  valor: number | string;
  descricao: string | null;
  contrato_id: string;
  mes_referencia: string;
  imovel: string;
  inquilino: string;
  comprovante: string | null;
}

export interface ResumoMensal {
  ano: number;
  mes: number;
  total: number;
  qtd: number;
  por_imovel: { imovel: string; total: number; qtd: number }[];
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

/** entrada de um recebimento; `boleto` é recusado pelo servidor (não é comprovante) */
export interface NovoPagamento {
  contrato_id: string;
  data: string; // AAAA-MM-DD
  valor: number;
  tipo: string;
  mes_referencia: string; // AAAA-MM
  observacao?: string;
}

/**
 * financeApi — dados estruturados do financeiro (`server/finance.mjs`).
 * Todas as rotas são `/api/finance/*`, atrás do mesmo login do vault.
 */
export const financeApi = {
  async imoveis(): Promise<Imovel[]> {
    const d = await request<{ imoveis: Imovel[] }>('GET', '/api/finance/imoveis');
    return d.imoveis ?? [];
  },
  async criarImovel(body: {
    apelido: string;
    tipo: string;
    logradouro: string;
    numero: string;
    complemento?: string;
    bairro: string;
    cidade: string;
    uf: string;
    cep: string;
  }): Promise<{ id: string; apelido: string }> {
    const d = await request<{ imovel: { id: string; apelido: string } }>('POST', '/api/finance/imoveis', body);
    return d.imovel;
  },
  async inquilinos(): Promise<Inquilino[]> {
    const d = await request<{ inquilinos: Inquilino[] }>('GET', '/api/finance/inquilinos');
    return d.inquilinos ?? [];
  },
  async criarInquilino(body: { nome: string; documento: string; telefone?: string; email?: string }): Promise<Inquilino> {
    const d = await request<{ inquilino: Inquilino }>('POST', '/api/finance/inquilinos', body);
    return d.inquilino;
  },
  async imobiliarias(): Promise<Imobiliaria[]> {
    const d = await request<{ imobiliarias: Imobiliaria[] }>('GET', '/api/finance/imobiliarias');
    return d.imobiliarias ?? [];
  },
  async contratos(): Promise<Contrato[]> {
    const d = await request<{ contratos: Contrato[] }>('GET', '/api/finance/contratos');
    return d.contratos ?? [];
  },
  async criarContrato(body: {
    imovel_id: string;
    inquilino_id: string;
    imobiliaria_id?: string;
    data_inicio: string;
    data_fim: string;
    dia_vencimento: number;
    valor_aluguel: number;
    indice: string;
    responsavel_iptu: string;
  }): Promise<Contrato> {
    const d = await request<{ contrato: Contrato }>('POST', '/api/finance/contratos', body);
    return d.contrato;
  },
  async pagamentos(filtro: { de?: string; ate?: string; mes?: string } = {}): Promise<{ pagamentos: Pagamento[]; total: number }> {
    const qs = new URLSearchParams();
    if (filtro.de) qs.set('de', filtro.de);
    if (filtro.ate) qs.set('ate', filtro.ate);
    if (filtro.mes) qs.set('mes_referencia', filtro.mes);
    const suffix = qs.toString() ? `?${qs}` : '';
    const d = await request<{ pagamentos: Pagamento[]; total: number }>('GET', `/api/finance/pagamentos${suffix}`);
    return { pagamentos: d.pagamentos ?? [], total: Number(d.total) || 0 };
  },
  async resumo(ano: number, mes: number): Promise<ResumoMensal> {
    const d = await request<{ resumo: ResumoMensal }>('GET', `/api/finance/resumo?ano=${ano}&mes=${mes}`);
    return d.resumo;
  },
  async editarPagamento(
    id: string,
    body: { contrato_id: string; data: string; valor: number; mes_referencia: string; descricao: string },
  ): Promise<Pagamento> {
    const d = await request<{ pagamento: Pagamento }>('PATCH', `/api/finance/pagamentos/${id}`, body);
    return d.pagamento;
  },
  /** envia o arquivo e liga ao recebimento; se já havia um, o vínculo passa para o novo */
  async anexarComprovante(pagamento_id: string, arquivo: File): Promise<void> {
    const ext = COMPROVANTE_EXT[arquivo.type];
    if (!ext) throw new Error('O comprovante precisa ser imagem (JPG, PNG, WebP) ou PDF.');
    const comprovante = `99-Meta/attachments/comprovantes/${new Date().toISOString().slice(0, 7)}/site-${pagamento_id}-${Date.now()}.${ext}`;
    await vaultApi.uploadFile(comprovante, arquivo);
    await request('POST', '/api/finance/comprovantes', { pagamento_id, comprovante });
  },
  async criarPagamento(body: NovoPagamento): Promise<Pagamento> {
    const d = await request<{ pagamento: Pagamento }>('POST', '/api/finance/pagamentos', body);
    return d.pagamento;
  },
};

/* ---------- 📈 Investimentos (`/api/investimentos/*`, server/investimentos.mjs) ---------- */

export interface PosicaoInv {
  ticker: string;
  quantidade: number;
  custo: number;
  preco_medio: number;
  preco: number;
  variacao: number | null;
  valor: number;
  resultado: number;
  resultado_pct: number;
}
export interface PontoInv {
  data: string;
  patrimonio: number;
  retorno: number;
  ibov: number | null;
  cdi: number | null;
}
export interface CarteiraInv {
  id: string;
  nome: string;
  usa_relatorios: boolean;
  caixa: number;
  aportes: number;
  patrimonio: number;
  retorno: number;
  posicoes: PosicaoInv[];
  serie: PontoInv[];
}
export interface AcompanhadaInv {
  ticker: string;
  preco: number | null;
  variacao: number | null;
  variacao_30d: number | null;
}
export interface ResumoInv {
  carteiras: CarteiraInv[];
  acompanhadas: AcompanhadaInv[];
  atualizado_em: string | null;
  mercado_configurado: boolean;
  tem_ibov: boolean;
}
export interface MovimentoInv {
  id: number;
  tipo: string;
  ticker: string | null;
  quantidade: number | null;
  preco: number | null;
  taxas: number;
  valor: number;
  data: string;
  motivo: string | null;
  origem: string;
}
export interface OrdemInv {
  id: number;
  carteira: string;
  lado: string;
  ticker: string;
  quantidade: number;
  motivo: string;
  decidida_em: string;
  status: string;
  erro: string | null;
  preco: number | null;
  executada_em: string | null;
}
export interface AnaliseInv {
  id: number;
  tipo: string;
  carteira: string | null;
  data: string;
  texto: string;
}
export interface AlertaInv {
  id: number;
  ticker: string;
  tipo: string;
  valor: number;
}
export interface RelatorioInv {
  id: number;
  titulo: string;
  fonte: string | null;
  data: string;
  resumo: string | null;
  recomendacoes: { ticker: string; acao: string; preco_alvo: number | null; motivo: string }[];
}

const INV = '/api/investimentos';

export const investApi = {
  resumo: () => request<ResumoInv>('GET', `${INV}/resumo`),
  movimentos: async () => (await request<{ movimentos: MovimentoInv[] }>('GET', `${INV}/movimentos`)).movimentos,
  registrar: (body: Record<string, unknown>) => request('POST', `${INV}/movimentos`, body),
  removerMovimento: (id: number) => request('DELETE', `${INV}/movimentos/${id}`),
  ordens: async () => (await request<{ ordens: OrdemInv[] }>('GET', `${INV}/ordens`)).ordens,
  analises: async () => (await request<{ analises: AnaliseInv[] }>('GET', `${INV}/analises`)).analises,
  alertas: async () => (await request<{ alertas: AlertaInv[] }>('GET', `${INV}/alertas`)).alertas,
  criarAlerta: (body: { ticker: string; tipo: string; valor: number }) => request('POST', `${INV}/alertas`, body),
  removerAlerta: (id: number) => request('DELETE', `${INV}/alertas/${id}`),
  acompanhar: (ticker: string) => request('POST', `${INV}/acompanhadas`, { ticker }),
  deixarDeAcompanhar: (ticker: string) => request('DELETE', `${INV}/acompanhadas/${encodeURIComponent(ticker)}`),
  relatorios: async () => (await request<{ relatorios: RelatorioInv[] }>('GET', `${INV}/relatorios`)).relatorios,
  criarRelatorio: (body: { titulo: string; fonte: string; data: string; texto: string }) => request('POST', `${INV}/relatorios`, body),
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

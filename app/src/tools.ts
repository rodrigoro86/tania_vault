/**
 * tools.ts — lista das tools (plugins) disponíveis, lida de GET /api/tools.
 * A carga é UMA promessa compartilhada por módulo: quantas telas chamarem
 * `useTools()`, só há um fetch. Erro ou resposta malformada → lista vazia.
 * `recarregarTools()` descarta a promessa (a tela de admin chama depois de
 * salvar uma tool, para ver o resultado na hora).
 */
import { useEffect, useState } from 'react';
import { expireSession } from './api';

export interface Pagina {
  id: string;
  titulo: string;
}

export interface Manifesto {
  id: string;
  nome: string;
  icone: string;
  versao?: string;
  paginas: Pagina[];
  vinculos?: { campo: string; pagina: string }[];
  config?: { chave: string; segredo: boolean; descricao?: string }[];
}

export interface ToolInfo {
  id: string;
  origem: 'env' | 'banco';
  ativo: boolean;
  url?: string;
  erro?: string;
  manifest: Manifesto | null;
}

/** id de tool/página: só minúsculas, números e hífen (seguro na URL do iframe) */
export const ID_OK = /^[a-z0-9-]{1,32}$/;

function limpar(raw: unknown): ToolInfo[] {
  const lista = Array.isArray(raw) ? raw : (raw as { tools?: unknown[] })?.tools;
  if (!Array.isArray(lista)) return [];
  const out: ToolInfo[] = [];
  for (const item of lista) {
    const t = item as ToolInfo;
    if (!t || typeof t.id !== 'string' || !ID_OK.test(t.id)) continue;
    const m = t.manifest;
    if (!m || !Array.isArray(m.paginas)) continue;
    const paginas = m.paginas.filter(
      (p) => p && typeof p.id === 'string' && ID_OK.test(p.id) && typeof p.titulo === 'string',
    );
    if (!paginas.length) continue;
    const vinculos = (Array.isArray(m.vinculos) ? m.vinculos : []).filter(
      (v) => v && typeof v.campo === 'string' && typeof v.pagina === 'string' && ID_OK.test(v.pagina),
    );
    out.push({ ...t, manifest: { ...m, paginas, vinculos } });
  }
  return out;
}

let carga: Promise<ToolInfo[]> | null = null;

function carregar(): Promise<ToolInfo[]> {
  if (!carga) {
    carga = fetch('/api/tools')
      .then(async (res) => {
        expireSession(res);
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error((data as { error?: string })?.error || `${res.status} ${res.statusText}`);
        return limpar(data);
      })
      .catch(() => []);
  }
  return carga;
}

export function recarregarTools(): void {
  carga = null;
}

export function useTools(): ToolInfo[] {
  const [tools, setTools] = useState<ToolInfo[]>([]);
  useEffect(() => {
    let vivo = true;
    void carregar().then((t) => {
      if (vivo) setTools(t);
    });
    return () => {
      vivo = false;
    };
  }, []);
  return tools;
}

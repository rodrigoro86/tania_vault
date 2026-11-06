/**
 * agentes.ts — agentes especializados da Tania (spec 2026-11-06-agentes-da-tania).
 *
 * Cada agente é uma nota `99-Meta/Agentes/Tania/<nome>.md` editável pelo front: o frontmatter `quando` diz quando
 * usar, o corpo diz como trabalhar. O prompt do sistema lista nome + quando; a ferramenta `usar_agente` devolve as
 * instruções. Lido do vault a cada pedido: editar a nota vale na hora.
 */
import { parseFrontmatter } from './rules.ts';

export const PASTA_AGENTES = '99-Meta/Agentes/Tania/';
const NOME = /^[a-z0-9-]{1,32}$/;

export interface AgenteTania {
  nome: string;
  quando: string;
  instrucoes: string;
}

interface StoreLeitura {
  // local devolve string; S3 devolve {key, size} (os dois stores divergem no contrato)
  listKeys(prefix?: string): Promise<Array<string | { key: string }>>;
  readText(rel: string): Promise<string>;
}

/** agentes válidos da pasta (só `.md` direto nela, com `quando`), em ordem de nome */
export async function listarAgentes(store: StoreLeitura): Promise<AgenteTania[]> {
  let keys: string[];
  try {
    keys = (await store.listKeys(PASTA_AGENTES)).map((k) => (typeof k === 'string' ? k : k.key));
  } catch {
    return [];
  }
  const out: AgenteTania[] = [];
  for (const key of keys.sort()) {
    const resto = key.startsWith(PASTA_AGENTES) ? key.slice(PASTA_AGENTES.length) : '';
    const m = /^([^/]+)\.md$/.exec(resto);
    if (!m || !NOME.test(m[1])) continue;
    let texto: string;
    try {
      texto = await store.readText(key);
    } catch {
      continue;
    }
    const fm = parseFrontmatter(texto);
    const quando = fm?.data.quando;
    if (typeof quando !== 'string' || !quando.trim()) {
      console.warn(`agentes: ${key} sem "quando" no frontmatter; ignorado`);
      continue;
    }
    out.push({ nome: m[1], quando: quando.trim(), instrucoes: (fm?.body ?? '').trim() });
  }
  return out;
}

/** bloco do prompt do sistema; vazio sem agentes */
export function blocoAgentes(agentes: AgenteTania[]): string[] {
  if (!agentes.length) return [];
  return [
    'Agentes especializados (instruções do usuário em 99-Meta/Agentes/Tania/):',
    ...agentes.map((a) => `- ${a.nome}: ${a.quando}`),
    'Antes de agir num pedido que se encaixa num desses agentes, chame usar_agente com o nome e siga as instruções dele',
    '(elas valem acima das regras gerais quando conflitarem). Um pedido pode precisar de mais de um agente.',
    '',
  ];
}

/** procura por nome normalizado ("Agenda " = "agenda") */
export function acharAgente(agentes: AgenteTania[], nome: string): AgenteTania | undefined {
  const alvo = String(nome ?? '').trim().toLowerCase();
  return agentes.find((a) => a.nome === alvo);
}

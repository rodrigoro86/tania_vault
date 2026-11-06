/**
 * edits.ts — edição por trechos (procurar/substituir) usada por edit_file e
 * edit_note (server/agent.ts). O agente manda só o trecho antigo e o novo, em
 * vez do arquivo inteiro: ajustar uma apresentação de 40 KB cabe folgado no
 * limite de saída do modelo.
 *
 * Tudo ou nada: se um trecho não for achado (ou for ambíguo), nada muda e o
 * erro diz qual edição falhou e por quê.
 */
export interface Edit {
  old: string;
  new: string;
  /** substitui todas as ocorrências (senão o trecho precisa ser único) */
  all?: boolean;
}

export type EditResult = { ok: true; text: string; replaced: number } | { ok: false; errors: string[] };

const count = (text: string, part: string) => (part ? text.split(part).length - 1 : 0);
const preview = (s: string) => JSON.stringify(s.length > 80 ? `${s.slice(0, 77)}...` : s);

export function applyEdits(text: string, edits: Edit[]): EditResult {
  const errors: string[] = [];
  let out = text;
  let replaced = 0;
  edits.forEach((e, i) => {
    const label = `edição ${i + 1} (${preview(e.old)})`;
    if (!e.old) return void errors.push(`${label}: "old" vazio`);
    if (e.old === e.new) return void errors.push(`${label}: "old" e "new" iguais`);
    const n = count(out, e.old);
    if (n === 0) return void errors.push(`${label}: trecho não encontrado — copie exatamente do arquivo atual (read_file/read_note), com espaços e quebras de linha`);
    if (n > 1 && !e.all) return void errors.push(`${label}: trecho aparece ${n} vezes — inclua mais contexto para ficar único, ou use all: true`);
    out = out.split(e.old).join(e.new);
    replaced += e.all ? n : 1;
  });
  return errors.length ? { ok: false, errors } : { ok: true, text: out, replaced };
}

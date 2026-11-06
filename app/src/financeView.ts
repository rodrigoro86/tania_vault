/**
 * financeView.ts — formatação e cálculos da tela 💰 Aluguéis
 * (`components/Finance.tsx`). Fica separado do componente e sem DOM para
 * poder ser testado com `node --test` (server/tests/finance-view.test.mjs).
 *
 * Regra do domínio (SPEC §4.4): boleto NÃO é comprovante — por isso 'boleto'
 * não aparece entre os tipos de recebimento da tela.
 */

/** R$ 1.800,00 — o `numeric` do Postgres chega como string ("1800.00") */
export function brl(valor: number | string | null | undefined): string {
  const n = Number(valor);
  if (valor === null || valor === undefined || valor === '' || !Number.isFinite(n)) return '—';
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/** hoje no fuso local em AAAA-MM-DD (`toISOString` passaria para UTC e adiantaria o dia) */
export function hojeISO(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Lê o valor digitado no padrão brasileiro: "1800", "1800,50", "1.800,00",
 * "R$ 1.800" e também "1800.00" (como o pg devolve). NaN quando não é número.
 * Sem isto, "1.800,00" digitado no campo virava NaN.
 */
export function parseMoney(v: string | number | null | undefined): number {
  if (typeof v === 'number') return v;
  const s = String(v ?? '').replace(/\s|R\$/g, '').trim();
  if (!s) return Number.NaN;
  if (s.includes(',')) return Number(s.replace(/\./g, '').replace(',', '.'));
  // sem vírgula, "1.800"/"1.234.567" é separador de milhar (pt-BR), não decimal
  if (/^\d{1,3}(\.\d{3})+$/.test(s)) return Number(s.replace(/\./g, ''));
  return Number(s);
}

/** mês corrente usado no resumo mensal */
export function mesAtual(d: Date = new Date()): { ano: number; mes: number } {
  return { ano: d.getFullYear(), mes: d.getMonth() + 1 };
}

export const MESES = [
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
] as const;

/** "outubro/2026" */
export function mesLabel(ano: number, mes: number): string {
  return `${MESES[mes - 1] ?? mes}/${ano}`;
}

/** "2026-10" -> "outubro/2026" */
export function mesRefLabel(ref: string): string {
  const [ano, mes] = ref.split('-').map(Number);
  return mesLabel(ano, mes);
}

/** "12345678901" -> "123.456.789-01"; CNPJ igual; outro formato volta como veio */
export function documentoLabel(doc: string): string {
  if (doc.length === 11) return doc.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  if (doc.length === 14) return doc.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  return doc;
}

/** "vence dia 10" | "sem vencimento" */
export function vencimentoLabel(dia: number | string | null | undefined): string {
  const n = Number(dia);
  if (!Number.isInteger(n) || n < 1) return 'sem vencimento';
  return `vence dia ${n}`;
}

/** "2026-10-31" -> "31/10/2026" (sem Date: não desloca por fuso) */
export function dataBR(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso ?? '—');
}

/** tipos aceitos no recebimento (menos 'boleto', que o servidor recusa com 422) */
export const TIPOS_RECEBIMENTO = ['pix', 'dinheiro', 'transferencia', 'outro'] as const;
export type TipoRecebimento = (typeof TIPOS_RECEBIMENTO)[number];

export function tipoLabel(tipo: string): string {
  switch (tipo) {
    case 'pix':
      return 'Pix';
    case 'dinheiro':
      return 'Dinheiro';
    case 'transferencia':
      return 'Transferência';
    case 'boleto':
      return 'Boleto';
    default:
      return 'Outro';
  }
}

/** status calculado do contrato, como a API de aluguéis devolve */
export function statusContratoLabel(status: string): string {
  return status === 'a_vencer' ? 'a vencer' : status;
}

export type SituacaoAluguel = 'atrasado' | 'a_receber' | 'recebido';

const ORDEM_SITUACAO: SituacaoAluguel[] = ['atrasado', 'a_receber', 'recebido'];

/**
 * Aluguéis de um mês (AAAA-MM), do que pede atenção ao que já foi recebido.
 * Só entram contratos vigentes no mês, a mesma regra que o banco usa para
 * aceitar o recebimento. Vencimento dia 31 em mês curto cai no último dia.
 * Qualquer recebimento quita o mês: o valor pago pode diferir do contrato.
 */
export function alugueisDoMes<
  C extends { id: string; data_inicio: string; data_fim: string; dia_vencimento: number; valor_aluguel: number | string; status: string },
>(contratos: C[], pagamentos: { contrato_id: string; valor: number | string }[], ref: string, hoje: string = hojeISO()) {
  const [ano, mes] = ref.split('-').map(Number);
  const ultimoDia = new Date(ano, mes, 0).getDate();
  return contratos
    .filter((c) => c.status !== 'encerrado' && c.data_inicio.slice(0, 7) <= ref && ref <= c.data_fim.slice(0, 7))
    .map((contrato) => {
      const recebido = pagamentos
        .filter((p) => p.contrato_id === contrato.id)
        .reduce((soma, p) => soma + Number(p.valor), 0);
      const falta = recebido > 0 ? 0 : Number(contrato.valor_aluguel);
      const vence = `${ref}-${String(Math.min(contrato.dia_vencimento, ultimoDia)).padStart(2, '0')}`;
      const situacao: SituacaoAluguel = recebido > 0 ? 'recebido' : vence < hoje ? 'atrasado' : 'a_receber';
      return { contrato, recebido, falta, situacao };
    })
    .sort((a, b) => ORDEM_SITUACAO.indexOf(a.situacao) - ORDEM_SITUACAO.indexOf(b.situacao));
}

/** mês anterior/próximo do seletor de resumo (mes 1..12, virando o ano) */
export function mesVizinho(ano: number, mes: number, passo: number): { ano: number; mes: number } {
  const total = ano * 12 + (mes - 1) + passo;
  return { ano: Math.floor(total / 12), mes: (total % 12) + 1 };
}

/**
 * schema.ts — mini-schema tipado (sem dependências): uma definição gera
 *   1. o tipo TypeScript       (Infer<typeof X>)
 *   2. a validação em runtime  (parse: erros com o caminho do campo)
 *   3. o JSON Schema           (enviado ao LLM como `parameters` da ferramenta)
 *
 * Sem dependência de propósito: o container de produção não roda npm install
 * (ver docker-compose.yml), então o servidor só usa o que é do próprio Node.
 */

export type Issues = string[];

export interface Schema<T> {
  /** valida e devolve o valor tipado; acumula problemas em `issues` */
  parse(value: unknown, at: string, issues: Issues): T | undefined;
  json(): Record<string, unknown>;
  readonly optional?: boolean;
}

export type Infer<S> = S extends Schema<infer T> ? T : never;

const where = (at: string) => at || 'valor';

interface StringOpts {
  description?: string;
  min?: number;
  max?: number;
  pattern?: RegExp;
  /** mensagem quando o pattern falha */
  patternMessage?: string;
}

function string(opts: StringOpts = {}): Schema<string> {
  return {
    parse(v, at, issues) {
      if (typeof v !== 'string') {
        issues.push(`${where(at)}: deve ser texto`);
        return undefined;
      }
      if (opts.min !== undefined && v.trim().length < opts.min) issues.push(`${where(at)}: obrigatório`);
      if (opts.max !== undefined && v.length > opts.max) issues.push(`${where(at)}: no máximo ${opts.max} caracteres`);
      if (opts.pattern && !opts.pattern.test(v)) issues.push(`${where(at)}: ${opts.patternMessage ?? `formato inválido (${opts.pattern})`}`);
      return v;
    },
    json: () => ({
      type: 'string',
      ...(opts.description ? { description: opts.description } : {}),
      ...(opts.max !== undefined ? { maxLength: opts.max } : {}),
    }),
  };
}

function number(opts: { description?: string; min?: number; max?: number } = {}): Schema<number> {
  return {
    parse(v, at, issues) {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        issues.push(`${where(at)}: deve ser número`);
        return undefined;
      }
      if (opts.min !== undefined && v < opts.min) issues.push(`${where(at)}: mínimo ${opts.min}`);
      if (opts.max !== undefined && v > opts.max) issues.push(`${where(at)}: máximo ${opts.max}`);
      return v;
    },
    json: () => ({ type: 'number', ...(opts.description ? { description: opts.description } : {}) }),
  };
}

function boolean(description?: string): Schema<boolean> {
  return {
    parse(v, at, issues) {
      if (typeof v !== 'boolean') {
        issues.push(`${where(at)}: deve ser true ou false`);
        return undefined;
      }
      return v;
    },
    json: () => ({ type: 'boolean', ...(description ? { description } : {}) }),
  };
}

function oneOf<const T extends readonly string[]>(values: T, description?: string): Schema<T[number]> {
  return {
    parse(v, at, issues) {
      if (typeof v !== 'string' || !values.includes(v)) {
        issues.push(`${where(at)}: deve ser um de ${values.join(' | ')} (veio ${JSON.stringify(v)})`);
        return undefined;
      }
      return v as T[number];
    },
    json: () => ({ type: 'string', enum: [...values], ...(description ? { description } : {}) }),
  };
}

function array<T>(item: Schema<T>, opts: { description?: string; min?: number; max?: number } = {}): Schema<T[]> {
  return {
    parse(v, at, issues) {
      if (!Array.isArray(v)) {
        issues.push(`${where(at)}: deve ser uma lista`);
        return undefined;
      }
      if (opts.min !== undefined && v.length < opts.min) issues.push(`${where(at)}: pelo menos ${opts.min} item(ns)`);
      if (opts.max !== undefined && v.length > opts.max) issues.push(`${where(at)}: no máximo ${opts.max} itens`);
      return v.map((x, i) => item.parse(x, `${at}[${i}]`, issues)) as T[];
    },
    json: () => ({ type: 'array', items: item.json(), ...(opts.description ? { description: opts.description } : {}) }),
  };
}

function optional<T>(inner: Schema<T>): Schema<T | undefined> {
  return {
    optional: true,
    parse: (v, at, issues) => (v === undefined || v === null ? undefined : inner.parse(v, at, issues)),
    json: () => inner.json(),
  };
}

type Shape = Record<string, Schema<unknown>>;
type OptionalKeys<S extends Shape> = { [K in keyof S]: undefined extends Infer<S[K]> ? K : never }[keyof S];
type RequiredKeys<S extends Shape> = Exclude<keyof S, OptionalKeys<S>>;
export type InferShape<S extends Shape> = { [K in RequiredKeys<S>]: Infer<S[K]> } & { [K in OptionalKeys<S>]?: Infer<S[K]> };

interface ObjectOpts {
  description?: string;
  /** aceita campos fora do shape (ex.: frontmatter tem campos livres); padrão: recusa */
  passthrough?: boolean;
}

function object<S extends Shape>(shape: S, opts: ObjectOpts = {}): Schema<InferShape<S>> {
  return {
    parse(v, at, issues) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) {
        issues.push(`${where(at)}: deve ser um objeto`);
        return undefined;
      }
      const input = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [key, schema] of Object.entries(shape)) {
        const child = at ? `${at}.${key}` : key;
        if (input[key] === undefined && !schema.optional) {
          issues.push(`${child}: obrigatório`);
          continue;
        }
        const parsed = schema.parse(input[key], child, issues);
        if (parsed !== undefined) out[key] = parsed;
      }
      for (const key of Object.keys(input)) {
        if (key in shape) continue;
        if (opts.passthrough) out[key] = input[key];
        else issues.push(`${at ? `${at}.` : ''}${key}: campo desconhecido`);
      }
      return out as InferShape<S>;
    },
    json: () => ({
      type: 'object',
      ...(opts.description ? { description: opts.description } : {}),
      properties: Object.fromEntries(Object.entries(shape).map(([k, s]) => [k, s.json()])),
      required: Object.entries(shape).filter(([, s]) => !s.optional).map(([k]) => k),
      additionalProperties: !!opts.passthrough,
    }),
  };
}

export const s = { string, number, boolean, oneOf, array, optional, object };

/** valida tudo e devolve o valor tipado ou a lista de problemas */
export function check<T>(schema: Schema<T>, value: unknown): { ok: true; value: T } | { ok: false; issues: Issues } {
  const issues: Issues = [];
  const parsed = schema.parse(value, '', issues);
  return issues.length || parsed === undefined ? { ok: false, issues } : { ok: true, value: parsed };
}

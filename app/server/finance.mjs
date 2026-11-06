/**
 * finance.mjs — dados estruturados no schema `alugueis` (mesmo banco e mesmas
 * regras de api_assistente_alugueis): imóveis, inquilinos, imobiliárias,
 * contratos, recebimentos (alugueis.extrato) e resumo mensal (Carnê-Leão).
 * Usado pela API HTTP e pelas tools do agente.
 * Regra: boleto NÃO é comprovante (não registra pagamento).
 * Comprovantes: arquivo no storage, vínculo na tabela `comprovantes`.
 */
import { query } from './db.mjs';
import { ATTACHMENTS_DIR, readJson, store } from './vault-api.mjs';

export const TIPOS = ['pix', 'boleto', 'dinheiro', 'transferencia', 'outro'];

/** categoria de `alugueis.categorias` usada nos recebimentos (vínculo contrato) */
const CATEGORIA_ALUGUEL = 'Aluguel recebido';

function fail(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const text = (v, name, { required = true, max = 500 } = {}) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (required && !s) throw fail(`${name} é obrigatório`);
  if (s.length > max) throw fail(`${name} muito longo`);
  return s || null;
};

const money = (v, name) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw fail(`${name} deve ser > 0`);
  return Math.round(n * 100) / 100;
};

const isoDate = (v, name) => {
  const s = String(v ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw fail(`${name} deve ser AAAA-MM-DD`);
  return s;
};

/** gatilhos e constraints do banco -> mensagem, como core/errors.py da API de aluguéis */
const ERROS_BANCO = {
  categoria_inativa: [422, 'A categoria Aluguel recebido está desativada.'],
  contrato_obrigatorio: [422, 'Informe o contrato e o mês de referência.'],
  mes_fora_do_contrato: [422, 'O mês de referência está fora do período do contrato.'],
  um_contrato_por_imovel: [409, 'Este imóvel já tem um contrato ativo nesse período.'],
  inquilinos_documento_key: [409, 'Já existe um inquilino com este documento.'],
  23503: [404, 'Imóvel, inquilino, imobiliária ou contrato não encontrado.'],
  23514: [422, 'Algum valor não passou nas regras de validação.'],
  '22P02': [422, 'Valor em formato inválido.'],
  22003: [422, 'Valor fora do limite permitido.'],
};

export function traduzErroBanco(err) {
  const t = ERROS_BANCO[err?.constraint] ?? ERROS_BANCO[err?.hint] ?? ERROS_BANCO[err?.code];
  return t ? fail(t[1], t[0]) : err;
}

const db = (sql, params) =>
  query(sql, params).catch((err) => {
    throw traduzErroBanco(err);
  });

const hoje = () => "(now() at time zone 'America/Sao_Paulo')::date";

/* ---------- imóveis ---------- */

export async function listImoveis() {
  // número "0" = sítio sem número
  const { rows } = await db(
    `select id, apelido, tipo, logradouro, numero, complemento, bairro, cidade, uf, cep,
            inscricao_imobiliaria, matricula, observacoes,
            concat_ws(', ', logradouro, nullif(numero, '0'), complemento, bairro, cidade || '/' || uf) as endereco
     from alugueis.imoveis
     where arquivado_em is null
     order by apelido`,
  );
  return rows;
}

export async function createImovel(input) {
  const uf = text(input?.uf, 'uf', { max: 2 }).toUpperCase();
  if (!/^[A-Z]{2}$/.test(uf)) throw fail('uf deve ter 2 letras');
  const cep = String(input?.cep ?? '').replace(/\D/g, '');
  if (cep.length !== 8) throw fail('cep deve ter 8 dígitos');
  const { rows } = await db(
    `insert into alugueis.imoveis
       (apelido, tipo, logradouro, numero, complemento, bairro, cidade, uf, cep,
        inscricao_imobiliaria, matricula, observacoes)
     values ($1, coalesce($2::alugueis.tipo_imovel, 'casa'), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     returning id, apelido, tipo`,
    [
      text(input?.apelido, 'apelido'),
      text(input?.tipo, 'tipo', { required: false }),
      text(input?.logradouro, 'logradouro'),
      text(input?.numero, 'numero'),
      text(input?.complemento, 'complemento', { required: false }),
      text(input?.bairro, 'bairro'),
      text(input?.cidade, 'cidade'),
      uf,
      cep,
      text(input?.inscricao_imobiliaria, 'inscricao_imobiliaria', { required: false }),
      text(input?.matricula, 'matricula', { required: false }),
      text(input?.observacoes, 'observacoes', { required: false, max: 2000 }),
    ],
  );
  return rows[0];
}

/* ---------- inquilinos ---------- */

export async function listInquilinos() {
  const { rows } = await db(
    `select id, nome, documento, telefone, email, observacoes
     from alugueis.inquilinos where arquivado_em is null order by nome`,
  );
  return rows;
}

export async function createInquilino(input) {
  const documento = String(input?.documento ?? '').replace(/\D/g, '');
  if (documento.length !== 11 && documento.length !== 14) throw fail('documento deve ser CPF (11) ou CNPJ (14 dígitos)');
  const { rows } = await db(
    `insert into alugueis.inquilinos (nome, documento, telefone, email, observacoes)
     values ($1, $2, $3, $4, $5)
     returning id, nome, documento, telefone, email, observacoes`,
    [
      text(input?.nome, 'nome'),
      documento,
      text(input?.telefone, 'telefone', { required: false, max: 100 }),
      text(input?.email, 'email', { required: false, max: 200 }),
      text(input?.observacoes, 'observacoes', { required: false, max: 2000 }),
    ],
  );
  return rows[0];
}

/* ---------- imobiliárias ---------- */

export async function listImobiliarias() {
  const { rows } = await db('select id, nome from alugueis.imobiliarias where arquivado_em is null order by nome');
  return rows;
}

/* ---------- contratos ---------- */

export async function listContratos() {
  const ref = hoje();
  const { rows } = await db(`
    select c.id, c.imovel_id, i.apelido as imovel_apelido, c.inquilino_id, q.nome as inquilino_nome,
           c.imobiliaria_id, b.nome as imobiliaria_nome, c.data_inicio::text, c.data_fim::text,
           c.data_saida::text, c.dia_vencimento, c.valor_aluguel, c.indice, c.responsavel_iptu, c.observacoes,
           case when c.data_saida is not null then 'encerrado'
                when c.data_fim < ${ref} then 'vencido'
                when c.data_fim <= ${ref} + 60 then 'a_vencer'
                else 'ativo' end as status
    from alugueis.contratos c
    join alugueis.imoveis i on i.id = c.imovel_id
    join alugueis.inquilinos q on q.id = c.inquilino_id
    left join alugueis.imobiliarias b on b.id = c.imobiliaria_id
    order by i.apelido, q.nome`);
  return rows;
}

export async function createContrato(input) {
  const data_inicio = isoDate(input?.data_inicio, 'data_inicio');
  const data_fim = isoDate(input?.data_fim, 'data_fim');
  if (data_fim <= data_inicio) throw fail('data_fim deve ser depois de data_inicio');
  const dia_vencimento = Number(input?.dia_vencimento);
  if (!Number.isInteger(dia_vencimento) || dia_vencimento < 1 || dia_vencimento > 31) {
    throw fail('dia_vencimento deve ser de 1 a 31');
  }
  const { rows: imovel } = await db('select arquivado_em from alugueis.imoveis where id = $1', [input?.imovel_id ?? null]);
  if (imovel[0]?.arquivado_em) throw fail('Este imóvel está arquivado.', 409);
  const { rows } = await db(
    `insert into alugueis.contratos
       (imovel_id, inquilino_id, imobiliaria_id, data_inicio, data_fim, dia_vencimento, valor_aluguel,
        indice, responsavel_iptu, observacoes)
     values ($1, $2, $3, $4, $5, $6, $7,
             coalesce($8::alugueis.indice_reajuste, 'igpm'),
             coalesce($9::alugueis.responsavel_iptu, 'inquilino'), $10)
     returning id, imovel_id, inquilino_id, imobiliaria_id, data_inicio::text, data_fim::text,
               dia_vencimento, valor_aluguel, indice, responsavel_iptu`,
    [
      input?.imovel_id ?? null,
      input?.inquilino_id ?? null,
      input?.imobiliaria_id || null,
      data_inicio,
      data_fim,
      dia_vencimento,
      money(input?.valor_aluguel, 'valor_aluguel'),
      text(input?.indice, 'indice', { required: false }),
      text(input?.responsavel_iptu, 'responsavel_iptu', { required: false }),
      text(input?.observacoes, 'observacoes', { required: false, max: 2000 }),
    ],
  );
  return rows[0];
}

/* ---------- pagamentos (lançamentos de aluguel em alugueis.extrato) ---------- */

const PAGAMENTOS = `
  from alugueis.extrato e
  join alugueis.categorias k on k.id = e.categoria_id and k.vinculo = 'contrato' and k.tipo = 'entrada'
  join alugueis.contratos c on c.id = e.contrato_id
  join alugueis.imoveis i on i.id = c.imovel_id
  join alugueis.inquilinos q on q.id = c.inquilino_id
  left join comprovantes cp on cp.extrato_id = e.id`;

const COLUNAS_PAGAMENTO = `e.id, e.data::text, e.valor, e.descricao, e.contrato_id,
  to_char(e.mes_referencia, 'YYYY-MM') as mes_referencia,
  i.apelido as imovel, q.nome as inquilino, cp.caminho as comprovante`;

export const COMPROVANTES_DIR = `${ATTACHMENTS_DIR}/comprovantes`;

/** o caminho vem do LLM: só aceita arquivo que existe na pasta de comprovantes e ainda sem dono */
async function confereComprovante(caminho) {
  const c = String(caminho ?? '');
  if (!c.startsWith(`${COMPROVANTES_DIR}/`) || c.includes('..') || !/\.(jpe?g|png|webp|pdf)$/i.test(c) || !(await store.exists(c))) {
    throw fail('Comprovante não encontrado.', 422);
  }
  if (await comprovanteVinculado(c)) throw fail('Este comprovante já está em outro recebimento.', 409);
  return c;
}

export async function comprovanteVinculado(caminho) {
  const { rows } = await db('select 1 from comprovantes where caminho = $1', [caminho]);
  return rows.length > 0;
}

const vincular = (extratoId, caminho) =>
  db(
    `insert into comprovantes (extrato_id, caminho) values ($1, $2)
     on conflict (extrato_id) do update set caminho = excluded.caminho`,
    [extratoId, caminho],
  );

/** liga um comprovante a um recebimento já lançado (troca o anterior, se houver) */
export async function anexarComprovante(input) {
  const caminho = await confereComprovante(input?.comprovante);
  const { rows } = await db(`select e.id ${PAGAMENTOS} where e.id = $1`, [input?.pagamento_id]);
  if (!rows[0]) throw fail('Recebimento não encontrado.', 404);
  await vincular(rows[0].id, caminho);
  return { pagamento_id: rows[0].id, comprovante: caminho };
}

/**
 * @param {{ de?: string, ate?: string, mes_referencia?: string, contrato_id?: string, imovel_id?: string, limit?: number }} [opts]
 */
export async function listPagamentos({ de, ate, mes_referencia, contrato_id, imovel_id, limit = 200 } = {}) {
  const cond = [];
  const params = [];
  if (de) {
    params.push(isoDate(de, 'de'));
    cond.push(`e.data >= $${params.length}`);
  }
  if (ate) {
    params.push(isoDate(ate, 'ate'));
    cond.push(`e.data <= $${params.length}`);
  }
  if (mes_referencia) {
    params.push(isoDate(`${mes_referencia}-01`, 'mes_referencia'));
    cond.push(`e.mes_referencia = $${params.length}`);
  }
  if (contrato_id) {
    params.push(contrato_id);
    cond.push(`e.contrato_id = $${params.length}`);
  }
  if (imovel_id) {
    params.push(imovel_id);
    cond.push(`c.imovel_id = $${params.length}`);
  }
  const where = cond.length ? `where ${cond.join(' and ')}` : '';
  const cap = Math.min(Number(limit) || 200, 500);
  const { rows } = await db(
    `select ${COLUNAS_PAGAMENTO}
     ${PAGAMENTOS}
     ${where}
     order by e.data desc, e.criado_em desc
     limit $${params.length + 1}`,
    [...params, cap],
  );
  return rows;
}

export async function createPagamento(input) {
  const data = isoDate(input?.data, 'data');
  const valor = money(input?.valor, 'valor');
  const tipo = String(input?.tipo ?? '').trim();
  if (!TIPOS.includes(tipo)) throw fail(`tipo deve ser um de ${TIPOS.join(', ')}`);
  if (tipo === 'boleto') {
    throw fail('boleto não é comprovante: registre o Pix/transferência que você recebeu', 422);
  }
  const mes = String(input?.mes_referencia || data.slice(0, 7));
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mes)) throw fail('mes_referencia deve ser AAAA-MM');
  const observacao = text(input?.observacao, 'observacao', { required: false, max: 2000 });
  const comprovante = input?.comprovante ? await confereComprovante(input.comprovante) : null;

  // shortcut: lança na única conta cadastrada; com mais de uma, a tela precisa escolher a conta
  const contas = await db('select id from alugueis.contas limit 2');
  if (contas.rows.length !== 1) throw fail('O recebimento precisa de exatamente uma conta cadastrada.', 422);
  const categoria = await db(
    `select id from alugueis.categorias where nome = $1 and tipo = 'entrada' and natureza = 'casas'`,
    [CATEGORIA_ALUGUEL],
  );
  if (!categoria.rows[0]) throw fail(`Categoria "${CATEGORIA_ALUGUEL}" não encontrada.`, 422);

  // extrato não tem coluna de tipo e `detalhes` segue o formulário da categoria, então vai na descrição
  const { rows } = await db(
    `insert into alugueis.extrato (conta_id, categoria_id, data, valor, descricao, contrato_id, mes_referencia)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning id, contrato_id, data::text, valor, descricao, to_char(mes_referencia, 'YYYY-MM') as mes_referencia`,
    [
      contas.rows[0].id,
      categoria.rows[0].id,
      data,
      valor,
      [tipo, observacao].filter(Boolean).join(' · '),
      input?.contrato_id ?? null,
      `${mes}-01`,
    ],
  );
  if (comprovante) await vincular(rows[0].id, comprovante);
  return { ...rows[0], comprovante };
}

/** corrige contrato, data, valor, mês do aluguel ou descrição; só o que vier em `input` muda */
export async function updatePagamento(id, input) {
  const campos = [];
  const params = [id];
  const set = (coluna, valor) => {
    params.push(valor);
    campos.push(`${coluna} = $${params.length}`);
  };
  if (input?.contrato_id !== undefined) set('contrato_id', input.contrato_id); // o gatilho refaz o imóvel e confere o mês
  if (input?.data !== undefined) set('data', isoDate(input.data, 'data'));
  if (input?.valor !== undefined) set('valor', money(input.valor, 'valor'));
  if (input?.mes_referencia !== undefined) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.mes_referencia)) throw fail('mes_referencia deve ser AAAA-MM');
    set('mes_referencia', `${input.mes_referencia}-01`);
  }
  if (input?.descricao !== undefined) set('descricao', text(input.descricao, 'descricao', { required: false, max: 2000 }));
  if (!campos.length) throw fail('Nada para alterar.');

  const atual = await db(`select e.id ${PAGAMENTOS} where e.id = $1`, [id]);
  if (!atual.rows[0]) throw fail('Recebimento não encontrado.', 404);
  await db(`update alugueis.extrato set ${campos.join(', ')} where id = $1`, params);
  const { rows } = await db(`select ${COLUNAS_PAGAMENTO} ${PAGAMENTOS} where e.id = $1`, [id]);
  return rows[0];
}

/* ---------- resumo (Carnê-Leão) ---------- */

export async function resumoMensal(ano, mes) {
  const y = Number(ano);
  const m = Number(mes);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) throw fail('ano inválido');
  if (!Number.isInteger(m) || m < 1 || m > 12) throw fail('mês inválido');
  const start = `${y}-${String(m).padStart(2, '0')}-01`;
  const end = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;

  const { rows } = await db(
    `select i.apelido as imovel, coalesce(sum(e.valor), 0)::float8 as total, count(*)::int as qtd
     ${PAGAMENTOS}
     where e.data >= $1 and e.data < $2
     group by i.apelido order by total desc`,
    [start, end],
  );
  return {
    ano: y,
    mes: m,
    total: rows.reduce((acc, r) => acc + r.total, 0),
    qtd: rows.reduce((acc, r) => acc + r.qtd, 0),
    por_imovel: rows,
  };
}

/* ---------- HTTP ---------- */

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

export async function handleFinance(req, res, pathname, url) {
  try {
    const method = req.method;

    if (pathname === '/api/finance/imoveis' && method === 'GET') {
      return json(res, 200, { ok: true, imoveis: await listImoveis() });
    }
    if (pathname === '/api/finance/imoveis' && method === 'POST') {
      return json(res, 201, { ok: true, imovel: await createImovel(await readJson(req)) });
    }

    if (pathname === '/api/finance/inquilinos' && method === 'GET') {
      return json(res, 200, { ok: true, inquilinos: await listInquilinos() });
    }
    if (pathname === '/api/finance/inquilinos' && method === 'POST') {
      return json(res, 201, { ok: true, inquilino: await createInquilino(await readJson(req)) });
    }

    if (pathname === '/api/finance/imobiliarias' && method === 'GET') {
      return json(res, 200, { ok: true, imobiliarias: await listImobiliarias() });
    }

    if (pathname === '/api/finance/contratos' && method === 'GET') {
      return json(res, 200, { ok: true, contratos: await listContratos() });
    }
    if (pathname === '/api/finance/contratos' && method === 'POST') {
      return json(res, 201, { ok: true, contrato: await createContrato(await readJson(req)) });
    }

    if (pathname === '/api/finance/pagamentos' && method === 'GET') {
      const pagamentos = await listPagamentos({
        de: url.searchParams.get('de') ?? undefined,
        ate: url.searchParams.get('ate') ?? undefined,
        mes_referencia: url.searchParams.get('mes_referencia') ?? undefined,
        contrato_id: url.searchParams.get('contrato_id') ?? undefined,
        imovel_id: url.searchParams.get('imovel_id') ?? undefined,
        limit: url.searchParams.get('limit') ?? undefined,
      });
      const total = pagamentos.reduce((acc, p) => acc + Number(p.valor), 0);
      return json(res, 200, { ok: true, pagamentos, total });
    }
    if (pathname === '/api/finance/pagamentos' && method === 'POST') {
      return json(res, 201, { ok: true, pagamento: await createPagamento(await readJson(req)) });
    }

    const pagamentoId = /^\/api\/finance\/pagamentos\/([^/]+)$/.exec(pathname)?.[1];
    if (pagamentoId && method === 'PATCH') {
      return json(res, 200, { ok: true, pagamento: await updatePagamento(pagamentoId, await readJson(req)) });
    }

    if (pathname === '/api/finance/comprovantes' && method === 'POST') {
      return json(res, 201, { ok: true, ...(await anexarComprovante(await readJson(req))) });
    }

    if (pathname === '/api/finance/resumo' && method === 'GET') {
      const now = new Date();
      const ano = Number(url.searchParams.get('ano') || now.getFullYear());
      const mes = Number(url.searchParams.get('mes') || now.getMonth() + 1);
      return json(res, 200, { ok: true, resumo: await resumoMensal(ano, mes) });
    }

    return json(res, 404, { ok: false, error: `rota financeira desconhecida: ${method} ${pathname}` });
  } catch (err) {
    return json(res, err.status || 500, { ok: false, error: err.message || 'erro interno' });
  }
}

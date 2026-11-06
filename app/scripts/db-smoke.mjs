/**
 * db-smoke.mjs — valida Postgres + migrações + financeiro + lembretes.
 * Cria dados temporários, confere e limpa no final.
 * Uso: node scripts/db-smoke.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
try {
  process.loadEnvFile(path.join(HERE, '..', '.env'));
} catch {
  /* sem .env */
}

const { migrate, query } = await import('../server/db.mjs');
const finance = await import('../server/finance.mjs');
const reminders = await import('../server/reminders.mjs');

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(ok ? 'OK  ' : 'FAIL', name, extra);
  if (!ok) failures++;
};

try {
  const run = await migrate();
  console.log('migração:', JSON.stringify(run));
} catch (err) {
  console.error('ERRO na migração:', err.message);
  process.exit(1);
}

const stamp = Date.now();
let imovel;
let inquilino;
let contrato;
let pagamento;
let lembrete;

try {
  imovel = await finance.createImovel({
    apelido: `__smoke_${stamp}__`,
    logradouro: 'Rua Teste',
    numero: '1',
    bairro: 'Centro',
    cidade: 'Conchas',
    uf: 'sp',
    cep: '18570-000',
  });
  check('imovel criado', Boolean(imovel?.id), `id=${imovel?.id}`);

  const documento = String(stamp).padStart(11, '0').slice(-11);
  inquilino = await finance.createInquilino({ nome: `__smoke_${stamp}__`, documento });
  check('inquilino criado', Boolean(inquilino?.id), `id=${inquilino?.id}`);

  const novoContrato = {
    imovel_id: imovel.id,
    inquilino_id: inquilino.id,
    data_inicio: '2026-01-01',
    data_fim: '2026-12-31',
    dia_vencimento: 10,
    valor_aluguel: 1800,
  };
  contrato = await finance.createContrato(novoContrato);
  check('contrato criado', Boolean(contrato?.id), `id=${contrato?.id}`);

  const codigo = (p) => p.then(() => 0, (e) => e.status);
  check('documento duplicado (409)', (await codigo(finance.createInquilino({ nome: 'x', documento }))) === 409);
  check('contrato sobreposto (409)', (await codigo(finance.createContrato(novoContrato))) === 409);

  pagamento = await finance.createPagamento({
    contrato_id: contrato.id,
    data: '2026-10-15',
    valor: 1800,
    tipo: 'pix',
  });
  check('pagamento registrado', Boolean(pagamento?.id), `R$ ${pagamento?.valor}`);
  check('recebimento sem comprovante', pagamento?.comprovante === null);
  check('mês de referência vem da data', pagamento?.mes_referencia === '2026-10', pagamento?.mes_referencia);
  check(
    'mês fora do contrato (422)',
    (await codigo(finance.createPagamento({ contrato_id: contrato.id, data: '2027-03-01', valor: 1, tipo: 'pix' }))) === 422,
  );

  // regra do projeto: boleto NÃO é comprovante
  let rejeitou = false;
  try {
    await finance.createPagamento({ contrato_id: contrato.id, data: '2026-10-16', valor: 100, tipo: 'boleto' });
  } catch (e) {
    rejeitou = e.status === 422;
  }
  check('boleto rejeitado (422)', rejeitou);

  const caminho = `${finance.COMPROVANTES_DIR}/smoke/${Date.now()}.pdf`;
  const { store } = await import('../server/vault-api.mjs');
  check('comprovante inexistente (422)', (await codigo(finance.anexarComprovante({ pagamento_id: pagamento.id, comprovante: caminho }))) === 422);
  await store.write(caminho, Buffer.from('%PDF-'));
  await finance.anexarComprovante({ pagamento_id: pagamento.id, comprovante: caminho });
  const comComprovante = await finance.listPagamentos({ contrato_id: contrato.id });
  check('comprovante aparece na lista', comComprovante[0]?.comprovante === caminho);
  check(
    'comprovante repetido (409)',
    (await codigo(finance.createPagamento({ contrato_id: contrato.id, data: '2026-10-20', valor: 1, tipo: 'pix', comprovante: caminho }))) === 409,
  );
  check('recebimento recusado não grava', (await finance.listPagamentos({ contrato_id: contrato.id })).length === 1);
  check(
    'vínculo exige recebimento existente',
    await query(`insert into comprovantes (extrato_id, caminho) values (gen_random_uuid(), 'x')`).then(() => false, (e) => e.code === '23503'),
  );
  const outro = await finance.createPagamento({ contrato_id: contrato.id, data: '2026-10-21', valor: 1, tipo: 'pix' });
  const segundo = `${caminho}.pdf`;
  await store.write(segundo, Buffer.from('%PDF-'));
  await finance.anexarComprovante({ pagamento_id: outro.id, comprovante: segundo });
  await query('delete from alugueis.extrato where id = $1', [outro.id]);
  check('apagar o recebimento desfaz o vínculo', !(await finance.comprovanteVinculado(segundo)));
  await store.remove(segundo);
  await query('delete from comprovantes where caminho = $1', [caminho]);
  await store.remove(caminho);

  const editado = await finance.updatePagamento(pagamento.id, { valor: 1750.5, descricao: 'corrigido' });
  check('edição muda só o que veio', editado?.valor === 1750.5 && editado?.descricao === 'corrigido' && editado?.data === '2026-10-15');
  check('edição: mês fora do contrato (422)', (await codigo(finance.updatePagamento(pagamento.id, { mes_referencia: '2027-03' }))) === 422);
  check('edição: recebimento inexistente (404)', (await codigo(finance.updatePagamento(crypto.randomUUID(), { valor: 1 }))) === 404);
  check('edição: sem campos (400)', (await codigo(finance.updatePagamento(pagamento.id, {}))) === 400);
  await finance.updatePagamento(pagamento.id, { valor: 1800 });
  check('edição: contrato inexistente (404)', (await codigo(finance.updatePagamento(pagamento.id, { contrato_id: crypto.randomUUID() }))) === 404);
  const imovel2 = await finance.createImovel({ apelido: `__smoke2_${stamp}__`, logradouro: 'Rua', numero: '2', bairro: 'Centro', cidade: 'Conchas', uf: 'sp', cep: '18570-000' });
  const contrato2 = await finance.createContrato({ ...novoContrato, imovel_id: imovel2.id });
  const trocado = await finance.updatePagamento(pagamento.id, { contrato_id: contrato2.id });
  const imovelDoLancamento = (await query('select imovel_id from alugueis.extrato where id = $1', [pagamento.id])).rows[0].imovel_id;
  check('edição: troca de contrato refaz o imóvel', trocado?.contrato_id === contrato2.id && imovelDoLancamento === imovel2.id);
  await finance.updatePagamento(pagamento.id, { contrato_id: contrato.id });
  await query('delete from alugueis.contratos where id = $1', [contrato2.id]);
  await query('delete from alugueis.imoveis where id = $1', [imovel2.id]);

  const r = await finance.resumoMensal(2026, 10);
  check('resumo mensal soma >= 1800', Number(r.total) >= 1800, `total R$ ${r.total} (${r.qtd} pgto)`);

  check('contrato listado com status', (await finance.listContratos()).some((c) => c.id === contrato.id && c.status));
  check('imovel listado', (await finance.listImoveis()).some((i) => i.id === imovel.id));

  const lista = await finance.listPagamentos({ de: '2026-10-01', ate: '2026-10-31' });
  check('listar pagamentos no período', lista.some((p) => p.id === pagamento.id), `${lista.length} pgto no período`);

  lembrete = await reminders.createReminder({ texto: `__smoke_${stamp}__`, quando: '2030-01-01T09:00:00-03:00' });
  check('lembrete criado', lembrete?.id > 0, `id=${lembrete?.id}`);
  const pend = await reminders.listReminders({ status: 'pending' });
  check('lembrete pendente listado', pend.some((l) => l.id === lembrete.id));
  const cancelado = await reminders.cancelReminder(lembrete.id);
  check('lembrete cancelado', cancelado?.status === 'cancelled');
} finally {
  // limpeza (ordem por causa das chaves estrangeiras)
  if (pagamento?.id) await query('delete from alugueis.extrato where id = $1', [pagamento.id]).catch(() => {});
  if (contrato?.id) await query('delete from alugueis.contratos where id = $1', [contrato.id]).catch(() => {});
  if (inquilino?.id) await query('delete from alugueis.inquilinos where id = $1', [inquilino.id]).catch(() => {});
  if (imovel?.id) await query('delete from alugueis.imoveis where id = $1', [imovel.id]).catch(() => {});
  if (lembrete?.id) await query('delete from lembretes where id = $1', [lembrete.id]).catch(() => {});
  await query('select 1').catch(() => {});
}

process.exit(failures ? 1 : 0);

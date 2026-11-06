/**
 * db-smoke.mjs — valida Postgres + migrações + lembretes.
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
let lembrete;

try {
  lembrete = await reminders.createReminder({ texto: `__smoke_${stamp}__`, quando: '2030-01-01T09:00:00-03:00' });
  check('lembrete criado', lembrete?.id > 0, `id=${lembrete?.id}`);
  const pend = await reminders.listReminders({ status: 'pending' });
  check('lembrete pendente listado', pend.some((l) => l.id === lembrete.id));
  const cancelado = await reminders.cancelReminder(lembrete.id);
  check('lembrete cancelado', cancelado?.status === 'cancelled');
} finally {
  // limpeza
  if (lembrete?.id) await query('delete from lembretes where id = $1', [lembrete.id]).catch(() => {});
  await query('select 1').catch(() => {});
}

process.exit(failures ? 1 : 0);

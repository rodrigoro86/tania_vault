/**
 * db.mjs — conexão Postgres (pool), migrações e helpers de query.
 * DATABASE_URL no .env, ou as variáveis padrão PGHOST/PGUSER/PGPASSWORD/PGDATABASE/PGPORT
 * (o pg lê sozinho); PG_SSL=1 para exigir SSL; PG_POOL_MAX opcional.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// bigint e numeric viram number no JS (ids e valores)
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(HERE, 'migrations');

let pool = null;

export function dbConfigured() {
  return Boolean(process.env.DATABASE_URL || process.env.PGHOST);
}

export function getPool() {
  if (!pool) {
    if (!dbConfigured()) throw new Error('DATABASE_URL (ou PGHOST) não definida');
    pool = new pg.Pool({
      // vazio = o pg usa PGHOST/PGUSER/PGPASSWORD/PGDATABASE/PGPORT
      connectionString: process.env.DATABASE_URL || undefined,
      max: Number(process.env.PG_POOL_MAX || 10),
      ssl: process.env.PG_SSL === '1' ? { rejectUnauthorized: false } : undefined,
    });
    pool.on('error', (err) => console.error('db: erro no pool:', err.message));
  }
  return pool;
}

export async function query(text, params = []) {
  return getPool().query(text, params);
}

/** roda fn(client) dentro de uma transação (commit no fim, rollback em erro) */
export async function withTx(fn) {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** aplica as migrações de server/migrations/*.sql ainda não registradas */
export async function migrate() {
  if (!dbConfigured()) return { skipped: true, reason: 'DATABASE_URL ausente' };
  const db = getPool();
  await db.query(
    'create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())',
  );
  const files = (await fs.readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const applied = [];
  for (const file of files) {
    const done = await db.query('select 1 from schema_migrations where version = $1', [file]);
    if (done.rowCount) continue;
    const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    const client = await db.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into schema_migrations (version) values ($1)', [file]);
      await client.query('commit');
      applied.push(file);
      console.log('db: migration aplicada', file);
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  return { applied };
}

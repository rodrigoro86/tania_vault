/**
 * config-db.mjs — carrega as variáveis de configuração das integrações do
 * Postgres na subida do servidor (spec 2026-11-05-config-no-banco).
 *
 * Precedência: o banco vence o `.env`/env do processo; quando a linha não
 * existe, vale o env. A tabela `configuracoes` é criada pelo backend Rust
 * (migração `backend/migrations/101_configuracoes.sql`) — se ela ainda não
 * existe (42P01) ou qualquer query falhar, só loga: o servidor sobe com o .env.
 *
 * Segredos cifrados em AES-256-GCM, formato idêntico ao do Rust:
 * `"v1:" + base64(nonce12 ‖ ciphertext ‖ tag16)`, chave `TANIA_CONFIG_KEY`
 * = 32 bytes em base64.
 */
import crypto from 'node:crypto';

const PREFIX = 'v1:';

/** decifra um valor "v1:..."; chave errada, formato torto ou qualquer erro -> null */
export function decifrar(valor, keyB64) {
  try {
    if (typeof valor !== 'string' || !valor.startsWith(PREFIX)) return null;
    const key = Buffer.from(keyB64 ?? '', 'base64');
    if (key.length !== 32) return null;
    const raw = Buffer.from(valor.slice(PREFIX.length), 'base64');
    if (raw.length < 12 + 16) return null; // nonce + tag, no mínimo
    const nonce = raw.subarray(0, 12);
    const tag = raw.subarray(raw.length - 16);
    const ciphertext = raw.subarray(12, raw.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/**
 * lê `configuracoes` e grava cada linha em process.env. Devolve { aplicadas }.
 * `query` é injetável para testar sem banco (default: pool de db.mjs).
 */
export async function loadDbConfig({ query, key = process.env.TANIA_CONFIG_KEY } = {}) {
  const run = query ?? ((sql) => import('./db.mjs').then(({ getPool }) => getPool().query(sql)));

  let rows;
  try {
    // banco fora do ar não pode travar a subida: depois de 5 s segue com o .env
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout lendo configuracoes')), 5000).unref());
    rows = (await Promise.race([run('select chave, valor, segredo from configuracoes'), timeout])).rows ?? [];
  } catch (err) {
    if (err?.code === '42P01') return { aplicadas: 0 }; // tabela ainda não migrada pelo Rust
    console.error('config-db:', err?.message ?? err);
    return { aplicadas: 0 };
  }

  let aplicadas = 0;
  for (const row of rows) {
    const valor = row.segredo ? decifrar(row.valor, key) : row.valor;
    if (valor === null) {
      console.warn('config-db: não decifrou', row.chave);
      continue;
    }
    process.env[row.chave] = valor;
    aplicadas++;
  }
  if (aplicadas > 0) console.log(`config-db: ${aplicadas} variáveis do banco`);
  return { aplicadas };
}

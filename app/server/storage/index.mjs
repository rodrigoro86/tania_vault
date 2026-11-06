/**
 * index.mjs — fábrica do VaultStore (LocalFs | S3/MinIO) e instância única.
 * VAULT_STORAGE=rustfs|minio|s3 -> bucket S3; qualquer outro valor -> filesystem local.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalFsStore } from './local.mjs';
import { S3Store } from './s3.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** mesmo default do vault-api: três níveis acima de server/storage/ = raiz do projeto */
const LOCAL_ROOT = process.env.VAULT_ROOT || path.join(HERE, '..', '..', '..');

export { LocalFsStore, S3Store };

export function createStore(mode = process.env.VAULT_STORAGE) {
  const m = String(mode || 'local').toLowerCase();
  return m === 'rustfs' || m === 'minio' || m === 's3' ? new S3Store() : new LocalFsStore(LOCAL_ROOT);
}

export const store = createStore();

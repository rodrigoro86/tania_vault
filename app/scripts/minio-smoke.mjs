/**
 * minio-smoke.mjs — valida o VaultStore/MinIO de ponta a ponta.
 * Escreve um objeto temporário em _smoke/, lê de volta, lista, apaga.
 * Uso: node scripts/minio-smoke.mjs   (lê app/.env)
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { S3Store } from '../server/storage/s3.mjs';

try {
  process.loadEnvFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env'));
} catch {
  /* sem .env: usa o env do processo */
}

const store = new S3Store();
const key = `_smoke/tania-${Date.now()}.md`;
const text = `# smoke\n\nTania ${new Date().toISOString()}\n`;

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(ok ? 'OK  ' : 'FAIL', name, extra);
  if (!ok) failures++;
};

console.log('destino:', store.label);

try {
  await store.writeText(key, text);
  check('write', true);

  check('exists', await store.exists(key));

  const back = await store.readText(key);
  check('readText igual', back === text);

  const st = await store.stat(key);
  check('stat', st.size > 0, JSON.stringify(st));

  const keys = await store.listKeys('_smoke/');
  check('listKeys contém', keys.some((k) => k.key === key), `${keys.length} chave(s)`);

  await store.remove(key);
  check('remove', !(await store.exists(key)));
} catch (err) {
  failures++;
  console.error('ERRO:', err?.name || err?.Code || '', err?.message || err);
  if (err?.$metadata) console.error('meta:', JSON.stringify(err.$metadata));
  if (err?.name === 'SignatureDoesNotMatch') {
    console.error('DICA: RUSTFS_SECRET_KEY não confere. Access key e secret key costumam ser DIFERENTES;');
    console.error('      pegue o par correto no console do MinIO (Access Keys / Users).');
  }
  if (err?.name === 'NoSuchBucket') {
    console.error(`DICA: o bucket "${(process.env.RUSTFS_BUCKET || process.env.MINIO_BUCKET)}" não existe — crie no console do bucket.`);
  }
  if (err?.name === 'InvalidArgument' && /API port/i.test(err?.message || '')) {
    console.error('DICA: esse endpoint é o CONSOLE, não a API S3. Use o host/porta da API (ex.: s3.seudominio).');
  }
}

process.exit(failures ? 1 : 0);

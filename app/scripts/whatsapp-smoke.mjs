/**
 * whatsapp-smoke.mjs — simula o webhook da Evolution (sem enviar WhatsApp).
 * Prova o fluxo: apikey → whitelist → classificação "melhoria" → LLM → nota no MinIO.
 * Uso: node scripts/whatsapp-smoke.mjs   (EVOLUTION_DRY_RUN=1)
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

const HERE = path.dirname(fileURLToPath(import.meta.url));
try {
  process.loadEnvFile(path.join(HERE, '..', '.env'));
} catch {
  /* sem .env */
}
process.env.EVOLUTION_DRY_RUN = '1';

const { handleEvolutionWebhook } = await import('../server/whatsapp.mjs');
const { store } = await import('../server/vault-api.mjs');

const number = String(process.env.WHATSAPP_ALLOWED_NUMBERS || '').split(',')[0].replace(/\D/g, '');
if (!number) {
  console.error('FAIL: WHATSAPP_ALLOWED_NUMBERS vazio no .env');
  process.exit(1);
}

const id = `smoke-${Date.now()}`;
const payload = {
  event: 'messages.upsert',
  instance: process.env.EVOLUTION_INSTANCE,
  apikey: process.env.EVOLUTION_API_KEY,
  data: {
    key: { remoteJid: `${number}@s.whatsapp.net`, fromMe: false, id },
    message: { conversation: `escreva uma melhoria: exportar o relatório de testes em CSV (${id})` },
    messageType: 'conversation',
  },
};

const req = Readable.from([JSON.stringify(payload)]);
req.method = 'POST';
req.url = '/api/evolution/webhook';
req.headers = { 'content-type': 'application/json', apikey: process.env.EVOLUTION_API_KEY };

const res = {
  statusCode: 0,
  body: '',
  writeHead(code, headers) {
    this.statusCode = code;
    this.headers = headers || {};
  },
  end(body = '') {
    this.body += body;
  },
};

console.log('POST /api/evolution/webhook (apikey + número', number + ')');
await handleEvolutionWebhook(req, res);
console.log('resposta:', res.statusCode, res.body);

const before = new Set((await store.listKeys('03-Melhorias/')).map((k) => k.key));
let found = null;
for (let i = 0; i < 40 && !found; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const keys = (await store.listKeys('03-Melhorias/')).map((k) => k.key);
  found = keys.find((k) => !before.has(k)) ?? null;
  if (!found && keys.length && i === 39) found = keys[keys.length - 1];
}

if (!found) {
  console.error('FAIL: nenhuma nota em 03-Melhorias/ após 40s');
  process.exit(1);
}

console.log('\nOK   nota criada:', found);
console.log('----- conteúdo -----');
console.log(await store.readText(found));

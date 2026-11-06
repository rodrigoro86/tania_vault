/**
 * evolution.mjs — cliente mínimo da Evolution API (WhatsApp).
 * EVOLUTION_DRY_RUN=1 -> não envia, só loga (teste sem spam).
 */
/** remove aspas em volta (o env_file do Swarm entrega 'valor' literal) */
const clean = (v) => String(v ?? '').trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
const base = () => clean(process.env.EVOLUTION_URL).replace(/\/+$/, '');
const key = () => clean(process.env.EVOLUTION_INSTANCE_TOKEN) || clean(process.env.EVOLUTION_API_KEY);
export const instance = () => clean(process.env.EVOLUTION_INSTANCE) || 'tania';

/** baixa a mídia de uma mensagem recebida: { base64, mimetype, fileName } */
export async function getMedia(messageKey) {
  if (!base()) throw new Error('EVOLUTION_URL não configurada');
  const res = await fetch(`${base()}/chat/getBase64FromMediaMessage/${encodeURIComponent(instance())}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: key() },
    body: JSON.stringify({ message: { key: messageKey }, convertToMp4: false }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.base64) throw new Error(`Evolution ${res.status}: ${data?.message || 'mídia indisponível'}`);
  return data;
}

/** envia texto para um número (dígitos com DDI+DDD) */
export async function sendText(number, text) {
  if (process.env.EVOLUTION_DRY_RUN === '1') {
    console.log(`[evolution dry-run] -> ${number}: ${text}`);
    return { dryRun: true };
  }
  if (!base()) throw new Error('EVOLUTION_URL não configurada');
  const res = await fetch(`${base()}/message/sendText/${encodeURIComponent(instance())}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: key() },
    body: JSON.stringify({ number, text }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Evolution ${res.status}: ${data?.message || data?.error || res.statusText}`);
  return data;
}

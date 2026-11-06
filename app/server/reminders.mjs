/**
 * reminders.mjs — lembretes no Postgres + scheduler que envia no WhatsApp.
 */
import { query } from './db.mjs';
import { readJson } from './vault-api.mjs';

function fail(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

export async function listReminders({ status } = {}) {
  const { rows } = status
    ? await query('select * from lembretes where status = $1 order by quando', [status])
    : await query('select * from lembretes order by status, quando');
  return rows;
}

export async function createReminder(input) {
  const texto = String(input?.texto ?? '').trim();
  if (!texto) throw fail('texto é obrigatório');
  const quando = new Date(String(input?.quando ?? ''));
  if (Number.isNaN(quando.getTime())) throw fail('quando inválido (use ISO, ex.: 2026-11-01T09:00:00-03:00)');
  const recorrencia = input?.recorrencia ? String(input.recorrencia).slice(0, 40) : null;
  const canal = input?.canal ? String(input.canal).slice(0, 20) : 'whatsapp';
  const { rows } = await query(
    'insert into lembretes (texto, quando, recorrencia, canal) values ($1, $2, $3, $4) returning *',
    [texto, quando.toISOString(), recorrencia, canal],
  );
  return rows[0];
}

export async function cancelReminder(id) {
  const { rows } = await query("update lembretes set status = 'cancelled' where id = $1 returning *", [Number(id)]);
  if (!rows.length) throw fail('lembrete não encontrado', 404);
  return rows[0];
}

export async function dueReminders(now = new Date()) {
  const { rows } = await query(
    "select * from lembretes where status = 'pending' and quando <= $1 order by quando",
    [now.toISOString()],
  );
  return rows;
}

export async function markSent(id) {
  await query("update lembretes set status = 'sent' where id = $1", [Number(id)]);
}

let timer = null;

/** a cada 60s manda os lembretes vencidos para o número dono (whitelist[0]) */
export function startScheduler({ intervalMs = 60_000 } = {}) {
  if (timer) return timer;
  const tick = async () => {
    try {
      const due = await dueReminders();
      if (!due.length) return;
      const numero = String(process.env.WHATSAPP_ALLOWED_NUMBERS || '').split(',')[0].replace(/\D/g, '');
      if (!numero) return;
      const { sendText } = await import('./evolution.mjs');
      for (const r of due) {
        await sendText(numero, `⏰ ${r.texto}`);
        await markSent(r.id);
        console.log('reminders: enviado', r.id);
      }
    } catch (err) {
      console.error('reminders: erro no scheduler:', err.message);
    }
  };
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  console.log('reminders: scheduler ativo (cada', Math.round(intervalMs / 1000), 's)');
  return timer;
}

/* ---------- HTTP ---------- */

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

export async function handleReminders(req, res, pathname, url) {
  try {
    const method = req.method;

    if (pathname === '/api/reminders' && method === 'GET') {
      const status = url.searchParams.get('status') ?? undefined;
      return json(res, 200, { ok: true, lembretes: await listReminders({ status }) });
    }
    if (pathname === '/api/reminders' && method === 'POST') {
      return json(res, 201, { ok: true, lembrete: await createReminder(await readJson(req)) });
    }
    const cancel = /^\/api\/reminders\/(\d+)\/cancel$/.exec(pathname);
    if (cancel && method === 'POST') {
      return json(res, 200, { ok: true, lembrete: await cancelReminder(Number(cancel[1])) });
    }

    return json(res, 404, { ok: false, error: `rota de lembretes desconhecida: ${method} ${pathname}` });
  } catch (err) {
    return json(res, err.status || 500, { ok: false, error: err.message || 'erro interno' });
  }
}

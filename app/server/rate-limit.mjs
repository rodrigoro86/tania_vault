/**
 * rate-limit.mjs — janela fixa por IP, em memória (uso pessoal/VPN).
 * Protege a API contra abuso; o /login já tem o próprio bloqueio (auth.mjs).
 *
 * Config (opcional):
 *   RATE_LIMIT_MAX        requisições por janela (padrão 300)
 *   RATE_LIMIT_WINDOW_MS  janela em ms (padrão 60_000 = 1 min)
 */
export function createRateLimit({ windowMs, max, maxEntries = 10_000 } = {}) {
  const win = Number(process.env.RATE_LIMIT_WINDOW_MS || windowMs || 60_000);
  const cap = Number(process.env.RATE_LIMIT_MAX || max || 300);
  const hits = new Map(); // ip -> { count, reset }

  /** remove entradas vencidas (evita crescer sem limite) */
  function sweep(now) {
    for (const [ip, v] of hits) if (v.reset <= now) hits.delete(ip);
  }

  return function allow(ip) {
    const now = Date.now();
    const cur = hits.get(ip);
    if (!cur || cur.reset <= now) {
      if (hits.size >= maxEntries) sweep(now);
      hits.set(ip, { count: 1, reset: now + win });
      return true;
    }
    cur.count++;
    return cur.count <= cap;
  };
}

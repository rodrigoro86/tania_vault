/**
 * sw.js — service worker do PWA (instalar o site como app).
 *
 * Conservador de propósito (o site já sofreu com cache velho, ver CHANGELOG 0.2.0):
 *   - navegação (HTML): rede primeiro; offline cai no último index.html bom
 *     (leitura offline: o bundle tem as notas);
 *   - /assets/* (hash no nome, imutável): cache primeiro;
 *   - /api/*, /login, /logout, POSTs: nunca passam pelo cache;
 *   - /logout apaga o cache (o bundle guarda o texto das notas no aparelho).
 */
const CACHE = 'vault-v1';
const SHELL = '/__shell';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** mantém só os assets do index.html atual (builds antigos não acumulam) */
async function prune(html) {
  const keep = new Set([...html.matchAll(/\/assets\/[^"'\s)]+/g)].map((m) => m[0]));
  const cache = await caches.open(CACHE);
  for (const req of await cache.keys()) {
    const p = new URL(req.url).pathname;
    if (p.startsWith('/assets/') && !keep.has(p)) await cache.delete(req);
  }
}

async function navigate(request) {
  try {
    const res = await fetch(request);
    // só guarda o app de verdade (não a tela de login nem redirects)
    const type = res.headers.get('content-type') || '';
    if (res.ok && !res.redirected && type.includes('text/html')) {
      const html = await res.clone().text();
      if (html.includes('id="root"')) {
        const cache = await caches.open(CACHE);
        await cache.put(SHELL, new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
        prune(html);
      }
    }
    return res;
  } catch {
    const cached = await caches.match(SHELL);
    return (
      cached ||
      new Response('<!doctype html><meta charset="utf-8"><title>Vault offline</title><p style="font:16px system-ui;padding:24px">Sem conexão e nada guardado ainda. Abra o Vault online uma vez.</p>', {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    );
  }
}

async function asset(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (res.ok && !res.redirected) (await caches.open(CACHE)).put(request, res.clone());
  return res;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname === '/logout') {
    event.waitUntil(caches.delete(CACHE));
    return; // segue para a rede: o servidor apaga o cookie
  }
  if (url.pathname.startsWith('/api') || url.pathname === '/login') return;
  if (request.mode === 'navigate') return event.respondWith(navigate(request));
  if (url.pathname.startsWith('/assets/')) return event.respondWith(asset(request));
});

// Paridade backend Rust (proxy) vs Node legado: roda as mesmas rotas GET contra
// os dois e aponta divergências. Só GET — comparar não pode ter efeito colateral.
// Uso: node scripts/parity.mjs [NODE_URL] [RUST_URL]
//      PARITY_COOKIE=... para rotas que exigem auth.
import assert from 'node:assert';

const NODE = process.argv[2] ?? 'http://127.0.0.1:3101';
const RUST = process.argv[3] ?? 'http://127.0.0.1:3100';

const headers = {};
if (process.env.PARITY_COOKIE) headers.Cookie = process.env.PARITY_COOKIE;

// /api/health fica fora: os dois respondem de forma diferente por design.
const CASES = [
  { path: '/api/notes' },
  { path: '/api/agent/status' },
  { path: '/api/clickup/status' },
  { path: '/api/reminders' },
  { path: '/api/nao-existe' }, // rota inexistente: os dois devem 404 igual
];

async function get(url) {
  // redirect manual: um 302 do legado é uma diferença real, não algo a seguir.
  const res = await fetch(url, { redirect: 'manual', headers });
  return {
    status: res.status,
    type: res.headers.get('content-type') ?? '',
    body: await res.text(),
  };
}

// a ordem das listas do /api/notes não é contrato (o front reordena): Node usa localeCompare, Rust ordena por bytes
function normalize(data) {
  for (const k of ['notes', 'files']) if (Array.isArray(data?.[k])) data[k].sort((x, y) => (x.path < y.path ? -1 : 1));
  if (Array.isArray(data?.folders)) data.folders.sort();
  return data;
}

function motivo(a, b) {
  if (a.status !== b.status) return `status ${a.status} vs ${b.status}`;
  if (a.type.includes('json') && b.type.includes('json')) {
    try {
      assert.deepStrictEqual(normalize(JSON.parse(a.body)), normalize(JSON.parse(b.body)));
      return null;
    } catch (err) {
      return `JSON difere: ${err.message.replace(/\s+/g, ' ').slice(0, 120)}`;
    }
  }
  return a.body === b.body ? null : 'corpos diferentes (texto)';
}

// Rede caída de um lado só não invalida o outro: capturamos por separado.
async function attempt(url) {
  try {
    return await get(url);
  } catch (err) {
    return { error: err.message };
  }
}

let same = 0;
for (const { path } of CASES) {
  const a = await attempt(NODE + path);
  const b = await attempt(RUST + path);
  const reason = a.error ? `node: ${a.error}`
    : b.error ? `rust: ${b.error}`
    : motivo(a, b);

  if (reason) {
    console.log(`DIFF GET ${path}: ${reason}`);
  } else {
    same++;
    console.log(`OK   GET ${path}`);
  }
}

console.log(`${same}/${CASES.length} iguais`);
if (same !== CASES.length) process.exit(1);

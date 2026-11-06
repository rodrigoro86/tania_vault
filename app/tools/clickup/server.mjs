/**
 * server.mjs — servidor da tool ClickUp (Task 5).
 *
 * Roda:  node tools/clickup/server.mjs   (porta PORT, padrão 4100)
 *
 * Toda rota exige o header `x-tania-tool-secret` igual a TANIA_TOOL_SECRET
 * (comparação em tempo constante; tamanhos diferentes = falso), senão 401 JSON.
 *
 *   GET  /manifest.json   manifesto da tool (id, páginas, vínculos, config, prompt)
 *   POST /mcp             MCP (JSON-RPC 2.0): initialize, notifications/initialized, tools/list, tools/call
 *   GET  /api/status|tasks|dashboard|task/{id}   a API de antes, sem o prefixo /api/clickup
 *   GET  /ui/<pagina>     tarefas | painel | card  (HTML de dist/tools/clickup/)
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError } from './errors.mjs';

const VERSAO = '1.0.0';
const PAGINAS = new Set(['tarefas', 'painel', 'card']);

/** o texto que estava em agent.ts, com os nomes das funções MCP */
const PROMPT = [
  'ClickUp (SÓ LEITURA): clickup__clickup_tasks e clickup__clickup_task consultam tarefas suas e da equipe. Você não cria nem altera nada no',
  '  ClickUp; se pedirem, explique que a integração é só de leitura. Resumos podem virar nota (com plano), citando a URL das tarefas.',
].join('\n');

const MANIFESTO = {
  id: 'clickup',
  nome: 'ClickUp',
  icone: '✅',
  versao: VERSAO,
  paginas: [
    { id: 'tarefas', titulo: 'Tarefas' },
    { id: 'painel', titulo: 'Painel' },
  ],
  vinculos: [{ campo: 'clickup', pagina: 'card' }],
  config: [{ chave: 'CLICKUP_TOKEN', segredo: true, descricao: 'token da API v2 do ClickUp (pk_...)' }],
  prompt: PROMPT,
};

/** dist do front: app/dist/tools/clickup (troque com TANIA_TOOL_DIST em testes) */
const distDir = () => process.env.TANIA_TOOL_DIST || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'tools', 'clickup');

function segredoOk(req) {
  const want = process.env.TANIA_TOOL_SECRET || '';
  const got = req.headers['x-tania-tool-secret'];
  if (!want || typeof got !== 'string' || !got) return false;
  const a = Buffer.from(got, 'utf8');
  const b = Buffer.from(want, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function lerCorpo(req, limite = 200_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const partes = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limite) return reject(new ApiError(413, 'payload grande demais'));
      partes.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(partes).toString('utf8')));
    req.on('error', reject);
  });
}

/** exportado para os testes: devolve o servidor SEM ouvir a porta */
export function criarServidor() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://tool');
      const pathname = url.pathname;

      if (!segredoOk(req)) return json(res, 401, { ok: false, error: 'segredo da tool ausente ou incorreto' });

      if (pathname === '/manifest.json' && req.method === 'GET') return json(res, 200, MANIFESTO);

      if (pathname === '/mcp') {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'MCP é POST' });
        const { handleMcp } = await import('./mcp.ts');
        let body;
        try {
          body = JSON.parse(await lerCorpo(req));
        } catch {
          return json(res, 400, { ok: false, error: 'corpo não é JSON válido' });
        }
        const out = await handleMcp(body);
        if (out === null) {
          res.writeHead(202); // notifications/initialized: sem resposta
          return res.end();
        }
        return json(res, 200, out);
      }

      if (pathname.startsWith('/api/')) {
        // a API de hoje vive em handleClickUp sob /api/clickup/; aqui o prefixo é só /api/
        const { handleClickUp } = await import('./clickup.ts');
        return await handleClickUp(req, res, `/api/clickup/${pathname.slice('/api/'.length)}`);
      }

      if (pathname.startsWith('/ui/')) {
        const pagina = decodeURIComponent(pathname.slice('/ui/'.length));
        if (!PAGINAS.has(pagina)) return json(res, 404, { ok: false, error: `página desconhecida: ${pagina}` });
        const arquivo = path.join(distDir(), `${pagina}.html`);
        let html;
        try {
          html = await fs.readFile(arquivo);
        } catch {
          return json(res, 503, { ok: false, error: 'páginas da tool não construídas: rode npm run build' });
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(html);
      }

      return json(res, 404, { ok: false, error: `rota desconhecida: ${pathname}` });
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 500;
      json(res, status, { ok: false, error: err?.message || 'erro interno' });
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const porta = Number(process.env.PORT) || 4100;
  const server = criarServidor();
  server.listen(porta, () => console.log(`tool clickup na porta ${porta}`));
}

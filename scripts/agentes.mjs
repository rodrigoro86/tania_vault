#!/usr/bin/env node
// scripts/agentes.mjs — sincroniza agents/*.md ↔ 99-Meta/Agentes/Equipe/ e agents/tania/*.md ↔ 99-Meta/Agentes/Tania/.
// Node 24, sem dependências. Config em .env.agentes na raiz (TANIA_URL, TANIA_SESSAO).

import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import readline from 'node:readline';

const ARQUIVO_CONFIG = '.env.agentes';
const NOME_VALIDO = /^[A-Za-z0-9._-]+\.md$/;
// pasta local (relativa a agents/) ↔ pasta no vault; `rotulo` prefixa o nome no relatório
const PARES = [
  { local: '', remoto: '99-Meta/Agentes/Equipe/', rotulo: '' },
  { local: 'tania', remoto: '99-Meta/Agentes/Tania/', rotulo: 'tania/' },
];
const SESSAO_EXPIRADA = 'sessão expirada: rode node scripts/agentes.mjs login';

export function raizRepo() {
  return path.dirname(path.dirname(path.resolve(new URL(import.meta.url).pathname)));
}

function parseConfig(text) {
  const cfg = { url: '', sessao: '' };
  for (const linha of String(text).split(/\r?\n/)) {
    const m = linha.match(/^\s*(TANIA_URL|TANIA_SESSAO)\s*=\s*(.*)$/);
    if (m) {
      const valor = m[2].trim().replace(/^"|"$/g, '');
      if (m[1] === 'TANIA_URL') cfg.url = valor;
      else cfg.sessao = valor;
    }
  }
  return cfg;
}

export async function lerConfig(dir) {
  try {
    return parseConfig(await fs.promises.readFile(path.join(dir, ARQUIVO_CONFIG), 'utf8'));
  } catch {
    return { url: '', sessao: '' };
  }
}

export async function gravarConfig(dir, { url, sessao }) {
  const destino = path.join(dir, ARQUIVO_CONFIG);
  const conteudo = `TANIA_URL=${url}\nTANIA_SESSAO=${sessao}\n`;
  const fd = await fs.promises.open(destino, 'w', 0o600);
  try {
    await fd.writeFile(conteudo);
  } finally {
    await fd.close();
  }
  await fs.promises.chmod(destino, 0o600);
}

function base(url) {
  return String(url).replace(/\/+$/, '');
}

async function request(url, rota, sessao, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (sessao) headers.cookie = `vault_session=${sessao}`;

  let res;
  try {
    res = await fetch(`${base(url)}${rota}`, { redirect: 'manual', ...options, headers });
  } catch {
    throw new Error(`Tania fora do ar em ${base(url)}`);
  }

  if (res.status === 401) throw new Error(SESSAO_EXPIRADA);
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location') || '';
    if (location.includes('/login')) throw new Error(SESSAO_EXPIRADA);
  }

  if (!res.ok) {
    if (res.status === 409) return res;
    let detalhe = res.statusText;
    try {
      const body = await res.json();
      if (body && (body.error || body.message)) detalhe = body.error || body.message;
    } catch {
      /* corpo não é JSON */
    }
    throw new Error(`${res.status} ${detalhe}`);
  }
  return res;
}

export async function login({ url, user, password }) {
  let res;
  try {
    res = await fetch(`${base(url)}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ user, password }),
    });
  } catch {
    throw new Error(`Tania fora do ar em ${base(url)}`);
  }

  let cookies = [];
  try {
    cookies = res.headers.getSetCookie();
  } catch {
    cookies = res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : [];
  }

  for (const cookie of cookies) {
    const m = String(cookie).match(/vault_session=([^;]+)/);
    if (m && m[1]) return m[1];
  }
  throw new Error('login recusado');
}

export async function push({ url, sessao, agentsDir }) {
  const criados = [];
  const pulados = [];

  for (const par of PARES) {
    const dir = path.join(agentsDir, par.local);
    let nomes;
    try {
      nomes = await fs.promises.readdir(dir);
    } catch (err) {
      if (par.local) continue; // agents/tania é opcional
      throw new Error(`não li ${dir}: ${err.message}`);
    }
    for (const nome of nomes.sort()) {
      if (!NOME_VALIDO.test(nome)) continue;
      const content = await fs.promises.readFile(path.join(dir, nome), 'utf8');
      const res = await request(url, '/api/notes', sessao, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: `${par.remoto}${nome}`, content }),
      });
      (res.status === 409 ? pulados : criados).push(`${par.rotulo}${nome}`);
    }
  }

  return { criados, pulados };
}

export async function pull({ url, sessao, agentsDir }) {
  const res = await request(url, '/api/notes', sessao, { method: 'GET' });
  const body = await res.json().catch(() => null);
  const notes = Array.isArray(body?.notes) ? body.notes : [];

  const gravados = [];
  for (const note of notes) {
    const caminho = String(note?.path || '');
    const par = PARES.find((p) => caminho.startsWith(p.remoto));
    if (!par || typeof note.content !== 'string') continue;
    const nome = caminho.slice(par.remoto.length);
    if (!NOME_VALIDO.test(nome)) continue; // subpasta ou nome estranho: fora
    const dir = path.join(agentsDir, par.local);
    const destino = path.join(dir, nome);
    const atual = await fs.promises.readFile(destino, 'utf8').catch(() => null);
    if (atual === note.content) continue;
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(destino, note.content);
    gravados.push(`${par.rotulo}${nome}`);
  }
  return { gravados };
}

async function perguntarLogin(rl, config) {
  const defaultUrl = config.url || 'http://localhost:3000';
  const url = (await rl.question(`URL da Tania [${defaultUrl}]: `).catch(() => '')).trim() || defaultUrl;
  const user = (await rl.question('usuário: ').catch(() => '')).trim();

  const escrever = rl._writeToOutput;
  rl._writeToOutput = () => {};
  let password = '';
  try {
    password = await rl.question('senha: ');
  } finally {
    rl._writeToOutput = escrever;
  }
  return { url, user, password };
}

async function main(argv) {
  const comando = argv[2];
  const dir = raizRepo();
  const agentsDir = path.join(dir, 'agents');

  if (comando !== 'login' && comando !== 'push' && comando !== 'pull') {
    throw new Error('uso: node scripts/agentes.mjs login|push|pull');
  }

  if (comando === 'login') {
    const config = await lerConfig(dir);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let dados;
    try {
      dados = await perguntarLogin(rl, config);
    } finally {
      rl.close();
    }
    const sessao = await login(dados);
    await gravarConfig(dir, { url: dados.url, sessao });
    console.log(`sessão gravada em ${path.join(dir, ARQUIVO_CONFIG)} (modo 0600)`);
    return;
  }

  const { url, sessao } = await lerConfig(dir);
  if (!url) throw new Error(`sem TANIA_URL em ${path.join(dir, ARQUIVO_CONFIG)}: rode node scripts/agentes.mjs login`);
  if (!sessao) throw new Error(`sem TANIA_SESSAO em ${path.join(dir, ARQUIVO_CONFIG)}: rode node scripts/agentes.mjs login`);

  if (comando === 'push') {
    const { criados, pulados } = await push({ url, sessao, agentsDir });
    console.log(`push: ${criados.length} criados, ${pulados.length} já existiam`);
    for (const n of criados) console.log(`  criado ${n}`);
    for (const n of pulados) console.log(`  pulado ${n} (já existe, não sobrescrevo)`);
    return;
  }

  if (comando === 'pull') {
    const { gravados } = await pull({ url, sessao, agentsDir });
    console.log(`pull: ${gravados.length} alterados`);
    for (const n of gravados) console.log(`  ${n}`);
    return;
  }

  throw new Error('uso: node scripts/agentes.mjs login|push|pull');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv).catch((err) => {
    console.error(err.message || String(err));
    process.exitCode = 1;
  });
}

/**
 * agentes.test.mjs — agentes especializados da Tania (99-Meta/Agentes/Tania/*.md).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acharAgente, blocoAgentes, listarAgentes, PASTA_AGENTES } from '../agent/agentes.ts';

function storeFalso(arquivos) {
  return {
    async listKeys(prefix) {
      return Object.keys(arquivos).filter((k) => k.startsWith(prefix));
    },
    async readText(rel) {
      if (!(rel in arquivos)) throw new Error('não existe');
      return arquivos[rel];
    },
  };
}

test('listarAgentes: só .md direto na pasta, com nome válido e "quando"', async () => {
  const store = storeFalso({
    [`${PASTA_AGENTES}ideias.md`]: '---\nquando: ideias soltas\n---\n# Ideias\nGRAVE EM 05-Ideias\n',
    [`${PASTA_AGENTES}agenda.md`]: '---\ntype: meta\nquando: "o que fiz no dia"\n---\n# Agenda\nDIARIO\n',
    [`${PASTA_AGENTES}sem-fm.md`]: '# sem frontmatter\n',
    [`${PASTA_AGENTES}Maiuscula.md`]: '---\nquando: x\n---\n',
    [`${PASTA_AGENTES}sub/y.md`]: '---\nquando: y\n---\n',
    [`${PASTA_AGENTES}notas.txt`]: 'quando: z',
  });
  const lista = await listarAgentes(store);
  assert.deepEqual(lista.map((a) => a.nome), ['agenda', 'ideias']);
  assert.equal(lista[0].quando, 'o que fiz no dia');
  assert.match(lista[0].instrucoes, /^# Agenda\nDIARIO$/);
});

test('listarAgentes: aceita o formato do S3 ({key, size})', async () => {
  const s3 = {
    async listKeys() {
      return [{ key: `${PASTA_AGENTES}agenda.md`, size: 10 }];
    },
    async readText() {
      return '---\nquando: dia\n---\nok';
    },
  };
  assert.deepEqual((await listarAgentes(s3)).map((a) => a.nome), ['agenda']);
});

test('listarAgentes: pasta ausente ou store com erro → lista vazia', async () => {
  assert.deepEqual(await listarAgentes(storeFalso({})), []);
  const quebrado = { listKeys: async () => { throw new Error('bucket fora'); }, readText: async () => '' };
  assert.deepEqual(await listarAgentes(quebrado), []);
});

test('blocoAgentes e acharAgente', () => {
  const lista = [{ nome: 'agenda', quando: 'o que fiz', instrucoes: 'x' }];
  assert.deepEqual(blocoAgentes([]), []);
  const bloco = blocoAgentes(lista).join('\n');
  assert.match(bloco, /- agenda: o que fiz/);
  assert.match(bloco, /usar_agente/);
  assert.equal(acharAgente(lista, ' Agenda ')?.nome, 'agenda');
  assert.equal(acharAgente(lista, 'financeiro'), undefined);
});

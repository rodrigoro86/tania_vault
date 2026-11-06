import test from 'node:test';
import assert from 'node:assert/strict';
import { S3Store } from '../storage/s3.mjs';

/** S3 em memória: só os comandos que as pastas usam */
function fakeStore() {
  const store = new S3Store({ bucket: 'b', endpoint: 'http://s3.test' });
  const keys = new Set();
  store.client = {
    async send(cmd) {
      const { Key, Prefix = '', MaxKeys = 1000 } = cmd.input;
      const name = cmd.constructor.name;
      if (name === 'PutObjectCommand') return void keys.add(Key);
      if (name === 'DeleteObjectCommand') return void keys.delete(Key);
      const hits = [...keys].filter((k) => k.startsWith(Prefix)).sort().slice(0, MaxKeys);
      return { Contents: hits.map((k) => ({ Key: k, Size: 0 })), KeyCount: hits.length };
    },
  };
  return { store, keys };
}

test('mkdir cria pasta vazia que aparece na listagem sem virar arquivo', async () => {
  const { store } = fakeStore();
  await store.mkdir('00-Inbox/nova');
  assert.equal(await store.dirExists('00-Inbox/nova'), true);
  assert.equal(await store.isEmptyDir('00-Inbox/nova'), true);
  const { folders, notes, files } = await store.list();
  assert.deepEqual(folders, ['00-Inbox', '00-Inbox/nova']);
  assert.deepEqual([notes, files], [[], []]);
});

test('pasta com arquivo não é vazia; removeDir apaga o marcador', async () => {
  const { store, keys } = fakeStore();
  await store.mkdir('a/b');
  await store.write('a/b/foto.png', 'x');
  assert.equal(await store.isEmptyDir('a/b'), false);
  await store.removeDir('a/b');
  assert.equal(keys.size, 0);
  assert.equal(await store.dirExists('a/b'), false);
});

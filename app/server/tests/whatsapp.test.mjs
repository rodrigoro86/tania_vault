import test from 'node:test';
import assert from 'node:assert/strict';
import { comprovantePath, extractMedia, hojeSP, lembrar, senderNumber } from '../whatsapp.mjs';

test('senderNumber usa o número real quando o remoteJid é @lid', () => {
  const key = { remoteJid: '123456789012345@lid', remoteJidAlt: '5511999999999@s.whatsapp.net' };
  assert.equal(senderNumber(key), '5511999999999');
});

test('senderNumber usa o remoteJid quando já é o número', () => {
  assert.equal(senderNumber({ remoteJid: '5511999999999@s.whatsapp.net' }), '5511999999999');
});

test('senderNumber não aceita remoteJidAlt que não seja número de telefone', () => {
  const key = { remoteJid: '123456789012345@lid', remoteJidAlt: '999999999999999@lid' };
  assert.equal(senderNumber(key), '123456789012345');
});

test('extractMedia acha imagem, documento com legenda e mensagem temporária', () => {
  assert.deepEqual(extractMedia({ imageMessage: { mimetype: 'image/jpeg', caption: ' casa 2 ' } }), { mimetype: 'image/jpeg', caption: 'casa 2' });
  assert.equal(
    extractMedia({ documentWithCaptionMessage: { message: { documentMessage: { mimetype: 'application/pdf', caption: 'x' } } } }).mimetype,
    'application/pdf',
  );
  assert.equal(extractMedia({ ephemeralMessage: { message: { imageMessage: { mimetype: 'image/png; a=b' } } } }).mimetype, 'image/png');
  assert.equal(extractMedia({ conversation: 'oi' }), null);
});

test('comprovantePath separa por mês e limpa o id da mensagem', () => {
  assert.equal(comprovantePath('d', '../A1-b', 'application/pdf', '2026-10-31'), 'd/2026-10/2026-10-31-A1b.pdf');
});

test('hojeSP usa o dia de São Paulo, não o UTC', () => {
  assert.equal(hojeSP(new Date('2026-11-02T02:30:00Z')), '2026-11-01');
  assert.equal(hojeSP(new Date('2026-11-02T03:30:00Z')), '2026-11-02');
});

test('lembrar mantém só as 12 últimas mensagens, em ordem', () => {
  const c = { at: 0, history: [] };
  for (let i = 1; i <= 20; i++) lembrar(c, { role: 'user', content: String(i) });
  assert.deepEqual(c.history.map((m) => m.content), ['9', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20']);
  assert.ok(c.at > 0);
});

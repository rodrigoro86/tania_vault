/**
 * rules.test.mjs — schema tipado e regras do vault (server/agent/*.ts).
 *
 * Roda:  node --test server/tests/rules.test.mjs   (Node >= 22.18: type stripping)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { s, check } from '../agent/schema.ts';
import { parseFrontmatter, checkNote, checkPlan, planAllows, linkTargets, checkFile, wikilinks, retargetLinks } from '../agent/rules.ts';

const targets = linkTargets(['03-Comandos/Git/Git-status.md', 'Home.md', '03-Comandos/Git/Git-log.md']);

const commandNote = (extra = '') => `---
type: command
created: 2026-10-23
tags: [comando, comando/git]
status: active
tool: git
command: git log --oneline
confidence: high
${extra}---

# git log resumido

\`\`\`bash
git log --oneline -20
\`\`\`

Ver também [[Git-status]].
`;

test('schema: tipo, validação e JSON Schema da mesma definição', () => {
  const Args = s.object({ path: s.string({ min: 1 }), limit: s.optional(s.number({ max: 10 })), kind: s.oneOf(['a', 'b']) });
  assert.deepEqual(check(Args, { path: 'x', kind: 'a' }), { ok: true, value: { path: 'x', kind: 'a' } });

  const bad = check(Args, { path: '', limit: 50, kind: 'z', extra: 1 });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.issues, [
    'path: obrigatório',
    'limit: máximo 10',
    'kind: deve ser um de a | b (veio "z")',
    'extra: campo desconhecido',
  ]);

  const json = Args.json();
  assert.deepEqual(json.required, ['path', 'kind']);
  assert.deepEqual(json.properties.kind, { type: 'string', enum: ['a', 'b'] });
  assert.equal(json.additionalProperties, false);
});

test('frontmatter: listas inline e em bloco, aspas, comentários', () => {
  const fm = parseFrontmatter('---\ntype: "command"\ntags:\n  - comando\n  - comando/git\nstatus: active # comentário\nlista: [a, \'b\']\n---\n# T\n');
  assert.deepEqual(fm.data, { type: 'command', tags: ['comando', 'comando/git'], status: 'active', lista: ['a', 'b'] });
  assert.equal(fm.body, '# T\n');
  assert.equal(parseFrontmatter('# sem frontmatter'), null);
});

test('nota de comando válida passa', () => {
  const r = checkNote('03-Comandos/Git/Git-log.md', commandNote(), targets);
  assert.deepEqual(r.errors, []);
});

test('nota fora das regras: cada problema vira erro explicado', () => {
  const content = `---
type: command
created: 23/10/2026
tags: [shell, comando/git]
status: pronto
---

Sem título, sem bloco bash e com [[Nao-existe]].
`;
  const r = checkNote('02-Estudos/Nota com espaço.md', content, targets);
  const all = r.errors.join('\n');
  for (const expected of [
    /"Nota com espaço\.md" precisa ser ASCII/,
    /frontmatter\.created: data ISO/,
    /frontmatter\.status: deve ser um de/,
    /frontmatter\.tool: obrigatório/,
    /frontmatter\.confidence: obrigatório/,
    /tag "shell": raiz fora da lista oficial/,
    /falta o título H1/,
    /bloco ```bash/,
  ]) {
    assert.match(all, expected);
  }
  assert.ok(r.warnings.some((w) => w.includes('[[Nao-existe]] não existe')));
});

test('pasta é livre, fora do vault não; type x pasta é aviso', () => {
  const livre = checkNote('Minha-Pasta/X.md', commandNote(), targets);
  assert.deepEqual(livre.errors, []);
  assert.ok(livre.warnings.some((w) => /mora em 03-Comandos\//.test(w)));
  for (const p of ['app/X.md', '.obsidian/X.md', '01-Agenda/.oculta/X.md', 'AGENTS.md']) {
    assert.match(checkNote(p, commandNote(), targets).errors.join('\n'), /fora do vault/, p);
  }
  assert.match(checkFile('app/x.html', '<!doctype html>').errors.join('\n'), /fora do vault/);

  const warn = checkNote('03-Comandos/Git/Git-log.md', commandNote().replace('Ver também', 'Usei ontem. Ver também'), targets);
  assert.deepEqual(warn.errors, []);
  assert.ok(warn.warnings.some((w) => /data relativa/.test(w)));

  const extraTag = checkNote('03-Comandos/Git/Git-log.md', commandNote().replace('comando/git]', 'comando/kubectl]'), targets);
  assert.deepEqual(extraTag.errors, []);
  assert.ok(extraTag.warnings.some((w) => /lista fechada/.test(w)));
});

test('plano: valida pasta x type e libera só as ações aprovadas', () => {
  const plan = {
    summary: 'organiza o inbox',
    actions: [
      { action: 'move', path: '00-Inbox/Ideia.md', to: '03-Comandos/Git/Git-stash.md', type: 'command', reason: 'é um comando git' },
      { action: 'create', path: '02-Estudos/LLM/Tool-use.md', type: 'learning', reason: 'conceito novo' },
    ],
  };
  assert.deepEqual(checkPlan(plan), []);
  assert.ok(planAllows(plan, { action: 'move', path: '00-Inbox/Ideia.md', to: '03-Comandos/Git/Git-stash.md' }));
  assert.ok(!planAllows(plan, { action: 'move', path: '00-Inbox/Ideia.md', to: '03-Comandos/Outro.md' }));
  assert.ok(!planAllows(plan, { action: 'update', path: '02-Estudos/LLM/Tool-use.md' }));
  assert.ok(!planAllows(null, { action: 'create', path: '02-Estudos/LLM/Tool-use.md' }));

  const bad = checkPlan({
    summary: 'errado',
    actions: [
      { action: 'create', path: '03-Comandos/X.md', type: 'learning', reason: 'pasta errada' },
      { action: 'create', path: '00-Inbox/Y.md', reason: 'sem type' },
      { action: 'move', path: '00-Inbox/Z.md', type: 'command', reason: 'sem destino' },
    ],
  });
  assert.equal(bad.length, 2);
  assert.match(bad.join('\n'), /informe o "type"/);
  assert.match(bad.join('\n'), /move precisa de "to"/);
});

test('type x pasta não barra o plano', () => {
  const plan = (path) => ({ summary: 'projeto', actions: [{ action: 'create', path, type: 'project', reason: 'projeto com prazo' }] });
  assert.deepEqual(checkPlan(plan('04-Projetos/Front-mobile.md')), []);
  assert.deepEqual(checkPlan(plan('01-Agenda/Front-mobile.md')), []);
});

test('ideia fora de 05-Ideias só gera aviso', () => {
  const note = (path) => `---\ntype: idea\ncreated: 2026-10-24\ntags: [ideia]\nstatus: draft\n---\n\n# E se o vault falasse\n\nLigada a [[Home]].\n`;
  assert.deepEqual(checkNote('05-Ideias/E-se-o-vault-falasse.md', note(), targets).errors, []);
  assert.deepEqual(checkNote('00-Inbox/E-se-o-vault-falasse.md', note(), targets).errors, []);
  assert.match(checkNote('00-Inbox/E-se-o-vault-falasse.md', note(), targets).warnings.join('\n'), /type "idea" mora em 05-Ideias\//);
});

test('arquivos do agente: HTML/SVG em qualquer pasta, avisos de recurso local', () => {
  const ok = checkFile('99-Meta/attachments/Apresentacoes/Deck.html', '<!doctype html><html><script src="https://cdn.x/r.js"></script></html>');
  assert.deepEqual(ok, { errors: [], warnings: [] });

  assert.deepEqual(checkFile('99-Meta/attachments/Logo.html', '<!doctype html><img src="/brand/logo.png">').warnings, [], '/brand é público');
  const local = checkFile('99-Meta/attachments/Deck.html', '<!doctype html><img src="foto.png"><link href="http://x/a.css">');
  assert.deepEqual(local.errors, []);
  assert.match(local.warnings.join('\n'), /recursos locais não carregam.*foto\.png/);
  assert.match(local.warnings.join('\n'), /http:\/\//);

  assert.match(checkFile('99-Meta/attachments/d.svg', '<html></html>').errors.join('\n'), /<svg>/);
  assert.deepEqual(checkFile('02-Estudos/d.html', '<!doctype html>').errors, []);
  assert.match(checkFile('99-Meta/attachments/d.js', 'x').errors.join('\n'), /só cria/);

  // embed de anexo conta como link existente
  const t = linkTargets(['99-Meta/attachments/Apresentacoes/Deck.html', 'Home.md']);
  assert.ok(t.has('deck.html') && t.has('home') && !t.has('deck'));
});

test('wikilinks dentro de código são exemplo, não link', () => {
  assert.deepEqual(wikilinks('Ver [[Git]].\n\n```markdown\n![[deck.html]]\n```\n\nE `[[inline]]`.'), ['Git']);
});

test('diário: um arquivo por dia em 01-Agenda (tag agenda/diario)', () => {
  const dia = '---\ntype: journal\ncreated: 2026-11-01\ntags: [agenda/diario]\nstatus: open\n---\n\n# 2026-11-01\n\n- feito\n';
  assert.deepEqual(checkNote('01-Agenda/2026-11-01.md', dia, targets).errors, []);
  for (const p of ['01-Agenda/2026-11-01-Reuniao.md', '01-Agenda/Reuniao.md', '01-Agenda/2026/2026-11-01.md', 'Outra/2026-11-01.md']) {
    assert.match(checkNote(p, dia, targets).errors.join('\n'), /um arquivo por dia/, p);
  }
  // outras notas da agenda (relatório, reunião) não são o diário: nome livre
  const relatorio = dia.replace('agenda/diario', 'agenda/revisao');
  assert.deepEqual(checkNote('01-Agenda/2026-11-01-Relatorio.md', relatorio, targets).errors, []);
});

test('tipos do ambiente de teste: cada um sugere a sua pasta', () => {
  const nota = (type, tag) => `---\ntype: ${type}\ncreated: 2026-11-01\ntags: [${tag}]\nstatus: open\n---\n\n# Nota\n`;
  for (const [type, tag, pasta] of [['test', 'teste', '02-Testes'], ['improvement', 'melhoria', '03-Melhorias'], ['spec', 'especificacao', '04-Especificacoes'], ['doc', 'documentacao', '05-Documentacao']]) {
    const ok = checkNote(`${pasta}/Login/x.md`, nota(type, tag), targets);
    assert.deepEqual(ok.errors, [], type);
    assert.ok(!ok.warnings.some((w) => /mora em/.test(w)), type);
    assert.ok(checkNote('Outra/x.md', nota(type, tag), targets).warnings.some((w) => w.includes(`mora em ${pasta}/`)), type);
  }
});

test('tópicos: subpastas seguem valendo para o type', () => {
  const ideia = '---\ntype: idea\ncreated: 2026-11-01\ntags: [ideia]\nstatus: draft\n---\n\n# Reformar a casa\n';
  const r = checkNote('05-Ideias/Casa/Reformar-a-casa.md', ideia, targets);
  assert.deepEqual(r.errors, []);
  assert.ok(!r.warnings.some((w) => /mora em/.test(w)));
});

test('retargetLinks reaponta caminho e nome, sem tocar em nome parecido', () => {
  const from = '00-Inbox/Git.md';
  assert.equal(retargetLinks('[[00-Inbox/Git|o git]] e ![[00-Inbox/Git.md#a]]', from, '03-Comandos/Git.md'), '[[03-Comandos/Git|o git]] e ![[03-Comandos/Git#a]]');
  assert.equal(retargetLinks('[[Git]] [[Gitlab]]', from, '03-Comandos/Git.md'), '[[Git]] [[Gitlab]]', 'link por nome segue valendo');
  assert.equal(retargetLinks('[[Git]] [[Gitlab]]', from, '03-Comandos/Git-basico.md'), '[[Git-basico]] [[Gitlab]]');
});

# Agentes no vault — Implementation Plan

> Execução: Strata implementa a T1 (prompt em `.strata/tasks/AGV-T1-script.md`); Claude Code faz T2–T3, revisa e testa.

**Goal:** instruções dos agentes (Tania e equipe de dev) editáveis pelo front, com o vault de produção como fonte.
**Spec:** `docs/superpowers/specs/2026-11-06-agentes-no-vault-design.md`

## Global Constraints
- Sem dependência nova. Node 24 (`node:test`, `fetch`, `readline`). Testes rodam no container `node:24-alpine`.
- Senha nunca gravada; sessão só em `.env.agentes` (fora do Git por `.env*`).
- `pull` nunca apaga arquivos de `agents/`; `push` nunca sobrescreve (409 = pula).

## Review Focus
1. Sessão expirada (401 ou redirect para /login): erro "sessão expirada: rode login", sem gravar nada (T1).
2. Nota com nome estranho (`../x.md`, subpasta, sem `.md`): ignorada pelo pull (T1).
3. Tania fora do ar: erro claro, exit ≠ 0, nada local muda (T1).
4. `Tania.md` ausente ou o vault sem a pasta: agente segue igual, painel mostra a dica de `push` (T2, T3).

### Task 1 (Strata): `scripts/agentes.mjs` + `scripts/tests/agentes.test.mjs`
Funções exportadas para teste (o CLI só roda quando executado direto):
`lerConfig(dir) -> {url, sessao}`, `gravarConfig(dir, {url, sessao})`, `login({url, user, password}) -> sessao`,
`push({url, sessao, agentsDir}) -> {criados: string[], pulados: string[]}`, `pull({url, sessao, agentsDir}) -> {gravados: string[]}`.
Testes com servidor `node:http` falso: os 4 itens da Review Focus que são da T1, login (cookie gravado, senha ausente do arquivo),
push (cria 2, pula 1 com 409), pull (grava `Equipe/a.md`, ignora `Equipe/sub/b.md`, `Outra/c.md`, `Equipe/../d.md`, mantém `agents/x.txt`).
Script `test` em `package.json` da raiz? Não há: rodar com `node --test scripts/tests/`.

### Task 2 (Claude): agente lê `99-Meta/Agentes/Tania.md`
`systemPrompt` em `app/server/agent.ts`: terceiro `readOptional`; bloco só se não vazio. Teste em `app/server/tests/agent.test.mjs`.

### Task 3 (Claude): painel 🤖 Agents com "Instruções" + docs
`AgentsPane` (`app/src/components/Sidebar.tsx`): links das notas `99-Meta/Agentes/**` (Tania primeiro). `agents/README.md`,
`AGENTS.md` §2/§4 e CHANGELOGs: fonte de verdade no vault, `pull` antes de delegar.

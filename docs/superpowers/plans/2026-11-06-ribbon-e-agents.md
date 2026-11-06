# Plano: menu em faixa de ícones e Agents (F2e)

Spec: `docs/superpowers/specs/2026-11-06-ribbon-e-agents-design.md`. O Strata codifica e o Claude revisa e testa.

| # | Tarefa | Arquivos |
|---|---|---|
| T1 | Rust: migração 102, validação, `GET`/`PUT /api/agents` e testes | `backend/migrations/102_*`, `backend/src/agents/`, `db/mod.rs`, `http/mod.rs`, `lib.rs`, `tests/agents_api.rs` |
| T2 | Node: `loadConfig`/`setActive` com o banco | `app/server/agent.ts`, `app/server/tests/agent.test.mjs` |
| T3 | Front: faixa de ícones e vistas | `app/src/components/{Ribbon,Sidebar}.tsx`, `styles.css` |
| T4 | Front: tela `/agentes` | `app/src/components/Agents.tsx`, `api.ts`, `App.tsx` |
| T5 | Claude: docs (SPEC, AGENTS, README, CHANGELOG) e ponta a ponta | — |

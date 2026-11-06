# Plano: configuração no banco (F2d)

Spec: `docs/superpowers/specs/2026-11-05-config-no-banco-design.md`. O Strata codifica e o Claude revisa e testa, como na F2c.

| # | Tarefa | Arquivos |
|---|---|---|
| T1 | Migração, lista de chaves, cifra e repositório | `backend/migrations/101_*.sql`, `backend/src/settings/{mod,keys,crypto,repo}.rs`, `db/mod.rs` |
| T2 | Rotas `/api/config`, carga do rate limit na subida, restart | `backend/src/settings/routes.rs`, `http/mod.rs`, `main.rs`, `tests/settings_api.rs` |
| T3 | Node: `config-db.mjs`, chamada no `server.mjs` e `/api/internal/restart` | `app/server/config-db.mjs`, `server.mjs`, `auth.mjs`, `tests/config-db.test.mjs` |
| T4 | Front: tela de Configurações, abas e ⚙ | `app/src/api.ts`, `components/Settings.tsx`, `Users.tsx`, `UserMenu.tsx`, `App.tsx` |
| T5 | Claude: compose, docs e ponta a ponta | `docker-compose.yml`, SPEC, AGENTS, README, CHANGELOG, `.env.example` |

# Plano: usuários e tokens (F2c)

Spec: `docs/superpowers/specs/2026-11-05-usuarios-tokens-design.md`.
Execução: o Strata codificou cada tarefa a partir de um prompt próprio (histórico removido na limpeza). Depois de cada uma, o Claude revisa o diff
e roda `cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test` (e `npm test` no Docker com
node:24, quando a tarefa mexe no Node ou no front). O Postgres de teste é o container `tania-pg-test` na porta 5433, com
`TEST_DATABASE_URL`.

| # | Tarefa | Arquivos |
|---|---|---|
| T1 | Deps, pool e migrador; `100_usuarios.sql` | `backend/Cargo.toml`, `backend/src/db/`, `backend/migrations/`, `backend/tests/db.rs` |
| T2 | Senha (argon2), token, validações e repositório de usuários e sessões | `backend/src/users/{password,token,repo}.rs`, `backend/tests/users_repo.rs` |
| T3 | Portão por sessão no banco, sem `VAULT_AUTH`; bootstrap do admin; headers para o Node | `backend/src/{config,main}.rs`, `backend/src/http/{auth,mod,proxy}.rs`, testes de auth |
| T4 | Rotas `/api/auth/*` e `/api/users` | `backend/src/users/routes.rs`, `backend/tests/users_api.rs` |
| T5 | CLI `tania user add` | `backend/src/main.rs` |
| T6 | Node: bypass por `LEGACY_PROXY_SECRET` + teste | `app/server/auth.mjs`, `app/server/tests/auth.test.mjs` |
| T7 | Front: `usersApi`, `Users.tsx`, rota e menu | `app/src/api.ts`, `app/src/components/Users.tsx`, `App.tsx`, `Sidebar.tsx` |
| T8 | Claude: compose, README, `.env.example`, SPEC, AGENTS, CHANGELOG; ponta a ponta no compose | docs + infra |

Cada tarefa vira um commit na branch `feat/backend-rust-users`.

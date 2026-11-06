# agent-data — Postgres + lembretes + investimentos

**Papel:** dono dos dados estruturados: schema Postgres e endpoints de lembretes
e investimentos. O financeiro saiu da spec (SPEC §12).

## Dono de
- `app/server/db.*` (pool/query)
- migrations do schema
- `app/server/reminders.mjs`
- `app/server/investimentos*.mjs`

## Fornece (contrato)
- Schema (SPEC §7.6, §13): `lembretes` e o schema `investimentos`.
- Endpoints: `/api/reminders/*` e `/api/investimentos/*`.

## Consome
- Env: `DATABASE_URL`.
- Driver: `pg` (+ migrations, ex.: `node-pg-migrate` ou Drizzle).

## Faz
- Aplicar as migrações (com índices).
- CRUD de lembretes (`status: pending|sent|cancelled`, `canal`, `recorrencia`).
- Expor os endpoints para o agent-backend criar as tools.

## NÃO faz
- Mexer no `VaultStore`.
- Tratar o webhook da Evolution (só expõe a API que ele consome).
- Fazer UI (só expõe endpoints; as telas são do agent-frontend).

## Pronto quando
- Lembretes criados/listados/cancelados via API.
- `npm test` verde (testes de lembretes/investimentos).

# agent-data — Postgres + financeiro + lembretes

**Papel:** dono dos dados estruturados: schema Postgres e endpoints de financeiro
(aluguéis/Carnê-Leão) e lembretes.

## Dono de
- `app/server/db.*` (pool/query)
- migrations do schema
- `app/server/finance.ts`
- `app/server/reminders.ts`

## Fornece (contrato)
- Schema (PLANO §5): `imoveis`, `inquilinos`, `contratos`, `pagamentos`, `lembretes`.
- Endpoints: `/api/finance/*` (imoveis, inquilinos, contratos, pagamentos, `resumo` mensal) e `/api/reminders/*`.

## Consome
- Env: `DATABASE_URL`.
- Driver: `pg` (+ migrations, ex.: `node-pg-migrate` ou Drizzle).

## Faz
- Aplicar o schema §5 (com índices).
- CRUD de imóveis/inquilinos/contratos/pagamentos.
- `resumo mensal` via SQL (`select sum(valor) from pagamentos where data between ...`).
- Regras de negócio: **boleto ≠ comprovante** (não lança pagamento de boleto), sem acesso bancário.
- CRUD de lembretes (`status: pending|sent|cancelled`, `canal`, `recorrencia`).
- Expor os endpoints para o agent-backend criar as tools e o agent-evolution registrar pagamento por mensagem.

## NÃO faz
- Mexer no `VaultStore`.
- Tratar o webhook da Evolution (só expõe a API que ele consome).
- Fazer UI (só expõe endpoints; as telas são do agent-frontend).

## Pronto quando
- Registrar pagamento e responder "quanto recebi em outubro?" lendo do Postgres.
- Lembretes criados/listados/cancelados via API.
- `npm test` verde (testes de financeiro/lembretes).

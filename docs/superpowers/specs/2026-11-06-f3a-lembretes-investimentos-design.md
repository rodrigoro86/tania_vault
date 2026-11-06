# F3a — Lembretes e investimentos (rotas simples) no backend Rust

Etapa da migração strangler (README, "Migração para Rust"). O Rust passa a atender, direto no Postgres, as rotas
abaixo; o resto continua no Node pelo `fallback(proxy)` de cada `MethodRouter`. Contrato JSON idêntico ao Node.

## No Rust (novo)

| Rota | Resposta |
|---|---|
| `GET /api/reminders?status=` | `{ok, lembretes}`; sem status: `order by status, quando`; com: `where status = $1 order by quando` |
| `POST /api/reminders` `{texto, quando, recorrencia?, canal?}` | 201 `{ok, lembrete}`; texto vazio → 400 "texto é obrigatório"; quando não ISO → 400 "quando inválido (use ISO, ex.: 2026-11-01T09:00:00-03:00)"; recorrencia ≤ 40 chars, canal ≤ 20 (padrão `whatsapp`) |
| `POST /api/reminders/{id}/cancel` | `{ok, lembrete}` com status `cancelled`; inexistente → 404 "lembrete não encontrado" |
| `GET /api/investimentos/movimentos?carteira=` | `{ok, movimentos}` (padrão `real`), `order by data, id` |
| `DELETE /api/investimentos/movimentos/{id}` | `{ok}`; só carteira `real`; senão 404 "movimento não encontrado" |
| `GET /api/investimentos/ordens` | `{ok, ordens}` (100 mais recentes) |
| `GET /api/investimentos/analises?tipo=` | `{ok, analises}` (30) |
| `GET/POST /api/investimentos/alertas`, `DELETE …/alertas/{id}` | como o Node (POST valida ticker B3, tipo e valor > 0; DELETE desativa) |
| `GET /api/investimentos/acompanhadas`, `DELETE …/acompanhadas/{ticker}` | como o Node (`variacao_30d` calculada no SQL) |
| `GET /api/investimentos/relatorios` | `{ok, relatorios}` (30) |

Qualquer usuário logado (sem exigir admin), como no Node. Sem banco → 503 "banco não configurado".

## Continua no Node

- Agendadores: envio de lembretes no WhatsApp (F4) e rotinas de investimentos (F5, usam LLM).
- `GET /api/investimentos/resumo`, `POST …/movimentos` (precisam do cálculo da carteira), `POST …/acompanhadas` (brapi),
  `POST …/relatorios` (LLM): vão na F3b.
- **Financeiro** (`/api/finance/*`): o schema `alugueis` é do `api_assistente_alugueis` e não existe localmente (só stub),
  então não dá para testar. Fica para quando o schema real estiver num banco de teste.
- As tools do agente seguem chamando os módulos Node direto.

## Formato do JSON

O Postgres monta o JSON (`row_to_json`/`json_agg`), então `bigint`/`numeric` saem como número, igual ao Node.
`timestamptz` sai como ISO UTC com milissegundos (`2026-11-01T12:00:00.000Z`), igual ao `JSON.stringify(Date)`.
`date` sai `AAAA-MM-DD`. Única diferença: `alertas.ultimo_envio` (o Node mandava um `Date` à meia-noite local); nenhuma tela usa.

## Diferenças conhecidas para o Node

- `quando` aceita só ISO 8601 com fuso (RFC 3339); o `new Date()` do Node aceitava também data sem hora ou sem fuso.
- Id não numérico em `/api/reminders/{id}/cancel` e nos `DELETE …/{id}` responde 400 (rejeição do axum) em vez de 404.

## Testes

Banco de teste (`TEST_DATABASE_URL`) com as migrações Node `001`, `003` e `004` aplicadas pelo teste, registradas em
`schema_migrations` como o Node faz.

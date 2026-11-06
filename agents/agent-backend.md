# agent-backend — API + agente (server.mjs, vault-api.mjs, agent.ts)

**Papel:** manter a API REST e o agente LLM funcionando sobre o `VaultStore`,
preservando auth/CSRF/sanitize e as tools existentes.

## Dono de
- `app/server/server.mjs`
- `app/server/vault-api.mjs`
- `app/server/agent.ts`
- `app/server/agent/*` (schema, rules, context, edits)

## Consome
- `VaultStore` (só a interface — nunca o estado interno do storage).
- Contrato de rotas em `SPEC.md §8` / `PLANO-ADAPTACAO.md`.
- Endpoints do agent-data (`/api/finance/*`, `/api/reminders/*`) como consumidor, na Fase 2.

## Faz
- Substituir `fs` por `store` nas tools e rotas (mantendo `sanitize`, `SKIP_DIRS`).
- Manter `/api/health`, `/api/notes|folders|files|rename`, `/api/agent/*`.
- Adicionar novas tools do agente quando o agent-data expuser endpoints (registrar pagamento, consultas, lembretes).
- Manter o fluxo `propose_plan → escrita`, com o plano visível no terminal e a validação de regras (`AGENTS.md` do vault).

## NÃO faz
- Mexer na implementação do storage (`app/server/storage/`).
- Criar o schema Postgres nem os endpoints financeiros (é do agent-data).
- Tratar o webhook da Evolution (é do agent-evolution).

## Pronto quando
- `/api/*` funciona sobre o `VaultStore` (local e MinIO).
- Tools do agente continuam validando e escrevendo corretamente.
- `npm test` verde.

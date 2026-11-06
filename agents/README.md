# Agentes — equipe de desenvolvimento do Tania_Assistente

Esta pasta contém **um arquivo por agente**, cada um autocontido (dá para usar
direto como prompt de delegação). A carta-mestra está em [`../AGENTS.md`](../AGENTS.md).

## Índice

| Agente | Arquivo | Dono de | Fase |
|---|---|---|---|
| agent-spec | [`agent-spec.md`](agent-spec.md) | SPEC, PLANO, AGENTS | todas |
| agent-storage | [`agent-storage.md`](agent-storage.md) | `app/server/storage/` | 1 |
| agent-backend | [`agent-backend.md`](agent-backend.md) | `server.mjs`, `vault-api.mjs`, `agent.ts` | 1–2 |
| agent-data | [`agent-data.md`](agent-data.md) | Postgres + financeiro + lembretes | 2 |
| agent-evolution | [`agent-evolution.md`](agent-evolution.md) | WhatsApp webhook + scheduler | 3 |
| agent-frontend | [`agent-frontend.md`](agent-frontend.md) | `app/src/` | 2 |
| agent-reviewer | [`agent-reviewer.md`](agent-reviewer.md) | (transversal) testes + sync gate | todas |

## Como usar

1. Para delegar uma fase, use o arquivo do agente dono como prompt (ex.: Fase 1 →
   `agent-storage.md`).
2. Ao terminar a fase, rode o `agent-reviewer.md` (sync gate) antes de marcar como pronta.
3. Registro de modelos no harness: [`../agents.patch.yml`](../agents.patch.yml).

## Regra de ouro (vale para todos)

Mudou contrato compartilhado (endpoint, schema, env var, assinatura do `VaultStore`,
gatilho)? Atualize **na mesma entrega**: código + `SPEC.md §8` + `PLANO-ADAPTACAO.md`
+ `AGENTS.md §3`. Nunca fica metade.

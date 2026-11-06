---
type: project
created: 2026-10-31
tags: [projeto/tania, agents, processo]
status: open
---

# AGENTS.md — Equipe de agentes e protocolo de sincronização

Define **quem é dono de quê** no projeto Tania_Assistente e as regras para que
**SPEC ↔ código ↔ infra** nunca fiquem dessincronizados.

## 1. Fontes de verdade (hierarquia)

| Arquivo | Significado | Agente dono |
|---|---|---|
| `SPEC.md` | O QUÊ e COMO (requisitos, arquitetura, FR/NFR, schema, env, fases) | agent-spec |
| `AGENTS.md` (este) | QUEM (papéis, donos, contratos) + regras de sync | agent-spec |
| `app/` | Implementação | agent-frontend / backend / storage / data / evolution |

> **Regra de ouro:** quando um contrato compartilhado muda (endpoint, schema,
> env var, assinatura do `VaultStore`), a mudança é feita **junto** no código E
> nos docs (`SPEC.md` + `AGENTS.md`). Nunca fica metade.

## 2. Papéis (cada agente é dono de arquivos e NÃO invade o dos outros)

| Agente | Dono de | Responsável por | Não mexe em |
|---|---|---|---|
| **agent-spec** | `SPEC.md`, `AGENTS.md` | manter docs = decisões travadas; registrar mudanças de contrato | código em `app/` |
| **agent-storage** | `app/server/storage/` | `VaultStore`: `LocalFsStore` + `S3Store` (MinIO), presigned URL, versioning | Postgres, Evolution, UI |
| **agent-backend** | `app/server/server.mjs`, `vault-api.mjs`, `auth.mjs`, `rate-limit.mjs`, `agent.ts`, `agent/*`, `clickup*.ts` | rotas `/api/*`, tools do agente, auth/CSRF, ClickUp | storage (usa só a interface), schema Postgres |
| **agent-data** | `server/db.mjs`, `server/migrations/`, `server/finance.mjs`, `server/reminders.mjs`, `server/investimentos*.mjs` | schema Postgres, endpoints `/api/finance/*`, `/api/reminders/*` e `/api/investimentos/*`, schedulers de lembretes e de investimentos | `VaultStore`, webhook Evolution |
| **agent-evolution** | `server/evolution.mjs`, `server/whatsapp.mjs` | webhook WhatsApp, whitelist, sendText | criar endpoints financeiros |
| **agent-frontend** | `app/src/` | UI Obsidian web + telas (Financeiro, Lembretes) | alterar contratos de API sem passar pelo agent-spec |
| **agent-reviewer** | (transversal) | revisar diffs, rodar `npm test`, aplicar o sync gate (§4) | implementar features grandes sozinho |

### Mapa rápido de arquivos → dono

```
app/src/**                     → agent-frontend
app/server/server.mjs          → agent-backend
app/server/vault-api.mjs       → agent-backend
app/server/auth + rate-limit   → agent-backend
app/server/agent.ts + agent/*  → agent-backend
app/server/clickup*.ts         → agent-backend
app/server/storage/**          → agent-storage
app/server/db + migrations + finance + reminders + investimentos* → agent-data
app/server/evolution + whatsapp → agent-evolution
backend/** (Rust, migração)    → mesmo dono do domínio em app/server: http/+agent/+tools/+mcp/ → agent-backend,
                                 storage/ → agent-storage, db/+finance/+reminders/+investimentos/ → agent-data,
                                 whatsapp/ → agent-evolution
scripts/parity.mjs             → agent-reviewer
SPEC.md / AGENTS.md            → agent-spec
tudo (review + testes)           → agent-reviewer
```

## 3. Contratos compartilhados (interfaces que todos respeitam)

1. **`VaultStore`** (canônico em `app/server/storage/local.mjs` e `s3.mjs`): `list / listKeys /
   read / readText / write / writeText / remove / removeDir / mkdir / rename / exists /
   dirExists / isEmptyDir / stat / readStream / presign`. Quem muda a assinatura avisa
   agent-backend (consumidor) e agent-spec (docs).
2. **API REST** (rotas em `app/server/server.mjs` e `vault-api.mjs`): `/api/notes|folders|files|rename|agent|clickup|finance|investimentos|reminders|evolution|health`; no backend Rust também `/api/auth/*`, `/api/users` (SPEC §7.7) e `/api/config` (SPEC §7.8) e `/api/agents` (SPEC §7.9); `/api/reminders` e parte de `/api/investimentos` já são atendidos pelo Rust (`backend/src/reminders.rs`, `investimentos.rs`, dono agent-data; spec `docs/superpowers/specs/2026-11-06-f3a-lembretes-investimentos-design.md`).
3. **Schema Postgres** (`app/server/migrations/`, SPEC §7.6): `lembretes`, `comprovantes` (vínculo extrato ↔ arquivo), `usuarios`, `sessoes`, `configuracoes` e `agentes_config` (migrações `100_`–`102_` em `backend/migrations/`, dono agent-data); financeiro no schema `alugueis`, cujo dono é `api_assistente_alugueis`; carteiras no schema `investimentos` (SPEC §13). As tabelas `public.imoveis/inquilinos/contratos/pagamentos` estão fora de uso.
4. **Env vars** (SPEC §8.1): `VAULT_STORAGE`, `RUSTFS_*` (aceita `MINIO_*`), `DATABASE_URL`, `EVOLUTION_*`, `WHATSAPP_ALLOWED_NUMBERS`, `BRAPI_TOKEN`, `TANIA_BOOTSTRAP_ADMIN`, `LEGACY_PROXY_SECRET`, `TANIA_CONFIG_KEY` (`VAULT_AUTH` só no Node legado). O Compose não fornece `TANIA_CONFIG_KEY` padrão: salvar segredos exige chave própria no `.env` da raiz (SPEC §8.1).
5. **Gatilhos** (`app/server/whatsapp.mjs`): `💡`/`ideia:` → `05-Ideias/`; `✅`/`feito:` → `01-Diario/YYYY-MM-DD.md` (um arquivo por dia);
   imagem/PDF → `COMPROVANTES_DIR`, sem passar pelo LLM (dados do recebimento vêm da legenda ou da conversa);
   resto, inclusive consultas → agente.

## 4. Protocolo de sincronização (Sync gate)

Toda fase só é "pronta" quando o **agent-reviewer** confirma:

1. `npm test` verde (em `app/`).
2. Código usa exatamente as assinaturas dos contratos (§3) — sem desvio silencioso.
3. `SPEC.md` reflete endpoints/schema/env **reais** (não o planejado).
4. `AGENTS.md` §2/§3 atualizados se a responsabilidade/contrato mudou.
5. `SPEC.md §12` (decisões em aberto) atualizada — nenhuma decisão tomada fica listada como "aberta".

Checklist de entrega por agente (todo commit/PR):
- [ ] código do seu domínio
- [ ] teste (se aplicável)
- [ ] atualização do contrato nos docs (se mudou interface)
- [ ] nota no `app/CHANGELOG.md` (se mudou comportamento)

## 5. Ordem de construção (dependências entre agentes)

```
agent-storage  ─┐
                ├─► agent-backend ─► agent-reviewer
agent-data     ─┘        │
                         ▼
                agent-evolution ─► agent-reviewer
                agent-frontend  ─► agent-reviewer
```

- **Fase 1** = agent-storage (fases em SPEC §11).
- **Fase 2** = agent-data + agent-backend (tools) + agent-frontend (telas).
- **Fase 3** = agent-evolution.
- **Fase 4** = todos + agent-reviewer (hardening).

Cada agente consome **só a interface** do anterior — nunca o estado interno. É isso
que mantém o projeto sincronizado: contratos estáveis + donos sem sobreposição.

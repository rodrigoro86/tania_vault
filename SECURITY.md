# SECURITY.md — Modelo de segurança do Tania_Assistente

Defesa em camadas. Status: o que já existe, o que foi implementado e o que vem
nas próximas fases.

## Camadas

| Camada | Medida | Onde | Status |
|---|---|---|---|
| **0 — Segredos** | todos os segredos em `app/.env` (gitignored); chave do LLM via `apiKeyEnv` no `agent.config.json`; nunca logar segredo | `agent.ts` (`keyOf`), `.env.example` | ✅ implementado |
| **1a — Login** | basic auth + bloqueio por IP após 5 erros (15 min) | `auth.mjs` | ✅ já existia |
| **1b — API** | rate limit por IP (janela fixa) na `/api` | `rate-limit.mjs` + `server.mjs` | ✅ implementado |
| **1c — Webhook WhatsApp** | verificar header `apikey` + whitelist de números | Fase 3 (desenho abaixo) | 📐 desenhado |
| **1d — API interna** | token Bearer para outros serviços/agentes (se houver) | — | ⏳ opcional |
| **2 — Rede/TLS** | MinIO/Postgres só na rede interna; HTTPS via Tailscale ou nginx+Let's Encrypt | deploy | ⚠️ depende do seu servidor |
| **3 — Validação** | sanitize de paths, CSRF (Content-Type), CSP sandbox em HTML/SVG, presigned URL com expiração | `vault-api.mjs`, `auth.mjs` | ✅ já existia |

## Regra de ouro dos segredos

- **Um único lugar:** `app/.env` (nunca commitado; `.gitignore` já o ignora).
- Configuração NÃO-secreta (baseUrl, model, active) pode ficar no `agent.config.json`.
- Segredo sempre via `apiKeyEnv` apontando para uma variável do `.env`.
- Após editar o `.env`, reiniciar (`docker compose restart`).

## Desenho da verificação do webhook (Evolution → Node)

Quando a Fase 3 criar `POST /api/evolution/webhook`, a ordem de verificação é
**obrigatória** e nessa sequência:

1. **Autenticar a origem:** exigir o header `apikey` (que a Evolution envia) e
   comparar em tempo constante com `EVOLUTION_API_KEY`. Sem match → `401`, loga, não responde.
2. **Autorizar o remetente:** extrair o número do payload e conferir contra
   `WHATSAPP_ALLOWED_NUMBERS` (whitelist). Fora da lista → ignora e loga (não processa, não responde).
3. **Só então** classificar a mensagem (gatilhos/agente) e agir.
4. Toda ação do webhook passa pelas mesmas regras de escrita do `agent.ts`
   (plano aprovado NÃO se aplica a gatilhos determinísticos — eles são roteados
   direto; a escrita continua passando por `sanitize` + `VaultStore`).

> Nunca confie na URL como segredo: o webhook precisa do `apikey` no header.

## Rate limit (config)

```env
# opcional (padrões: 300 req/min por IP)
RATE_LIMIT_MAX=300
RATE_LIMIT_WINDOW_MS=60000
```

## Checklist de segurança por fase

- [ ] segredos fora do git (`.env`, `agent.config.json`, `clickup.config.json` ignorados)
- [ ] chaves do LLM via `apiKeyEnv` (não inline no JSON versionado)
- [ ] webhook verifica `apikey` + whitelist antes de processar
- [ ] MinIO/Postgres não expostos à internet
- [ ] logs não contêm segredos nem dados de comprovante (CPF)

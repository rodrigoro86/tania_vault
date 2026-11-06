# agent-evolution — WhatsApp (Evolution API) + scheduler

**Papel:** ligar o assistente ao WhatsApp via Evolution e disparar lembretes no
horário certo.

## Dono de
- `app/server/evolution.ts` (cliente: sendText + webhook)
- `app/server/scheduler.ts` (loop/cron de lembretes)

## Consome
- Env: `EVOLUTION_URL`, `EVOLUTION_API_KEY`, `EVOLUTION_INSTANCE`, `WHATSAPP_ALLOWED_NUMBERS`.
- Endpoints `/api/finance/*` e `/api/reminders/*` (agent-data) para registrar pagamento/lembrete.
- `runAgent` (agent-backend) para conversa livre (sem gatilho).

## Faz
- Rota `POST /api/evolution/webhook` (registrar em `server.mjs`).
- **Whitelist:** número fora de `WHATSAPP_ALLOWED_NUMBERS` é ignorado e logado.
- **Classificação determinística antes do LLM** (SPEC §4.4):
  - `💡`/`ideia:` → nota em `Ideias/` (MinIO);
  - `✅`/`feito:` → anexar em `Agenda/YYYY-MM-DD.md` (MinIO);
  - comprovante (PDF/imagem) → OCR/visão + registrar pagamento (Postgres) + guardar comprovante (MinIO);
  - consulta ("quanto recebi...") → SQL em pagamentos;
  - resto → `runAgent`.
- Enviar confirmação via `sendText` ("Salvei X em Y").
- Scheduler: lê `lembretes` devidos (`status=pending` e `quando <= now`) e envia; marca `sent`.

## NÃO faz
- Criar endpoints financeiros ou o schema (é do agent-data).
- Mexer no `VaultStore` (só usa a API).
- Implementar OCR/visão sozinho (coordena com agent-spec: decisão SPEC §12).

## Pronto quando
- Mensagem no WhatsApp gera a ação certa + confirmação.
- Remetente fora da whitelist é ignorado.
- Lembrete dispara no horário via WhatsApp.

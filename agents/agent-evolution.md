# agent-evolution — WhatsApp (Evolution API) + scheduler

**Papel:** ligar o assistente ao WhatsApp via Evolution e disparar lembretes no
horário certo.

## Dono de
- `app/server/evolution.ts` (cliente: sendText + webhook)
- `app/server/scheduler.ts` (loop/cron de lembretes)

## Consome
- Env: `EVOLUTION_URL`, `EVOLUTION_API_KEY`, `EVOLUTION_INSTANCE`, `WHATSAPP_ALLOWED_NUMBERS`.
- Endpoints `/api/reminders/*` (agent-data) para lembretes.
- `runAgent` (agent-backend) para conversa livre (sem gatilho).

## Faz
- Rota `POST /api/evolution/webhook` (registrar em `server.mjs`).
- **Whitelist:** número fora de `WHATSAPP_ALLOWED_NUMBERS` é ignorado e logado.
- **Classificação determinística antes do LLM** (SPEC §4.4):
  - `💡`/`ideia:` → nota em `Ideias/` (MinIO);
  - `✅`/`feito:` → anexar em `Agenda/YYYY-MM-DD.md` (MinIO);
  - anexo (PDF/imagem) → guardar no vault (MinIO), sem LLM;
  - resto → `runAgent`.
- Enviar confirmação via `sendText` ("Salvei X em Y").
- Scheduler: lê `lembretes` devidos (`status=pending` e `quando <= now`) e envia; marca `sent`.

## NÃO faz
- Criar endpoints de dados ou o schema (é do agent-data).
- Mexer no `VaultStore` (só usa a API).

## Pronto quando
- Mensagem no WhatsApp gera a ação certa + confirmação.
- Remetente fora da whitelist é ignorado.
- Lembrete dispara no horário via WhatsApp.

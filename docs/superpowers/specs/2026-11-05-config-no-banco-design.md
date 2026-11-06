# Configuração das integrações no banco (F2d)

## Objetivo
O admin edita pela tela as variáveis das integrações e elas ficam salvas no Postgres. Os segredos são cifrados. A mudança
vale quando o sistema reinicia, e a própria tela tem o botão que reinicia.

Fora do escopo: hot reload, storage/banco/porta no banco, `clickup.config.json`/`agent.config.json`, histórico.

## Chaves editáveis (14 chaves; lista fixa, fonte única em `backend/src/settings/keys.rs`)
| Grupo | Chave | Segredo | Validação |
|---|---|---|---|
| WhatsApp | `EVOLUTION_URL` | não | começa com http:// ou https:// |
| WhatsApp | `EVOLUTION_API_KEY` | sim | — |
| WhatsApp | `EVOLUTION_INSTANCE` | não | — |
| WhatsApp | `EVOLUTION_INSTANCE_TOKEN` | sim | — |
| WhatsApp | `EVOLUTION_DRY_RUN` | não | `0` ou `1` |
| WhatsApp | `WHATSAPP_ALLOWED_NUMBERS` | não | dígitos separados por vírgula |
| LLM | `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `GROQ_API_KEY` | sim | — |
| ClickUp | `CLICKUP_TOKEN` | sim | — (vence o `token` do `clickup.config.json`) |
| Servidor | `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS` | não | inteiro > 0 |

Valor: de 1 a 4096 caracteres, sem quebra de linha.

## Banco: `backend/migrations/101_configuracoes.sql`
```sql
create table if not exists configuracoes (
  chave text primary key,
  valor text not null,
  segredo boolean not null default false,
  atualizado_em timestamptz not null default now(),
  atualizado_por text
);
```

## Cifra (Rust e Node, formato idêntico)
- **Chave:** `TANIA_CONFIG_KEY` = 32 bytes em base64.
- **Algoritmo:** AES-256-GCM com nonce aleatório de 12 bytes.
- **Valor gravado:** `"v1:" + base64(nonce ‖ texto cifrado ‖ tag16)`.
- **Vetor de teste:** chave `AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=` (32×0x01), nonce 12×0x02, texto `segredo-123` →
  `v1:AgICAgICAgICAgICdLOuOy8zrtDi/o+FiZpSjLX0DVK6OayjlgMf`.
- **Sem chave:** só não-segredos podem ser gravados; segredo responde 503 "defina TANIA_CONFIG_KEY no servidor".

## Precedência e carga
O valor do banco vence o `.env`/env do processo. Quando a linha não existe, vale o env.
- **Node (`app/server/config-db.mjs`, `loadDbConfig()`):** o `server.mjs` chama logo depois do `loadEnvFile` e antes do
  `import('./vault-api.mjs')`. Lê `configuracoes` (com a tabela ausente, `42P01`, não faz nada), decifra os segredos e
  grava em `process.env`. Qualquer erro só loga: o servidor sobe com o `.env`.
- **Rust:** depois de `db::migrate`, aplica `RATE_LIMIT_MAX`/`RATE_LIMIT_WINDOW_MS` do banco no `Config`.

## API (admin; `{ok:false,error}` nos erros)
| Rota | Resposta |
|---|---|
| `GET /api/config` | `{ok, pendente, cifra: bool, itens:[{chave, grupo, descricao, segredo, origem: "banco"\|"env"\|"vazio", valor}]}`. `valor`: em claro se não é segredo; `"••••" + últimos 4` se é segredo; `""` se vazio. `pendente` = alguma linha com `atualizado_em` posterior à subida do processo |
| `PUT /api/config/{chave}` `{valor}` | 200 `{ok, item}`; 400 chave fora da lista ou valor inválido; 503 segredo sem `TANIA_CONFIG_KEY` |
| `DELETE /api/config/{chave}` | 200 `{ok}` (volta a valer o env); 400 chave fora da lista |
| `POST /api/config/restart` | 202 `{ok}`. Depois: `POST {LEGACY_UPSTREAM}/api/internal/restart` com `x-tania-proxy`, espera ~300 ms e `exit(0)` |

**Node `POST /api/internal/restart`:** só aceita com `x-tania-proxy` igual ao `LEGACY_PROXY_SECRET` (comparação em tempo
constante), senão 403. Responde 202 e chama `process.exit(0)` em 200 ms. O Docker (`restart: unless-stopped`) ou o
Swarm sobem os dois de novo.

## Front
- **Tela `/configuracoes` (`components/Settings.tsx`):** abas Integrações | Usuários. A aba Usuários continua em
  `/usuarios`, que ganha as mesmas abas.
- **Integrações:** um bloco por grupo e uma linha por chave, com nome, descrição, etiqueta da origem
  (banco/.env/vazio), campo (`password` para segredo; segredo mostra a máscara e o campo começa vazio), Salvar e
  Remover. Com `pendente`, aparece a faixa "Mudanças salvas; valem depois de reiniciar" com o botão
  **Aplicar e reiniciar**, que chama o restart e recarrega a página depois de ~5 s.
- **Rodapé do menu lateral:** a ⚙ leva a `/configuracoes`.

## Testes
- **Rust (unitário):** o vetor acima decifra para `segredo-123`; cifrar e decifrar ida e volta; chave errada falha;
  validação por chave.
- **Rust (`tests/settings_api.rs`, com banco):** não admin 403; chave desconhecida 400; o segredo nunca volta em claro;
  PUT e depois GET mostra `origem: banco`; DELETE volta para env/vazio; `pendente` true depois do PUT.
- **Node:** `config-db` decifra o vetor; `loadDbConfig` com um pool falso aplica em `process.env`; restart interno 403
  sem o segredo.
- **Ponta a ponta:** salvar o `BRAPI_TOKEN` na tela, Aplicar e reiniciar, conferir o `process.env` no container legacy.

## Env nova
`TANIA_CONFIG_KEY` (Rust e Node). O compose local usa uma chave fixa de desenvolvimento.

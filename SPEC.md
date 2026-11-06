# SPEC — Tania_Assistente

> **Documento de especificação de produto/software**
> Status: Rascunho v2.0 (arquitetura travada)
> Data: 2026-10-31
> Idioma: pt-BR

---

## Resumo executivo

- **Tania_Assistente** é um assistente pessoal **sempre ligado (24/7)** que recebe mensagens do usuário, **lembra do trabalho dele** e **executa ações** (não apenas conversa): captura ideias, registra tarefas concluídas, cria lembretes e acompanha investimentos.
- Stack: **agente próprio** (`Tania_Assistente/app/server/agent.ts`, type-safe com tools + fluxo plano→aprovação + validação de regras) + **DeepSeek** (LLM substituível por OpenRouter/Ollama via `agent.config.json`) + **front "Obsidian web"** (`Tania_Assistente/front`, React+Vite+TS, com terminal do agente).
- **Storage das notas `.md`:** **MinIO** (bucket S3 com **versioning**) através da camada `VaultStore` (`LocalFsStore` + `S3Store`). As "pastas" do vault viram **object keys** no bucket.
- **Dados estruturados:** **Postgres** (lembretes, usuários, configurações, investimentos).
- **API única:** o servidor Node do front concentra front, agente e webhook. Novos endpoints: `/api/reminders/*`, `/api/investimentos/*` e `/api/evolution/webhook`.
- **Canal principal: WhatsApp via Evolution API** (ponte Baileys), com **whitelist de números obrigatória** (o gateway recusa tudo até a lista ser configurada; o Node reforça). Telegram fica como **alternativa/contingência**.
- **Classificação por gatilhos simples** para evitar erro de classificação: `💡`/`ideia:` → `Ideias/`; `✅`/`feito:` → nota do dia em `01-Diario/YYYY-MM-DD.md`; imagem/PDF encaminhado → guardado no vault como anexo. **Sempre confirmar onde salvou.**
- **Lembretes**: tabela `lembretes` no Postgres + **scheduler** no Node que dispara via WhatsApp (sem Google Calendar, §12).
- **Privacidade**: a API do LLM processa as mensagens em servidores de terceiros; anexos não são enviados ao LLM.
- **Riscos já mapeados**: banimento do WhatsApp (número pré-pago + whitelist).

> **Financeiro fora do escopo (2026-11-06):** aluguéis, recebimentos e Carnê-Leão saíram desta especificação e vão voltar no futuro como uma **tool** separada. Até lá, o código atual (`app/server/finance.mjs`, `/api/finance/*`, tela `/financeiro`, tools do agente) continua no app, mas não é mais requisito nem será portado para o Rust.

---

## 1. Visão e Objetivo

### 1.1 O que é

Tania_Assistente é um **assistente pessoal de execução** — não um chatbot. Ele permanece ativo 24/7, recebe mensagens curtas do usuário pelo WhatsApp (via Evolution API) e, em vez de apenas responder, **executa ações**: salva notas (MinIO), registra dados estruturados (Postgres) e dispara lembretes.

O nome "Tania" refere-se à **persona do assistente**: uma figura que acompanha o trabalho do usuário, lembra do contexto e age em nome dele sobre um conjunto bem delimitado de operações.

### 1.2 Para quem

- O **usuário principal (dono)** — uma pessoa física que:
  - Captura ideias e tarefas ao longo do dia, inclusive fora do computador (via celular/WhatsApp).
  - Usa o **front "Obsidian web"** (`Tania_Assistente/front`) como base de notas, com o terminal do agente embutido.
  - Valoriza privacidade e controle sobre os próprios dados (por isso mantém a infra própria: MinIO + Postgres).

### 1.3 O problema que resolve

1. **Fricção de captura**: boas ideias e tarefas se perdem entre o celular e o computador. Hoje, o usuário precisa abrir o front, navegar até a pasta certa e formatar a nota — passos demais para uma captura rápida.
2. **Esquecimento do trabalho**: sem registro, o usuário perde o fio do que fez no dia e do que ficou pendente.

### 1.4 Princípio central

> **A Tania anota e organiza com autonomia; nada é apagado e o bucket guarda as versões.** O assistente tem um escopo de escrita restrito ao bucket do vault (MinIO) e a um conjunto fixo de tabelas (Postgres), e nunca toca em contas bancárias, corretoras nem faz transações.

---

## 2. Metas e Não-metas (Goals / Non-goals)

### 2.1 Metas (dentro do escopo)

| ID | Meta |
|----|------|
| G1 | Receber mensagens 24/7 via canal principal (WhatsApp/Evolution) e opcional (Telegram). |
| G2 | Classificar mensagens por gatilhos simples e confiáveis, sem exigir que o usuário "pense" na estrutura. |
| G3 | Gravar notas `.md` no MinIO (object keys) com estrutura de pastas determinística. |
| G6 | Confirmar, a cada ação, **o quê** foi salvo e **onde**. |
| G7 | Manter memória do trabalho do usuário (o que ele está fazendo/fez) entre mensagens. |
| G8 | Funcionar com custo operacional baixo (VPS barata ou PC próprio; LLM pago conforme uso). |
| G9 | Criar e disparar **lembretes** (tabela `lembretes` + scheduler) via WhatsApp. |

### 2.2 Não-metas (FORA do escopo — explícito)

| ID | Não-meta | Justificativa |
|----|----------|---------------|
| NG1 | **Acesso a conta bancária ou corretora** (saldo, extrato, Pix, ordens). | Risco e responsabilidade desproporcionais. |
| NG2 | **Financeiro de aluguéis** (recebimentos, inquilinos, Carnê-Leão). | Fora desta spec; volta no futuro como tool separada. |
| NG4 | **Automação bancária de conciliação** (BaaS, open banking, scraping de apps de banco). | Explicitamente vetado por privacidade/segurança. |
| NG5 | **Aplicativo mobile próprio**. | A interface é o mensageiro (WhatsApp) + o front "Obsidian web" (`Tania_Assistente/front`). |
| NG6 | **IA generativa de conteúdo longo ou conversa aberta ilimitada**. | A Tania é acionada por comandos/acionadores; conversa livre é secundária. |
| NG7 | **Multi-usuário**. | Um único dono + (opcionalmente) números whitelistados. |

---

## 3. Persona / Usuário

### 3.1 A Tania (persona do assistente)

- **Nome**: Tania.
- **Tom de voz**: direto, curto, confiável, sem rodeios. Confirma ações com uma frase objetiva.
- **Comportamento**: sempre responde confirmando **o que fez** e **onde**; quando não entende, pede o dado mínimo que falta (ex.: "Qual o valor?"), em vez de adivinhar.
- **Limite de autonomia**: nunca inventa valores ou datas. Se faltar informação, pergunta.

### 3.2 O usuário (dono)

- Usa o celular como principal ponto de captura (mensagens curtas durante o dia, via WhatsApp).
- Não quer perder tempo formatando notas; quer que a Tania faça isso por ele.

### 3.3 Fluxo de uso típico (narrativa)

1. Durante o dia, o usuário tem uma ideia → envia `💡 ...` pelo **WhatsApp** (Evolution).
2. A Tania salva em `Ideias/` (objeto no MinIO) e responde: "💾 Ideia salva em `Ideias/2026-10-31-ideia-sobre-X.md`".
3. Ao terminar uma tarefa → envia `✅ ...`.
4. A Tania anexa à nota do dia em `01-Diario/2026-10-31.md` e confirma.
5. Precisa lembrar de algo → "me lembra amanhã às 9h de ligar para o contador" → a Tania cria o lembrete e avisa no WhatsApp na hora.

---

## 4. Arquitetura

### 4.1 Visão geral dos componentes

| Componente | Papel | Onde / Observações |
|------------|-------|-------------|
| **Front "Obsidian web"** | Interface de leitura/edição das notas `.md` + **terminal do agente**. | `app/src/` (React + Vite + TS). |
| **API + agente** | **Única porta de entrada**: CRUD do vault, ferramentas do agente, webhook e scheduler. | `app/server/` (Node 24: `server.mjs` + `vault-api.mjs` + `agent.ts`). |
| **VaultStore** | Abstração de storage: `LocalFsStore` (dev/fallback) e `S3Store` (MinIO). | `app/server/storage/` (novo). |
| **MinIO** | Bucket com as notas `.md` + anexos. **Versioning = "undo"**. | Servidor do usuário. |
| **Postgres** | Dados estruturados: lembretes, usuários, configurações, investimentos. | Servidor do usuário. |
| **Evolution API** | Ponte WhatsApp (Baileys); recebe/envia via REST + webhook. | Servidor do usuário (já subida). |
| **DeepSeek (LLM)** | Modelo de linguagem que interpreta intenção, extrai dados e gera respostas. | Substituível por OpenRouter/Ollama via `agent.config.json`. |
| **Scheduler** | Loop/cron que lê `lembretes` devidos e dispara via Evolution. | `app/server/scheduler.ts` (novo). |

> O **Hermes Agent não é o cérebro** desta arquitetura. O cérebro é o agente próprio do front (`server/agent.ts`). O Hermes permanece apenas como uma opção complementar futura (não recomendada por ora, para evitar duplicação).

### 4.2 Diagrama de arquitetura (Mermaid)

```mermaid
flowchart LR
    subgraph Entrada
        WA["WhatsApp"] --> EV["Evolution API<br/>(ponte Baileys)"]
        UI["Front Obsidian web<br/>React + terminal do agente"]
    end

    EV -- "webhook (mensagem)" --> API
    EV <-- "sendText (resposta/lembrete)" --> API
    UI <-- "/api/*" --> API

    subgraph Servidor["Servidor Node 24 (app/server)"]
        API["API REST + agente LLM<br/>(server.mjs + vault-api + agent.ts)"]
        ST["VaultStore<br/>LocalFsStore | S3Store"]
        SCH["Scheduler de lembretes"]
        LLM["LLM — DeepSeek<br/>(OpenRouter/Ollama via agent.config.json)"]
    end

    API --> ST
    API --> PG[("Postgres<br/>lembretes · usuários<br/>configurações · investimentos")]
    API --> LLM
    ST --> MIN[("MinIO bucket<br/>*.md + anexos · versioning")]
    SCH --> EV
    SCH --> PG
```

### 4.3 Diagrama de fluxo de mensagem (Mermaid)

```mermaid
flowchart TD
    A["Usuário envia mensagem no WhatsApp"] --> B["Evolution API recebe"]
    B --> C["POST /api/evolution/webhook"]
    C --> D{"Whitelist<br/>número permitido?"}
    D -- "Não" --> E["Ignorar / log (sem resposta)"]
    D -- "Sim" --> F{"Classificação por gatilho"}

    F -- "💡 ou ideia:" --> G["Criar nota em Ideias/ (MinIO)"]
    F -- "✅ ou feito:" --> H["Anexar à nota do dia 01-Diario/YYYY-MM-DD.md (MinIO)"]
    F -- "anexo (PDF/imagem)" --> I["Guardar no vault (MinIO), sem LLM"]
    F -- "nenhum gatilho" --> K["Agente (LLM) interpreta / pede dado faltante"]

    G --> L["Confirmação via sendText"]
    H --> L
    I --> L
    K --> L
```

### 4.4 Descrição textual do fluxo

1. **Entrada**: o usuário envia uma mensagem (texto, PDF ou imagem) ao número WhatsApp.
2. **Recepção**: a Evolution API chama `POST /api/evolution/webhook` no Node.
3. **Autorização**: o Node aplica a **whitelist** (`WHATSAPP_ALLOWED_NUMBERS`). Remetente fora da lista é **ignorado e logado** (a Evolution já recusa tudo por padrão; o Node reforça).
4. **Roteamento**: classificação por **gatilho explícito** (determinístico), antes de qualquer LLM:
   - `💡` / `ideia:` → criar nota em `Ideias/` (MinIO);
   - `✅` / `feito:` → anexar à nota do dia `01-Diario/YYYY-MM-DD.md` (MinIO);
   - **anexo** (PDF/imagem) → guardado no vault (MinIO), sem passar pelo LLM;
   - **sem gatilho** → agente (LLM) usa a memória para interpretar e/ou pedir o dado faltante.
5. **Ação**: a skill correspondente escreve no MinIO e/ou Postgres (ou lê, no caso de consulta).
6. **Resposta**: o Node envia `sendText` via Evolution com uma confirmação curta (**o que foi salvo e onde**).

---

## 5. Requisitos Funcionais (FR)

> Convenção de IDs: **FR-nn**. Prioridades: **[P0]** obrigatório para MVP; **[P1]** v1; **[P2]** v2.

### 5.1 Recepção de mensagens e canais

- **FR-01 [P0]** O sistema deve receber mensagens via **WhatsApp** através da **Evolution API** (ponte Baileys), pelo webhook `POST /api/evolution/webhook`.
- **FR-02 [P1]** O sistema deve (opcionalmente) receber mensagens via **Telegram** (API oficial) como canal alternativo/contingência.
- **FR-03 [P0]** O sistema deve responder a mensagens de texto, imagens e PDFs (documentos/encaminhamentos).
- **FR-04 [P0]** O sistema deve processar mensagens em ordem de chegada e responder de forma assíncrona (sem travar o bot).

### 5.2 Whitelist (lista de números permitidos)

- **FR-05 [P0]** O sistema deve manter uma **whitelist** de números permitidos (`WHATSAPP_ALLOWED_NUMBERS`).
- **FR-06 [P0]** O sistema deve **recusar silenciosamente** (não responder, apenas logar) qualquer remetente fora da whitelist.
- **FR-07 [P1]** A Evolution deve **recusar tudo por padrão** até que ao menos um número seja adicionado; o Node **reforça** a whitelist no webhook.
- **FR-08 [P1]** Deve haver um comando administrativo (restrito ao dono) para adicionar/remover números da whitelist (ex.: `/allow <numero>`).

### 5.3 Classificação por gatilhos (evitar erro de classificação)

- **FR-09 [P0]** Mensagens iniciadas com **`💡`** ou com o prefixo **`ideia:`** (case-insensitive, ignorando espaços) devem ser classificadas como **captura de ideia**.
- **FR-10 [P0]** Mensagens iniciadas com **`✅`** ou com o prefixo **`feito:`** devem ser classificadas como **registro de tarefa concluída**.
- **FR-11 [P0]** **Anexos** (PDF ou imagem) devem ser guardados no vault como arquivo (nunca como ideia/nota), sem passar pelo LLM.
- **FR-13 [P0]** A classificação por gatilho deve ter **prioridade sobre a interpretação do LLM** (determinística primeiro, LLM só para o restante).
- **FR-14 [P1]** Se a mensagem não casar com nenhum gatilho, o sistema deve usar o LLM com a memória para interpretar a intenção ou **pedir o dado faltante**.

### 5.4 Escrita de notas e confirmação

- **FR-15 [P0]** Ao salvar uma ideia, o sistema deve criar um `.md` em `Ideias/` (object key no MinIO) com nome de data + slug (ex.: `Ideias/2026-10-31-ideia.md`).
- **FR-16 [P0]** Ao registrar uma tarefa concluída, o sistema deve **anexar** à nota do dia `01-Diario/YYYY-MM-DD.md` (criando o objeto se não existir, usando a data atual no formato `AAAA-MM-DD`).
- **FR-17 [P0]** **Toda ação de escrita deve gerar uma resposta de confirmação** contendo: (a) um resumo do conteúdo salvo e (b) o **caminho/nome do arquivo** onde foi salvo.
- **FR-18 [P0]** A confirmação deve usar formato consistente, ex.: `"💾 Ideia salva em Ideias/2026-10-31-ideia.md"`.
- **FR-19 [P1]** O sistema deve evitar sobrescrever conteúdo: ao anexar a uma nota existente, deve **acrescentar** (append) em vez de substituir.
- **FR-20 [P1]** O sistema deve gerar nomes de arquivo sem colisão (sufixo numérico quando necessário).

> FR-12 e FR-21 a FR-35 (financeiro e leitura de comprovantes) foram removidos; os demais números não mudam.

### 5.8 Storage (MinIO / VaultStore)

- **FR-36 [P0]** O sistema deve abstrair o storage atrás da interface **`VaultStore`** (`list`, `read`, `write`, `remove`, `mkdir`, `rename`, `exists`, `stat`, `stream`, `presign`), com duas implementações: **`LocalFsStore`** (dev/fallback) e **`S3Store`** (MinIO).
- **FR-37 [P0]** No **`S3Store`**, as **object keys** devem corresponder aos caminhos lógicos do vault: `list` por prefixo (paginação), `rename` = copy + delete, `mkdir` = no-op.
- **FR-38 [P0]** O bucket MinIO deve ter **versioning habilitado**, como mecanismo de "nunca apagar"/undo — substituindo o autocommit git no modo MinIO.
- **FR-39 [P0]** Anexos devem ser servidos via **presigned URL** (S3) mantendo suporte a Range/ETag; no modo local, via `stream()` em `/files/*`.
- **FR-40 [P1]** As regras de segurança de caminho (`sanitize`, `SKIP_DIRS`) devem continuar válidas; dentro do vault a escrita é livre em qualquer pasta: validam o **caminho lógico**, que vira key no S3 ou path no fs.

### 5.9 Dados estruturados (Postgres) e webhook Evolution

> FR-41, FR-42 e FR-45 (financeiro) foram removidos.


- **FR-43 [P1]** O sistema deve **criar lembrete** (texto, quando, recorrência, canal) na tabela `lembretes` via `/api/reminders/*` e/ou tool `criar_lembrete`.
- **FR-44 [P1]** O sistema deve **listar/consultar lembretes** pendentes (tool `listar_lembretes` / `/api/reminders/*`).
- **FR-47 [P1]** O agente deve atuar como **bibliotecária**: sugerir onde cada nota deve ficar, sem alterar nada, e reorganizar quando pedido, sem aprovação prévia (o plano fica visível no terminal); mover nota atualiza os `[[links]]`.
- **FR-46 [P0]** O sistema deve expor o webhook **`POST /api/evolution/webhook`** para receber mensagens, aplicar whitelist, rotear por gatilho/agente e responder via `sendText` da Evolution.

---

## 6. Requisitos Não-Funcionais (NFR)

> Convenção de IDs: **NFR-nn**.

### 6.1 Disponibilidade e confiabilidade

- **NFR-01** O serviço deve estar **disponível 24/7** (processo supervisor que reinicia em caso de falha; ex.: `systemd` ou `docker --restart unless-stopped` no servidor Node).
- **NFR-02** O tempo de resposta percebido (mensagem → confirmação) deve ser, em condições normais, **≤ 10 s** para ações de captura.
- **NFR-03** Falhas em uma mensagem **não devem derrubar o serviço** (isolamento por mensagem, com log e resposta de erro amigável quando aplicável).

### 6.2 Segurança e privacidade

- **NFR-04** Nenhuma **credencial bancária** pode ser armazenada ou solicitada pelo sistema.
- **NFR-05** Chaves/segredos (DeepSeek/OpenRouter, Evolution, MinIO, Postgres) devem ser lidos de **variáveis de ambiente / cofre de segredos**, nunca hardcoded no código ou commitados.
- **NFR-06** Anexos **não devem ser enviados a terceiros** (LLM) sem necessidade (ver seção 9).
- **NFR-07** O sistema deve registrar **logs** de ações (mensagem recebida, remetente, gatilho, ação, resultado) para auditoria — **sem** registrar o conteúdo integral de anexos em logs.

### 6.3 Custo

- **NFR-08** O custo recorrente deve caber em orçamento de uso pessoal: VPS barata (~US$ 5–10/mês) **ou** PC próprio (custo 0 de hospedagem), mais custo de uso da API do LLM (pay-per-use).
- **NFR-09** O modelo/roteamento deve permitir **fallback para modelo local (Ollama)** para tarefas não sensíveis ao custo/latência, reduzindo gasto de API.

### 6.4 Desempenho e escalabilidade

- **NFR-10** O sistema deve suportar **1 usuário** com dezenas de mensagens/dia sem degradação; não há requisito de multi-usuário concorrente (NG7).
- **NFR-11** Operações de leitura/escrita devem ser **idempotentes** quando possível (repetir a mesma mensagem não deve duplicar lançamentos sem confirmação).

### 6.5 Observabilidade / Logs

- **NFR-12** Deve haver **log estruturado** (timestamp, canal, remetente, gatilho, skill, caminho do arquivo escrito, erro).
- **NFR-13** Deve haver **alertas mínimos** para falhas críticas (ex.: gateway desconectado, erro de API persistente) — ao menos log visível; notificação via mensageiro é desejável (P2).

### 6.6 Manutenibilidade e configuração

- **NFR-14** Toda a configuração deve ser feita por **variáveis de ambiente** (storage backend, chaves MinIO/Postgres/Evolution, whitelist, provedor/modelo).
- **NFR-15** O sistema deve permitir trocar o provedor de LLM (DeepSeek ↔ OpenRouter ↔ Ollama) **sem mudança de código** (configuração apenas, via `agent.config.json`).

---

## 7. Estrutura do Vault (pastas e arquivos)

> **Nota (v2.0):** as "pastas" abaixo **não são mais diretórios físicos** — são **object keys (prefixos) no bucket MinIO**. Os dados estruturados (lembretes, investimentos) **não vivem em markdown**: vivem no **Postgres** (ver §7.6). O markdown continua para notas livres e como espelho de leitura humana.

### 7.1 Árvore de object keys (bucket MinIO)

```
tania-vault/                         ← bucket
├── Ideias/
│   ├── 2026-10-31-ideia-automatizar-captura.md
│   └── 2026-11-01-ideia-tema-de-artigo.md
├── 01-Diario/
│   ├── 2026-10-31.md
│   └── 2026-11-01.md
└── Memória/                        ← (opcional) notas de contexto do trabalho
    └── contexto-atual.md
```

### 7.2 Template de nota — Ideia

Arquivo (object key): `Ideias/YYYY-MM-DD-<slug>.md`

```markdown
---
tipo: ideia
data: 2026-10-31
fonte: whatsapp
---

# 💡 <título da ideia>

<conteúdo da mensagem, sem o prefixo "💡" ou "ideia:">

<!-- criado por Tania_Assistente -->
```

### 7.3 Template de nota do dia — Agenda

Arquivo (object key): `01-Diario/YYYY-MM-DD.md` (criado no primeiro `✅` do dia; appends seguintes)

```markdown
# 📅 2026-10-31

## ✅ Feito
- 10:22 — Finalizei o relatório de outubro
- 15:47 — Revisei o contrato do fornecedor

## 📝 Notas
- <itens opcionais>
```

> Regra: cada `✅`/`feito:` gera uma linha `- HH:MM — <texto>` na seção `## ✅ Feito`.

### 7.5 Template de memória (opcional)

Arquivo (object key): `Memória/contexto-atual.md`

```markdown
# Contexto atual

## Em andamento
- <o que o usuário está trabalhando agora>

## Próximos passos
- <pendências citadas pelo usuário>
```

### 7.6 Dados estruturados no Postgres (schema resumido)

Fonte de verdade para lembretes, usuários, configurações e investimentos (§13).

| Tabela | Campos-chave |
|--------|--------------|
| `lembretes` | `id`, `texto`, `quando`, `recorrencia`, `canal`, `status`, `created_at` |
| `usuarios` | `id` (uuid), `username` (único sem diferenciar maiúsculas), `senha_hash` (argon2id), `admin`, `ativo`, `criado_em`, `atualizado_em` |
| `agentes_config` | `id` = 1 (uma linha), `config` jsonb `{active, providers}` (provedores do agente LLM), `atualizado_em`, `atualizado_por` |
| `configuracoes` | `chave` (pk, lista fixa em `backend/src/settings/keys.rs`), `valor` (segredo = `v1:` AES-256-GCM), `segredo`, `atualizado_em`, `atualizado_por` |
| `sessoes` | `token_hash` (sha256 do token, pk), `usuario_id` → `usuarios` (cascade), `criado_em`, `expira_em` |

> **Usuários e sessões:** criadas pelo backend Rust (`backend/migrations/100_usuarios.sql`), registradas na mesma `schema_migrations` do Node (versões `100_`+ são do Rust). Spec: `docs/superpowers/specs/2026-11-05-usuarios-tokens-design.md`.
>
> **Financeiro (fora do escopo):** o schema `alugueis` (dono: `api_assistente_alugueis`), a tabela `comprovantes` e as tabelas antigas `public.imoveis/inquilinos/contratos/pagamentos` continuam no banco, mas não fazem parte desta spec.

---

### 7.7 Usuários e tokens (backend Rust)

Login por usuário. O token de sessão (32 bytes aleatórios, base64url, 30 dias) vai no cookie `vault_session` ou em
`Authorization: Bearer <token>`. O banco guarda só o `sha256` dele. Erros no formato `{ok:false,error}`.

| Rota | Acesso | O que faz |
|---|---|---|
| `POST /api/auth/login` `{username,password}` | público (bloqueio de 5 erros/15 min por IP) | `{ok,token,expiresAt,user}` + cookie |
| `POST /api/auth/logout` | logado | apaga a sessão atual |
| `GET /api/auth/me` | logado | `{ok,user}` |
| `GET /api/users`, `GET /api/users/{id}` | admin | lista / detalhe (sem hash) |
| `POST /api/users` `{username,password,admin?}` | admin | cria (username `[a-zA-Z0-9._-]{3,32}`, senha 8–128) |
| `PATCH /api/users/{id}` `{password?,admin?,ativo?}` | admin; o próprio usuário só `password` | altera; trocar a senha ou desativar derruba as sessões |
| `DELETE /api/users/{id}` | admin | apaga; nunca a si mesmo nem o último admin ativo (409) |

Primeiro admin: `TANIA_BOOTSTRAP_ADMIN` ou `tania user add <nome> --admin` (senha pela entrada padrão). Tela no front:
👥 Usuários (`/usuarios`).

### 7.8 Configuração das integrações no banco (backend Rust)

O admin edita em ⚙ Configurações (`/configuracoes`) as integrações: WhatsApp/Evolution, chaves de LLM, token do
ClickUp (`CLICKUP_TOKEN`) e rate limit. `BRAPI_TOKEN` (investimentos, escondidos no front) fica só no env. O valor salvo no banco vence o `.env`. Ele vale na subida (o Rust lê o rate limit; o Node, via
`server/config-db.mjs`, põe tudo em `process.env` antes de carregar os módulos). Banco, storage, porta e segredos de
infraestrutura continuam só no env. Spec: `docs/superpowers/specs/2026-11-05-config-no-banco-design.md`.

| Rota (admin) | O que faz |
|---|---|
| `GET /api/config` | lista as chaves com a origem (`banco`/`env`/`vazio`); segredos mascarados (`••••1234`) |
| `PUT /api/config/{chave}` `{valor}` | valida e salva (segredo cifrado); 503 sem `TANIA_CONFIG_KEY` |
| `DELETE /api/config/{chave}` | remove do banco (volta a valer o env) |
| `POST /api/config/restart` | reinicia Rust e Node (Node por `POST /api/internal/restart` com `x-tania-proxy`) |

### 7.9 Agents: provedores do agente LLM no banco

O admin edita em 🤖 Agents (`/agentes`) os provedores do agente do terminal: URL, modelo, max tokens, qual chave LLM usar
(só as de ⚙ Configurações → LLM) e o ativo. Fica em `agentes_config`. O Node relê a cada pedido (vale na hora) e o banco
vence o `app/agent.config.json`, que vira só a alternativa. Spec: `docs/superpowers/specs/2026-11-06-ribbon-e-agents-design.md`.

| Rota (admin) | O que faz |
|---|---|
| `GET /api/agents` | `{origem: banco\|nenhum, config, chaves}`; sem linha devolve o modelo inicial |
| `PUT /api/agents` `{config}` | valida (`deny_unknown_fields`: `apiKey` inline é recusado) e grava |

A troca do ativo continua em `POST /api/agent/config` (Node), que grava no banco quando a config vem de lá.

**Instruções** (spec `docs/superpowers/specs/2026-11-06-agentes-no-vault-design.md`): `99-Meta/Agentes/Tania.md` entra no prompt
do agente a cada pedido (ausente = nada muda); `99-Meta/Agentes/Equipe/*.md` são as instruções da equipe de desenvolvimento,
sincronizadas com `agents/*.md` por `scripts/agentes.mjs`. O painel 🤖 Agents lista essas notas em "Instruções".

### 7.10 Tools (funcionalidades plugáveis)

Uma **tool** é um serviço HTTP com contrato fixo: `GET /manifest.json` (id, nome, ícone, páginas, vínculos, config, prompt),
`POST /mcp` (funções do agente, MCP/JSON-RPC), `/ui/{pagina}` (página mostrada num iframe) e `/api/*` (API própria). Toda
chamada leva `x-tania-tool-secret`. Interna (código em `app/tools/<id>/`, sobe no compose) ou externa (URL cadastrada pelo
admin), o contrato é o mesmo. Spec: `docs/superpowers/specs/2026-11-06-tools-design.md`.

| Rota (backend Rust) | Acesso | O que faz |
|---|---|---|
| `GET /api/tools` | logado | tools do env e do banco com o manifesto (ou `erro`); `url` só para admin |
| `POST /api/tools`, `PUT/DELETE /api/tools/{id}` | admin | cadastra/edita/remove tool externa (segredo cifrado; tools do env não se editam) |
| `GET/PUT /api/tools/{id}/config` | admin | chaves `config` do manifesto; segredo nunca volta |
| `/tools/{id}/ui/*`, `/tools/{id}/api/*` | logado | proxy para a tool com `x-tania-user`/`x-tania-admin`; `x-tania-*`, cookie e bearer do cliente não passam |
| `GET /api/core/config` | tool (`Authorization: Tool <id>:<segredo>`) | valores das chaves da própria tool, decifrados |

Tabelas `tools` e `tools_config` (`backend/migrations/103_tools.sql`). O agente (Node) junta as funções MCP das tools às suas
como `{id}__{nome}` e acrescenta o `prompt` de cada manifesto. Tools internas: **ClickUp** (`app/tools/clickup/`: tarefas, painel,
card de nota com `clickup:` no frontmatter; token em `tools_config`). Planejadas: Investimentos e Aluguéis.

## 8. Configuração

### 8.1 Variáveis de ambiente

| Variável | Descrição | Exemplo |
|----------|-----------|---------|
| `VAULT_AUTH` | Só o **Node legado** (produção atual): `usuário:senha` do login. O backend Rust não usa; lá o login é por usuário no Postgres. | `usuario:senha` |
| `TANIA_BOOTSTRAP_ADMIN` | Backend Rust: `usuário:senha` do admin criado na subida **só se** a tabela `usuarios` estiver vazia. O compose local usa `admin:admin`; produção não deve definir. | `admin:admin` |
| `TANIA_CONFIG_KEY` | 32 bytes em base64 (Rust e Node): cifra (AES-256-GCM) os segredos salvos em ⚙ Configurações. Sem ela, só valores não secretos podem ser salvos. O compose não fornece chave padrão; configure uma chave própria no `.env` da raiz. | `head -c 32 /dev/urandom \| base64` |
| `TANIA_TOOLS` | Tools do env: `id=url` separados por vírgula (compose: `clickup=http://tool-clickup:4100`). Lido pelo Rust e pelo Node. | `clickup=http://tool-clickup:4100` |
| `TANIA_TOOL_SECRET_<ID>` | Segredo de cada tool do env (id em maiúsculas, `-` → `_`). Tool sem segredo é ignorada. Na tool, o mesmo valor vai em `TANIA_TOOL_SECRET`, e `TANIA_CORE_URL` aponta para o backend. | `TANIA_TOOL_SECRET_CLICKUP=...` |
| `LEGACY_PROXY_SECRET` | Segredo compartilhado Rust → Node: o Rust manda `x-tania-proxy` (e `x-tania-user`) e o Node aceita a requisição já autenticada. Sem ele, o Node segue só com `VAULT_AUTH`. | `um-segredo-longo` |
| `PORT` | Porta do servidor. Em dev/local (compose), o backend Rust (`backend/`) usa `3100` e o Node legado `3101`; em produção o Node segue na `3100`. | `3100` |
| `LEGACY_UPSTREAM` | Backend Rust: URL do Node legado para onde vão as rotas ainda não portadas (migração strangler; some na F7). | `http://127.0.0.1:3101` |
| `RATE_LIMIT_MAX` | Requisições por IP por janela na `/api` (opcional). | `300` |
| `RATE_LIMIT_WINDOW_MS` | Tamanho da janela do rate limit, em ms (opcional). | `60000` |
| `VAULT_STORAGE` | Backend do vault (`rustfs` \| `local`; `minio`/`s3` = `rustfs`). | `rustfs` |
| `RUSTFS_ENDPOINT` | `host:porta` do bucket. | `minio.local:9000` |
| `RUSTFS_USE_SSL` | Usa TLS (`true`/`false`). | `false` |
| `RUSTFS_ACCESS_KEY` | Access key do bucket. | `...` |
| `RUSTFS_SECRET_KEY` | Secret key do bucket. | `...` |
| `RUSTFS_BUCKET` | Bucket das notas. | `tania-vault` |
| `BRAPI_TOKEN` | Token da brapi.dev para cotações (§13). Sem ele, as rotinas ficam desligadas. | `...` |
| `DATABASE_URL` | Conexão com o Postgres. No backend Rust é também o login (usuários e sessões); sem ela, só o localhost entra. Alternativa (usada pelo compose local): as variáveis padrão `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, lidas quando `DATABASE_URL` está vazia. | `postgres://tania:...@postgres.local:5432/tania` |
| `EVOLUTION_URL` | Base URL da Evolution API. | `http://evolution.local:8080` |
| `EVOLUTION_API_KEY` | apikey da Evolution. | `...` |
| `EVOLUTION_INSTANCE` | Instância da Evolution. | `tania` |
| `WHATSAPP_ALLOWED_NUMBERS` | Whitelist de números, separados por vírgula. | `5511999999999,5511888888888` |

### 8.2 Chaves e provedores (LLM)

- O provedor/modelo do LLM **não é env var**: fica em `app/agent.config.json` (fora do git), com `active` + `providers` compatíveis com `/chat/completions` (DeepSeek, OpenAI, OpenRouter, Groq, Ollama).
- **DeepSeek**: provedor padrão.
- **OpenRouter**: roteador com múltiplos modelos.
- **Ollama (local)**: modelo no próprio PC/VPS; ideal para **privacidade** e custo zero por token.

### 8.3 Storage (S3 compatível / local)

- `VAULT_STORAGE=rustfs` → usa `S3Store` (object keys = caminhos do vault); requer `RUSTFS_*` e **versioning habilitado no bucket**.
  Qualquer servidor S3 compatível com path-style serve; em produção é o **RustFS** (antes MinIO).
  Compatibilidade: `VAULT_STORAGE=minio|s3` e os nomes antigos `MINIO_*` ainda são aceitos (`RUSTFS_*` tem prioridade).
- Backend Rust (`backend/src/storage/`) e Node leem as mesmas variáveis e o mesmo bucket; durante a migração os dois escrevem nele.
- `VAULT_STORAGE=local` → usa `LocalFsStore` (dev/fallback), sem undo: pasta com conteúdo não pode ser apagada.
- É responsabilidade do operador garantir bucket, credenciais e rede até o MinIO.

### 8.4 Whitelist de números

- Formato: lista separada por vírgula na variável `WHATSAPP_ALLOWED_NUMBERS`.
- A Evolution **não aceita nenhuma mensagem** enquanto a lista estiver vazia (recusa por padrão); o Node reforça a checagem no webhook.

### 8.5 Exemplo de arquivo de configuração (`.env`)

```bash
VAULT_AUTH=usuario:senha
PORT=3100

# storage
VAULT_STORAGE=rustfs
RUSTFS_ENDPOINT=rustfs.local:9000
RUSTFS_USE_SSL=false
RUSTFS_ACCESS_KEY=...
RUSTFS_SECRET_KEY=...
RUSTFS_BUCKET=tania-vault

# postgres
DATABASE_URL=postgres://tania:...@postgres.local:5432/tania

# evolution / whatsapp
EVOLUTION_URL=http://evolution.local:8080
EVOLUTION_API_KEY=...
EVOLUTION_INSTANCE=tania
WHATSAPP_ALLOWED_NUMBERS=5511999999999
```

---

## 9. Segurança e Privacidade

### 9.1 Riscos identificados

| Risco | Detalhe | Mitigação |
|-------|---------|-----------|
| **Banimento do WhatsApp** | Ponte não oficial (Evolution/Baileys) emula WhatsApp Web e pode ser banida pela Meta. | Usar número/chip **pré-pago separado** (não o número pessoal); **whitelist obrigatória**; **Telegram como canal de contingência**; aceitar o risco ou desativar WhatsApp. |
| **Dados em servidores de terceiros** | A API do LLM processa as mensagens nos servidores do provedor. | Não enviar dados sensíveis desnecessariamente; anexos não vão ao LLM; **modelo local (Ollama)** quando preciso; revisar a política de dados do provedor. |
| **Segredos expostos** | Vazamento de chaves DeepSeek/Evolution/MinIO/Postgres. | Segredos via variáveis de ambiente/cofre; nunca commitá-los; restringir a apikey da Evolution. |
| **Acesso indevido ao bot** | Alguém fora da whitelist envia mensagens. | Whitelist obrigatória; recusa silenciosa; comando `/allow` restrito ao dono. |
| **Escrita acidental / sobrescrita** | A Tania corromper notas no MinIO ou dados no Postgres. | Append em vez de sobrescrever; nomes sem colisão; **versioning do bucket** como undo; confirmação do que foi salvo. |

### 9.2 Políticas de privacidade recomendadas

1. **Minimização de dados**: enviar ao LLM apenas o texto necessário; anexos ficam no MinIO e não vão ao LLM.
2. **Retenção de logs**: logs sem conteúdo sensível.
3. **Dados de terceiros**: evitar expor dados de outras pessoas a serviços externos.

---

## 10. Riscos e Mitigações (tabela consolidada)

| # | Risco | Probabilidade | Impacto | Mitigação |
|---|-------|---------------|---------|-----------|
| R2 | **Banimento do WhatsApp**. | Média | Médio | Número pré-pago separado; whitelist obrigatória; Telegram como contingência; manter WhatsApp desligável. |
| R3 | **Vazamento de dados sensíveis a terceiros**. | Média | Alto | Minimização de dados; anexos fora do LLM; Ollama local quando preciso. |
| R4 | **Classificação errada** (mensagem salva no lugar errado). | Média | Médio | Gatilhos determinísticos e simples; confirmação sempre; fácil correção (editar objeto `.md`). |
| R6 | **Falha de disponibilidade** (VPS/PC desligado, crash). | Média | Médio | Supervisor + restart automático; alerta de gateway desconectado. |
| R7 | **Mensagem duplicada** (webhook reenviado). | Média | Médio | Idempotência por id da mensagem; confirmação. |
| R8 | **Custo de API crescente** (uso intenso). | Baixa | Baixo | Fallback Ollama local; modelo mais barato para tarefas simples. |
| R9 | **Acesso às notas no celular**. | Média | Médio | O front "Obsidian web" é acessível pelo navegador via Tailscale — não depende de Obsidian mobile/sync. |

---

## 11. Roadmap em fases

### 11.1 Fase 1 — Storage adapter (MinIO)

- Criar `app/server/storage/{index,local,s3}.mjs` com a interface `VaultStore`.
- Trocar `fs` por `store` em `vault-api.mjs` e `agent.ts` (mantendo `sanitize*`).
- `/files/*` → presigned URL (S3) mantendo Range/ETag; `stream()` para o modo local.
- Remover/condicionar o glob de build em `src/vault.ts`.
- Env `VAULT_STORAGE` + `MINIO_*`; ajustar `Dockerfile`/`docker-compose.yml` (sem volume do vault, sem git); habilitar **versioning** no bucket.

**Critério de aceite**: o app lê/escreve `.md` e anexos no MinIO, sem autocommit git, com undo por versão.

### 11.2 Fase 2 — Postgres + lembretes

- Adicionar driver (`pg` + `node-pg-migrate` ou Drizzle) e aplicar o schema (§7.6).
- Novos endpoints: `/api/reminders/*`.
- Novas tools do agente: `criar_lembrete`, `listar_lembretes`.
- Tela `Lembretes` no front (pendente).

**Critério de aceite**: cria e lista lembretes pelo terminal, com os dados vindos do Postgres.

### 11.3 Fase 3 — Evolution WhatsApp + scheduler

- `app/server/evolution.ts` (cliente) + rota `POST /api/evolution/webhook`.
- `app/server/scheduler.ts`: loop/cron lê `lembretes` devidos e envia via Evolution.
- Mapear mensagem → gatilho determinístico (spec) ou `runAgent`.
- Configurar o webhook da Evolution apontando para o Node; whitelist.

**Critério de aceite**: mandar `ideia: …`/`✅ feito: …`/anexo no WhatsApp e receber a confirmação; lembrete dispara no horário.

### 11.4 Fase 4 — Alinhamento com a spec + hardening

- Ajustar regras do agente (gatilhos, confirmação).
- Observabilidade: logs do webhook, idempotência de mensagem (evitar nota duplicada).
- Revisão de segurança (chaves em env, CORS do webhook, rate limit).

**Critério de aceite**: fluxo ponta a ponta confiável, com anexos (PDF e imagem), sem duplicações e com logs auditáveis.

---

## 12. Decisões em aberto / Perguntas pendentes

Nenhuma decisão aberta. Fechadas em 2026-11-06:

1. **Lembretes**: só mensagem WhatsApp. Google Calendar fica fora.
2. **Anexos**: sem leitura automática (nem visão, nem OCR). O arquivo vai para `COMPROVANTES_DIR` sem passar pelo LLM.
3. **Backup do vault**: só o versioning do bucket, sem espelho git local.
4. **Financeiro**: sai da spec; volta no futuro como tool separada.

---

## 13. Investimentos

Módulo em `/investimentos` para acompanhar ações da B3 e medir se as decisões dão resultado. A Tania **nunca executa ordens nem acessa a corretora**: a carteira real só registra o que o usuário informa, e sugestão de IA não é recomendação profissional.

### 13.1 Escopo

- Só ações da B3, sem FII, ETF ou exterior.
- Três carteiras: `real`, `agente` (só dados de mercado) e `agente_relatorios` (mercado + recomendações dos relatórios). Comparadas entre si, com Ibovespa e com CDI, por rentabilidade em cotas: aporte não conta como ganho.
- Registro pelo site e pelo WhatsApp/terminal (tools `investimentos_*`). Compra sem caixa gera o aporte que faltava.
- Aporte e retirada da carteira real são espelhados nas fictícias: mesmo valor, mesma data.
- Lista "Acompanhando": ações salvas para ver no dashboard com preço e variação no dia e em 30 dias, pelo site ou pela tool `investimentos_acompanhar`. É só observação: os agentes fictícios não a leem e ela não cria alertas.

### 13.2 Modelo de dados (`migrations/003_investimentos.sql`, `004_acompanhadas.sql`)

Schema `investimentos`. A carteira é um livro de `movimentos`: caixa, posições e rentabilidade são calculados dele, então lançamento retroativo funciona. Demais tabelas: `carteiras`, `ordens`, `cotacoes`, `ultimos`, `indicadores`, `alertas`, `acompanhadas`, `relatorios`, `analises` e `rotinas` (trava de execução).

### 13.3 Rotinas (`server/investimentos-rotinas.mjs`, horário de São Paulo, dias úteis)

| Quando | O quê |
|---|---|
| 10h-18h, a cada 30 min | Preços das ações em uso e alertas (no máximo um por regra e cinco por dia). |
| 18h30 (repete a cada 30 min até 22h se faltar dado) | Histórico, CDI e proventos; ordens do dia anterior pela abertura de hoje; decisões dos agentes; resumo no WhatsApp. |

Sem pregão no dia (feriado), não há decisão. Sem `BRAPI_TOKEN`, as rotinas ficam desligadas.

### 13.4 Agentes

- **Fictícios:** chamada única ao LLM, sem ferramentas, que devolve ordens em JSON. Não veem a carteira real nem ordens uns dos outros. Só `agente_relatorios` recebe as recomendações extraídas.
- **Simulador é código, não IA** (`investimentos-calc.mjs`): valida ticker do universo, caixa e posição, aplica o preço de abertura do pregão seguinte e taxa de 0,03%. Até 5 ordens por dia.
- **Analista:** é a Tania, com as tools `investimentos_*`, mais o resumo diário.
- **Leitor de relatórios:** chamada sem ferramentas que só extrai resumo e recomendações. O texto é tratado como dado, e o resto do sistema só recebe campos validados. O texto vai para o provedor de LLM ativo: conferir os termos da assinatura.

### 13.5 Dados externos

- Cotações, histórico e proventos: [brapi](https://brapi.dev), com `BRAPI_TOKEN`. Plano gratuito: 30 min de atraso, 15 mil requisições por mês, 3 meses de histórico, um ticker por requisição. O histórico mais longo se forma no banco.
- CDI: SGS do Banco Central, série 12.

### 13.6 API

`/api/investimentos/`: `resumo` (GET), `movimentos` (GET, POST, DELETE `/:id`, só carteira real), `ordens` (GET), `analises` (GET), `alertas` (GET, POST, DELETE `/:id`), `acompanhadas` (GET, POST valida o ticker na brapi, DELETE `/:ticker`) e `relatorios` (GET, POST com texto colado).

### 13.7 Limitações conhecidas

- Desdobramentos e grupamentos não são ajustados: exigem correção manual.
- Provento usa os dados da brapi: JCP com 15% retidos, sem cálculo de imposto de venda.
- Relatório entra como texto colado. PDF e leitura automática dependem do serviço assinado.
- Importação de nota de corretagem fica para depois.

---

## Apêndice A — Exemplos concretos (mensagem → ação → resposta)

| # | Mensagem do usuário (WhatsApp) | Gatilho | Ação | Resposta da Tania (via Evolution `sendText`) |
|---|---------------------|---------|------|-------------------|
| 1 | `💡 automatizar a captura de ideias` | 💡 | cria `Ideias/2026-10-31-automatizar-a-captura-de-ideias.md` (MinIO) | "💾 Ideia salva em `Ideias/2026-10-31-automatizar-a-captura-de-ideias.md`" |
| 2 | `ideia: escrever artigo sobre produtividade` | ideia: | cria `Ideias/2026-10-31-escrever-artigo-sobre-produtividade.md` (MinIO) | "💾 Ideia salva em `Ideias/2026-10-31-escrever-artigo-sobre-produtividade.md`" |
| 3 | `✅ fechei a planilha do mês` | ✅ | append em `01-Diario/2026-10-31.md` → `- 15:47 — fechei a planilha do mês` | "✅ Registrado em `01-Diario/2026-10-31.md`" |
| 4 | `feito: enviei o relatório` | feito: | append em `01-Diario/2026-10-31.md` | "✅ Registrado em `01-Diario/2026-10-31.md`" |
| 5 | `me lembra amanhã às 9h de ligar para o contador` | — (agente) | cria lembrete em `lembretes` (Postgres) | "⏰ Lembrete criado para 01/11 às 09:00" |
| 6 | [número fora da whitelist] | — | ignora + log (Evolution recusa por padrão) | *(sem resposta)* |

---

## Apêndice B — Glossário

- **VaultStore**: camada de abstração de storage; implementações `LocalFsStore` (filesystem) e `S3Store` (MinIO).
- **MinIO**: object storage compatível com S3; guarda as notas `.md` e anexos como **object keys** num bucket com **versioning**.
- **Object key**: caminho de um objeto no bucket (ex.: `Ideias/2026-10-31-ideia.md`); substitui o "arquivo numa pasta" no modo MinIO.
- **Presigned URL**: URL assinada de curta duração para acessar um objeto do MinIO sem expor credenciais.
- **Postgres**: banco relacional; fonte de verdade para lembretes, usuários, configurações e investimentos.
- **Evolution API**: ponte WhatsApp (Baileys) que expõe REST + webhook para receber/enviar mensagens.
- **Agente (do front)**: `server/agent.ts` — cérebro type-safe com tools + fluxo plano→aprovação + validação de regras. *(O Hermes Agent não é o cérebro; seria apenas opcional/complementar.)*
- **Vault**: conjunto de notas `.md` armazenadas como object keys no MinIO (front "Obsidian web" lê/edita).
- **Whitelist**: lista de números/IDs de chat autorizados a interagir com o assistente.

---

*Fim do documento. Revisar as decisões em aberto (seção 12) antes de fechar a v1.*

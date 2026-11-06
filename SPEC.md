# SPEC — Tania_Assistente

> **Documento de especificação de produto/software**
> Status: Rascunho v2.0 (arquitetura travada)
> Data: 2026-10-31
> Idioma: pt-BR

---

## Resumo executivo

- **Tania_Assistente** é um assistente pessoal **sempre ligado (24/7)** que recebe mensagens do usuário, **lembra do trabalho dele** e **executa ações** (não apenas conversa): captura ideias, registra tarefas concluídas e lança recebimentos de aluguel.
- Stack: **agente próprio** (`Tania_Assistente/app/server/agent.ts`, type-safe com tools + fluxo plano→aprovação + validação de regras) + **DeepSeek** (LLM substituível por OpenRouter/Ollama via `agent.config.json`) + **front "Obsidian web"** (`Tania_Assistente/front`, React+Vite+TS, com terminal do agente).
- **Storage das notas `.md`:** **MinIO** (bucket S3 com **versioning**) através da camada `VaultStore` (`LocalFsStore` + `S3Store`). As "pastas" do vault viram **object keys** no bucket.
- **Dados estruturados:** **Postgres** (imóveis, inquilinos, contratos, pagamentos, lembretes). Consultas financeiras/Carnê-Leão viram **SQL**, não mais parse de markdown.
- **API única:** o servidor Node do front concentra front, agente e webhook. Novos endpoints: `/api/finance/*`, `/api/reminders/*` e `/api/evolution/webhook`.
- **Canal principal: WhatsApp via Evolution API** (ponte Baileys), com **whitelist de números obrigatória** (o gateway recusa tudo até a lista ser configurada; o Node reforça). Telegram fica como **alternativa/contingência**.
- **Classificação por gatilhos simples** para evitar erro de classificação: `💡`/`ideia:` → `Ideias/`; `✅`/`feito:` → nota do dia em `01-Diario/YYYY-MM-DD.md`; comprovante encaminhado → `Financeiro/` + lançamento no Postgres. **Sempre confirmar onde salvou.**
- **Financeiro**: registrar recebimento de aluguel apenas a partir de **comprovante de Pix/pagamento** (boleto NÃO é comprovante). O agente **não tem acesso à conta bancária** — só lê o comprovante e anota data, inquilino, imóvel e valor.
- **Lembretes**: tabela `lembretes` no Postgres + **scheduler** no Node que dispara via WhatsApp. Google Calendar fica como opcional.
- **Privacidade crítica**: a API do DeepSeek processa dados em servidores de terceiros; comprovantes contêm CPF/dados de inquilinos. Considerar **OCR local** / modelo separado para a parte financeira.
- **Riscos já mapeados**: banimento do WhatsApp (número pré-pago + whitelist); DeepSeek pode não ler imagens (exige OCR/modelo com visão — validar); vazamento de CPF a terceiros.

---

## 1. Visão e Objetivo

### 1.1 O que é

Tania_Assistente é um **assistente pessoal de execução** — não um chatbot. Ele permanece ativo 24/7, recebe mensagens curtas do usuário pelo WhatsApp (via Evolution API) e, em vez de apenas responder, **executa ações**: salva notas (MinIO), registra lançamentos financeiros (Postgres) e dispara lembretes.

O nome "Tania" refere-se à **persona do assistente**: uma figura que acompanha o trabalho do usuário, lembra do contexto e age em nome dele sobre um conjunto bem delimitado de operações.

### 1.2 Para quem

- O **usuário principal (dono)** — uma pessoa física que:
  - Captura ideias e tarefas ao longo do dia, inclusive fora do computador (via celular/WhatsApp).
  - Administra **aluguéis de imóveis** (pessoa física) e precisa registrar recebimentos para o **Carnê-Leão**.
  - Usa o **front "Obsidian web"** (`Tania_Assistente/front`) como base de notas, com o terminal do agente embutido.
  - Valoriza privacidade e controle sobre os próprios dados (por isso mantém a infra própria: MinIO + Postgres).

### 1.3 O problema que resolve

1. **Fricção de captura**: boas ideias e tarefas se perdem entre o celular e o computador. Hoje, o usuário precisa abrir o front, navegar até a pasta certa e formatar a nota — passos demais para uma captura rápida.
2. **Esquecimento do trabalho**: sem registro, o usuário perde o fio do que fez no dia e do que ficou pendente.
3. **Controle de aluguéis manual e propenso a erro**: recebimentos anotados em lugares dispersos dificultam o Carnê-Leão. A Tania centraliza em **Postgres** (fonte de verdade consultável por SQL) e mantém um espelho legível em nota.

### 1.4 Princípio central

> **A Tania anota e organiza com autonomia; nada é apagado e o bucket guarda as versões.** O assistente tem um escopo de escrita restrito ao bucket do vault (MinIO) e a um conjunto fixo de tabelas (Postgres), e nunca toca em contas bancárias nem faz transações.

---

## 2. Metas e Não-metas (Goals / Non-goals)

### 2.1 Metas (dentro do escopo)

| ID | Meta |
|----|------|
| G1 | Receber mensagens 24/7 via canal principal (WhatsApp/Evolution) e opcional (Telegram). |
| G2 | Classificar mensagens por gatilhos simples e confiáveis, sem exigir que o usuário "pense" na estrutura. |
| G3 | Gravar notas `.md` no MinIO (object keys) com estrutura de pastas determinística. |
| G4 | Registrar recebimentos de aluguel (data, inquilino, imóvel, valor) a partir de comprovantes, no Postgres. |
| G5 | Responder a consultas sobre o histórico financeiro (ex.: "quanto recebi em outubro?") via SQL. |
| G6 | Confirmar, a cada ação, **o quê** foi salvo e **onde**. |
| G7 | Manter memória do trabalho do usuário (o que ele está fazendo/fez) entre mensagens. |
| G8 | Funcionar com custo operacional baixo (VPS barata ou PC próprio; LLM pago conforme uso). |
| G9 | Criar e disparar **lembretes** (tabela `lembretes` + scheduler) via WhatsApp. |

### 2.2 Não-metas (FORA do escopo — explícito)

| ID | Não-meta | Justificativa |
|----|----------|---------------|
| NG1 | **Acesso a conta bancária** (ler saldo, extrato, fazer Pix, conciliar automaticamente). | Risco e responsabilidade desproporcionais. A Tania só lê o comprovante enviado pelo usuário. |
| NG2 | **Contabilidade completa / emissão de guias do Carnê-Leão ou DARF**. | A Tania registra e consulta; o cálculo e o envio do imposto ficam com o usuário/contador. |
| NG3 | **Gestão completa de inquilinos** (cobrança, negociação de contrato, envio de mensagens a inquilinos). | O sistema guarda **cadastro mínimo** (nome, CPF, contato, contrato) para referenciar pagamentos; não é um sistema de gestão de locação. |
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
- **Limite de autonomia**: nunca inventa valores, datas ou dados de inquilino. Se faltar informação, pergunta.

### 3.2 O usuário (dono)

- Pessoa física, dona de imóveis alugados (2+ imóveis, com inquilinos e valores distintos).
- Usa o celular como principal ponto de captura (mensagens curtas durante o dia, via WhatsApp).
- Precisa do **Carnê-Leão** (imposto mensal sobre renda de aluguel de PF) — portanto precisa de um histórico confiável de recebimentos.
- Não quer perder tempo formatando notas; quer que a Tania faça isso por ele.

### 3.3 Fluxo de uso típico (narrativa)

1. Durante o dia, o usuário tem uma ideia → envia `💡 ...` pelo **WhatsApp** (Evolution).
2. A Tania salva em `Ideias/` (objeto no MinIO) e responde: "💾 Ideia salva em `Ideias/2026-10-31-ideia-sobre-X.md`".
3. Ao terminar uma tarefa → envia `✅ ...`.
4. A Tania anexa à nota do dia em `01-Diario/2026-10-31.md` e confirma.
5. Um inquilino paga o aluguel → o usuário **encaminha o comprovante de Pix**.
6. A Tania extrai data/inquilino/imóvel/valor (via OCR/visão), **lança no Postgres** (tabela `pagamentos`), guarda o comprovante no MinIO e atualiza a nota `Financeiro/Aluguéis 2026.md` (espelho). Responde: "Salvei R$ 1.800 da Casa 2 em Aluguéis 2026".
7. No fim do mês → "quanto recebi em outubro?" → a Tania consulta `pagamentos` via SQL e responde.

---

## 4. Arquitetura

### 4.1 Visão geral dos componentes

| Componente | Papel | Onde / Observações |
|------------|-------|-------------|
| **Front "Obsidian web"** | Interface de leitura/edição das notas `.md` + **terminal do agente**. | `app/src/` (React + Vite + TS). |
| **API + agente** | **Única porta de entrada**: CRUD do vault, ferramentas do agente, webhook e scheduler. | `app/server/` (Node 24: `server.mjs` + `vault-api.mjs` + `agent.ts`). |
| **VaultStore** | Abstração de storage: `LocalFsStore` (dev/fallback) e `S3Store` (MinIO). | `app/server/storage/` (novo). |
| **MinIO** | Bucket com as notas `.md` + anexos. **Versioning = "undo"**. | Servidor do usuário. |
| **Postgres** | Dados estruturados: imóveis, inquilinos, contratos, pagamentos, lembretes. | Servidor do usuário. |
| **Evolution API** | Ponte WhatsApp (Baileys); recebe/envia via REST + webhook. | Servidor do usuário (já subida). |
| **DeepSeek (LLM)** | Modelo de linguagem que interpreta intenção, extrai dados e gera respostas. | Substituível por OpenRouter/Ollama via `agent.config.json`. |
| **Camada de OCR/Visão** | Extrai texto de comprovantes (PDF/imagem). | A definir (seção 12): modelo com visão ou OCR local. |
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
        OCR["Camada OCR/Visão<br/>(comprovantes)"]
    end

    API --> ST
    API --> PG[("Postgres<br/>imoveis · inquilinos · contratos<br/>pagamentos · lembretes")]
    API --> LLM
    API --> OCR
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
    F -- "comprovante (PDF/imagem)" --> I["OCR/visão → registrar pagamento (Postgres) + comprovante (MinIO)"]
    F -- "consulta (quanto recebi...?)" --> J["SQL em pagamentos e responder"]
    F -- "nenhum gatilho" --> K["Agente (LLM) interpreta / pede dado faltante"]

    G --> L["Confirmação via sendText"]
    H --> L
    I --> L
    J --> L
    K --> L
```

### 4.4 Descrição textual do fluxo

1. **Entrada**: o usuário envia uma mensagem (texto, PDF ou imagem) ao número WhatsApp.
2. **Recepção**: a Evolution API chama `POST /api/evolution/webhook` no Node.
3. **Autorização**: o Node aplica a **whitelist** (`WHATSAPP_ALLOWED_NUMBERS`). Remetente fora da lista é **ignorado e logado** (a Evolution já recusa tudo por padrão; o Node reforça).
4. **Roteamento**: classificação por **gatilho explícito** (determinístico), antes de qualquer LLM:
   - `💡` / `ideia:` → criar nota em `Ideias/` (MinIO);
   - `✅` / `feito:` → anexar à nota do dia `01-Diario/YYYY-MM-DD.md` (MinIO);
   - **anexo de comprovante** (PDF/imagem) → OCR/visão + registrar pagamento (Postgres) + guardar comprovante (MinIO);
   - **pergunta de consulta** (padrão "quanto recebi...") → SQL em `pagamentos`;
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
- **FR-11 [P0]** **Anexos de comprovante** (PDF ou imagem) devem ser classificados como **registro financeiro** (e nunca como ideia/nota).
- **FR-12 [P1]** Mensagens com padrão de consulta financeira (ex.: "quanto recebi em ...", "quanto recebi no mês X") devem ser classificadas como **consulta**.
- **FR-13 [P0]** A classificação por gatilho deve ter **prioridade sobre a interpretação do LLM** (determinística primeiro, LLM só para o restante).
- **FR-14 [P1]** Se a mensagem não casar com nenhum gatilho, o sistema deve usar o LLM com a memória para interpretar a intenção ou **pedir o dado faltante**.

### 5.4 Escrita de notas e confirmação

- **FR-15 [P0]** Ao salvar uma ideia, o sistema deve criar um `.md` em `Ideias/` (object key no MinIO) com nome de data + slug (ex.: `Ideias/2026-10-31-ideia.md`).
- **FR-16 [P0]** Ao registrar uma tarefa concluída, o sistema deve **anexar** à nota do dia `01-Diario/YYYY-MM-DD.md` (criando o objeto se não existir, usando a data atual no formato `AAAA-MM-DD`).
- **FR-17 [P0]** **Toda ação de escrita deve gerar uma resposta de confirmação** contendo: (a) um resumo do conteúdo salvo e (b) o **caminho/nome do arquivo** onde foi salvo.
- **FR-18 [P0]** A confirmação deve usar formato consistente, ex.: `"Salvei R$ 1.800 da Casa 2 em Aluguéis 2026"`.
- **FR-19 [P1]** O sistema deve evitar sobrescrever conteúdo: ao anexar a uma nota existente, deve **acrescentar** (append) em vez de substituir.
- **FR-20 [P1]** O sistema deve gerar nomes de arquivo sem colisão (sufixo numérico quando necessário).

### 5.5 Registro financeiro de aluguel

- **FR-21 [P0]** Ao receber um **comprovante de Pix/pagamento**, o sistema deve extrair e registrar: **data**, **inquilino**, **imóvel** e **valor**.
- **FR-22 [P0]** O sistema deve **tratar boleto como NÃO comprovante**: ao identificar um boleto (documento que mostra o que *será* pago), deve **não lançar** o recebimento e avisar o usuário que é necessário encaminhar o **comprovante de pagamento**.
- **FR-23 [P0]** O sistema **não deve ter acesso à conta bancária** em nenhuma hipótese (nenhuma credencial bancária, nenhuma integração de extrato/Pix).
- **FR-24 [P0]** O lançamento deve ser registrado no **Postgres** (tabela `pagamentos`: `contrato_id`, `data`, `valor`, `tipo`, `comprovante_url`) como **fonte de verdade**; a nota `Financeiro/Aluguéis 2026.md` (objeto no MinIO) permanece como **espelho de leitura humana**, atualizado pela skill financeira.
- **FR-25 [P0]** Se faltar algum campo (ex.: valor ilegível), o sistema deve **perguntar pelo dado faltante** e só lançar após confirmação do usuário.
- **FR-26 [P1]** O sistema deve **vincular o comprovante** ao lançamento (arquivo em `99-Meta/attachments/comprovantes/AAAA-MM/` no MinIO; vínculo na tabela `comprovantes`, fora do schema `alugueis`). O arquivo não é enviado ao LLM: os dados vêm da legenda ou da conversa.
- **FR-27 [P2]** O sistema deve **detectar recebimentos duplicados** (mesmo valor+inquilino+data em curto intervalo) e pedir confirmação antes de lançar novamente.

### 5.6 Consultas (Carnê-Leão)

- **FR-28 [P0]** O sistema deve responder a consultas como **"quanto recebi em <mês>?"** somando os valores de `pagamentos` no Postgres (SQL com filtro de período).
- **FR-29 [P1]** O sistema deve responder a consultas por **imóvel** (ex.: "quanto a Casa 2 rendeu?") e por **inquilino**.
- **FR-30 [P1]** A resposta de consulta deve incluir o **total** e, opcionalmente, a **lista dos lançamentos** que compõem o total.
- **FR-31 [P2]** O sistema deve conseguir listar **recebimentos pendentes** (imóveis cujo aluguel do mês ainda não foi registrado), com base no cadastro de contratos/valores.

### 5.7 Leitura de comprovantes (PDF / imagem / OCR)

- **FR-32 [P0]** O sistema deve ler **PDF com texto** (texto extraível) e localizar os campos de comprovante.
- **FR-33 [P0]** O sistema deve processar **print/foto de comprovante** (imagem) extraindo texto via **OCR** ou via **modelo com visão**.
- **FR-34 [P0]** O sistema deve **validar previamente** se o modelo configurado (DeepSeek) consegue ler imagens; se não, deve usar **OCR dedicado/local** como fallback. *(validar antes de ir a produção — ver seção 12)*.
- **FR-35 [P1]** O OCR deve ser executado **localmente** quando o comprovante contiver dados sensíveis (CPF), para não enviar esses dados a servidores de terceiros (ver seção 9).

### 5.8 Storage (MinIO / VaultStore)

- **FR-36 [P0]** O sistema deve abstrair o storage atrás da interface **`VaultStore`** (`list`, `read`, `write`, `remove`, `mkdir`, `rename`, `exists`, `stat`, `stream`, `presign`), com duas implementações: **`LocalFsStore`** (dev/fallback) e **`S3Store`** (MinIO).
- **FR-37 [P0]** No **`S3Store`**, as **object keys** devem corresponder aos caminhos lógicos do vault: `list` por prefixo (paginação), `rename` = copy + delete, `mkdir` = no-op.
- **FR-38 [P0]** O bucket MinIO deve ter **versioning habilitado**, como mecanismo de "nunca apagar"/undo — substituindo o autocommit git no modo MinIO.
- **FR-39 [P0]** Anexos devem ser servidos via **presigned URL** (S3) mantendo suporte a Range/ETag; no modo local, via `stream()` em `/files/*`.
- **FR-40 [P1]** As regras de segurança de caminho (`sanitize`, `SKIP_DIRS`) devem continuar válidas; dentro do vault a escrita é livre em qualquer pasta: validam o **caminho lógico**, que vira key no S3 ou path no fs.

### 5.9 Dados estruturados (Postgres) e webhook Evolution

- **FR-41 [P0]** O sistema deve **registrar pagamento** (data, inquilino, imóvel, valor, tipo, comprovante) na tabela `pagamentos` via endpoint `/api/finance/*` e/ou tool `registrar_pagamento`.
- **FR-42 [P0]** O sistema deve **consultar resumo mensal** (Carnê-Leão) via SQL sobre `pagamentos` (soma por mês, com filtro por imóvel/inquilino) — endpoint `/api/finance/*` e/ou tools `consultar_pagamentos`/`resumo_mensal`.
- **FR-43 [P1]** O sistema deve **criar lembrete** (texto, quando, recorrência, canal) na tabela `lembretes` via `/api/reminders/*` e/ou tool `criar_lembrete`.
- **FR-44 [P1]** O sistema deve **listar/consultar lembretes** pendentes (tool `listar_lembretes` / `/api/reminders/*`).
- **FR-45 [P1]** O sistema deve manter **cadastro mínimo** de imóveis, inquilinos e contratos (para referenciar pagamentos), via `/api/finance/*`.
- **FR-47 [P1]** O agente deve atuar como **bibliotecária**: sugerir onde cada nota deve ficar, sem alterar nada, e reorganizar quando pedido, sem aprovação prévia (o plano fica visível no terminal); mover nota atualiza os `[[links]]`.
- **FR-46 [P0]** O sistema deve expor o webhook **`POST /api/evolution/webhook`** para receber mensagens, aplicar whitelist, rotear por gatilho/agente e responder via `sendText` da Evolution.

---

## 6. Requisitos Não-Funcionais (NFR)

> Convenção de IDs: **NFR-nn**.

### 6.1 Disponibilidade e confiabilidade

- **NFR-01** O serviço deve estar **disponível 24/7** (processo supervisor que reinicia em caso de falha; ex.: `systemd` ou `docker --restart unless-stopped` no servidor Node).
- **NFR-02** O tempo de resposta percebido (mensagem → confirmação) deve ser, em condições normais, **≤ 10 s** para ações de captura; ações com OCR podem levar mais (até ~30 s).
- **NFR-03** Falhas em uma mensagem **não devem derrubar o serviço** (isolamento por mensagem, com log e resposta de erro amigável quando aplicável).

### 6.2 Segurança e privacidade

- **NFR-04** Nenhuma **credencial bancária** pode ser armazenada ou solicitada pelo sistema.
- **NFR-05** Chaves/segredos (DeepSeek/OpenRouter, Evolution, MinIO, Postgres) devem ser lidos de **variáveis de ambiente / cofre de segredos**, nunca hardcoded no código ou commitados.
- **NFR-06** Dados sensíveis (CPF em comprovantes) **não devem ser enviados a terceiros** sem necessidade; preferir OCR local para a parte financeira (ver seção 9).
- **NFR-07** O sistema deve registrar **logs** de ações (mensagem recebida, remetente, gatilho, ação, resultado) para auditoria — **sem** registrar o conteúdo integral de comprovantes sensíveis em logs.

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

> **Nota (v2.0):** as "pastas" abaixo **não são mais diretórios físicos** — são **object keys (prefixos) no bucket MinIO**. Os dados estruturados (aluguéis, inquilinos, contratos, lembretes) **não vivem em markdown**: vivem no **Postgres** (ver §7.6). O markdown continua para notas livres e como espelho de leitura humana.

### 7.1 Árvore de object keys (bucket MinIO)

```
tania-vault/                         ← bucket
├── Ideias/
│   ├── 2026-10-31-ideia-automatizar-captura.md
│   └── 2026-11-01-ideia-tema-de-artigo.md
├── 01-Diario/
│   ├── 2026-10-31.md
│   └── 2026-11-01.md
├── Financeiro/
│   ├── Aluguéis 2026.md            ← espelho anual legível (Carnê-Leão)
│   └── comprovantes/
│       ├── 2026-10-31-casa2-pix.pdf
│       └── 2026-10-30-casa1-pix.png
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
- 15:47 — Enviei a vistoria da Casa 2

## 📝 Notas
- <itens opcionais>
```

> Regra: cada `✅`/`feito:` gera uma linha `- HH:MM — <texto>` na seção `## ✅ Feito`.

### 7.4 Template de nota financeira — Aluguéis

Arquivo (object key): `Financeiro/Aluguéis 2026.md` (espelho anual; fonte de verdade no Postgres)

```markdown
# 💰 Aluguéis 2026

> Espelho de leitura humana. Fonte de verdade: tabela `pagamentos` no Postgres.
> Boleto NÃO é comprovante.

| Data | Inquilino | Imóvel | Valor (R$) | Comprovante |
|------|-----------|--------|------------|-------------|
| 2026-10-31 | João Silva | Casa 2 | 1.800,00 | [[comprovantes/2026-10-31-casa2-pix.pdf]] |
| 2026-10-30 | Maria Souza | Casa 1 | 2.200,00 | [[comprovantes/2026-10-30-casa1-pix.png]] |

## Totais por mês
- Outubro/2026: R$ 4.000,00
```

> A skill financeira **registra no Postgres** (fonte de verdade) e **atualiza este espelho** (insere linha na tabela e ajusta os totais), preservando o que já existe.

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

Fonte de verdade para financeiro e lembretes. Schema completo no `PLANO-ADAPTACAO.md` §5.

| Tabela | Campos-chave |
|--------|--------------|
| `imoveis` | `id`, `apelido`, `endereco`, `created_at` |
| `inquilinos` | `id`, `nome`, `cpf`, `contato`, `created_at` |
| `contratos` | `id`, `imovel_id`, `inquilino_id`, `valor`, `vencimento`, `vigencia_inicio/fim`, `ativo` |
| `pagamentos` | `id`, `contrato_id`, `data`, `valor`, `tipo`, `comprovante_url`, `observacao`, `origem`, `created_at` |
| `lembretes` | `id`, `texto`, `quando`, `recorrencia`, `canal`, `status`, `created_at` |
| `usuarios` | `id` (uuid), `username` (único sem diferenciar maiúsculas), `senha_hash` (argon2id), `admin`, `ativo`, `criado_em`, `atualizado_em` |
| `agentes_config` | `id` = 1 (uma linha), `config` jsonb `{active, providers}` (provedores do agente LLM), `atualizado_em`, `atualizado_por` |
| `configuracoes` | `chave` (pk, lista fixa em `backend/src/settings/keys.rs`), `valor` (segredo = `v1:` AES-256-GCM), `segredo`, `atualizado_em`, `atualizado_por` |
| `sessoes` | `token_hash` (sha256 do token, pk), `usuario_id` → `usuarios` (cascade), `criado_em`, `expira_em` |

> **Usuários e sessões:** criadas pelo backend Rust (`backend/migrations/100_usuarios.sql`), registradas na mesma `schema_migrations` do Node (versões `100_`+ são do Rust). Spec: `docs/superpowers/specs/2026-11-05-usuarios-tokens-design.md`.
>
> **Aluguéis:** imóveis, inquilinos, contratos e recebimentos ficam no schema `alugueis` (ids uuid), cujo dono é `api_assistente_alugueis` (Alembic, doc em `docs/API.md` de lá). `server/finance.mjs` lê e grava direto nele; recebimento é lançamento de `alugueis.extrato` na categoria "Aluguel recebido". As tabelas `public.imoveis/inquilinos/contratos/pagamentos` da tabela acima estão fora de uso.

Consulta de Carnê-Leão vira SQL trivial, ex.:
`select sum(valor) from pagamentos where data between '2026-10-01' and '2026-10-31';`

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

## 8. Configuração

### 8.1 Variáveis de ambiente

| Variável | Descrição | Exemplo |
|----------|-----------|---------|
| `VAULT_AUTH` | Só o **Node legado** (produção atual): `usuário:senha` do login. O backend Rust não usa; lá o login é por usuário no Postgres. | `usuario:senha` |
| `TANIA_BOOTSTRAP_ADMIN` | Backend Rust: `usuário:senha` do admin criado na subida **só se** a tabela `usuarios` estiver vazia. O compose local usa `admin:admin`; produção não deve definir. | `admin:admin` |
| `TANIA_CONFIG_KEY` | 32 bytes em base64 (Rust e Node): cifra (AES-256-GCM) os segredos salvos em ⚙ Configurações. Sem ela, só valores não secretos podem ser salvos. | `head -c 32 /dev/urandom \| base64` |
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
- **DeepSeek**: provedor padrão. Suporta texto; **verificar suporte a imagem/visão** antes de usar para comprovantes.
- **OpenRouter**: roteador com múltiplos modelos (inclui modelos com visão). Útil como fallback para leitura de imagens.
- **Ollama (local)**: modelo no próprio PC/VPS; ideal para **privacidade** (comprovantes/CPF) e custo zero por token.

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
| **Dados em servidores de terceiros** | A API do DeepSeek processa mensagens e comprovantes nos servidores deles. | Não enviar dados sensíveis desnecessariamente; considerar **modelo local (Ollama) para a parte financeira**; revisar a política de dados do provedor. |
| **CPF/dados de inquilinos em comprovantes** | Comprovantes contêm CPF e dados pessoais de terceiros. | **OCR local** para extrair campos; **não** enviar o comprovante bruto à API de visão de terceiro quando houver dados sensíveis; minimizar o que vai para o LLM. |
| **Segredos expostos** | Vazamento de chaves DeepSeek/Evolution/MinIO/Postgres. | Segredos via variáveis de ambiente/cofre; nunca commitá-los; restringir a apikey da Evolution. |
| **Acesso indevido ao bot** | Alguém fora da whitelist envia mensagens. | Whitelist obrigatória; recusa silenciosa; comando `/allow` restrito ao dono. |
| **Escrita acidental / sobrescrita** | A Tania corromper notas no MinIO ou lançamentos no Postgres. | Append em vez de sobrescrever; nomes sem colisão; **versioning do bucket** como undo; confirmação do que foi salvo. |

### 9.2 Políticas de privacidade recomendadas

1. **Separar tráfego sensível**: financeiro/comprovantes → processamento **local** (Ollama + OCR local); ideias/agenda → pode ir ao DeepSeek.
2. **Minimização de dados**: enviar ao LLM apenas o texto necessário (campos extraídos), não o comprovante inteiro.
3. **Retenção de logs**: logs sem conteúdo sensível; comprovantes arquivados no MinIO (não em serviços de terceiros).
4. **Consentimento de terceiros**: informar que comprovantes com dados de inquilinos são processados localmente; evitar expor dados de terceiros a serviços externos.

---

## 10. Riscos e Mitigações (tabela consolidada)

| # | Risco | Probabilidade | Impacto | Mitigação |
|---|-------|---------------|---------|-----------|
| R1 | **DeepSeek não lê imagens** (print/foto de comprovante). | Alta | Alto (FR-33 inviabilizado) | Validar **antes**; usar modelo com visão via OpenRouter ou **OCR local** como fallback. |
| R2 | **Banimento do WhatsApp**. | Média | Médio | Número pré-pago separado; whitelist obrigatória; Telegram como contingência; manter WhatsApp desligável. |
| R3 | **Vazamento de dados sensíveis (CPF) a terceiros**. | Média | Alto | OCR local; modelo separado para financeiro; minimização de dados. |
| R4 | **Classificação errada** (mensagem salva no lugar errado). | Média | Médio | Gatilhos determinísticos e simples; confirmação sempre; fácil correção (editar objeto `.md`). |
| R5 | **Boleto confundido com comprovante** (lançamento indevido). | Média | Alto (erro fiscal) | Regra explícita: boleto ≠ comprovante; avisar o usuário e não lançar. |
| R6 | **Falha de disponibilidade** (VPS/PC desligado, crash). | Média | Médio | Supervisor + restart automático; alerta de gateway desconectado. |
| R7 | **Duplicidade de lançamento financeiro**. | Média | Médio | Detecção de duplicados (P2); idempotência; confirmação. |
| R8 | **Custo de API crescente** (uso intenso). | Baixa | Baixo | Fallback Ollama local; modelo mais barato para tarefas simples. |
| R9 | **Acesso às notas no celular**. | Média | Médio | O front "Obsidian web" é acessível pelo navegador via Tailscale — não depende de Obsidian mobile/sync. |
| R10 | **Dependência da qualidade do OCR** (valor/data ilegíveis). | Média | Médio | Perguntar dado faltante; nunca adivinhar (FR-25). |

---

## 11. Roadmap em fases

### 11.1 Fase 1 — Storage adapter (MinIO)

- Criar `app/server/storage/{index,local,s3}.mjs` com a interface `VaultStore`.
- Trocar `fs` por `store` em `vault-api.mjs` e `agent.ts` (mantendo `sanitize*`).
- `/files/*` → presigned URL (S3) mantendo Range/ETag; `stream()` para o modo local.
- Remover/condicionar o glob de build em `src/vault.ts`.
- Env `VAULT_STORAGE` + `MINIO_*`; ajustar `Dockerfile`/`docker-compose.yml` (sem volume do vault, sem git); habilitar **versioning** no bucket.

**Critério de aceite**: o app lê/escreve `.md` e anexos no MinIO, sem autocommit git, com undo por versão.

### 11.2 Fase 2 — Postgres + financeiro + lembretes

- Adicionar driver (`pg` + `node-pg-migrate` ou Drizzle) e aplicar o schema (§7.6).
- Novos endpoints: `/api/finance/*` (imóveis, inquilinos, contratos, pagamentos, resumo mensal) e `/api/reminders/*`.
- Novas tools do agente: `registrar_pagamento`, `consultar_pagamentos`, `resumo_mensal`, `criar_lembrete`, `listar_lembretes`.
- Telas no front: **`Financeiro`** (rota `/financeiro`: cadastro de imóveis e inquilinos, contratos, lançamento de recebimento e resumo do mês — mesma tela alimenta o Postgres que as tools usam) e `Lembretes` (pendente).

**Critério de aceite**: registra pagamento pelo terminal e responde "quanto recebi em outubro?" com total vindo do Postgres.

### 11.3 Fase 3 — Evolution WhatsApp + scheduler

- `app/server/evolution.ts` (cliente) + rota `POST /api/evolution/webhook`.
- `app/server/scheduler.ts`: loop/cron lê `lembretes` devidos e envia via Evolution.
- Mapear mensagem → gatilho determinístico (spec) ou `runAgent`.
- Configurar o webhook da Evolution apontando para o Node; whitelist.

**Critério de aceite**: mandar `ideia: …`/`✅ feito: …`/comprovante no WhatsApp e receber a confirmação; lembrete dispara no horário.

### 11.4 Fase 4 — Alinhamento com a spec + hardening

- Ajustar regras do agente (gatilhos, confirmação, boleto ≠ comprovante, Carnê-Leão).
- OCR/visão para comprovantes (validar leitura de imagem; OCR local para CPF).
- Observabilidade: logs do webhook, idempotência de mensagem (evitar lançamento duplicado).
- Revisão de segurança (chaves em env, CORS do webhook, rate limit).

**Critério de aceite**: fluxo ponta a ponta confiável, com comprovantes (PDF e imagem), sem duplicações e com logs auditáveis.

---

## 12. Decisões em aberto / Perguntas pendentes

> Pendências reais que **não bloqueiam as Fases 1–2**, mas precisam ser resolvidas antes de fechar v1.

1. **Lembretes**: só mensagem WhatsApp (zero dependência) ou também espelhar no **Google Calendar** (view/push nativo)?
2. **Comprovantes com visão**: usar **modelo com visão** na própria API do DeepSeek (dados vão para terceiros) ou **OCR local** (mais privado)?
3. **Espelho git**: manter um **mirror local do bucket** como backup extra, ou confiar **só no versioning do MinIO**?

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
| 2 | `ideia: escrever artigo sobre imóveis` | ideia: | cria `Ideias/2026-10-31-escrever-artigo-sobre-imoveis.md` (MinIO) | "💾 Ideia salva em `Ideias/2026-10-31-escrever-artigo-sobre-imoveis.md`" |
| 3 | `✅ fechei a planilha do mês` | ✅ | append em `01-Diario/2026-10-31.md` → `- 15:47 — fechei a planilha do mês` | "✅ Registrado em `01-Diario/2026-10-31.md`" |
| 4 | `feito: enviei a vistoria` | feito: | append em `01-Diario/2026-10-31.md` | "✅ Registrado em `01-Diario/2026-10-31.md`" |
| 5 | [encaminha `comprovante-pix-casa2.pdf`] | comprovante | registra em `pagamentos` (Postgres) + guarda comprovante (MinIO) + atualiza `Financeiro/Aluguéis 2026.md` | "Salvei R$ 1.800 da Casa 2 (João Silva) em Aluguéis 2026" |
| 6 | [encaminha `boleto-casa1.pdf`] | (boleto) | **não lança** | "⚠️ Isso é um boleto (mostra o que *será* pago), não um comprovante. Encaminhe o comprovante de pagamento para eu registrar." |
| 7 | `quanto recebi em outubro?` | consulta | soma outubro em `pagamentos` (SQL) | "Em outubro você recebeu R$ 4.000,00 (Casa 1: R$ 2.200,00 + Casa 2: R$ 1.800,00)." |
| 8 | `qual o valor da Casa 2?` | consulta | filtra por imóvel (SQL) | "A Casa 2 rendeu R$ 1.800,00 em outubro." |
| 9 | [número fora da whitelist] | — | ignora + log (Evolution recusa por padrão) | *(sem resposta)* |

---

## Apêndice B — Glossário

- **VaultStore**: camada de abstração de storage; implementações `LocalFsStore` (filesystem) e `S3Store` (MinIO).
- **MinIO**: object storage compatível com S3; guarda as notas `.md` e anexos como **object keys** num bucket com **versioning**.
- **Object key**: caminho de um objeto no bucket (ex.: `Ideias/2026-10-31-ideia.md`); substitui o "arquivo numa pasta" no modo MinIO.
- **Presigned URL**: URL assinada de curta duração para acessar um objeto do MinIO sem expor credenciais.
- **Postgres**: banco relacional; fonte de verdade para imóveis, inquilinos, contratos, pagamentos e lembretes.
- **Evolution API**: ponte WhatsApp (Baileys) que expõe REST + webhook para receber/enviar mensagens.
- **Agente (do front)**: `server/agent.ts` — cérebro type-safe com tools + fluxo plano→aprovação + validação de regras. *(O Hermes Agent não é o cérebro; seria apenas opcional/complementar.)*
- **Vault**: conjunto de notas `.md` armazenadas como object keys no MinIO (front "Obsidian web" lê/edita).
- **Whitelist**: lista de números/IDs de chat autorizados a interagir com o assistente.
- **Comprovante**: documento que comprova pagamento efetuado (Pix/transferência). **Diferente de boleto.**
- **Boleto**: documento de cobrança que indica valor a pagar; **não** comprova pagamento.
- **Carnê-Leão**: imposto de renda mensal (Brasil) sobre rendimentos de pessoa física, incluindo aluguel.
- **OCR**: reconhecimento ótico de caracteres (extrai texto de imagem).

---

*Fim do documento. Revisar as decisões em aberto (seção 12) antes de fechar a v1.*

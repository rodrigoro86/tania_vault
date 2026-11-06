# Changelog do front

Todas as mudanças relevantes do front (`app/`) ficam aqui.
Formato: [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) · versões em [SemVer](https://semver.org/lang/pt-BR/).
A versão vale em `app/package.json` e aparece no site (rodapé do explorador e dica do contador de notas).

Como versionar: ver [[Versionar-front]] (`04-Agentes/Workflows/Versionar-front.md`).

## [Não lançado]

### Alterado
- 🔓 Preparação para repositório público: a identidade visual de terceiros saiu (exportações viram "PDF com capa" e "Word com capa", com logo genérico em `public/brand/logo.png` e `logo-capa.png`); dados de exemplo dos testes ficaram fictícios; o domínio do deploy vem de `APP_DOMAIN` (variável do GitHub). O modelo de slides no vault passa a ser `99-Meta/attachments/Apresentacoes/Modelo-apresentacao.html`.
- ⚙ Configurações: sai o grupo Investimentos (`BRAPI_TOKEN` continua valendo pelo `.env`) e entra **ClickUp** com `CLICKUP_TOKEN` (segredo cifrado), que vence o `token` do `clickup.config.json`; o arquivo segue opcional para `teamId`/`spaceIds`.
- 🎨 Tema novo "petróleo": fundo navy-teal com brilhos, painéis de vidro, cantos arredondados, acento verde-água (azul, roxo e laranja de apoio), item ativo do menu em pílula, KPIs em gradiente e títulos em serifa. A impressão/PDF continua com fundo branco.
- 🐳 Compose: banco (usuário, senha, nome) e bucket (chaves, nome) definidos uma vez só no bloco `x-stack` e repassados ao Postgres, ao RustFS e ao app. Node e Rust aceitam as variáveis padrão `PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE` quando `DATABASE_URL` está vazia.
- 🔒 Front no compose (nginx) exige login: sem sessão válida, qualquer página ou asset redireciona para `/login` (o nginx confere a sessão no backend via `auth_request` em `/api/auth/me`). Só manifest, ícones e marca ficam públicos.
- Rodapé do menu lateral: bolinha com a inicial do usuário logado (abre papel e Sair), o nome e ⚙, que abre 👥 Usuários. O atalho de Usuários saiu da lista do menu.
- Menu lateral: atalhos 💰 Financeiro e 📈 Investimentos escondidos. As telas continuam em `#/financeiro` e `#/investimentos`.
- 🪣 Variáveis do bucket renomeadas de `MINIO_*` para `RUSTFS_*`, e `VAULT_STORAGE=rustfs`. Os nomes antigos (`MINIO_*`, `VAULT_STORAGE=minio`) continuam aceitos, então o `.env` de produção não quebra; `RUSTFS_*` tem prioridade.
- `docker compose up` na raiz não precisa mais de `.env`: admin local `admin` / `admin`, banco e bucket com valores padrão.
- 🔐 Backend Rust: o login deixa de usar `VAULT_AUTH` e passa a ser por usuário no Postgres, com token de sessão revogável (cookie `vault_session` ou `Authorization: Bearer`). O Node legado aceita o que o Rust já autenticou via `LEGACY_PROXY_SECRET`. Produção (só Node) não muda.

### Adicionado
- 🧭 Menu da esquerda em faixa de ícones, como no Obsidian: 📄 Vault (notas), ✅ ClickUp (Painel e Tarefas) e 🤖 Agents (provedores do agente, troca o ativo com um clique). Clicar no ícone ativo recolhe o painel.
- 🤖 Tela Agents (`/agentes`, admin): edita os provedores do agente LLM (URL, modelo, max tokens, chave e ativo). Fica salvo no banco e vale na hora; o `agent.config.json` vira alternativa.
- ↔️ Largura do explorador (esquerda) e do painel da direita ajustável: arraste a borda ou use as setas com a alça em foco; duplo clique volta ao padrão. Fica salva no navegador (só desktop).
- ⚙ Configurações (`/configuracoes`): o admin edita WhatsApp, chaves de LLM, `BRAPI_TOKEN` e rate limit pela tela. Fica salvo no banco (segredos cifrados com `TANIA_CONFIG_KEY`), vence o `.env` e vale depois de "Aplicar e reiniciar".
- 👥 Usuários: tela `/usuarios` (admin cria, edita, desativa e apaga; quem não é admin troca a própria senha) e API `/api/auth/login|logout|me` e `/api/users` no backend Rust. Admin inicial por `TANIA_BOOTSTRAP_ADMIN` (só com a tabela vazia) ou `tania user add <nome> --admin`.
- 🦀 **Backend Rust** (`backend/`), 1ª etapa da migração: fica na frente do Node e repassa tudo a ele (`LEGACY_UPSTREAM`). Sem `VAULT_AUTH`, bloqueia o acesso de fora do localhost. No compose local, o Rust ocupa a porta 3100 e o Node passa para a 3101. Produção não muda.
- 🔐 Login no backend Rust: página, cookie de sessão (o mesmo formato do Node: uma sessão vale nos dois), bloqueio de 15 min após 5 erros e limite de requisições por IP na `/api` (`RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`). O webhook do WhatsApp continua sem login.
- 🗂️ Rotas do vault no backend Rust: notas, pastas, renomear, anexos (`/files/*` com ETag, Range e URL assinada no S3) e envio de arquivos (até 50 MB), com a mesma validação de caminho e o mesmo bloqueio de CSRF do Node. Funciona com disco local e com S3 compatível (RustFS).
- A pasta `backend/` não entra no vault (`SKIP_DIRS`), nem no Node nem no Rust.
- 🐳 `docker-compose.yml` na raiz sobe a stack local inteira: front (nginx, porta 3000), backend Rust, Node legado, Postgres 17 e bucket RustFS (com versioning). Banco e bucket são locais e descartáveis; o schema `alugueis` entra como stub mínimo, então o financeiro local precisa do schema real do `api_assistente_alugueis`.
- `scripts/parity.mjs`: compara as rotas GET do Node e do Rust; `BACKEND_URL` no `npm run dev` manda a API para o backend.

## [0.13.0] — 2026-11-01

### Adicionado
- 👀 **Acompanhando**: lista de ações em Investimentos, com preço e variação no dia e em 30 dias, pelo site ou pelo WhatsApp. Exige a migração `004`.

## [0.12.0] — 2026-11-01

### Adicionado
- 📈 **Investimentos** (`/investimentos`): carteira de ações da B3 com rentabilidade contra Ibovespa e CDI, registro pelo site e pelo WhatsApp, cotações com atraso, alertas, leitura de relatórios e resumo diário da analista.
- 🤖 **Agentes fictícios**: duas carteiras simuladas, uma sem e outra com relatórios, que decidem depois do fechamento e executam na abertura seguinte, com os mesmos aportes da carteira real. Exige `BRAPI_TOKEN` e migração `003`.

## [0.11.0] — 2026-11-01

### Alterado
- 📚 **Bibliotecária**: organiza por tópicos, do geral para o específico (`04-Projetos/Pessoal/Tania/`, `05-Ideias/Casa/Reformar-a-casa.md`), também ao criar nota nova.
- Mapa de pastas alinhado ao vault: `02-Estudos`, `03-Comandos`, `04-Projetos` e `05-Ideias`. O `ideia:` do WhatsApp grava em `05-Ideias/`.
- 📔 **Diário**: um arquivo por dia em `01-Diario/AAAA-MM-DD.md`, com tudo o que foi feito no dia. O `feito:` do WhatsApp grava nele e o agente acrescenta no arquivo do dia em vez de criar outro.

### Corrigido
- `feito:` usava a data UTC e, depois das 21h em São Paulo, caía no dia seguinte.

## [0.10.0] — 2026-11-01

### Alterado
- 🤖 **Agente com autonomia**: no site e no WhatsApp ele mostra o plano e executa, sem pedir aprovação. Saíram `/aprovar`, `/rejeitar` e os botões do terminal.
- Link para nota existente deixou de ser obrigatório e virou aviso, o que trava menos o agente com o vault vazio.

## [0.9.0] — 2026-11-01

### Adicionado
- 📚 **Bibliotecária**: a Tania sugere onde cada coisa deve ficar e reorganiza quando você pede, sempre com plano aprovado. No WhatsApp ela mostra a lista e espera a confirmação.
- Mover nota pelo agente atualiza os `[[links]]` das outras notas.

### Alterado
- Pastas e notas livres em qualquer lugar do vault, inclusive a raiz: saíram `WRITE_DIRS` e `WRITE_ROOTS`, e "type x pasta" virou aviso. Continuam bloqueados `..`, `.git/`, `.obsidian/`, `app/` e similares, arquivos ocultos e o `AGENTS.md`.
- Pasta de primeiro nível pode ser excluída.
- O agente move notas antigas que não seguem o padrão.

## [0.8.0] — 2026-11-01

### Alterado
- 💬 **WhatsApp**: o agente sempre recebe no máximo as 12 últimas mensagens, agora incluindo as de `ideia:` e `feito:`.

### Removido
- Autocommit git do vault (`VAULT_GIT_COMMIT`), o campo `git` das respostas da API e o git da imagem Docker. No modo local, pasta com conteúdo não pode mais ser apagada, pois não há como recuperar.

### Corrigido
- 🗂️ **Pastas**: criar pasta no MinIO não gravava nada e a pasta não aparecia. Agora a pasta vazia é mantida por um arquivo oculto `.keep`.

## [0.7.0] — 2026-10-31

### Adicionado
- A aba aberta recarrega sozinha quando sai versão nova, ao voltar para ela ou a cada 5 minutos. Com formulário aberto ou campo preenchido, espera a próxima verificação.

## [0.6.0] — 2026-10-31

### Adicionado
- 💰 **Aluguéis**: botão **Editar** no Histórico para corrigir contrato, data, mês do aluguel, valor e descrição e para adicionar ou trocar o comprovante. O comprovante também pode ser enviado ao registrar o recebimento. Rota nova `PATCH /api/finance/pagamentos/:id`.
- 💬 **WhatsApp**: tool `editar_pagamento`.

## [0.5.0] — 2026-10-31

### Adicionado
- 💬 **WhatsApp**: imagem ou PDF vira comprovante guardado em `99-Meta/attachments/comprovantes/AAAA-MM/`, ligado ao recebimento pela nova tabela `comprovantes` (migração `002`). O arquivo não vai para o LLM: os dados vêm da legenda ou da conversa. O mesmo comprovante não entra em dois recebimentos.
- 💬 **WhatsApp**: memória de 30 minutos por número, e o agente ganhou `listar_imoveis`, `listar_inquilinos`, `listar_imobiliarias`, `situacao_mes` e `anexar_comprovante`; `consultar_pagamentos` filtra por mês do aluguel e contrato.
- 💰 **Aluguéis**: a aba Histórico voltou a mostrar o link do comprovante. Rota nova `POST /api/finance/comprovantes`.
- 💰 **Aluguéis**: aba **Resumo** (`/financeiro/resumo`) com o total recebido no mês pela data do recebimento, separado por imóvel.

### Alterado
- 💰 **Aluguéis**: qualquer recebimento quita o aluguel do mês, mesmo com valor diferente do contrato; a linha mostra o valor recebido e, abaixo, o do contrato.

## [0.4.0] — 2026-10-31

### Alterado
- 💰 **Aluguéis** (`/financeiro`): a tela abre mostrando quem pagou, quem falta e quem atrasou no mês, por mês de referência, com **Registrar** em cada aluguel. Histórico, contratos, imóveis e inquilinos viraram abas e os formulários abrem em janela. Imóveis mostram para quem estão alugados, CPF/CNPJ aparecem formatados e `GET /api/finance/pagamentos` aceita `mes_referencia=AAAA-MM`.

### Removido
- Sincronia com o GitHub pelo front: botões **⬇ Pull** e **⬆ Push**, estado do git na topbar, `git pull` automático ao abrir o site e as rotas `/api/git/status`, `/api/git/pull` e `/api/git/push`. Os commits automáticos de cada edição continuam, mas ficam só no servidor.

### Corrigido
- 💰 **Financeiro**: a tela, `/api/finance/*` e as tools do agente agora usam o schema `alugueis` (o cadastro real, o mesmo de `api_assistente_alugueis`), com os campos e as regras dele: imóvel com endereço completo, inquilino com CPF/CNPJ, contrato com vigência, imobiliária, índice e IPTU. Recebimentos viram lançamentos da categoria "Aluguel recebido" em `alugueis.extrato`, com mês de referência; o tipo (Pix etc.) e a observação ficam na descrição. O comprovante saiu da lista, porque o extrato não tem esse campo.

### Adicionado
- 💰 **Financeiro** (`/financeiro`, atalho "💰 Financeiro" no explorador): tela para carregar os dados dos aluguéis direto no navegador, sem passar pelo WhatsApp/terminal — cadastro de **imóveis** e **inquilinos**, **contratos** (imóvel + inquilino + valor + dia de vencimento) e **lançamento de recebimento** (contrato, data, valor, tipo e observação; o valor do contrato já vem sugerido) com **resumo do mês** (total, nº de recebimentos e por imóvel, com ◀ ▶ para trocar de mês) e a lista dos recebimentos com link do comprovante. Escreve no mesmo Postgres das tools (`/api/finance/*`), então o que o WhatsApp registra aparece na tela e vice-versa. **Boleto não aparece como tipo**: boleto não é comprovante (o servidor recusa com 422). HTML de data/moeda fica em `src/financeView.ts` (testado em `server/tests/finance-view.test.mjs`: 9 casos de fuso, `numeric` como string, mês/ano da virada e valor digitado em pt-BR — "1.800,00", "R$ 1.800" e "1800.00" viram o mesmo 1800).
- Atalho também no breadcrumb (`🏠 Home / Financeiro`) e no `npm run ssr-smoke` (render da tela sem banco).

### Corrigido
- WhatsApp: mensagens com JID `@lid` eram barradas pela whitelist; agora vale o número real de `remoteJidAlt`.
- `npm run ssr-smoke`: render do `App` quebrava com `localStorage is not defined` (o `App.tsx` lê abas/contexto no estado inicial) e, com o vault vazio, acusava falha em `Properties`/arquivos da sidebar — agora há stub de `localStorage` e as checagens que dependem de nota são puladas com aviso.

## [0.3.1] — 2026-10-27

### Adicionado
- Agente: **`edit_file`** e **`edit_note`** — ajustam trechos (procurar/substituir, tudo ou nada) de um HTML/SVG ou nota existente, sem reenviar o arquivo inteiro; system prompt e AGENTS.md §3.9: atualizar apresentação/documento/nota = editar o mesmo arquivo, nunca criar cópia `-V2`.
- Agente trabalha até terminar: resposta de texto cortada no `max_tokens` é continuada pelo servidor sozinha (até 6 vezes por turno, sem repetir o que já escreveu); teto de passos de 15 para 60 (só contra loop); system prompt proíbe parar para perguntar "posso continuar?". A aprovação do plano antes de escrever continua obrigatória.
- ☑ Tarefas: filtro **Projeto** (pastas do ClickUp, ex.: Projeto Core, CAMPO) e **Lista** dentro do projeto (cliente/frente, ex.: Cliente A); agrupar **por projeto**; espaço/projeto/lista ficam salvos no navegador. Servidor manda as pastas com as listas no `/api/clickup/status` e filtra por `project_ids[]`/`list_ids[]`.
- Agente: `clickup_tasks` aceita `project` e `list` (por nome).
- ☑ Tarefas → **⬇ Relatório** das tarefas filtradas na tela (`src/taskReport.ts`): **Word com capa** (capa com o recorte, ficha, Resumo com indicadores e alertas de atrasadas/sem responsável, Por status, Por responsável, Atrasadas e as tarefas agrupadas como na tela, com link para o ClickUp) ou **Markdown** (nota `type: journal` válida para `01-Agenda/`).
- ☑ Tarefas → ⬇ Relatório → **Apresentação** (`src/taskSlides.ts`): slides reveal.js das tarefas filtradas sobre o modelo oficial (`<head>`, fundo animado e script vêm dele): capa com o recorte, KPIs, por status, por responsável, atrasadas e próximos 7 dias (até 8 linhas por slide, o resto em slides seguintes), pontos de atenção e próximos passos, com link de cada tarefa para o ClickUp. **Abrir** grava em `99-Meta/attachments/Apresentacoes/` e abre numa aba nova; **.html** só baixa.
- ☑ **Painel ClickUp** (`/painel`, `GET /api/clickup/dashboard`): contagem dos cards **abertos** por **pessoa** e por **projeto** (total, atrasadas) — só leitura, nada é fechado no ClickUp. Filtros por espaço/projeto; o agente pode resumir por pessoa/projeto com `summarize` em `clickup_tasks`.
- Word: colunas das tabelas nunca ficam mais estreitas que a palavra mais longa (cabeçalhos e datas não quebram no meio).
- Testes do servidor: casos do painel, dos filtros por pasta/lista e da validação de `spaceIds` — 79 testes, todos passando (`npm test`).

### Corrigido
- ClickUp: `space`, `folder` e `list` fora dos espaços permitidos (`spaceIds`) são recusados (400), e tarefa por id/URL de outro espaço também (403); antes o `spaceIds` não barrava esses dois caminhos.

## [0.3.0] — 2026-10-26

### Adicionado
- Agente — orçamento de contexto (`server/agent/context.ts`):
  - **saída**: `max_tokens` por provedor (`maxTokens` no `agent.config.json`; DeepSeek usa 8192 por padrão em vez dos ~4k da API). Resposta cortada (`finish_reason: length`) não executa a ferramenta (argumentos podem estar pela metade): o agente recebe a recusa e refaz em partes; o usuário vê o aviso no terminal.
  - **leitura**: `read_note` acima de 15 mil caracteres vem em partes, com sumário de seções (`outline`) e `section`/`offset` para o resto; `read_file` com `offset`. Antes o resultado era cortado em 20 mil sem aviso. Nota em foco grande vai no prompt só com o sumário e o começo.
  - **histórico**: resultados de ferramenta e argumentos grandes de turnos antigos viram uma linha; a conversa enviada ao LLM respeita um orçamento (~120 mil caracteres), cortando turnos inteiros pelo começo.
  - system prompt orienta a escrever documento longo em partes (`create_note` + `append_to_note` por seção) e a usar **Word com capa** em vez de gerar HTML de nota longa.
- Documento A4 (HTML) → **⬇ PDF** e **⬇ Word** na barra do anexo HTML (`src/exportHtmlDoc.ts`): o PDF imprime uma cópia sem scripts num iframe `sandbox="allow-same-origin allow-modals"`; o Word (`src/htmlToDocx.ts`, lib `docx` carregada só no clique) gera .docx editável com capa (logo em sangria, rodapé próprio), cabeçalho com logo e rodapé com "página N" (campo PAGE), Título 1/2 de verdade, tabelas com cabeçalho repetido e zebra, caixas alerta/ponto em aberto, ficha e índice com pontilhado. Apresentações reveal.js são recusadas (PDF continua por ↗ Nova aba → Ctrl+P). Teste em `server/tests/html-to-docx.test.mjs` com o modelo real.
- **⬇ Exportar → Word (.docx)** na nota: a nota renderizada vira .docx com os estilos Tania (títulos, tabelas, links, imagens); embeds de slides/vídeo/PDF ficam de fora.
- **⬇ Exportar → Word com capa** na nota (`src/docMarca.ts`): monta a nota no formato do documento A4 (capa com logo Cloud e subtítulo do frontmatter, ficha só com `cliente`/`responsavel`/`versao`, cabeçalho com logo, rodapé "uso interno · página N"); `##` vira Título 1, callouts viram caixas âmbar/teal, tarefas viram ☑/☐. Sem LLM: nota de qualquer tamanho. Colunas das tabelas no .docx proporcionais ao conteúdo.
- ClickUp **só leitura** (`server/clickup.ts`, token em `app/clickup.config.json`, fora do git; cache de 1 min):
  - página **☑ Tarefas** (atalho no explorador): Eu/Equipe, filtro por pessoa e espaço, atrasadas e concluídas; agrupar por pessoa, status ou prazo; tarefa ligada a uma nota abre a nota;
  - card da tarefa nas Propriedades quando a nota tem `clickup: <id ou URL>` no frontmatter;
  - agente: `clickup_tasks` (minhas/equipe, pessoa, espaço, atrasadas, prazo em N dias) e `clickup_task`; nada é criado ou alterado no ClickUp (POST recusado).
  - tipos compartilhados servidor/front em `server/clickup-types.ts`; schema do agente ganhou `boolean`.
- Rodapé fixo (barra de status): à esquerda o estado ("escrita ativa · commit automático no git · sair" ou "somente leitura"), à direita a versão do sistema (`Vault vX.Y.Z`), o commit e a data do build (`__APP_COMMIT__`, `__APP_BUILT__` em `vite.config.ts`); no celular só "sair" + versão; some na impressão. O texto saiu do fim do explorador.
- Explorador: **Enviar arquivo ou imagem…** no menu de cada pasta (⋯ / + / botão direito) e arrastar arquivos do computador para cima da pasta. Nome vira ASCII, nome repetido ganha `-1`, `-2`…; `.md` enviado vira nota; na raiz vai para `00-Inbox`.
- **⬇ Exportar** na nota: **Markdown (.md)** (baixa o arquivo como está), **PDF** (impressão limpa em página clara) e **PDF com capa** (capa com logo e barras teal, Poppins/Arial, tabelas e alertas da identidade visual). PDF pelo "Salvar como PDF" do navegador, sem nada no servidor; imagens carregadas antes de imprimir.
- Nota como contexto do terminal: botão **💬 Terminal** na nota abre o agente com ela em foco (relida do disco a cada mensagem, `contextPath` validado no servidor); uma conversa salva por nota; `/contexto` e `/geral`.
- Modo ideia: nota `type: idea` em foco vira parceiro de brainstorm (perguntas curtas, estrutura em seções via `append_to_note` com plano, sugestão de virar projeto).
- Identidade visual Tania: logos públicos em `/brand/` (`public/brand/`, liberados sem login como os ícones do PWA) para apresentações isoladas; agente lê o AGENTS.md §8 e a nota `Identidade-Visual-Tania` antes de criar slides/documentos; validador aceita `/brand/…` sem aviso.
- Anexos servidos direto do disco em `/files/<caminho>` (com login): imagem/apresentação nova aparece depois do **⬇ Pull**, sem esperar deploy. ETag/304 e Range (vídeo).
- Apresentações `.htm`/`.html`: `![[deck.html]]` embute com **⛶ Tela cheia** e **↗ Nova aba**; abrem isoladas (CSP `sandbox` + iframe `sandbox`, sem `allow-same-origin`): o JS dos slides roda, mas não alcança o login nem a `/api`.
- Embeds de PDF (visualizador), vídeo e áudio; imagens com zoom (clique abre em tela cheia, Esc fecha).
- Imagem em markdown padrão `![texto](caminho)`: relativo à pasta da nota, à raiz do vault ou pelo nome do arquivo.
- Explorador lista os anexos (ícone por tipo) e abre a página do arquivo (`#/arquivo/<caminho>`) com pré-visualização.
- Editor: colar (Ctrl+V), arrastar ou **📎 Anexar** envia para `99-Meta/attachments/AAAA-MM/` (nome ASCII com data/hora), insere `![[nome]]` e commita.
- Agente: `list_files`, `read_file`, `create_file`, `update_file` (HTML de slides com reveal.js via CDN e SVG, só em `99-Meta/attachments/`); ações `create_file`/`update_file` no plano; validação do documento e aviso de recurso local que não carrega no modo isolado; embed de anexo conta como link existente.
- PWA instalável ("Instalar app" no Chrome/Edge/Android, "Adicionar à Tela de Início" no iOS):
  - `public/manifest.webmanifest` (standalone, tema escuro) e ícones gerados por `scripts/gen-icons.mjs` (192, 512, maskable, apple-touch, SVG), sem dependências.
  - `public/sw.js`: páginas pela rede primeiro (offline abre a última versão boa, só leitura); `/assets` com hash em cache; `/api`, `/login` e POSTs nunca em cache; `/logout` apaga o cache.
  - Manifest e ícones liberados sem login (só marca visual; o resto continua protegido).
- Terminal do agente no painel da direita (abas **Propriedades | >_ Terminal**): conversa com um LLM que organiza e escreve notas do vault.
- `server/agent.ts`: agente em TypeScript (type stripping do Node 22), compatível com qualquer API no formato OpenAI `/chat/completions`.
- `app/agent.config.json` (fora do git; modelo em `agent.config.example.json`): vários provedores (OpenAI, Gemini, OpenRouter, Groq, DeepSeek, Ollama) e o `active`; relido a cada pedido.
- Provedor padrão desta versão: DeepSeek (`deepseek-chat`).
- Comando `/modelo` no terminal: lista os provedores e troca o ativo (`/modelo gemini`) sem restart; as chaves nunca vão para o navegador.
- Ferramentas do agente: `list_notes`, `read_note`, `search_notes`, `create_note`, `append_to_note`, `update_note`, `move_note`, `create_folder` — sem apagar (AGENTS.md §3); cada escrita vira commit `agente: …`.
- System prompt montado no servidor com `AGENTS.md` + `99-Meta/Convencoes.md`; o cliente não consegue trocar.
- Decisões type-safe do agente:
  - `server/agent/schema.ts`: mini-schema sem dependências; uma definição gera o tipo TS, a validação em runtime e o JSON Schema das ferramentas.
  - Argumentos de todas as ferramentas validados (campo errado/faltando volta ao LLM com o motivo).
  - `propose_plan`: antes de escrever, o agente devolve ações tipadas `{action, path, to?, type?, reason}`; o terminal mostra o plano com **✓ Aprovar / ✗ Rejeitar** (`/aprovar`, `/rejeitar <motivo>`) e só ações do plano aprovado escrevem.
  - `server/agent/rules.ts`: AGENTS.md + Convencoes.md como regras — frontmatter por `type`, pasta x type, nomes ASCII, H1, bloco `bash` em comandos, ≥1 wikilink existente, tags da lista fechada, datas ISO. Erro bloqueia a escrita e volta ao LLM; aviso não bloqueia.
  - Ferramenta `check_note` para validar rascunhos sem gravar; `move_note` aceita o conteúdo novo (ex.: `inbox` → `command` ao sair do Inbox).
  - Tipo `Plan` compartilhado entre servidor e front (`import type`): mudou o formato, o build quebra.
- `tsconfig.server.json` (`erasableSyntaxOnly`) e `npm run typecheck`; o `build` agora checa os tipos do servidor também.
- Testes `server/tests/agent.test.mjs` (LLM falso: plano, aprovação, validação, sandbox, plano forjado) e `server/tests/rules.test.mjs`.

### Alterado
- Envio pelo site (usuário logado) aceita qualquer pasta do vault, não só `99-Meta/attachments/`; o agente continua restrito a `99-Meta/attachments/` (AGENTS.md §6). Raiz, `app/`, `.obsidian/` e dotfiles seguem bloqueados.
- Prompt do agente não sugere mais o tema escuro do reveal.js: parte do modelo da identidade visual.
- Anexos saíram do bundle (`import.meta.glob`): o `dist/` fica só com JS/CSS e os arquivos vêm de `/files`.
- Validador do agente ignora `[[links]]` dentro de blocos de código (exemplos).
- Pasta `07-Ideias/` com `type: idea` (AGENTS.md, 2026-10-24): validador do agente, escopo de escrita e explorador.
- Pasta `06-Projetos/` (AGENTS.md, 2026-10-24): `type: project` passa a morar nela no validador do agente; entra no escopo de escrita da API e do agente, e notas criadas pelo explorador nela nascem com `type: project`.
- Deploy troca só o `VAULT_AUTH` do `app/.env` e preserva as outras linhas.
- Deploy força o restart do serviço (código do servidor só carrega ao iniciar).

### Corrigido
- Explorador recolhia as pastas ao abrir uma nota em outra pasta: agora o que foi aberto (à mão ou pelo caminho da nota) continua aberto até você fechar; estado salvo no navegador (sobrevive a recarregar/PWA) e a lista rola até a nota atual ao abrir o explorador.
- Terminal no celular saía da tela: largura presa ao painel (`min-width: 0`, quebra de linhas longas) e altura pela área visível (teclado virtual e barra do navegador não escondem mais o campo de digitar); respeita a área segura do iPhone.

## [0.2.0] — 2026-10-23

### Adicionado
- Servidor com escrita em produção: `server/server.mjs` (Node) serve `dist/` + `/api`, com tela de login (`VAULT_AUTH`), no lugar do nginx somente leitura.
- Sincronia com o GitHub: rotas `/api/git/status`, `/api/git/pull` e `/api/git/push`, com fila única para os comandos git.
- `git pull` automático ao abrir o site.
- Botões **⬇ Pull** e **⬆ Push** com o estado do git (branch, para enviar, para baixar) na topbar, sempre visíveis.
- Versão do front exibida no site (`__APP_VERSION__`, lida do `package.json`).
- Teste `server/tests/git-sync.test.mjs` (status, pull, push, conflito).

### Alterado
- Deploy: o servidor virou clone git (deploy key); só `app/dist` vai por scp.
- `npm test` roda `server/tests/*.test.mjs` (Node 22 não aceita diretório).

### Corrigido
- Senha com `#` em `VAULT_AUTH` era cortada pelo `.env` (agora gravada entre aspas).
- Navegador preso em versão antiga: `index.html` com `Cache-Control: no-cache`, `assets/` com cache imutável.
- Fixture de `vault-api.test.mjs` compatível com git < 2.28 (sem `git init -b`).

## [0.1.0] — 2026-10-22

### Adicionado
- Front React estilo Obsidian: explorador, busca, tags, propriedades do frontmatter, wikilinks e anexos.
- Camada de escrita `server/vault-api.mjs` (criar, editar, renomear e excluir notas e pastas, com commit automático), disponível no `npm run dev`.
- Deploy via GitHub Actions: build do `dist/` e nginx com auth básica no Swarm/Traefik.

# Changelog

Mudanças relevantes do projeto Tania. Formato: [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) ·
versões em [SemVer](https://semver.org/lang/pt-BR/). O detalhe do front fica em [app/CHANGELOG.md](app/CHANGELOG.md).

## [Não lançado]

### Adicionado
- 🤖 **Agentes da Tania**: notas `99-Meta/Agentes/Tania/<nome>.md` (com `quando:`) viram agentes especializados que a Tania escolhe sozinha pela ferramenta `usar_agente`, no terminal e no WhatsApp. Modelos `agenda` e `ideias` em `agents/tania/`. No WhatsApp, `feito:` e `ideia:` passam pelo agente; sem LLM, gravam direto como antes.
- 🤖 Instruções dos agentes editáveis pelo front (🤖 Agents → Instruções): `99-Meta/Agentes/Tania.md` entra no prompt do agente da Tania; a equipe de desenvolvimento fica em `99-Meta/Agentes/Equipe/` e o `scripts/agentes.mjs` (`login`, `push`, `pull`) sincroniza com `agents/*.md`. Fonte de verdade: o vault de produção.
- 🧩 **Tools**: funcionalidades viram serviços plugáveis (manifesto + funções MCP do agente + páginas em iframe). Registro pelo env (`TANIA_TOOLS`) ou pela tela ⚙ → Tools, config por tool cifrada, proxy `/tools/{id}/ui|api/*` e `/api/core/config` no backend Rust. Spec `docs/superpowers/specs/2026-11-06-tools-design.md`.

### Alterado
- ✅ ClickUp vira a primeira tool (`app/tools/clickup/`, serviço `tool-clickup`). As funções do agente passam a se chamar `clickup__clickup_tasks` e `clickup__clickup_task`; o `CLICKUP_TOKEN` sai das configurações gerais para a config da tool (migração `103` copia o valor).
- 🚀 Produção (`app/build.yml`) passa a rodar o backend Rust na frente do Node e a tool ClickUp; o login vira por usuário (`TANIA_BOOTSTRAP_ADMIN` na 1ª subida).
- 🦀 Backend Rust (F3a): `/api/reminders` (listar, criar, cancelar) e as rotas simples de `/api/investimentos` (movimentos: listar e apagar; ordens; análises; alertas; acompanhadas: listar e remover; relatórios: listar) passam a ser atendidos direto no Postgres, com o mesmo JSON do Node. O resto segue no Node.
- 📄 Financeiro (aluguéis, recebimentos, Carnê-Leão) sai da spec do projeto (SPEC, AGENTS, README, papéis dos agentes); volta no futuro como tool separada. O código atual continua no app.
- SPEC §12 fechado: lembretes só pelo WhatsApp, comprovantes sem leitura automática, backup só pelo versionamento do bucket.

## [1.0.0] — 2026-11-06

Primeira versão pública.

### Incluído
- 📄 **Vault web** no estilo Obsidian (`app/`): notas, pastas, anexos, busca, wikilinks, exportação em PDF/Word e slides.
- 🤖 **Agente LLM** com tools sobre o vault, ClickUp, lembretes, financeiro e investimentos; provedores editáveis na tela Agents.
- 💬 **WhatsApp** (Evolution API): gatilhos `ideia:` e `feito:`, comprovantes direto para o vault e conversa com o agente.
- ⏰ **Lembretes**, 💰 **Financeiro** e 📈 **Investimentos** (carteira B3, comparação com Ibovespa/CDI, carteiras simuladas).
- 🦀 **Backend Rust** (`backend/`) na frente do Node legado: login por usuário no Postgres, sessões, rate limit, CSRF,
  rotas do vault, usuários, ⚙ Configurações (segredos cifrados com `TANIA_CONFIG_KEY`) e Agents.
- 🐳 **Stack local** com `docker compose up`: front (nginx), backend Rust, Node, Postgres 17 e bucket RustFS.

### Segurança
- Sem chave de criptografia padrão no Compose: salvar segredos exige `TANIA_CONFIG_KEY` própria no `.env`.
- Arquivos `.env*` fora do Git e do contexto Docker (exceto `.env.example`).

# Tania — assistente pessoal

Assistente pessoal auto-hospedado. Você conversa com ele pelo WhatsApp e pelo navegador; ele guarda notas num vault
estilo Obsidian, dispara lembretes, acompanha investimentos, acompanha tarefas do ClickUp e tem um terminal
com agente LLM que lê e edita as notas por você.

> Projeto pessoal, em evolução. O backend está migrando de Node para Rust (detalhes em [Migração](#migração-para-rust)).

## O que ele faz

- **Vault de notas:** notas `.md` com frontmatter, wikilinks, tags, anexos e busca, num bucket S3 (RustFS/MinIO) ou
  numa pasta local. Exporta para Markdown, PDF (simples ou com capa) e Word.
- **Agente LLM no terminal:** qualquer provedor compatível com a API da OpenAI (DeepSeek, OpenAI, Gemini, OpenRouter,
  Groq, Ollama ou um servidor local). Ele lê o vault, propõe mudanças e só aplica depois que você aprova.
- **WhatsApp** (via [Evolution API](https://github.com/EvolutionAPI/evolution-api)): `💡 ideia:` vira nota,
  `✅ feito:` entra no diário do dia, foto ou PDF vira anexo no vault, e o resto vai para o agente. Só números
  autorizados são atendidos.
- **Tools plugáveis:** cada funcionalidade extra é um serviço com manifesto, funções do agente (MCP) e páginas; o admin
  cadastra tools externas em ⚙ → Tools. Spec em [docs/superpowers/specs/2026-11-06-tools-design.md](docs/superpowers/specs/2026-11-06-tools-design.md).
- **ClickUp** (tool, só leitura): painel e lista de tarefas por pessoa, projeto e prazo, com relatório em Word e slides.
- **Lembretes e investimentos** no Postgres.
- **Multiusuário:** login por usuário e senha (argon2id), sessões revogáveis e papel de admin.
- **Configuração pela tela:** chaves das integrações (cifradas com AES-256-GCM) e provedores do agente ficam no banco,
  editáveis em ⚙ Configurações e 🤖 Agents.

## Arquitetura

```
navegador ──► frontend (nginx) ──► backend (Rust/axum) ──► legacy (Node)
                                      │                      │
                                      ├── RustFS (S3) ◄──────┤
                                      └──────────────────────┴──► Postgres
```

| Pasta | O que tem |
|---|---|
| [`app/src/`](app/src/) | Front React + Vite |
| [`backend/`](backend/) | Backend Rust: login, usuários, sessões, vault, anexos, configurações, agents; repassa ao Node o que ainda não foi portado |
| [`app/server/`](app/server/) | Backend Node (legado): agente LLM, WhatsApp, lembretes, investimentos |
| [`app/tools/`](app/tools/) | Tools internas (serviços com manifesto + MCP + páginas): ClickUp |
| [`docker-compose.yml`](docker-compose.yml) | Stack local completa |
| [`SPEC.md`](SPEC.md) | Requisitos, rotas, schema e variáveis de ambiente |
| [`AGENTS.md`](AGENTS.md) | Donos de cada parte e regras para manter código e docs em sincronia |
| [`docs/superpowers/`](docs/superpowers/) | Specs e planos de cada fase |

## Começar (Docker)

Requisito: Docker com Compose v2. Não precisa de `.env`.

```bash
git clone <este repositório> tania && cd tania
docker compose up -d --build
```

Abra http://localhost:3000 e entre com **`admin` / `admin`**. Esse admin é criado só na primeira subida, com o banco
vazio. **Troque a senha logo** em ⚙ (rodapé do menu) → Usuários.

Para salvar chaves e tokens em ⚙ Configurações, gere uma chave uma única vez:

```bash
(umask 077; printf 'TANIA_CONFIG_KEY=%s\n' "$(head -c 32 /dev/urandom | base64)" >> .env)
docker compose up -d
```

Execute a geração apenas se `TANIA_CONFIG_KEY` ainda não estiver definida no `.env` da raiz. Guarde uma cópia segura;
substituir a chave torna ilegíveis os segredos salvos com a anterior. Sem chave, só configurações não secretas podem ser salvas.

Depois, em ⚙ Configurações:
- **Integrações:** chaves de LLM, token do ClickUp, dados da Evolution API (WhatsApp).
- **🤖 Agents:** escolha o provedor do agente (modelo, URL e qual chave usar).

As mudanças em Integrações valem depois de **Aplicar e reiniciar**; as de Agents valem na hora.

```bash
docker compose logs -f backend legacy   # logs
docker compose down                     # parar (os dados ficam nos volumes)
docker compose down -v                  # parar e apagar banco e bucket locais
```

### Valores da stack local

Banco, bucket e segredos de desenvolvimento têm valores padrão no próprio compose (bloco `x-stack`). Para trocar,
defina a variável no shell ou num `.env` na raiz:

| Variável | Padrão | Para quê |
|---|---|---|
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | `tania`, `tania-local`, `tania` | Postgres (lidos só ao criar o volume) |
| `RUSTFS_ACCESS_KEY`, `RUSTFS_SECRET_KEY`, `RUSTFS_BUCKET` | `tania-local`, `tania-local-secret`, `tania-vault` | bucket S3 |
| `TANIA_BOOTSTRAP_ADMIN` | `admin:admin` | admin criado quando não há usuários |
| `TANIA_CONFIG_KEY` | vazio (gere uma chave própria) | cifra os segredos salvos no banco |
| `LEGACY_PROXY_SECRET` | `tania-local-proxy` | segredo entre o backend Rust e o Node |
| `FRONT_PORT`, `RUSTFS_PORT` | `3000`, `9000` | portas no host (só em `127.0.0.1`) |

> **Os padrões são só para uso local.** A stack expõe as portas apenas em `127.0.0.1`. Para publicar na internet,
> troque todos esses valores (`head -c 32 /dev/urandom | base64` gera uma `TANIA_CONFIG_KEY`) e coloque um proxy com
> HTTPS na frente. Se algum padrão já foi usado em produção, substitua-o antes de publicar o repositório. Perder a `TANIA_CONFIG_KEY` torna ilegíveis os segredos já salvos.

Limitações conhecidas da stack local:
- Os relatórios em slides usam um modelo HTML que fica no seu vault, em
  `99-Meta/attachments/Apresentacoes/Modelo-apresentacao.html`.

## Desenvolvimento sem Docker

Requisitos: Node 24 (o backend Node roda `.ts` direto) e Rust 1.94+.

```bash
cd app && npm ci && PORT=3101 npm run serve        # backend Node (legado), porta 3101
cd backend && cargo run                             # backend Rust, porta 3100 (lê app/.env)
cd app && BACKEND_URL=http://localhost:3100 npm run dev   # front com hot reload
```

O backend Rust precisa de um Postgres (`DATABASE_URL` ou `PGHOST`/`PGUSER`/`PGPASSWORD`/`PGDATABASE`); sem banco, só
aceita acessos de `localhost`. Modelo de variáveis: [`app/.env.example`](app/.env.example). Para criar um admin pela
linha de comando: `cargo run -- user add <nome> --admin` (a senha vem da entrada padrão).

## Testes

```bash
cd backend && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
cd app && npm test && npx tsc --noEmit
node scripts/parity.mjs        # compara as respostas do Node (3101) e do Rust (3100)
```

Testes que precisam de serviços reais rodam só com estas variáveis (sem elas, são pulados):
- Postgres: `TEST_DATABASE_URL`
- S3: `TEST_RUSTFS_ENDPOINT`, `TEST_RUSTFS_BUCKET`, `TEST_RUSTFS_ACCESS_KEY`, `TEST_RUSTFS_SECRET_KEY`

```bash
docker run -d --name tania-pg-test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=tania_test -p 127.0.0.1:5433:5432 postgres:17-alpine
TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:5433/tania_test cargo test
```

## Migração para Rust

O backend Rust fica na frente e repassa ao Node (strangler) o que ainda não foi portado. Rotas, JSON e cookie de
sessão são os mesmos, então o front não percebe a troca.

| Fase | Conteúdo | Situação |
|---|---|---|
| F0–F2 | Proxy, login, rate limit, storage (local e S3) e rotas do vault | feita |
| F2c–F2e | Usuários e sessões, configuração no banco, provedores do agente, menu em faixa de ícones | feita |
| F3a | Lembretes e rotas simples de investimentos direto no Postgres | feita |
| F3b | Investimentos (resumo, movimentos, acompanhar, relatórios) | a fazer |
| F4 | WhatsApp (Evolution) | a fazer |
| F5 | Agente LLM e ClickUp | a fazer |
| F6 | Servidor MCP com as ferramentas da Tania | a fazer |
| F7 | Remover o Node | a fazer |

## Deploy

[`app/build.yml`](app/build.yml) é um stack de Docker Swarm atrás do Traefik: backend Rust na frente, Node (legado) e a tool
ClickUp atrás. Na primeira subida o login passa a ser por usuário: defina `TANIA_BOOTSTRAP_ADMIN`, `LEGACY_PROXY_SECRET`,
`TANIA_CONFIG_KEY` e `TANIA_TOOL_SECRET_CLICKUP` no `.env` do servidor e construa as imagens `tania-app` e `tania-backend`. O workflow
[`.github/workflows/build.yml`](.github/workflows/build.yml) testa e faz o deploy por SSH; configure no GitHub a
variável `APP_DOMAIN` e os secrets `SSH_HOST`, `SSH_USER`, `SSH_KEY` (e, opcionais, `SSH_PORT`, `DEPLOY_DIR`,
`DEPLOY_TOKEN`).

## Segurança

Veja [SECURITY.md](SECURITY.md). Segredos nunca vão para o git: `app/.env`, `app/agent.config.json` e
`app/clickup.config.json` estão no `.gitignore`.

Mudanças de cada versão: [`app/CHANGELOG.md`](app/CHANGELOG.md).

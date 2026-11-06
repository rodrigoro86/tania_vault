# Tools — funcionalidades plugáveis (subprojeto 1: plataforma + ClickUp)

## Objetivo

Funcionalidades deixam de ser costuradas no núcleo. Uma **tool** é um serviço HTTP com um contrato único. Interna
(código em `app/tools/<id>/`, sobe no compose) ou externa (URL cadastrada pelo admin), o contrato é o mesmo.
Adicionar uma tool não muda o núcleo.

Subprojetos:
1. **Este:** plataforma de tools + ClickUp como primeira tool.
2. Investimentos vira tool (precisa de `/api/core/notify`, `/api/core/llm`, `/api/core/vault`, que entram lá).
3. Aluguéis (tool externa; o usuário cuida depois). O financeiro legado do Node não muda aqui.

## Contrato de uma tool

A tool responde, sempre exigindo o header `x-tania-tool-secret` igual ao seu segredo (senão 401):

| Endpoint | Conteúdo |
|---|---|
| `GET /manifest.json` | `{id, nome, icone, versao, paginas: [{id, titulo}], vinculos?: [{campo, pagina}], config?: [{chave, segredo, descricao}], prompt?}` |
| `POST /mcp` | MCP via HTTP (JSON-RPC 2.0, resposta `application/json`): `initialize`, `notifications/initialized`, `tools/list`, `tools/call` |
| `/ui/{pagina}` | HTML da página, mostrado num iframe |
| `/api/*` | API própria, usada pelas páginas da tool |

Headers que a Tania manda em toda chamada: `x-tania-tool-secret`, `x-tania-user` (username) e `x-tania-admin` (`1`/`0`),
estes dois últimos só nas requisições de um usuário (proxy).

- `id`: `[a-z0-9-]{1,32}`. `paginas[].id` e `vinculos[].pagina`: `[a-z0-9-]{1,32}`.
- `vinculos`: nota com o campo `campo` no frontmatter mostra, em Propriedades, a página `pagina` com `?valor=<valor>`.
- `config`: chaves que o admin edita em ⚙ Configurações; a tool lê com `GET /api/core/config`.
- `prompt`: texto acrescentado ao prompt do agente, explicando as funções.
- Funções MCP rodam direto, como as ferramentas de domínio de hoje (investimentos, financeiro): o `propose_plan` só vale
  para escrita no vault, e a tool que grava no vault (subprojeto 2) passa pela API do núcleo.

## Núcleo (backend Rust)

### Registro

Duas origens, juntas numa lista:
- **env** (`TANIA_TOOLS=clickup=http://tool-clickup:4100,outra=http://...`; segredo em `TANIA_TOOL_SECRET_<ID>`, id em
  maiúsculas e `-` → `_`). Não editáveis pela tela. Usado pelas tools internas do compose.
- **banco** (`tools`, migração `103_tools.sql`): `id` pk, `url`, `segredo` (cifrado `v1:` com `TANIA_CONFIG_KEY`),
  `ativo`, `atualizado_em`, `atualizado_por`. Cadastrar exige `TANIA_CONFIG_KEY` (senão 503, como em Configurações).
  Id repetido com o env → 409.

`tools_config` (mesma migração): `tool_id`, `chave`, `valor` (cifrado quando `segredo`), `segredo`, `atualizado_em`,
`atualizado_por`, pk `(tool_id, chave)`. A migração copia `configuracoes.CLICKUP_TOKEN` para
`tools_config('clickup','CLICKUP_TOKEN')` e apaga a linha antiga.

### Rotas

| Rota | Acesso | O que faz |
|---|---|---|
| `GET /api/tools` | logado | `{ok, tools: [{id, origem: "env"\|"banco", ativo, manifest\|null, erro?}]}`. Busca os manifestos em paralelo (timeout 3 s cada); `url` só para admin. Manifesto inválido ou com `id` diferente → `manifest: null` + `erro`. |
| `POST /api/tools` `{id, url, segredo}` | admin | cadastra tool externa (url `http(s)://`, até 300) |
| `PUT /api/tools/{id}` `{url?, segredo?, ativo?}` | admin | só tools do banco |
| `DELETE /api/tools/{id}` | admin | só tools do banco; apaga também a config |
| `GET /api/tools/{id}/config` | admin | chaves do manifesto: `{chave, segredo, descricao, definido, valor?}` (valor só das não secretas) |
| `PUT /api/tools/{id}/config` `{valores: {chave: valor\|null}}` | admin | só chaves do manifesto; `null` apaga; segredo sem cifra → 503 |
| `/tools/{id}/ui/*`, `/tools/{id}/api/*` | logado | proxy (streaming, como `proxy.rs`) para `{url}/ui/*` e `{url}/api/*`, com os headers da Tania; o cliente não pode forjar `x-tania-*`. Tool inexistente ou inativa → 404. Outros caminhos (`manifest.json`, `mcp`) → 404. |
| `GET /api/core/config` | tool (`Authorization: Tool <id>:<segredo>`) | `{ok, valores: {chave: valor}}` só das chaves do manifesto daquela tool, decifradas |

O portão (`gate`) aceita `/api/core/*` com `Authorization: Tool ...` (comparação em tempo constante) em vez de sessão.
Sem esse header, `/api/core/*` é 401.

## Agente (Node, até a F5)

`app/server/agent/tools-remotas.ts`:
- `carregarTools()`: lista env + banco (decifra com `TANIA_CONFIG_KEY`), só ativas; para cada uma, manifesto +
  `initialize` + `tools/list` (timeout 5 s; tool fora do ar é pulada com aviso no log). Cache de 60 s.
- Cada função vira `{id}__{nome}` (só `[a-zA-Z0-9_-]`, até 64) no formato de função do agente; `inputSchema` vira
  `parameters`. O `prompt` do manifesto entra no prompt do sistema.
- `tools/call` com timeout 30 s; o resultado é o texto dos `content` do tipo `text`; `isError` vira falha da ferramenta.

## Front

- `GET /api/tools` no carregamento. A faixa de ícones fica: 📄 Vault, cada tool com manifesto (ícone e nome), 🤖 Agents.
- Painel da tool: links para as páginas (`#/t/{id}/{pagina}`).
- Rota `/t/:id/:pagina` → `ToolFrame`: iframe `/tools/{id}/ui/{pagina}` ocupando a área de conteúdo.
- Propriedades: para cada `vinculo` cujo campo existe no frontmatter, iframe pequeno da página com `?valor=`.
- ⚙ Configurações: aba **Tools** (admin): lista, cadastrar/editar/remover externas, ativar/desativar, e os campos de
  `config` de cada tool.
- Rotas antigas `/tarefas` e `/painel` redirecionam para `/t/clickup/tarefas` e `/t/clickup/painel`.
- Iframe da mesma origem (`/tools/...`): a página da tool tem os mesmos poderes do front. Cadastrar uma tool externa é
  confiar no código dela; só admin cadastra.

## ClickUp como tool (`app/tools/clickup/`)

- `server.mjs` (Node, mesma imagem `tania-app`, `node tools/clickup/server.mjs`, porta 4100). Exige `TANIA_TOOL_SECRET`
  e `TANIA_CORE_URL`.
- `clickup.ts` e `clickup-types.ts` saem de `app/server/` para cá. O token vem de `/api/core/config`
  (`CLICKUP_TOKEN`, cache 60 s); o `clickup.config.json` segue opcional para `teamId`/`spaceIds`.
- Manifesto: `{id:"clickup", nome:"ClickUp", icone:"✅", paginas:[tarefas, painel], vinculos:[{campo:"clickup", pagina:"card"}],
  config:[{chave:"CLICKUP_TOKEN", segredo:true}], prompt}` (o texto que hoje está em `agent.ts`).
- MCP: `clickup_tasks` e `clickup_task`, os mesmos de `agent.ts` (somente leitura). O agente passa a
  chamá-los `clickup__clickup_tasks` e `clickup__clickup_task`.
- API: `GET /api/status|tasks|dashboard|task/{id}` (as de `/api/clickup/*` hoje).
- UI: páginas `tarefas`, `painel` e `card` são entradas extras do Vite (`app/tools/clickup/ui/*.html`), reaproveitando os
  componentes atuais. O build fica em `dist/tools/clickup/`; o servidor da tool devolve o HTML e os assets vêm de
  `/assets/` do front (mesma origem). Links para notas abrem no topo (`target="_top"`, `/#/...`).
- Sai do núcleo: `/api/clickup/*` do Node, `clickup_tasks`/`clickup_task` e a linha do prompt em `agent.ts`,
  `CLICKUP_TOKEN` de `backend/src/settings/keys.rs`, as rotas `/tarefas` e `/painel`, o painel ClickUp do `Sidebar`.

## Infra

- `docker-compose.yml`: serviço `tool-clickup`; `TANIA_TOOLS` e `TANIA_TOOL_SECRET_CLICKUP`
  (padrão local `tania-local-clickup`) no backend, no legacy e na tool.
- `nginx.front.conf`: `/tools/` vai para o backend.
- **Produção (`app/build.yml`) passa a rodar o backend Rust e o `tool-clickup`**: sem o proxy do Rust não há tools.

## Testes

- Rust: registro (env + banco), CRUD admin, config (segredo nunca volta), proxy (headers, prefixos permitidos,
  `x-tania-*` forjado removido), `/api/core/config` (segredo errado → 401), com uma tool falsa em porta local.
- Node: `tools-remotas` contra um servidor MCP falso (lista, chamada, erro, timeout); servidor da tool ClickUp
  (segredo, manifesto, `tools/list`, `tools/call` com a API do ClickUp mockada como em `clickup.test.mjs`).
- `npm run build` com as entradas novas; `npm test` e `cargo test` verdes.

## Fora do escopo

Widgets de dashboard, busca global, gatilhos de WhatsApp por tool, SDK por linguagem, MCP com SSE/streaming,
tools sem iframe (componentes nativos), marketplace.

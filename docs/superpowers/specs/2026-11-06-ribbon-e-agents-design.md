# Menu em faixa de ícones e área de Agents (F2e)

## Objetivo
1. **Menu da esquerda no estilo do Obsidian.** Uma faixa fixa de ícones de 44px troca o que o painel ao lado mostra:
   📄 Vault (árvore de `.md`), ✅ ClickUp (Painel e Tarefas) e 🤖 Agents (provedores do agente LLM).
2. **Tela 🤖 Agents (`/agentes`, só admin).** Edita os provedores do agente do terminal. Fica salvo no banco e vale
   na hora, sem reiniciar.

Fora do escopo: regras e prompt do agente, histórico de versões, agentes de investimento.

## Front
- **`Sidebar.tsx` vira `[faixa | painel]`** (`.sidebar` em flex de linha):
  - **`components/Ribbon.tsx`:** botões com ícone e `aria-label`; o ativo fica destacado. Clicar no ativo com o painel
    aberto recolhe; clicar com o painel recolhido abre naquela vista.
  - **Vista:** `'vault' | 'clickup' | 'agents'`, guardada em `localStorage` (`ui.leftView`).
  - **Recolhido:** só a faixa (os 44px de rail de hoje). O redimensionamento continua valendo para faixa + painel.
  - **Vault:** o conteúdo atual (cabeçalho com ações e árvore).
  - **ClickUp:** os atalhos 📊 Painel (`/painel`) e ☑ Tarefas (`/tarefas`), que saem da vista Vault.
  - **Agents:** `GET /api/agent/status` (Node, já existe), um item por provedor com ● no ativo e "sem chave" quando
    `hasKey` é false. Clicar faz `POST /api/agent/config {active}` (já existe). Para admin, o link "Gerenciar agents"
    leva a `/agentes`.
  - **Rodapé:** o `UserMenu` continua no fim do painel.
- **`components/Agents.tsx`, rota `/agentes`:**
  - **Formulário:** um bloco por provedor, com nome (só na criação), URL, modelo, max tokens (opcional), chave
    (select com as chaves LLM ou "sem chave"), um rádio para o ativo e Remover. Botão "+ Provedor".
  - **Salvar:** envia o documento inteiro (`PUT /api/agents`).
  - **Origem:** aparece "salvo no banco" ou "modelo inicial (não salvo)". Os erros do backend aparecem na tela.

## Banco: `backend/migrations/102_agentes_config.sql`
```sql
create table if not exists agentes_config (
  id smallint primary key default 1 check (id = 1),
  config jsonb not null,
  atualizado_em timestamptz not null default now(),
  atualizado_por text
);
```

## API Rust (`backend/src/agents/`, admin)
- **`GET /api/agents`:** `{ok, origem: "banco"|"nenhum", config, chaves}`. `chaves` = os nomes das chaves LLM
  permitidas. Sem linha: `config` = o modelo inicial (provedores deepseek, openai, gemini, openrouter, groq e ollama,
  como no `app/agent.config.example.json`, com `active: "deepseek"`).
- **`PUT /api/agents` `{config}`:** valida e grava (upsert id=1); 200 `{ok, origem: "banco", config}`; 400 com a
  mensagem do primeiro erro.
- **Validação** (`serde` com `deny_unknown_fields`, então `apiKey` inline é recusado):
  - `providers`: de 1 a 20; nome `^[a-z0-9_-]{1,32}$`.
  - `baseUrl`: `http://` ou `https://`, até 300 caracteres.
  - `model`: de 1 a 200 caracteres, sem quebra de linha.
  - `maxTokens`: opcional, inteiro de 1 a 1.000.000.
  - `apiKeyEnv`: opcional, ∈ {`DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`,
    `GROQ_API_KEY`}.
  - `active`: precisa ser um dos provedores.

## Node (`app/server/agent.ts`)
- **`loadConfig()`:** com banco configurado (`dbConfigured()`), lê `select config from agentes_config where id = 1`;
  havendo linha, usa ela (o banco vence o arquivo). Tabela ausente (42P01), sem linha ou erro de banco → o arquivo,
  como hoje. Lê a cada pedido, então vale na hora.
- **`setActive(name)`:** quando a config veio do banco, faz
  `update agentes_config set config = jsonb_set(config, '{active}', to_jsonb($1::text)), atualizado_em = now() where id = 1`;
  senão, grava o arquivo, como hoje.

## Testes
- **Rust:** unitários de validação (cada regra) e `tests/agents_api.rs` com banco (não admin 403; GET sem linha devolve
  o modelo inicial; PUT inválido 400; PUT válido e depois GET devolve `origem: banco`).
- **Node:** em `agent.test.mjs`, com um `query` falso, o banco vence o arquivo e `setActive` grava no banco.
- **Front:** typecheck e conferência no navegador (faixa, três vistas, recolher, tela `/agentes`).

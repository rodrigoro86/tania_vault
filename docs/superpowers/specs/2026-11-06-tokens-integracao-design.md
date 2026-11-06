# Tokens de integração e registro de atividade — design

**Data:** 2026-11-06 · **Status:** implementado (Partes 1 e 2). Parte 1 = gestão de tokens; Parte 2 = canais MCP e Hook.

## Objetivo

Agentes externos (Claude Code na máquina do usuário) registram o que estão fazendo na Agenda da Tania
(`01-Agenda/AAAA-MM-DD.md`), com tempo e tarefa. A gestão dos tokens e a ativação de cada canal ficam na interface.

## Canais

- **MCP** (`POST /mcp`): ferramenta `registrar_atividade`, o agente decide quando registrar.
- **Hook** (`POST /api/agenda/registro`, REST): o hook `SessionEnd` do Claude Code registra um mínimo ao fim da sessão.

Os dois usam a mesma função no servidor. O acréscimo ao diário acontece no servidor, com trava por arquivo.

## Parte 1 — tokens de integração (esta entrega)

### Banco (`backend/migrations/104_tokens_api.sql`, dono agent-data)

```
tokens_api(
  id uuid pk default gen_random_uuid(),
  usuario_id uuid not null references usuarios(id) on delete cascade,
  nome text not null,
  token_hash bytea not null unique,      -- sha256 do token, como sessoes
  mcp boolean not null default false,
  hook boolean not null default false,
  ativo boolean not null default true,
  criado_em timestamptz not null default now(),
  ultimo_uso timestamptz null
)
```

Chaves gerais em `configuracoes` (já existe): `INTEGRACAO_MCP` e `INTEGRACAO_HOOK` (`true`/`false`, padrão `false`).

### Rotas (Rust, dono agent-backend)

| Rota | Acesso | O que faz |
|---|---|---|
| `GET /api/tokens` | logado | lista os tokens do usuário (admin: todos), sem o valor do token |
| `POST /api/tokens` `{nome, mcp, hook}` | logado | cria; devolve o token **uma única vez** |
| `PATCH /api/tokens/{id}` `{nome?, mcp?, hook?, ativo?}` | dono ou admin | altera |
| `DELETE /api/tokens/{id}` | dono ou admin | revoga |
| `GET /api/integracoes` | admin | `{mcp: bool, hook: bool}` |
| `PUT /api/integracoes` `{mcp?, hook?}` | admin | liga/desliga os canais para todos os tokens |

- Token: 32 bytes aleatórios, base64url, prefixo `tania_` para ser reconhecível. Banco guarda só o sha256.
- Sem validade: vale até ser desativado ou revogado.
- Autorização de um token de integração: ativo + permissão do canal (`mcp` ou `hook`) + chave geral ligada.
  Nada disso dá acesso ao resto da API: o token só serve às rotas do canal.

### Interface (dono agent-frontend, Parte 1b)

Nova aba **Tokens** em ⚙ Configurações, ao lado de Integrações, Usuários e Tools:
- lista com nome, canais, último uso, interruptor ativo e botão revogar;
- criar: nome + ☐ MCP ☐ Hook; o token aparece uma vez, com botão copiar e os comandos prontos
  (`claude mcp add ...` e o trecho do hook);
- no topo, interruptores gerais MCP e Hook.

## Parte 2 — canais MCP e Hook (implementada)

- `POST /mcp` (JSON-RPC, protocolo 2025-06-18): ferramenta `registrar_atividade` `{agente, tarefa, minutos?}`.
- `POST /api/agenda/registro` `{agente, tarefa, minutos?}`: mesma função, para o hook.
- Autenticação: `Authorization: Bearer tania_…`. Só essas duas rotas aceitam o token; sessão não abre o canal.
  Regras: token ativo e usuário ativo, canal marcado no token, canal ligado nas Integrações. Cada uso grava `ultimo_uso`.
- Linha no diário (`01-Agenda/AAAA-MM-DD.md`, seção `## ✅ Feito`): `- ✅ HH:MM · agente · tarefa (N min)`, horário de São Paulo.
- Hook pronto: `scripts/tania-registro.sh inicio|fim`, guia em `docs/integracao-claude-code.md`.
- Limite: o lock de escrita vale só dentro do processo Rust; o Node legado (WhatsApp) não participa.

## Fora desta entrega

- Validade de token, permissões além de mcp/hook, auditoria por token.
- Desligar o hook na máquina do usuário: isso é local; a Tania só aceita ou recusa.

## Testes

- Rust: repo de tokens (criar/listar/revogar, hash não vaza na listagem), rotas com 401/403 corretos, chave geral desligada recusa o canal.
- Frontend: a aba aparece para admin; o token é mostrado uma vez.

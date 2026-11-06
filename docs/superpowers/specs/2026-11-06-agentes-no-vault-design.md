# Instruções dos agentes editáveis pelo front (vault de produção)

## Objetivo

O usuário ajusta pelo front como os agentes trabalham: o agente da Tania (terminal/WhatsApp) e a equipe de
desenvolvimento (`agents/*.md`, usada nas delegações ao Strata). A fonte de verdade passa a ser o **vault de produção**.

## Onde ficam

```
99-Meta/Agentes/
├── Tania.md          instruções do agente da Tania (tom, regras, prioridades)
└── Equipe/           README.md + agent-spec|storage|backend|data|evolution|frontend|reviewer.md
```

## Agente da Tania

`systemPrompt` (app/server/agent.ts) lê `99-Meta/Agentes/Tania.md` junto com `AGENTS.md` e `99-Meta/Convencoes.md`
(bloco `===== 99-Meta/Agentes/Tania.md =====`), a cada pedido. Arquivo ausente → o bloco não entra.

## Front

No painel 🤖 Agents da barra lateral, seção **Instruções** abaixo dos provedores: um link por nota de
`99-Meta/Agentes/` (Tania primeiro, depois `Equipe/` em ordem alfabética), abrindo no editor de notas. Sem notas →
"Nenhuma instrução no vault (rode `node scripts/agentes.mjs push`)".

## Script `scripts/agentes.mjs` (desenvolvimento, máquina local)

Config em `.env.agentes` na raiz (fora do Git pela regra `.env*`): `TANIA_URL` e `TANIA_SESSAO` (valor do cookie
`vault_session`).

| Comando | O que faz |
|---|---|
| `login` | pergunta URL (padrão o atual), usuário e senha no terminal (senha sem eco); `POST {url}/login` (form `user`, `password`, sem seguir redirect); pega o `vault_session` do `Set-Cookie` e grava `.env.agentes`. Senha nunca é gravada. Falha → "login recusado". |
| `push` | para cada `agents/*.md`, `POST {url}/api/notes {path:"99-Meta/Agentes/Equipe/<nome>", content}`; 409 = já existe, pula ("já existe, não sobrescrevo"). |
| `pull` | `GET {url}/api/notes`; para cada nota com caminho `99-Meta/Agentes/Equipe/<nome>.md` (sem subpastas), grava `agents/<nome>.md`. Não apaga nada em `agents/`. Mostra os arquivos alterados. |

Cookie vai em `Cookie: vault_session=<valor>`. 401/302 para `/login` → "sessão expirada: rode login". Rede → "Tania
fora do ar em <url>". Nome de arquivo só `[A-Za-z0-9._-]+\.md`.

## Fluxo de desenvolvimento

`agents/*.md` vira cópia: antes de cada delegação, `node scripts/agentes.mjs pull`. Editar a equipe é no front.

## Testes

`scripts/tests/agentes.test.mjs` com servidor falso: login grava a sessão e não a senha; push cria e pula 409;
pull grava só `Equipe/*.md` válidos e mantém os outros arquivos de `agents/`; sessão expirada → erro claro.
`app/server/tests`: o prompt inclui o `Tania.md` quando existe.

## Fora do escopo

`agents.patch.yml` pelo front, criar agentes pela tela, sincronização automática.

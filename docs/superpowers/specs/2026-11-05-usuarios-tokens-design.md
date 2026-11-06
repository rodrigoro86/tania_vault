# Usuários e tokens no backend Rust (F2c)

## Objetivo
Várias pessoas entram no site, cada uma com o próprio login, e todas veem o **mesmo vault**. Só o admin gerencia
usuários. O login gera um **token de sessão revogável**. No backend Rust, o `VAULT_AUTH` deixa de existir.

Fora do escopo: e-mail, recuperação de senha, permissão por pasta e listagem de sessões.

## Decisões
| Tema | Decisão |
|---|---|
| Vault | um só, compartilhado por todos os usuários |
| Token | opaco: 32 bytes aleatórios em base64url; o banco guarda só o `sha256`; validade de 30 dias |
| Transporte | cookie `vault_session` (mesmo nome, `HttpOnly; SameSite=Strict; Secure` em https) **ou** `Authorization: Bearer <token>` |
| Senha | hash `argon2id` (crate `argon2`, PHC string); mínimo de 8 caracteres |
| Permissão | o CRUD é só do admin; o próprio usuário pode trocar só a senha dele |
| `VAULT_AUTH` | removido do Rust; o Node legado continua com ele até a F7 |
| Primeiro admin | `TANIA_BOOTSTRAP_ADMIN=usuario:senha`: cria o admin **só se** `usuarios` estiver vazia. O compose local define `admin:admin`; produção não define |
| Admin manual | `tania user add <nome> [--admin]`, que lê a senha da entrada padrão |
| Sem `DATABASE_URL` | só loopback entra; o resto recebe 503 (o comportamento atual sem `VAULT_AUTH`) |

## Banco: `backend/migrations/100_usuarios.sql` (dono: agent-data)
```sql
create table usuarios (
  id uuid primary key default gen_random_uuid(),
  username text not null,
  senha_hash text not null,
  admin boolean not null default false,
  ativo boolean not null default true,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create table sessoes (
  token_hash bytea primary key,
  usuario_id uuid not null references usuarios(id) on delete cascade,
  criado_em timestamptz not null default now(),
  expira_em timestamptz not null
);
create unique index usuarios_username_idx on usuarios (lower(username));
create index sessoes_usuario_idx on sessoes(usuario_id);
```
Migrador do Rust (`backend/src/db/`):
- usa a mesma tabela `schema_migrations(version text primary key, applied_at)` do Node;
- a versão é o nome do arquivo;
- os arquivos vêm embutidos com `include_str!`;
- aplica cada um numa transação.

Os prefixos `100_`+ não colidem com os `001_`–`099_` do Node. O username é guardado como foi digitado e comparado sem
diferenciar maiúsculas (índice único em `lower(username)`).

## API (JSON; vale o CSRF atual: `Content-Type: application/json` em escrita)
Usuário público: `{ "id", "username", "admin", "ativo", "criadoEm" }`. Nunca expõe o hash.

| Rota | Acesso | Corpo | Resposta |
|---|---|---|---|
| `POST /api/auth/login` | público, bloqueio de 5 falhas/15 min por IP | `{username,password}` | 200 `{ok,token,expiresAt,user}` + Set-Cookie; 401 credencial errada ou usuário inativo; 429 bloqueado |
| `POST /api/auth/logout` | logado | — | 200 `{ok}`; apaga a sessão e limpa o cookie |
| `GET /api/auth/me` | logado | — | 200 `{ok,user}` |
| `GET /api/users` | admin | — | 200 `{ok,users:[...]}` ordenado por username |
| `GET /api/users/{id}` | admin | — | 200 `{ok,user}`; 404 |
| `POST /api/users` | admin | `{username,password,admin?}` | 201 `{ok,user}`; 400 inválido; 409 username já existe |
| `PATCH /api/users/{id}` | admin; o próprio usuário só com `{password}` | `{password?,admin?,ativo?}` | 200 `{ok,user}`; 403; 404; 409 se remover o último admin ativo |
| `DELETE /api/users/{id}` | admin, nunca a si mesmo | — | 200 `{ok}`; 404; 409 se for o último admin ativo |

Regras:
- **Username:** `^[a-zA-Z0-9._-]{3,32}$`.
- **Senha:** de 8 a 128 caracteres.
- **Sessões apagadas:** ao trocar a senha (menos a sessão atual, quando é o próprio usuário), ao desativar e ao
  apagar o usuário (por cascata). Mudar o `admin` vale na hora, porque o portão lê o usuário do banco a cada
  requisição.
- **Erros:** no formato atual `{ok:false,error}`. 401 sem sessão (em HTML: redirect para `/login`) e 403 sem permissão.
- **Página `/login`:** o `POST /login` (form HTML) e o `/logout` continuam e usam a mesma tabela.

## Portão (`backend/src/http/auth.rs`)
1. O asset público e o `GET /api/health` passam.
2. `/login`, `/logout` e `POST /api/auth/login` são tratados como hoje.
3. O token vem do Bearer ou do cookie: `sha256` → `select ... from sessoes join usuarios where token_hash=$1 and
   expira_em>now() and ativo`. Se acha, o `Usuario` vai para os `extensions` da request; se não acha, 401 ou redirect.
4. Antes do proxy para o Node: remove `x-tania-proxy` e `x-tania-user` vindos do cliente e põe
   `x-tania-proxy: $LEGACY_PROXY_SECRET` e `x-tania-user: <username>`.

## Node legado (`app/server/auth.mjs`, dono: agent-backend)
Com `LEGACY_PROXY_SECRET` definido, o portão deixa passar a requisição cujo header `x-tania-proxy` é igual ao segredo
(comparação em tempo constante). Sem a env, nada muda, então a produção atual (só o Node) não é afetada.

## Front (`app/src`, dono: agent-frontend)
- **Cliente:** `api.ts` ganha o `authApi.me()` e o `usersApi` (`list`, `create`, `update`, `remove`), que usam o `request()`
  existente.
- **Tela:** a nova `components/Users.tsx` fica na rota `/usuarios`. Reusa `Campo` e `Janela` de `Finance.tsx` e as
  classes `fin-*`.
  - **Admin:** tabela (usuário, admin, ativo, criado em) e os botões "Novo usuário" (janela com usuário, senha e admin),
    "Editar" (admin, ativo e nova senha opcional) e "Apagar" (com `confirm`). Os erros da API aparecem na tela.
  - **Quem não é admin:** a tela mostra só "Trocar minha senha".
- **Menu:** a `Sidebar.tsx` ganha o atalho "👥 Usuários", mostrado quando o `me()` responde. Se a rota não existir
  (backend só Node), o atalho fica escondido.

## Env vars novas (SPEC §8.1)
| Var | Onde | Uso |
|---|---|---|
| `DATABASE_URL` | Rust | já existe; agora o login depende dela |
| `TANIA_BOOTSTRAP_ADMIN` | Rust | `usuario:senha`; cria o admin só se não existe nenhum usuário |
| `LEGACY_PROXY_SECRET` | Rust e Node | segredo do header Rust → Node |

`VAULT_AUTH` passa a ser "só do Node legado". O compose define `TANIA_BOOTSTRAP_ADMIN: ${TANIA_BOOTSTRAP_ADMIN:-admin:admin}`
e um `LEGACY_PROXY_SECRET` local, o backend passa a depender do `postgres` e o README troca `tania/tania-local` por
`admin/admin`.

## Dependências novas (Rust)
- `sqlx` (postgres, runtime-tokio, tls-rustls, uuid, chrono; sem a feature `migrate`)
- `argon2`
- `rand`, para os bytes do token
- `uuid`
- `chrono`, para o `expiresAt` em ISO

## Testes
- **Unitários:** hash e conferência de senha, token (formato e hash), validação de username e senha.
- **Integração (`backend/tests/users.rs`):** rodam com `TEST_DATABASE_URL` e são pulados sem ela. Cobrem:
  - bootstrap, só com a tabela vazia;
  - login certo e errado, e o bloqueio na 6ª tentativa;
  - `me` por Bearer e por cookie;
  - quem não é admin recebe 403 no CRUD;
  - criar usuário duplicado dá 409;
  - trocar a senha invalida as outras sessões;
  - desativar o usuário barra o token dele;
  - o último admin não pode ser removido nem rebaixado;
  - DELETE de si mesmo é recusado;
  - o proxy envia `x-tania-proxy` e apaga o que veio do cliente.
- **Node:** um teste do bypass por header em `auth.test.mjs`, com o segredo certo, o errado e sem env.
- **Ponta a ponta:** `docker compose up`, login `admin/admin`, criar usuário, login com ele, abrir nota, abrir uma rota
  ainda servida pelo Node (lembretes), e confirmar que o 403 aparece para quem não é admin.

## Docs
- **SPEC:** §8.1 (envs), §7.6 (tabelas) e a lista de rotas.
- **AGENTS:** §3 (API `/api/auth|users` e as envs).
- **Outros:** `app/CHANGELOG.md`, `README.md` e `app/.env.example`.

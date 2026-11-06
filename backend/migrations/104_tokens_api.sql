-- Tokens de integração (design 2026-11-06-tokens-integracao-design.md).
-- O token em claro nunca fica no banco: só o sha256 (`token_hash`), como em `sessoes`.
-- Sem validade: vale até ser desativado ou revogado.
create table if not exists tokens_api (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null references usuarios(id) on delete cascade,
  nome text not null check (char_length(nome) between 1 and 60),
  token_hash bytea not null unique,
  mcp boolean not null default false,
  hook boolean not null default false,
  ativo boolean not null default true,
  criado_em timestamptz not null default now(),
  ultimo_uso timestamptz
);
create index if not exists tokens_api_usuario_idx on tokens_api (usuario_id);

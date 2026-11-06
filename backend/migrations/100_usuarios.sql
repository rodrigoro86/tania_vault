create table if not exists usuarios (
  id uuid primary key default gen_random_uuid(),
  username text not null,
  senha_hash text not null,
  admin boolean not null default false,
  ativo boolean not null default true,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create unique index if not exists usuarios_username_idx on usuarios (lower(username));
create table if not exists sessoes (
  token_hash bytea primary key,
  usuario_id uuid not null references usuarios(id) on delete cascade,
  criado_em timestamptz not null default now(),
  expira_em timestamptz not null
);
create index if not exists sessoes_usuario_idx on sessoes (usuario_id);

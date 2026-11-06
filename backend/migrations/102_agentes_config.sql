create table if not exists agentes_config (
  id smallint primary key default 1 check (id = 1),
  config jsonb not null,
  atualizado_em timestamptz not null default now(),
  atualizado_por text
);

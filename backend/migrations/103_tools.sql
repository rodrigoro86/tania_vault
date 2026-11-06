-- Registro das tools (design 2026-11-06-tools-design.md).
-- `tools`: as tools externas cadastradas pelo admin (as do env não vão ao banco).
-- `tools_config`: as chaves de config de cada tool, que substituem as chaves
-- globais do domínio (o ClickUp, por exemplo, sai de `configuracoes`).
create table if not exists tools (
  id text primary key check (id ~ '^[a-z0-9-]{1,32}$'),
  -- `{1,300}` não vale no Postgres (repetição máxima de 255): o limite de 300
  -- vai em `char_length`.
  url text not null check (url ~ '^https?://[^[:space:]]+$' and char_length(url) <= 300),
  segredo text not null,
  ativo boolean not null default true,
  atualizado_em timestamptz not null default now(),
  atualizado_por text
);

create table if not exists tools_config (
  -- sem FK: tools do env (clickup) também têm config e não têm linha em `tools`
  tool_id text not null,
  chave text not null,
  valor text not null,
  segredo boolean not null default false,
  atualizado_em timestamptz not null default now(),
  atualizado_por text,
  primary key (tool_id, chave)
);

-- O token do ClickUp, que estava nas configurações gerais, passa a ser config
-- da tool `clickup`. Rodado uma única vez (a migração é registrada em
-- `schema_migrations`), então o `on conflict` só protege re-execuções manuais.
insert into tools_config (tool_id, chave, valor, segredo, atualizado_por)
select 'clickup', 'CLICKUP_TOKEN', valor, segredo, atualizado_por
from configuracoes
where chave = 'CLICKUP_TOKEN'
on conflict (tool_id, chave) do update set
    valor = excluded.valor,
    segredo = excluded.segredo,
    atualizado_em = now(),
    atualizado_por = excluded.atualizado_por;

delete from configuracoes where chave = 'CLICKUP_TOKEN';

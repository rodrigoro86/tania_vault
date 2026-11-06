create table if not exists configuracoes (
  chave text primary key,
  valor text not null,
  segredo boolean not null default false,
  atualizado_em timestamptz not null default now(),
  atualizado_por text
);

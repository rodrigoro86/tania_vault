-- Ações acompanhadas no dashboard (SPEC §13): só observação, os agentes não leem.
create table investimentos.acompanhadas (
  ticker text primary key,
  created_at timestamptz not null default now()
);

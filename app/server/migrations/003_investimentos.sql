-- Módulo Investimentos (SPEC §13). Carteira = livro de movimentos: caixa, posições
-- e rentabilidade são sempre calculados deles, então lançamento retroativo funciona.
create schema if not exists investimentos;

create table investimentos.carteiras (
  id text primary key,
  nome text not null,
  usa_relatorios boolean not null default false
);
insert into investimentos.carteiras (id, nome, usa_relatorios) values
  ('real', 'Minha carteira', false),
  ('agente', 'Agente independente', false),
  ('agente_relatorios', 'Agente com relatórios', true);

create table investimentos.movimentos (
  id bigserial primary key,
  carteira text not null references investimentos.carteiras (id),
  tipo text not null check (tipo in ('aporte', 'retirada', 'compra', 'venda', 'provento')),
  ticker text,
  quantidade integer check (quantidade > 0),
  preco numeric(14, 4) check (preco > 0),
  taxas numeric(14, 2) not null default 0 check (taxas >= 0),
  valor numeric(14, 2) not null check (valor > 0),
  data date not null,
  motivo text,
  origem text not null default 'manual',
  espelho_de bigint references investimentos.movimentos (id) on delete cascade,
  ref text,
  created_at timestamptz not null default now(),
  unique (carteira, ref),
  check ((tipo in ('compra', 'venda')) = (quantidade is not null)),
  check (tipo in ('aporte', 'retirada') or ticker is not null)
);
create index on investimentos.movimentos (carteira, data);

create table investimentos.ordens (
  id bigserial primary key,
  carteira text not null references investimentos.carteiras (id),
  lado text not null check (lado in ('compra', 'venda')),
  ticker text not null,
  quantidade integer not null check (quantidade > 0),
  motivo text not null,
  decidida_em date not null,
  status text not null default 'pendente' check (status in ('pendente', 'executada', 'recusada')),
  erro text,
  preco numeric(14, 4),
  executada_em date
);
create index on investimentos.ordens (status);

create table investimentos.cotacoes (
  ticker text not null,
  data date not null,
  abertura numeric(14, 4),
  fechamento numeric(14, 4) not null,
  primary key (ticker, data)
);

create table investimentos.ultimos (
  ticker text primary key,
  preco numeric(14, 4) not null,
  variacao numeric(8, 3),
  em timestamptz not null default now()
);

create table investimentos.indicadores (
  serie text not null check (serie in ('CDI', 'IBOV')),
  data date not null,
  valor numeric(16, 6) not null,
  primary key (serie, data)
);

create table investimentos.alertas (
  id bigserial primary key,
  ticker text not null,
  tipo text not null check (tipo in ('queda_dia', 'preco_acima', 'preco_abaixo')),
  valor numeric(14, 4) not null check (valor > 0),
  ativo boolean not null default true,
  ultimo_envio date
);

create table investimentos.relatorios (
  id bigserial primary key,
  titulo text not null,
  fonte text,
  data date not null,
  texto text not null,
  resumo text,
  recomendacoes jsonb not null default '[]',
  created_at timestamptz not null default now()
);

create table investimentos.analises (
  id bigserial primary key,
  tipo text not null check (tipo in ('resumo', 'decisao')),
  carteira text references investimentos.carteiras (id),
  data date not null,
  texto text not null,
  created_at timestamptz not null default now()
);

-- trava de execução: cada rotina roda uma vez, mesmo com reinício ou réplica
create table investimentos.rotinas (
  chave text primary key,
  em timestamptz not null default now()
);

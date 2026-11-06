-- 001_init.sql — financeiro (aluguéis) e lembretes da Tania_Assistente

create table if not exists imoveis (
  id bigint generated always as identity primary key,
  apelido text not null,
  endereco text,
  created_at timestamptz not null default now()
);

create table if not exists inquilinos (
  id bigint generated always as identity primary key,
  nome text not null,
  cpf text,
  contato text,
  created_at timestamptz not null default now()
);

create table if not exists contratos (
  id bigint generated always as identity primary key,
  imovel_id bigint not null references imoveis(id) on delete cascade,
  inquilino_id bigint not null references inquilinos(id) on delete cascade,
  valor numeric(12,2) not null check (valor > 0),
  vencimento smallint check (vencimento between 1 and 28),
  vigencia_inicio date,
  vigencia_fim date,
  ativo boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists pagamentos (
  id bigint generated always as identity primary key,
  contrato_id bigint not null references contratos(id) on delete cascade,
  data date not null,
  valor numeric(12,2) not null check (valor > 0),
  tipo text not null check (tipo in ('pix','boleto','dinheiro','transferencia','outro')),
  comprovante_url text,
  observacao text,
  origem text not null default 'whatsapp',
  created_at timestamptz not null default now()
);

create table if not exists lembretes (
  id bigint generated always as identity primary key,
  texto text not null,
  quando timestamptz not null,
  recorrencia text,
  canal text not null default 'whatsapp',
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

create index if not exists idx_pagamentos_data on pagamentos (data);
create index if not exists idx_pagamentos_contrato on pagamentos (contrato_id);
create index if not exists idx_lembretes_status_quando on lembretes (status, quando);

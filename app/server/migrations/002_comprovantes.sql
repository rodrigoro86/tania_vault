-- relação recebimento ↔ comprovante: recebimento sem comprovante não tem linha aqui.
-- Fora de alugueis.extrato porque aquele schema é de api_assistente_alugueis, que
-- revalida `detalhes` a cada edição. Apagar o lançamento desfaz o vínculo; o arquivo fica.
create table if not exists comprovantes (
  extrato_id uuid primary key references alugueis.extrato (id) on delete cascade,
  caminho text not null unique,
  created_at timestamptz not null default now()
);

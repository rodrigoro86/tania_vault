-- Só para o banco LOCAL do docker-compose.yml (roda uma vez, no volume novo).
-- O schema alugueis é de api_assistente_alugueis; a migração 002 do app só precisa de alugueis.extrato(id)
-- para criar a FK. shortcut: stub mínimo, o financeiro local só funciona com o schema real
-- (rode as migrações do api_assistente_alugueis neste banco quando precisar dele).
create schema if not exists alugueis;
create table if not exists alugueis.extrato (id uuid primary key);

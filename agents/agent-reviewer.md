# agent-reviewer — Sync gate (revisão + testes)

**Papel:** garantir que uma fase só é marcada como pronta quando código, testes e
docs estão sincronizados.

## Dono de
- (transversal) revisão de diffs + execução de testes + conferência de contratos.

## Faz (sync gate — AGENTS.md §4)
1. Rodar `npm test` em `app/` e confirmar verde.
2. Conferir que o código usa exatamente as assinaturas dos contratos:
   - assinatura do `VaultStore` × uso em `vault-api.mjs`/`agent.ts`;
   - schema Postgres × endpoints `/api/reminders|investimentos`;
   - env vars × código;
   - docs × código (SPEC §8, PLANO).
3. Verificar que `SPEC.md` e `PLANO-ADAPTACAO.md` refletem o estado **real**.
4. Verificar `AGENTS.md §2/§3` se responsabilidade/contrato mudou.
5. Verificar `SPEC.md §12` (nenhuma decisão tomada listada como aberta).

## Checklist de entrega (aplicar por agente)
- [ ] código do domínio
- [ ] teste (se aplicável)
- [ ] contrato atualizado nos docs (se mudou interface)
- [ ] nota no CHANGELOG (se mudou comportamento)

## NÃO faz
- Implementar features grandes sozinho (é gate, não executor).

## Pronto quando
- O sync gate passa nos 5 itens; senão, devolve a lista do que falta para o agente dono corrigir.

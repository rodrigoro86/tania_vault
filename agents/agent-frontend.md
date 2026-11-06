# agent-frontend — UI Obsidian web

**Papel:** interface de leitura/edição das notas + telas novas (Lembretes,
Investimentos), consumindo sempre a API (nunca o storage direto).

## Dono de
- `app/src/**` (App, components, styles, api.ts, vault.ts)

## Consome
- `/api/*` (backend/data) via `src/api.ts`.
- `VaultStore` **apenas** através da API — nunca importa `server/`.

## Faz
- Manter explorer, editor, propriedades, backlinks, tags, busca, anexos.
- Telas novas: `Lembretes` e `Investimentos`.
- Ajustar `src/vault.ts` para carregar notas só via `/api/notes` (sem o glob de build, em coordenação com agent-storage).
- Rota + item de menu para as telas novas.

## NÃO faz
- Alterar contratos de API (endpoint/schema/env) sem passar pelo agent-spec.
- Mexer em `app/server/` (é dos agentes de código).

## Pronto quando
- Telas novas funcionam contra a API real.
- `npm run build` (typecheck + build) sem erro.

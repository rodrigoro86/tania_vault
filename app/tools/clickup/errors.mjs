/**
 * errors.mjs — ApiError da tool ClickUp.
 *
 * O erro já é `{ok:false, error}` em português (Global Constraints do plano);
 * `handleClickUp` lança ApiError(status, message) e quem serve HTTP traduz
 * status + mensagem. Está aqui separado para que `clickup.ts`, `mcp.ts` e
 * `server.mjs` compartirem a MESMA classe (instanceof funciona entre eles).
 */
export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

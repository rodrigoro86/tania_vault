//! Servidor MCP (JSON-RPC 2.0, protocolo 2025-06-18) do canal `POST /mcp`.
//!
//! Uma ferramenta só: `registrar_atividade`. O agente externo (Claude Code)
//! chama quando termina algo. Erro de regra (campo inválido) volta como
//! resultado com `isError`, e não como erro de protocolo.

use axum::http::StatusCode;
use serde_json::{json, Value};

use crate::http::AppState;
use crate::tokens::agenda;
use crate::tokens::auth::IntegracaoAuth;

const PROTOCOLO: &str = "2025-06-18";
const FERRAMENTA: &str = "registrar_atividade";

fn erro_rpc(id: Value, codigo: i64, mensagem: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": codigo, "message": mensagem } })
}

fn sucesso(id: Value, resultado: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": resultado })
}

pub fn lista_de_ferramentas() -> Value {
    json!({
        "tools": [{
            "name": FERRAMENTA,
            "description": "Registra no diário de hoje da Tania (01-Agenda) o que foi feito. Chame ao terminar uma tarefa.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "agente": { "type": "string", "description": "quem fez, ex.: agent-backend" },
                    "tarefa": { "type": "string", "description": "o que foi feito, em uma linha" },
                    "minutos": { "type": "integer", "minimum": 1, "maximum": 1440, "description": "tempo gasto, se souber" }
                },
                "required": ["agente", "tarefa"],
                "additionalProperties": false
            }
        }]
    })
}

/// Trata uma mensagem JSON-RPC. `None` = notificação (não há resposta).
pub async fn tratar(state: &AppState, _auth: &IntegracaoAuth, corpo: &Value) -> Option<Value> {
    let Some(obj) = corpo.as_object() else {
        return Some(erro_rpc(Value::Null, -32600, "pedido JSON-RPC inválido"));
    };
    let id = obj.get("id").cloned().unwrap_or(Value::Null);
    let Some(metodo) = obj.get("method").and_then(Value::as_str) else {
        return Some(erro_rpc(id, -32600, "pedido JSON-RPC inválido"));
    };
    // notificação: sem `id`, nada a responder
    let notificacao = !obj.contains_key("id");

    let resposta = match metodo {
        "initialize" => sucesso(
            id,
            json!({
                "protocolVersion": PROTOCOLO,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "tania-agenda", "version": env!("CARGO_PKG_VERSION") }
            }),
        ),
        "notifications/initialized" => return None,
        "tools/list" => sucesso(id, lista_de_ferramentas()),
        "tools/call" => chamar(state, id, obj.get("params")).await,
        _ => erro_rpc(id, -32601, "método desconhecido"),
    };
    if notificacao {
        None
    } else {
        Some(resposta)
    }
}

async fn chamar(state: &AppState, id: Value, params: Option<&Value>) -> Value {
    let nome = params.and_then(|p| p.get("name")).and_then(Value::as_str);
    if nome != Some(FERRAMENTA) {
        return erro_rpc(id, -32602, "ferramenta desconhecida");
    }
    let args = params.and_then(|p| p.get("arguments")).cloned().unwrap_or(json!({}));
    let agente = args.get("agente").and_then(Value::as_str).unwrap_or("");
    let tarefa = args.get("tarefa").and_then(Value::as_str).unwrap_or("");
    let minutos = args
        .get("minutos")
        .and_then(Value::as_u64)
        .and_then(|m| u32::try_from(m).ok());

    let texto = match agenda::validar(agente, tarefa, minutos) {
        Err(msg) => return resultado_erro(id, &msg),
        Ok(reg) => match agenda::registrar(&state.store, &reg, agenda::agora()).await {
            Ok(rel) => format!("Registrado em {rel}."),
            Err(_) => return resultado_erro(id, "não consegui gravar no diário"),
        },
    };
    sucesso(
        id,
        json!({ "content": [{ "type": "text", "text": texto }], "isError": false }),
    )
}

fn resultado_erro(id: Value, msg: &str) -> Value {
    sucesso(
        id,
        json!({ "content": [{ "type": "text", "text": msg }], "isError": true }),
    )
}

/// Status HTTP de resposta ao MCP: 202 para notificação, 200 para o resto.
pub fn status_da_resposta(resposta: &Option<Value>) -> StatusCode {
    if resposta.is_some() {
        StatusCode::OK
    } else {
        StatusCode::ACCEPTED
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lista_expoe_so_registrar_atividade_com_campos_obrigatorios() {
        let lista = lista_de_ferramentas();
        let tools = lista["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["name"], FERRAMENTA);
        let req = tools[0]["inputSchema"]["required"].as_array().unwrap();
        assert!(req.contains(&json!("agente")) && req.contains(&json!("tarefa")));
    }

    #[test]
    fn erro_de_protocolo_tem_codigo_e_id() {
        let e = erro_rpc(json!(7), -32601, "método desconhecido");
        assert_eq!(e["id"], 7);
        assert_eq!(e["error"]["code"], -32601);
    }

    #[test]
    fn notificacao_responde_202() {
        assert_eq!(status_da_resposta(&None), StatusCode::ACCEPTED);
        assert_eq!(status_da_resposta(&Some(json!({}))), StatusCode::OK);
    }
}

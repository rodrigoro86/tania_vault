//! Registro de atividade no diário `01-Agenda/AAAA-MM-DD.md` (design
//! `2026-11-06-tokens-integracao-design.md`, Parte 2).
//!
//! Cada registro vira uma linha `- ✅ HH:MM · agente · tarefa (N min)` dentro
//! da seção `## ✅ Feito`, o mesmo formato do agente `agenda` do WhatsApp. A
//! escrita é serializada por um lock do processo: dois agentes registrando ao
//! mesmo tempo não se sobrescrevem.
//!
//! Limite conhecido: o lock vale só dentro deste processo. O Node legado grava
//! o mesmo arquivo pelo WhatsApp e não participa do lock.

use std::sync::OnceLock;

use chrono::{DateTime, FixedOffset, Utc};
use tokio::sync::Mutex;

use crate::error::ApiError;
use crate::storage::Store;

pub const PASTA: &str = "01-Agenda";
pub const SECAO_FEITO: &str = "## ✅ Feito";
const MAX_AGENTE: usize = 40;
const MAX_TAREFA: usize = 300;
const MAX_MINUTOS: u32 = 1440;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Registro {
    pub agente: String,
    pub tarefa: String,
    pub minutos: Option<u32>,
}

/// Horário de São Paulo (UTC-3; o Brasil não usa horário de verão desde 2019).
pub fn agora() -> DateTime<FixedOffset> {
    let fuso = FixedOffset::west_opt(3 * 3600).expect("UTC-3 é um fuso válido");
    Utc::now().with_timezone(&fuso)
}

/// Valida e aparar os campos. Erro = mensagem para o cliente.
pub fn validar(agente: &str, tarefa: &str, minutos: Option<u32>) -> Result<Registro, String> {
    let agente = agente.trim();
    let tarefa = tarefa.trim();
    if agente.is_empty() || agente.chars().count() > MAX_AGENTE || agente.contains(['\n', '\r']) {
        return Err(format!("agente deve ter de 1 a {MAX_AGENTE} caracteres, em uma linha"));
    }
    if tarefa.is_empty() || tarefa.chars().count() > MAX_TAREFA || tarefa.contains(['\n', '\r']) {
        return Err(format!("tarefa deve ter de 1 a {MAX_TAREFA} caracteres, em uma linha"));
    }
    if let Some(m) = minutos {
        if !(1..=MAX_MINUTOS).contains(&m) {
            return Err(format!("minutos deve estar entre 1 e {MAX_MINUTOS}"));
        }
    }
    Ok(Registro {
        agente: agente.to_string(),
        tarefa: tarefa.to_string(),
        minutos,
    })
}

/// A linha do diário para o registro, no horário dado.
pub fn linha(reg: &Registro, quando: DateTime<FixedOffset>) -> String {
    let duracao = reg
        .minutos
        .map(|m| format!(" ({m} min)"))
        .unwrap_or_default();
    format!(
        "- ✅ {} · {} · {}{}",
        quando.format("%H:%M"),
        reg.agente,
        reg.tarefa,
        duracao
    )
}

/// Nota do dia, quando ainda não existe (mesmo frontmatter do agente `agenda`).
pub fn nota_nova(dia: &str) -> String {
    format!(
        "---\ntype: journal\ncreated: {dia}\ntags: [agenda/diario]\nstatus: open\n---\n# {dia}\n\n{SECAO_FEITO}\n"
    )
}

/// Põe `linha` no fim da seção `## ✅ Feito`, antes da próxima seção. Sem a
/// seção, ela é criada no fim do texto.
pub fn inserir_na_secao(texto: &str, linha: &str) -> String {
    let linhas: Vec<&str> = texto.lines().collect();
    let Some(i) = linhas.iter().position(|l| l.trim_end() == SECAO_FEITO) else {
        let mut out = texto.trim_end().to_string();
        out.push_str(&format!("\n\n{SECAO_FEITO}\n{linha}\n"));
        return out;
    };

    let proxima = linhas[i + 1..]
        .iter()
        .position(|l| l.starts_with("## "))
        .map(|k| i + 1 + k)
        .unwrap_or(linhas.len());
    // recua sobre as linhas em branco para a nova ficar colada ao último item
    let mut corte = proxima;
    while corte > i + 1 && linhas[corte - 1].trim().is_empty() {
        corte -= 1;
    }

    let mut out: Vec<&str> = linhas[..corte].to_vec();
    out.push(linha);
    out.extend_from_slice(&linhas[corte..]);
    let mut s = out.join("\n");
    s.push('\n');
    s
}

/// Acrescenta o registro ao diário do dia. Devolve o caminho da nota.
pub async fn registrar(store: &Store, reg: &Registro, quando: DateTime<FixedOffset>) -> Result<String, ApiError> {
    static ESCRITA: OnceLock<Mutex<()>> = OnceLock::new();
    let _guarda = ESCRITA.get_or_init(|| Mutex::new(())).lock().await;

    let dia = quando.format("%Y-%m-%d").to_string();
    let rel = format!("{PASTA}/{dia}.md");
    let base = if store.exists(&rel).await? {
        store.read_text(&rel).await?
    } else {
        nota_nova(&dia)
    };
    store
        .write_text(&rel, &inserir_na_secao(&base, &linha(reg, quando)))
        .await?;
    Ok(rel)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn quando() -> DateTime<FixedOffset> {
        FixedOffset::west_opt(3 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 11, 6, 14, 32, 0)
            .unwrap()
    }

    fn reg(minutos: Option<u32>) -> Registro {
        Registro {
            agente: "agent-backend".into(),
            tarefa: "porta rota /api/tools".into(),
            minutos,
        }
    }

    #[test]
    fn linha_segue_o_formato_do_agente_agenda() {
        assert_eq!(
            linha(&reg(Some(45)), quando()),
            "- ✅ 14:32 · agent-backend · porta rota /api/tools (45 min)"
        );
        assert_eq!(
            linha(&reg(None), quando()),
            "- ✅ 14:32 · agent-backend · porta rota /api/tools"
        );
    }

    #[test]
    fn validar_recusa_campos_fora_do_limite() {
        assert!(validar("  ", "x", None).is_err());
        assert!(validar("a", "", None).is_err());
        assert!(validar("a", "linha\nnova", None).is_err());
        assert!(validar("a", "x", Some(0)).is_err());
        assert!(validar("a", "x", Some(MAX_MINUTOS + 1)).is_err());
        assert_eq!(validar(" a ", " x ", Some(5)).unwrap().tarefa, "x");
    }

    #[test]
    fn nota_nova_tem_secao_feito() {
        let t = nota_nova("2026-11-06");
        assert!(t.starts_with("---\ntype: journal\n"));
        assert!(t.contains(&format!("\n{SECAO_FEITO}\n")));
    }

    #[test]
    fn insere_na_secao_antes_da_proxima() {
        let texto = "# d\n\n## ✅ Feito\n- ✅ 09:00 · a · x\n\n## Notas\nalgo\n";
        let out = inserir_na_secao(texto, "- ✅ 10:00 · b · y");
        assert_eq!(
            out,
            "# d\n\n## ✅ Feito\n- ✅ 09:00 · a · x\n- ✅ 10:00 · b · y\n\n## Notas\nalgo\n"
        );
    }

    #[test]
    fn insere_no_fim_quando_a_secao_e_a_ultima() {
        let texto = "# d\n\n## ✅ Feito\n- ✅ 09:00 · a · x\n";
        assert_eq!(
            inserir_na_secao(texto, "- ✅ 10:00 · b · y"),
            "# d\n\n## ✅ Feito\n- ✅ 09:00 · a · x\n- ✅ 10:00 · b · y\n"
        );
    }

    #[test]
    fn cria_a_secao_quando_falta() {
        let out = inserir_na_secao("# d\n", "- ✅ 10:00 · b · y");
        assert_eq!(out, "# d\n\n## ✅ Feito\n- ✅ 10:00 · b · y\n");
    }
}

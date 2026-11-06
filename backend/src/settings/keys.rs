//! Lista fixa das chaves editáveis na tela de configuração (SPEC/design
//! `2026-11-05-config-no-banco-design.md`). É a única fonte dessa lista: o
//! front, a API e os testes usam `CHAVES`, nunca uma cópia.

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Regra {
    Livre,
    Url,
    ZeroUm,
    Numeros,
    Inteiro,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Chave {
    pub nome: &'static str,
    pub grupo: &'static str,
    pub descricao: &'static str,
    pub segredo: bool,
    pub regra: Regra,
}

/// Valor aceito para qualquer chave: 1 a 4096 caracteres, sem quebra de linha.
const VALOR_MAX: usize = 4096;

pub const CHAVES: &[Chave] = &[
    Chave {
        nome: "EVOLUTION_URL",
        grupo: "WhatsApp",
        descricao: "URL da Evolution API",
        segredo: false,
        regra: Regra::Url,
    },
    Chave {
        nome: "EVOLUTION_API_KEY",
        grupo: "WhatsApp",
        descricao: "Chave da API da Evolution",
        segredo: true,
        regra: Regra::Livre,
    },
    Chave {
        nome: "EVOLUTION_INSTANCE",
        grupo: "WhatsApp",
        descricao: "Nome da instância do WhatsApp na Evolution",
        segredo: false,
        regra: Regra::Livre,
    },
    Chave {
        nome: "EVOLUTION_INSTANCE_TOKEN",
        grupo: "WhatsApp",
        descricao: "Token da instância na Evolution",
        segredo: true,
        regra: Regra::Livre,
    },
    Chave {
        nome: "EVOLUTION_DRY_RUN",
        grupo: "WhatsApp",
        descricao: "Não enviar mensagens de verdade (1 = só simular)",
        segredo: false,
        regra: Regra::ZeroUm,
    },
    Chave {
        nome: "WHATSAPP_ALLOWED_NUMBERS",
        grupo: "WhatsApp",
        descricao: "Números permitidos, separados por vírgula",
        segredo: false,
        regra: Regra::Numeros,
    },
    Chave {
        nome: "DEEPSEEK_API_KEY",
        grupo: "LLM",
        descricao: "Chave da API DeepSeek",
        segredo: true,
        regra: Regra::Livre,
    },
    Chave {
        nome: "OPENAI_API_KEY",
        grupo: "LLM",
        descricao: "Chave da API OpenAI",
        segredo: true,
        regra: Regra::Livre,
    },
    Chave {
        nome: "GEMINI_API_KEY",
        grupo: "LLM",
        descricao: "Chave da API Gemini",
        segredo: true,
        regra: Regra::Livre,
    },
    Chave {
        nome: "OPENROUTER_API_KEY",
        grupo: "LLM",
        descricao: "Chave da API OpenRouter",
        segredo: true,
        regra: Regra::Livre,
    },
    Chave {
        nome: "GROQ_API_KEY",
        grupo: "LLM",
        descricao: "Chave da API Groq",
        segredo: true,
        regra: Regra::Livre,
    },
    Chave {
        nome: "RATE_LIMIT_MAX",
        grupo: "Servidor",
        descricao: "Requisições por IP por janela na /api",
        segredo: false,
        regra: Regra::Inteiro,
    },
    Chave {
        nome: "RATE_LIMIT_WINDOW_MS",
        grupo: "Servidor",
        descricao: "Tamanho da janela do rate limit, em milissegundos",
        segredo: false,
        regra: Regra::Inteiro,
    },
];

/// A chave do nome dado, se está na lista.
pub fn chave(nome: &str) -> Option<&'static Chave> {
    CHAVES.iter().find(|c| c.nome == nome)
}

/// Devolve Err com a mensagem para o usuário quando o valor não serve.
pub fn validar(c: &Chave, valor: &str) -> Result<(), String> {
    if valor.is_empty() || valor.chars().count() > VALOR_MAX {
        return Err(format!(
            "valor inválido: 1 a {VALOR_MAX} caracteres, sem quebra de linha"
        ));
    }
    if valor.contains('\n') || valor.contains('\r') {
        return Err(format!(
            "valor inválido: 1 a {VALOR_MAX} caracteres, sem quebra de linha"
        ));
    }

    match c.regra {
        Regra::Livre => Ok(()),
        Regra::Url => {
            if valor.starts_with("http://") || valor.starts_with("https://") {
                Ok(())
            } else {
                Err("precisa começar com http:// ou https://".to_string())
            }
        }
        Regra::ZeroUm => {
            if valor == "0" || valor == "1" {
                Ok(())
            } else {
                Err("use 0 ou 1".to_string())
            }
        }
        Regra::Numeros => {
            for parte in valor.split(',') {
                let parte = parte.trim();
                if parte.is_empty() || !parte.chars().all(|ch| ch.is_ascii_digit()) {
                    return Err("números só com dígitos, separados por vírgula".to_string());
                }
            }
            Ok(())
        }
        Regra::Inteiro => match valor.parse::<u32>() {
            Ok(n) if n > 0 => Ok(()),
            _ => Err("precisa ser um número inteiro maior que zero".to_string()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chave_encontra_e_nao_inventa() {
        assert_eq!(chave("GROQ_API_KEY").map(|c| c.nome), Some("GROQ_API_KEY"));
        assert!(chave("GROQ_API_KEY").is_some_and(|c| c.segredo));
        // o token do ClickUp é config da tool (tools_config), não chave global
        assert!(chave("CLICKUP_TOKEN").is_none());
        assert!(chave("BRAPI_TOKEN").is_none());
        assert!(chave("VAULT_STORAGE").is_none());
        assert!(chave("").is_none());
    }

    #[test]
    fn regras_basicas() {
        let url = chave("EVOLUTION_URL").expect("a chave da spec deveria existir");
        assert!(validar(url, "https://evolution.local:8080").is_ok());
        assert_eq!(
            validar(url, "evolution.local:8080"),
            Err("precisa começar com http:// ou https://".to_string())
        );

        let dry = chave("EVOLUTION_DRY_RUN").expect("a chave da spec deveria existir");
        assert!(validar(dry, "1").is_ok());
        assert!(validar(dry, "0").is_ok());
        assert_eq!(validar(dry, "true"), Err("use 0 ou 1".to_string()));

        let numeros = chave("WHATSAPP_ALLOWED_NUMBERS").expect("a chave da spec deveria existir");
        assert!(validar(numeros, "5511999999999, 5511888888888").is_ok());
        assert_eq!(
            validar(numeros, "5511999999999,,5511888888888"),
            Err("números só com dígitos, separados por vírgula".to_string())
        );
        assert_eq!(
            validar(numeros, "5511-9999"),
            Err("números só com dígitos, separados por vírgula".to_string())
        );

        let limite = chave("RATE_LIMIT_MAX").expect("a chave da spec deveria existir");
        assert!(validar(limite, "300").is_ok());
        assert_eq!(
            validar(limite, "0"),
            Err("precisa ser um número inteiro maior que zero".to_string())
        );
        assert_eq!(
            validar(limite, "abc"),
            Err("precisa ser um número inteiro maior que zero".to_string())
        );

        let livre = chave("DEEPSEEK_API_KEY").expect("a chave da spec deveria existir");
        assert!(validar(livre, "sk-any-coisa").is_ok());
    }

    #[test]
    fn tamanho_e_quebra_de_linha() {
        let livre = chave("DEEPSEEK_API_KEY").expect("a chave da spec deveria existir");
        let msg = "valor inválido: 1 a 4096 caracteres, sem quebra de linha";
        assert_eq!(validar(livre, ""), Err(msg.to_string()));
        assert_eq!(validar(livre, "a\nb"), Err(msg.to_string()));
        assert_eq!(validar(livre, "a\r\nb"), Err(msg.to_string()));
        assert!(validar(livre, &"a".repeat(4096)).is_ok());
        assert_eq!(validar(livre, &"a".repeat(4097)), Err(msg.to_string()));
    }
}

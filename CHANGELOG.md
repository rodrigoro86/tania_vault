# Changelog

Mudanças relevantes do projeto Tania. Formato: [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) ·
versões em [SemVer](https://semver.org/lang/pt-BR/). O detalhe do front fica em [app/CHANGELOG.md](app/CHANGELOG.md).

## [Não lançado]

## [1.0.0] — 2026-11-06

Primeira versão pública.

### Incluído
- 📄 **Vault web** no estilo Obsidian (`app/`): notas, pastas, anexos, busca, wikilinks, exportação em PDF/Word e slides.
- 🤖 **Agente LLM** com tools sobre o vault, ClickUp, lembretes, financeiro e investimentos; provedores editáveis na tela Agents.
- 💬 **WhatsApp** (Evolution API): gatilhos `ideia:` e `feito:`, comprovantes direto para o vault e conversa com o agente.
- ⏰ **Lembretes**, 💰 **Financeiro** e 📈 **Investimentos** (carteira B3, comparação com Ibovespa/CDI, carteiras simuladas).
- 🦀 **Backend Rust** (`backend/`) na frente do Node legado: login por usuário no Postgres, sessões, rate limit, CSRF,
  rotas do vault, usuários, ⚙ Configurações (segredos cifrados com `TANIA_CONFIG_KEY`) e Agents.
- 🐳 **Stack local** com `docker compose up`: front (nginx), backend Rust, Node, Postgres 17 e bucket RustFS.

### Segurança
- Sem chave de criptografia padrão no Compose: salvar segredos exige `TANIA_CONFIG_KEY` própria no `.env`.
- Arquivos `.env*` fora do Git e do contexto Docker (exceto `.env.example`).

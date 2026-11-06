# Claude Code na sua máquina → Agenda da Tania

Como ligar o Claude Code (no notebook de trabalho, por exemplo) à Agenda da Tania. Desenho e regras:
[`superpowers/specs/2026-11-06-tokens-integracao-design.md`](superpowers/specs/2026-11-06-tokens-integracao-design.md).

## 1. Crie o token e ligue o canal (no app da Tania)

⚙ Configurações → **Tokens**:
1. (admin) em **Canais**, ligue **MCP** e/ou **Hook**.
2. Em **Novo token**, dê um nome (ex.: `notebook-trabalho`), marque os canais que esse token pode usar e clique em **Criar token**.
3. Copie o token **agora**: ele só aparece uma vez. Ele começa com `tania_`.

## 2. MCP: o agente decide quando registrar

```bash
claude mcp add --transport http tania https://SEU-DOMINIO/mcp \
  --header "Authorization: Bearer tania_..."
```

O agente ganha a ferramenta `registrar_atividade` (agente, tarefa e, se souber, minutos). Ela grava uma linha em
`01-Agenda/AAAA-MM-DD.md`, na seção `## ✅ Feito`.

## 3. Hook: registro mínimo ao fim de cada sessão

Copie [`scripts/tania-registro.sh`](../scripts/tania-registro.sh) para a sua máquina e adicione em `~/.claude/settings.json`
(troque o caminho do script):

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "/caminho/tania-registro.sh inicio" } ] }
    ],
    "SessionEnd": [
      { "hooks": [ { "type": "command", "command": "/caminho/tania-registro.sh fim" } ] }
    ]
  }
}
```

Variáveis no ambiente da sessão (ex.: no `~/.bashrc`):

```bash
export TANIA_URL=https://SEU-DOMINIO
export TANIA_TOKEN=tania_...
```

Sem essas variáveis o hook não faz nada. Ao fim da sessão ele registra `sessão em <pasta> (N min)`.

## Desligar ou revogar

- **Pela Tania:** desligue o canal em ⚙ Configurações → Tokens, ou desative/revogue o token. A Tania recusa na hora (403 ou 401).
- **Na máquina:** remova o hook do `settings.json` ou o `tania` do `claude mcp remove tania`. Isso é local; a Tania só aceita ou recusa.

## Limites conhecidos

- O token não expira. Quem tem o token pode registrar na agenda, e nada mais.
- Dois registros no mesmo instante são serializados só dentro do servidor Rust. O WhatsApp (Node legado) grava o mesmo arquivo sem esse lock.
- O hook mede o tempo entre `inicio` e `fim` na mesma máquina. Se a sessão for interrompida (fechar o terminal sem encerrar), o `fim` pode não rodar e nada é registrado.

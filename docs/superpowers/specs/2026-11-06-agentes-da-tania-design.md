# Agentes da Tania (roteamento por instruções no vault)

## Objetivo
Pedidos do terminal e do WhatsApp (mesmo `runAgent`) usam o agente especializado certo: "coloca na minha agenda que fiz X" →
agente `agenda`. Os agentes são notas editáveis pelo front.

## Formato
`99-Meta/Agentes/Tania/<nome>.md` (`nome`: `^[a-z0-9-]{1,32}$`, o do arquivo). Frontmatter `quando:` (texto: quando usar) obrigatório;
sem ele o agente é ignorado com aviso no log. Corpo = instruções.

## Agente
- Cada pedido: lista os agentes do vault (`store.listKeys('99-Meta/Agentes/Tania/')`, só `.md` direto na pasta) e põe no prompt do
  sistema um bloco "Agentes especializados" com `- <nome>: <quando>` e a regra: antes de agir num pedido que se encaixa, chame
  `usar_agente` e siga as instruções; pode usar mais de um.
- Ferramenta `usar_agente({nome})`: devolve `{nome, instrucoes}` (summary `🤖 agente <nome>`); inexistente → falha com a lista.
- Sem agentes na pasta: nenhum bloco e a ferramenta responde "nenhum agente".

## WhatsApp
`feito:`/`ideia:` vão para `runAgentText` (texto original). Falha do agente (sem LLM, erro, timeout) → comportamento antigo
(diário / nota de ideia direto). Comprovante (imagem/PDF) continua direto.

## Modelos
`agents/tania/agenda.md` e `agents/tania/ideias.md` reproduzem o comportamento atual. `scripts/agentes.mjs` sincroniza também
`agents/tania/*.md` ↔ `99-Meta/Agentes/Tania/` (push sem sobrescrever, pull sem apagar).

## Front
Seção Instruções do painel 🤖 Agents agrupada: Tania (Tania.md + Tania/*) e Equipe.

## Fora do escopo
Ferramentas ou modelo por agente, tela própria para criar agente.

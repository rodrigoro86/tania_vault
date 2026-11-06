# Agentes da Tania — Implementation Plan

**Spec:** `docs/superpowers/specs/2026-11-06-agentes-da-tania-design.md`. Execução: Claude Code faz T1, T3, T4; Strata faz T2.

## Review Focus
1. Nota em `Tania/` sem frontmatter ou sem `quando`: ignorada, prompt segue (T1).
2. Nome pedido com outro caso/espaço ("Agenda "): normaliza (trim + minúsculas) antes de procurar (T1).
3. WhatsApp sem LLM configurado: `feito:` ainda grava no diário (T2).
4. Subpasta dentro de `Tania/`: ignorada (T1, T2-script).

### T1 (Claude): `app/server/agent/agentes.ts` + integração em `agent.ts`
`listarAgentes(store): Promise<{nome, quando, instrucoes}[]>`, `blocoAgentes(lista): string`; ferramenta `usar_agente`. Teste em `agent.test.mjs`.
### T2 (Strata): WhatsApp passa `feito:`/`ideia:` pelo agente com fallback + script sincroniza `agents/tania/`
### T3 (Claude): modelos `agents/tania/agenda.md`, `ideias.md`; front agrupa Instruções
### T4 (Claude): docs (SPEC §7.9, AGENTS, CHANGELOGs), push local e teste no navegador

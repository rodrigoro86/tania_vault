#!/usr/bin/env bash
# Hook do Claude Code: registra a sessão na Agenda da Tania (design
# docs/superpowers/specs/2026-11-06-tokens-integracao-design.md, canal Hook).
#
# Uso no settings.json: SessionStart -> tania-registro.sh inicio
#                       SessionEnd   -> tania-registro.sh fim
# Precisa de TANIA_URL e TANIA_TOKEN no ambiente. Sem eles, sai em silêncio:
# o hook nunca atrapalha a sessão.
set -u

acao="${1:-fim}"
[ -n "${TANIA_URL:-}" ] && [ -n "${TANIA_TOKEN:-}" ] || exit 0

entrada=$(cat)
sid=$(printf '%s' "$entrada" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("session_id", "sem-id"))' 2>/dev/null || echo sem-id)
marcas="${TMPDIR:-/tmp}/tania-sessoes"
mkdir -p "$marcas"
marca="$marcas/$sid"

if [ "$acao" = inicio ]; then
  date +%s > "$marca"
  exit 0
fi

minutos=""
if [ -f "$marca" ]; then
  minutos=$(( ( $(date +%s) - $(cat "$marca") ) / 60 ))
  rm -f "$marca"
fi

corpo=$(python3 - "$(basename "$PWD")" "$minutos" <<'PY'
import json, sys
projeto, minutos = sys.argv[1], sys.argv[2]
corpo = {"agente": "claude-code", "tarefa": "sessão em " + projeto}
if minutos and int(minutos) >= 1:
    corpo["minutos"] = int(minutos)
print(json.dumps(corpo, ensure_ascii=False))
PY
)

curl -s -m 10 -o /dev/null -X POST "$TANIA_URL/api/agenda/registro" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TANIA_TOKEN" \
  -d "$corpo" || true

# app/ — front e backend Node (legado)

Front estilo Obsidian para ler e editar as notas do vault, com terminal de agente (LLM), integração com ClickUp e
exportação para Word/PDF/slides.

- `src/`: front React (Vite)
- `server/`: backend Node legado (agente, ClickUp, WhatsApp, lembretes, investimentos); some na F7
- Versões e mudanças: [CHANGELOG.md](CHANGELOG.md)

Para subir a stack inteira (front, backend Rust, Node, Postgres e bucket), veja o [README da raiz](../README.md).

## Arquivos de configuração (fora do git)

| Arquivo | Para quê |
|---|---|
| `agent.config.json` | LLM do terminal (alternativa: a tela 🤖 Agents salva no banco, e o banco vence); o modelo está em `agent.config.example.json` |
| `clickup.config.json` | `token`, `teamId` e `spaceIds` do ClickUp |

Os dois são relidos a cada pedido, então mudar não exige reiniciar. Variáveis de ambiente: `.env.example`. Com o
backend Rust, as integrações também podem ser editadas em ⚙ Configurações.

## Acesso pelo Tailscale (uma vez só)

```bash
sudo tailscale serve --bg 3000   # porta do front no compose da raiz
```

## Desenvolvimento

Requer Node 24 (o servidor roda os `.ts` direto).

```bash
npm install
npm run dev        # Vite em http://localhost:5173 (BACKEND_URL=http://localhost:3100 usa o backend Rust)
npm test           # testes do servidor
npm run build      # typecheck + build de produção em dist/
npm run serve      # servidor Node sem Docker
```

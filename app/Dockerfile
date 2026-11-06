# syntax=docker/dockerfile:1
# Build: tsc + vite (as notas vivem no MinIO; sem glob de build).
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

# Runtime: Node 24 roda server/*.ts direto (type stripping).
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOME=/tmp
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
# tools internas (ClickUp...): mesma imagem, outro comando (docker-compose.yml)
COPY --from=build /app/tools ./tools
# regra da situação do mês, a mesma da tela (tool situacao_mes)
COPY --from=build /app/src/financeView.ts ./src/financeView.ts
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1 || exit 1
CMD ["node", "server/server.mjs"]

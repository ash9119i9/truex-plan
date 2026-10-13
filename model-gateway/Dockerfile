# syntax=docker/dockerfile:1

# Build from the repository root so the shared gateway token code is available.
FROM node:24-bookworm-slim AS build
WORKDIR /app/model-gateway
COPY model-gateway/package.json model-gateway/package-lock.json ./
RUN --mount=type=cache,id=truex-model-gateway-npm,target=/root/.npm \
    npm ci
COPY model-gateway/tsconfig.json ./
COPY model-gateway/src ./src
COPY shared/gateway-token.ts shared/prompt-cache.ts /app/shared/
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
WORKDIR /app/model-gateway
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4200
COPY --from=build /app/model-gateway/dist ./dist
COPY --from=build /app/model-gateway/node_modules ./node_modules
USER node
EXPOSE 4200
HEALTHCHECK --interval=30s --timeout=6s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/ready', {signal: AbortSignal.timeout(5000)}).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "dist/model-gateway/src/index.js"]

FROM node:24-bookworm-slim AS codex-artifact
WORKDIR /artifact
COPY codex.lock.json ./codex.lock.json
COPY deploy/agentcore/bin/codex ./codex
COPY deploy/agentcore/bin/codex.json ./codex.json
COPY deploy/agentcore/verify-binary.mjs ./verify-binary.mjs
RUN node verify-binary.mjs codex codex.json codex.lock.json

FROM node:24-bookworm-slim AS core-build
WORKDIR /app/agent-core
COPY agent-core/package*.json ./
RUN npm ci
COPY agent-core/tsconfig.json ./
COPY agent-core/src ./src
COPY shared /app/shared
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS gateway-build
WORKDIR /app/model-gateway
COPY model-gateway/package*.json ./
RUN npm ci
COPY model-gateway/tsconfig.json ./
COPY model-gateway/src ./src
COPY shared /app/shared
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git ripgrep libssl3 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=core-build /app/agent-core /app/agent-core
COPY --from=gateway-build /app/model-gateway /app/model-gateway
COPY shared/schema /app/shared/schema
COPY codex.lock.json /app/codex.lock.json
COPY --chmod=0755 --from=codex-artifact /artifact/codex /app/vendor/codex/codex-rs/target/debug/codex
COPY deploy/agentcore/start.mjs /app/deploy/agentcore/start.mjs
RUN mkdir -p /data/codex /data/workspace && chown -R node:node /data /app
USER node
ENV PROJECT_ROOT=/app CODEX_HOME=/data/codex AGENT_WORKSPACE=/data/workspace
RUN /app/vendor/codex/codex-rs/target/debug/codex --version
EXPOSE 8080
CMD ["node", "/app/deploy/agentcore/start.mjs"]

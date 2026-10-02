FROM rust:1.95-bookworm AS codex-build
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev clang cmake && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY vendor/codex/ ./
WORKDIR /src/codex-rs
RUN cargo build --locked --release -p codex-cli --bin codex

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
COPY --from=codex-build /src/codex-rs/target/release/codex /app/vendor/codex/codex-rs/target/debug/codex
COPY deploy/agentcore/start.mjs /app/deploy/agentcore/start.mjs
RUN mkdir -p /data/codex /data/workspace && chown -R node:node /data /app
USER node
ENV PROJECT_ROOT=/app CODEX_HOME=/data/codex AGENT_WORKSPACE=/data/workspace
EXPOSE 8080
CMD ["node", "/app/deploy/agentcore/start.mjs"]

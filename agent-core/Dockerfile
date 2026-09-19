FROM rust:1.95-bookworm AS runtime-build
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev clang cmake && rm -rf /var/lib/apt/lists/*
WORKDIR /src
# Source must first be fetched and verified by npm run codex:setup on the host.
COPY vendor/codex/ ./
WORKDIR /src/codex-rs
RUN cargo build --locked --release -p codex-cli --bin codex
FROM node:24-bookworm-slim AS adapter-build
WORKDIR /app/agent-core
COPY agent-core/package*.json ./
RUN npm ci
COPY agent-core/tsconfig.json ./
COPY agent-core/src ./src
COPY shared /app/shared
RUN npm run build && npm prune --omit=dev
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git ripgrep libssl3 && rm -rf /var/lib/apt/lists/*
WORKDIR /app/agent-core
COPY --from=adapter-build /app/agent-core /app/agent-core
COPY shared/schema /app/shared/schema
COPY codex.lock.json /app/codex.lock.json
COPY --from=runtime-build /src/codex-rs/target/release/codex /app/vendor/codex/codex-rs/target/debug/codex
RUN mkdir -p /data/codex /data/workspace && chown -R node:node /data /app
USER node
ENV HOST=0.0.0.0 PORT=4100 PROJECT_ROOT=/app CODEX_HOME=/data/codex AGENT_WORKSPACE=/data/workspace
EXPOSE 4100
CMD ["npm","start"]

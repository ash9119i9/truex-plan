# syntax=docker/dockerfile:1

# Download the pinned prebuilt ARM64 Codex release; codex.lock.json holds its tag and SHA-256.
# The archive checksum is verified before the binary is extracted.
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS codex-download
WORKDIR /src
COPY codex.lock.json ./
COPY scripts/codex.mjs ./scripts/
RUN node scripts/codex.mjs --download --target=aarch64-unknown-linux-musl

FROM node:24-bookworm-slim AS services-build
ARG TARGETARCH
RUN test "$TARGETARCH" = arm64
WORKDIR /app
COPY shared ./shared
COPY agent-core/package.json agent-core/package-lock.json agent-core/tsconfig.json ./agent-core/
RUN --mount=type=cache,id=truex-agentcore-npm,target=/root/.npm \
    npm --prefix agent-core ci
COPY agent-core/src ./agent-core/src
RUN npm --prefix agent-core run build \
    && npm --prefix agent-core prune --omit=dev

# Trixie provides glibc 2.41, including symbols needed by Ubuntu 24.04 ARM64 builds.
FROM node:24-trixie-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git ripgrep libssl3t64 libcap2 liblzma5 tini chromium fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app/agent-core
COPY --from=services-build /app/agent-core/dist ./dist
COPY --from=services-build /app/agent-core/node_modules ./node_modules
COPY shared/schema /app/shared/schema
COPY codex.lock.json /app/codex.lock.json
COPY --chmod=0755 --from=codex-download /src/vendor/codex/codex-rs/target/debug/codex /app/vendor/codex/codex-rs/target/debug/codex
RUN mkdir -p /mnt/state && chown node:node /mnt/state \
    && /app/vendor/codex/codex-rs/target/debug/codex --version \
    && chromium --version
USER node
ENV NODE_ENV=production PROJECT_ROOT=/app \
    CODEX_HOME=/mnt/state/codex AGENT_WORKSPACE=/mnt/state/workspace \
    HOST=0.0.0.0 PORT=8080 CHROMIUM_PATH=/usr/bin/chromium
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/agent-core/src/agentcore.js"]

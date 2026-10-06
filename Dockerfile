# syntax=docker/dockerfile:1

# Build the pinned ARM64 executable first with --target codex-artifact.
# Cross-compilation runs natively on the builder, including on x86-64 hosts.
FROM --platform=$BUILDPLATFORM node:24-bookworm AS codex-source
WORKDIR /src
COPY codex.lock.json ./
COPY scripts/codex.mjs scripts/codex-artifact.mjs ./scripts/
RUN node scripts/codex.mjs

FROM --platform=$BUILDPLATFORM rust:1.95-bookworm AS codex-build
RUN dpkg --add-architecture arm64 \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
       gcc-aarch64-linux-gnu g++-aarch64-linux-gnu \
       libc6-dev:arm64 libssl-dev:arm64 libcap-dev:arm64 liblzma-dev:arm64 \
       pkg-config clang cmake \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src/vendor/codex/codex-rs
COPY --from=codex-source /src/vendor/codex /src/vendor/codex
RUN rustup target add --toolchain 1.95.0 aarch64-unknown-linux-gnu
ENV CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc \
    CC_aarch64_unknown_linux_gnu=aarch64-linux-gnu-gcc \
    CXX_aarch64_unknown_linux_gnu=aarch64-linux-gnu-g++ \
    AR_aarch64_unknown_linux_gnu=aarch64-linux-gnu-ar \
    PKG_CONFIG_ALLOW_CROSS=1 \
    PKG_CONFIG_PATH_aarch64_unknown_linux_gnu=/usr/lib/aarch64-linux-gnu/pkgconfig \
    CARGO_PROFILE_RELEASE_DEBUG=0 \
    CARGO_PROFILE_RELEASE_STRIP=symbols
ARG CODEX_BUILD_JOBS=2
RUN --mount=type=cache,id=truex-arm64-cargo-registry,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=truex-arm64-cargo-git,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,id=truex-arm64-cargo-target,target=/src/vendor/codex/codex-rs/target,sharing=locked \
    cargo build --locked --release --target aarch64-unknown-linux-gnu \
      --jobs "$CODEX_BUILD_JOBS" -p codex-cli --bin codex \
    && install -D -m 0755 target/aarch64-unknown-linux-gnu/release/codex /out/codex

FROM codex-source AS codex-manifest
COPY --from=codex-build /out/codex /out/codex
RUN node scripts/codex-artifact.mjs create /out/codex /out/codex.json codex.lock.json vendor/codex

FROM scratch AS codex-artifact
COPY --from=codex-manifest /out/codex /codex
COPY --from=codex-manifest /out/codex.json /codex.json

# Image builds consume the exported artifact; they do not compile Rust again.
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS artifact-check
WORKDIR /artifact
COPY codex.lock.json ./
COPY scripts/codex-artifact.mjs ./
COPY .runtime/agentcore/codex .runtime/agentcore/codex.json ./
RUN node codex-artifact.mjs verify codex codex.json codex.lock.json

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
COPY --chmod=0755 --from=artifact-check /artifact/codex /app/vendor/codex/codex-rs/target/debug/codex
COPY --from=artifact-check /artifact/codex.json /app/codex-artifact.json
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

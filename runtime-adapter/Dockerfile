# syntax=docker/dockerfile:1

# runtime-adapter for Bedrock AgentCore Runtime (RUNTIME_MODE=agentcore),
# with an official Codex release binary in the same image. Build from the
# repository root:
#
#   docker buildx build --platform linux/arm64 -f runtime-adapter/Dockerfile \
#     -t truex-runtime-adapter:local --load .
#
# The same image runs as the plain HTTP server with RUNTIME_MODE=server.

# The Codex release in the image. To upgrade, change all three together:
# the tag, its version string (`codex --version`) and the sha256 of
# codex-aarch64-unknown-linux-musl.tar.gz from the release page. Run the
# real-Codex tests (test/codex) against the new version first.
ARG CODEX_RELEASE=rust-v0.164.0-alpha.1
ARG CODEX_VERSION=0.164.0-alpha.1
ARG CODEX_SHA256=9eb1b68c4605510861b00e7eae502da265c1d62b6415b29c87d3fb0bff9066f1

# Downloads the release and checks its checksum and architecture. Static
# (musl) build: it needs no system libraries.
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS codex-release
ARG CODEX_RELEASE
ARG CODEX_SHA256
WORKDIR /download
ADD https://github.com/openai/codex/releases/download/${CODEX_RELEASE}/codex-aarch64-unknown-linux-musl.tar.gz codex.tar.gz
RUN echo "${CODEX_SHA256}  codex.tar.gz" | sha256sum -c - \
    && tar -xzf codex.tar.gz \
    && install -D -m 0755 codex-aarch64-unknown-linux-musl /out/codex \
    && node -e 'const h = require("fs").readFileSync("/out/codex").subarray(0, 20); \
         if (h.readUInt32BE(0) !== 0x7f454c46 || h[4] !== 2 || h.readUInt16LE(18) !== 183) \
           { console.error("Not a Linux ARM64 executable"); process.exit(1); }'

# Plain JavaScript with no runtime dependencies, so it builds natively.
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS build
WORKDIR /app
COPY runtime-adapter/package.json runtime-adapter/package-lock.json \
     runtime-adapter/tsconfig.json runtime-adapter/tsconfig.build.json ./
RUN --mount=type=cache,id=truex-runtime-adapter-npm,target=/root/.npm \
    npm ci --no-audit --no-fund
COPY runtime-adapter/src ./src
RUN npm run build

# Python 3 and the pinned document libraries coding runs use
# (runtime-adapter/toolchain): hash-checked wheels only, no compilers.
FROM node:24-trixie-slim AS toolchain
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*
COPY runtime-adapter/toolchain/requirements.txt /tmp/toolchain-requirements.txt
RUN python3 -m venv /opt/truex/python \
    && /opt/truex/python/bin/python3 -m pip install --no-cache-dir \
       --disable-pip-version-check --no-input --require-hashes \
       --only-binary=:all: --no-deps -r /tmp/toolchain-requirements.txt \
    && rm /tmp/toolchain-requirements.txt \
    && /opt/truex/python/bin/python3 -I -c "import docx, openpyxl, pptx, pypdf, reportlab"
ENV RUNTIME_TOOLCHAIN_DIRS=/opt/truex/python

FROM toolchain AS runtime
ARG TARGETARCH
ARG CODEX_RELEASE
ARG CODEX_VERSION
RUN test "$TARGETARCH" = arm64
# Codex needs TLS roots, git and ripgrep. tini reaps the Codex processes the
# adapter starts.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git ripgrep tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app/runtime-adapter
COPY runtime-adapter/package.json ./
COPY --from=build /app/dist ./dist
COPY --from=codex-release /out/codex /opt/truex/bin/codex
# Fails the build, not the first chat, if the binary can't run here or is
# not the expected version.
RUN mkdir -p /mnt/state && chown node:node /mnt/state \
    && version="$(/opt/truex/bin/codex --version)" && echo "$version" \
    && test "$version" = "codex-cli ${CODEX_VERSION}"
LABEL truex.codex.release="${CODEX_RELEASE}"
USER node
# RUNTIME_STATE_DIR is the AgentCore session storage mount. Coding stays off
# unless RUNTIME_CODING_ENABLED=1 is set on the runtime.
ENV NODE_ENV=production \
    RUNTIME_MODE=agentcore HOST=0.0.0.0 PORT=8080 \
    RUNTIME_STATE_DIR=/mnt/state \
    RUNTIME_CODEX_BINARY=/opt/truex/bin/codex
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]

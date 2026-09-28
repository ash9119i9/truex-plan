# Sandbox image for agent-core's run_script tool (SCRIPT_RUNNER=docker).
# Build: docker build -t truex-script-runner:local deploy/runner
FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 \
 && rm -rf /var/lib/apt/lists/* /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
USER 65534:65534
WORKDIR /work

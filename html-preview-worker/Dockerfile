FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
ARG CHROMIUM_VERSION=154.0.8037.92-1~deb12u1
RUN apt-get update && apt-get install -y --no-install-recommends chromium=${CHROMIUM_VERSION} chromium-common=${CHROMIUM_VERSION} fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /renderer
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY render.mjs ./
USER 65534:65534
ENTRYPOINT ["node", "/renderer/render.mjs"]

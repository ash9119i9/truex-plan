FROM node:24-bookworm-slim AS build
WORKDIR /app/web-service
COPY web-service/package*.json ./
RUN npm ci
COPY web-service/tsconfig.json ./
COPY web-service/src ./src
COPY shared /app/shared
RUN npm run build && npm prune --omit=dev
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 procps procps && rm -rf /var/lib/apt/lists/* && mkdir -p /data/webcrawl && chown node:node /data/webcrawl
WORKDIR /app/web-service
COPY --from=build /app/web-service ./
USER node
ENV HOST=0.0.0.0 PORT=4400
EXPOSE 4400
CMD ["node", "dist/web-service/src/index.js"]

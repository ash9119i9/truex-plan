FROM node:24-bookworm-slim AS build
WORKDIR /app/model-gateway
COPY model-gateway/package*.json ./
RUN npm ci
COPY model-gateway/tsconfig.json ./
COPY model-gateway/src ./src
COPY shared /app/shared
RUN npm run build && npm prune --omit=dev
FROM node:24-bookworm-slim
WORKDIR /app/model-gateway
COPY --from=build /app/model-gateway ./
USER node
ENV HOST=0.0.0.0 PORT=4200
EXPOSE 4200
# Run node directly (not npm) so SIGTERM reaches the drain handler.
CMD ["node","dist/model-gateway/src/index.js"]

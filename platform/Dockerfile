FROM node:24-bookworm-slim AS build
WORKDIR /app/platform
COPY platform/package*.json ./
RUN npm ci
COPY platform/tsconfig.json ./
COPY platform/src ./src
COPY shared /app/shared
RUN npm run build && npm prune --omit=dev
FROM node:24-bookworm-slim
WORKDIR /app/platform
COPY --from=build /app/platform ./
USER node
ENV HOST=0.0.0.0 PORT=4000
EXPOSE 4000
CMD ["npm","start"]

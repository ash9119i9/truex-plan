# syntax=docker/dockerfile:1
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
WORKDIR /app
COPY shared ./shared
COPY platform/package.json platform/package-lock.json platform/tsconfig.json ./platform/
RUN npm --prefix platform ci
COPY platform/src ./platform/src
RUN npm --prefix platform run build && npm --prefix platform prune --omit=dev

FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
WORKDIR /app/platform
COPY --from=build --chown=node:node /app/platform/dist ./dist
COPY --from=build --chown=node:node /app/platform/node_modules ./node_modules
COPY --from=build --chown=node:node /app/shared/schema /app/shared/schema
USER node
ENV NODE_ENV=production AUTOMATIONS_ENABLED=off
STOPSIGNAL SIGTERM
CMD ["node", "dist/platform/src/automation/main.js"]

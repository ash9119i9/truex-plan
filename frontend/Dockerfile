# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
COPY frontend/scripts/patch-legend-list.mjs ./scripts/patch-legend-list.mjs
RUN npm ci
COPY frontend/ ./
COPY shared/ /app/shared/
ARG NEXT_PUBLIC_PLATFORM_URL
ENV NEXT_PUBLIC_PLATFORM_URL=$NEXT_PUBLIC_PLATFORM_URL
RUN npm run build && npm prune --omit=dev && mkdir -p public

FROM node:24-bookworm-slim AS runtime
WORKDIR /app/frontend
ENV NODE_ENV=production PORT=3000 NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app/frontend/package.json ./
COPY --from=build /app/frontend/node_modules ./node_modules
COPY --from=build /app/frontend/.next ./.next
COPY --from=build /app/frontend/public ./public
COPY --from=build /app/frontend/next.config.ts ./
USER node
EXPOSE 3000
CMD ["node", "node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0", "--port", "3000"]

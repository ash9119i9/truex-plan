# syntax=docker/dockerfile:1

# Use the repository root as the build context for shared contracts and code.
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,id=truex-shared-npm,target=/root/.npm \
    npm ci --omit=dev
WORKDIR /app/platform
COPY platform/package.json platform/package-lock.json ./
# The MongoDB test binary is not needed when compiling the service.
RUN --mount=type=cache,id=truex-platform-npm,target=/root/.npm \
    MONGOMS_DISABLE_POSTINSTALL=1 npm ci
COPY platform/tsconfig.json ./
COPY platform/src ./src
COPY shared /app/shared
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
WORKDIR /app/platform
ENV NODE_ENV=production AUTH_MODE=poc HOST=0.0.0.0 PORT=4000
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/platform/package.json ./package.json
COPY --from=build /app/platform/dist ./dist
COPY --from=build /app/platform/node_modules ./node_modules
USER node
EXPOSE 4000
# Check this process without invoking AgentCore on every container probe.
HEALTHCHECK --interval=30s --timeout=6s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/livez', {signal: AbortSignal.timeout(5000)}).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "dist/platform/src/index.js"]

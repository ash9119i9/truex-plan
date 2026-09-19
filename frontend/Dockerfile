FROM node:24-bookworm-slim AS build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend ./
COPY shared /app/shared
ARG NEXT_PUBLIC_PLATFORM_URL=http://localhost:4000
ENV NEXT_PUBLIC_PLATFORM_URL=$NEXT_PUBLIC_PLATFORM_URL
RUN npm run build
FROM node:24-bookworm-slim
WORKDIR /app
COPY --from=build /app/frontend/.next/standalone ./
COPY --from=build /app/frontend/.next/static ./frontend/.next/static
USER node
ENV HOSTNAME=0.0.0.0 PORT=3000
EXPOSE 3000
CMD ["node","frontend/server.js"]

# syntax=docker/dockerfile:1
# Build context = the bridge repo root: subdustd imports the protocol lib from src/atomic.

FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1-alpine AS runtime
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock ./
COPY src ./src
COPY subdustd ./subdustd
EXPOSE 9010
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["bun", "run", "subdustd/healthcheck.ts", "/config/subdustd.json"]
CMD ["bun", "run", "subdustd/main.ts", "/config/subdustd.json"]

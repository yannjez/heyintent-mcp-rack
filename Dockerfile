FROM node:22-bookworm-slim AS base

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@10.33.3

WORKDIR /app

FROM base AS build

COPY . .
RUN pnpm install --frozen-lockfile
# Prisma requires a URL while loading its config, but generation does not connect.
RUN DATABASE_URL=postgresql://postgres:postgres@localhost:5432/heyintent_rack pnpm build

FROM base AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    WEB_DIST=/app/apps/web-rack/dist

# Keep workspace links and the Prisma CLI used for deployment migrations.
COPY --from=build --chown=node:node /app /app

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["sh", "/app/docker/entrypoint.sh"]
CMD ["node", "apps/api-rack/dist/server.js"]

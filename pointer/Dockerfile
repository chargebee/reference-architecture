# syntax=docker/dockerfile:1.7

# ---------- Base ----------
# Node 22 (current LTS, supported by Next.js 16). Alpine for a small image.
FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat
ENV CI=true
RUN corepack enable

# ---------- Dependencies ----------
FROM base AS deps
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Keep the pnpm store on the same filesystem as node_modules so pnpm can
# hardlink instead of copying (avoids ~2x disk usage during install).
RUN pnpm config set store-dir /app/.pnpm-store \
 && pnpm install --frozen-lockfile

# ---------- Builder ----------
FROM base AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production

RUN pnpm build

# ---------- Lambda worker bundle ----------
FROM deps AS lambda-builder
WORKDIR /app

COPY . .
RUN pnpm build:lambda

# ---------- Lambda worker runtime ----------
FROM public.ecr.aws/lambda/nodejs:22 AS lambda-worker

ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps

COPY --from=lambda-builder /app/dist/lambda/ ${LAMBDA_TASK_ROOT}/

CMD ["index.handler"]

# ---------- Runner ----------
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Run as a non-root user.
RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 nextjs

# Standalone server + traced node_modules.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
# Static assets and public files (served by the standalone server when colocated).
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public      ./public

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/" >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]

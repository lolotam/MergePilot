# ==============================================================================
# MergePilot Multi-Stage Dockerfile
# Stage 1: Build - compiles all workspace packages with frozen lockfile
# Stage 2: Runtime - minimal image containing only production dependencies
# ==============================================================================

FROM node:22-bookworm-slim AS build

# Pin pnpm via Corepack matching root package.json packageManager (pnpm@10.18.0)
RUN corepack enable && corepack prepare pnpm@10.18.0 --activate

WORKDIR /build

# Copy monorepo manifests and lockfile first for optimal layer caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/ packages/
COPY apps/ apps/
COPY tsconfig*.json eslint.config.js vitest.config.ts ./

# Install workspace dependencies with frozen lockfile
RUN pnpm install --frozen-lockfile

# Build workspace packages (engine, github, app, and web if present)
RUN pnpm build

# Deploy @mergepilot/app with production dependencies only into /out
RUN pnpm --filter @mergepilot/app --legacy deploy --prod /out

# If apps/web/dist exists, copy build output for static serving
RUN if [ -d apps/web/dist ]; then \
      mkdir -p /out/apps/web/dist /out/public && \
      cp -r apps/web/dist/* /out/apps/web/dist/ && \
      cp -r apps/web/dist/* /out/public/; \
    fi

# ==============================================================================
# Stage 2: Minimal Runtime Image
# ==============================================================================
FROM node:22-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Copy only production artifacts deployed from the build stage
COPY --chown=node:node --from=build /out /app

# Switch to non-root user
USER node

# Expose web application port
EXPOSE 3000

# Container healthcheck against /health route
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Default command runs the web application server
CMD ["node", "dist/server/main.js"]

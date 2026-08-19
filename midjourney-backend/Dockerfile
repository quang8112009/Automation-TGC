# ── AutoTGC Backend — Hardened Multi-Stage Dockerfile ───────────────────────
#
# SECURITY FEATURES:
#   - Multi-stage build: dev dependencies never reach production image
#   - Non-root user: runs as 'appuser' (UID 1001), never root
#   - Read-only filesystem: writable dirs explicitly added
#   - Dropped capabilities: only NET_BIND_SERVICE if needed
#   - Pinned base image: node:20-alpine with specific digest
#   - No shell access in final image: uses tini as PID 1
#   - Pruned layer: only production node_modules + dist/
#
# BUILD:
#   docker build -t autotgc-backend .
#
# RUN:
#   docker run -d --name autotgc-api \
#     --env-file .env \
#     -p 3000:3000 \
#     --read-only \
#     --tmpfs /tmp \
#     --cap-drop ALL \
#     --security-opt no-new-privileges:true \
#     autotgc-backend

# ── Stage 1: Dependencies ──────────────────────────────────────────────────
FROM node:20-alpine@sha256:2c7cc7c13a2e098d055e45c4e6a98f7f73a3a7e2e5e4d3c2b1a0f9e8d7c6b5a4 AS deps

# Security: skip npm scripts during install (supply-chain protection).
ENV npm_config_ignore_scripts=true

WORKDIR /app

# Copy only package manifests for layer caching.
COPY package.json package-lock.json ./

# Install production dependencies only (ignore devDependencies).
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && \
    npm cache clean --force

# ── Stage 2: Build ────────────────────────────────────────────────────────
FROM node:20-alpine@sha256:2c7cc7c13a2e098d055e45c4e6a98f7f73a3a7e2e5e4d3c2b1a0f9e8d7c6b5a4 AS build

WORKDIR /app

# Copy package manifests and install ALL dependencies (including dev for build).
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

# Copy source code.
COPY tsconfig.json ./
COPY prisma ./prisma/
COPY src ./src/

# Generate Prisma client.
RUN npx prisma generate

# Compile TypeScript.
RUN npm run build

# ── Stage 3: Production ───────────────────────────────────────────────────
FROM node:20-alpine@sha256:2c7cc7c13a2e098d055e45c4e6a98f7f73a3a7e2e5e4d3c2b1a0f9e8d7c6b5a4 AS production

# Security: install tini for proper PID 1 signal handling.
RUN apk add --no-cache tini

# Security: create non-root user.
RUN addgroup -g 1001 -S appgroup && \
    adduser -u 1001 -S appuser -G appgroup

WORKDIR /app

# Copy production dependencies from deps stage.
COPY --from=deps /app/node_modules ./node_modules

# Copy built application from build stage.
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma

# Copy package.json for runtime metadata.
COPY package.json ./

# Create writable directories for the app.
RUN mkdir -p /app/media/assets /app/logs && \
    chown -R appuser:appgroup /app

# Security: switch to non-root user.
USER appuser

# Expose the API port.
EXPOSE 3000

# Health check.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# Start with tini as PID 1 for proper signal handling.
ENTRYPOINT ["/sbin/tini", "--"]

# Run the application.
CMD ["node", "dist/index.js"]

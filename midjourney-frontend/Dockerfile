# ── AutoTGC Frontend — Hardened Multi-Stage Dockerfile ──────────────────────
#
# SECURITY FEATURES:
#   - Multi-stage build: node build tools never reach production image
#   - Non-root user: runs as 'appuser' (UID 1001)
#   - Nginx serving: minimal attack surface, no Node.js in production
#   - Read-only filesystem: only nginx temp dirs writable
#   - Security headers: configured in nginx.conf
#
# BUILD:
#   docker build -t autotgc-frontend .
#
# RUN:
#   docker run -d --name autotgc-fe \
#     -p 8080:80 \
#     --read-only \
#     --tmpfs /tmp \
#     --cap-drop ALL \
#     --security-opt no-new-privileges:true \
#     autotgc-frontend

# ── Stage 1: Build ────────────────────────────────────────────────────────
FROM node:20-alpine AS build

WORKDIR /app

# Copy package manifests for layer caching.
COPY package.json package-lock.json ./

# Install dependencies.
RUN npm ci --ignore-scripts --no-audit --no-fund

# Copy source code.
COPY . .

# Build the production bundle.
RUN npm run build

# ── Stage 2: Production (Nginx) ──────────────────────────────────────────
FROM nginx:1.27-alpine AS production

# Security: remove default nginx config.
RUN rm -f /etc/nginx/conf.d/default.conf

# Copy custom nginx config.
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy built assets from build stage.
COPY --from=build /app/dist /usr/share/nginx/html

# Security: create non-root user.
RUN addgroup -g 1001 -S appgroup && \
    adduser -u 1001 -S appuser -G appgroup && \
    chown -R appuser:appgroup /usr/share/nginx/html && \
    chown -R appuser:appgroup /var/cache/nginx && \
    chown -R appuser:appgroup /var/log/nginx && \
    touch /var/run/nginx.pid && \
    chown appuser:appgroup /var/run/nginx.pid

# Security: switch to non-root user.
USER appuser

# Expose the HTTP port.
EXPOSE 80

# Health check.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:80/healthz || exit 1

# Nginx runs in foreground.
CMD ["nginx", "-g", "daemon off;"]

# Server Configuration Requirements

> **Last updated:** June 4, 2026
> **Environment:** Production
> **Domain:** tgc-auto.thiennn.icu
> **Server IP:** 36.50.26.118

---

## 1. Server Access

### 1.1 Connection Details

| Parameter | Value |
|-----------|-------|
| **IP Address** | `36.50.26.118` |
| **Domain** | `tgc-auto.thiennn.icu` |
| **SSH User** | `root` |
| **SSH Port** | `22` |
| **SSH Auth** | Key-based (`~/.ssh/autotgc-server`) |

### 1.2 OS & Middleware

| Service | Version / Config | Status |
|---------|-----------------|--------|
| **OS** | Ubuntu 5.15.0-generic | ✅ Running |
| **Nginx** | Panel-managed (aaPanel) | ✅ Running |
| **Node.js** | 20.x | ✅ Running |
| **PM2** | process manager | ✅ Running |
| **PostgreSQL** | 16 (Docker) | ⚠️ Needs restart |
| **Redis** | `127.0.0.1:6379` | ✅ Running |

---

## 2. Network Architecture

```
Internet
    │
    ├── HTTPS :443 (planned — acme.sh)
    └── HTTP  :80
            │
            ▼
    nginx (aaPanel / www/server/panel/vhost/nginx/)
        │
        ├── :80  → tgc-auto.conf  (domain vhost)
        └── :8088 → autotgc.conf    (IP:8088 fallback)
                │
                ▼
        proxy_pass http://127.0.0.1:3000
                │
                ▼
        Node.js backend (PM2 — autotgc-api)
                │
                ├── PostgreSQL :5434
                └── Redis :6379
```

### 2.1 Endpoint URLs

| Endpoint | URL | Type |
|----------|-----|------|
| **Frontend (SPA)** | `http://tgc-auto.thiennn.icu` | Static files → index.html fallback |
| **Backend API** | `http://tgc-auto.thiennn.icu/api` | Proxied to `:3000` |
| **Health** | `http://tgc-auto.thiennn.icu/healthz` | Returns `{"status":"ok"}` |
| **Readiness** | `http://tgc-auto.thiennn.icu/readyz` | Returns `{"status":"ready","checks":{...}}` |
| **API Docs** | `http://tgc-auto.thiennn.icu/docs` | OpenAPI/Swagger |
| **WebSocket** | `ws://tgc-auto.thiennn.icu/api/v1/ws` | Realtime events |
| **SSE** | `http://tgc-auto.thiennn.icu/api/v1/stream` | Server-Sent Events |

---

## 3. API Key Inventory

### 3.1 AI Gateway — YeScale (DeepSeek V4)

The platform uses YeScale (`api.yescale.io`) as an OpenAI-compatible gateway for text, image, and video generation.

| Variable | Value | Purpose |
|----------|-------|---------|
| `GEMINI_BASE_URL` | `https://api.yescale.io/v1` | Gateway base (appends `/chat/completions`) |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Text generation model |
| `GEMINI_API_KEY` | `sk-BrXTrqjgITNV9d46C5ZG6FkiKtPwPpx3ytgOBYVBJ07B5uNn` | Text generation API key |
| `GEMINI_IMAGE_BASE_URL` | `https://api.yescale.io/v1` | Image gen gateway (appends `/images/generations`) |
| `GEMINI_IMAGE_MODEL` | `nano-banana-pro` | Image generation model |
| `GEMINI_IMAGE_API_KEY` | `sk-TdDECEXgYqOFmep6O3JP3rz0EKw1YetAC6Y1lqWpeyXg5WgU` | Image generation API key |
| `VEO_BASE_URL` | `https://api.yescale.io/v1` | Video gen gateway |
| `VEO_MODEL` | `veo3.1` | Video generation model |
| `VEO_API_KEY` | `sk-mOaRxa0nX2UlepKgUJD6vR8UArl9oumwjvVWTo13TzMZVYTc` | Video generation API key |

**Fallback behavior:** When no AI key is configured, all AI features return deterministic grounded answers with `aiGenerated: false` — never a 502 error.

### 3.2 JWT Authentication

| Variable | Value | Purpose |
|----------|-------|---------|
| `JWT_SECRET` | `rM7te39WLxAGNXq7tDKuKf3iw208RAZTvKpvXDTEiab2igYVwZFAeKGA9IGqtdR` | Token signing secret |
| `ACCESS_TOKEN_TTL_HOURS` | `24` | Access token expiry |
| `REFRESH_TOKEN_TTL_DAYS` | `30` | Refresh token expiry |

### 3.3 Webhook Secrets

| Variable | Value | Purpose |
|----------|-------|---------|
| `WEBHOOK_SECRET_FACEBOOK` | `0eB7sbf1dt9anzX7dZojASmfXpcTpJ` | HMAC signing for Facebook webhook payloads |
| `WEBHOOK_SECRET_WEBSITE` | `ttTAZIhtc9E4yCT4xv21lYC7Jx4HH46` | HMAC signing for Website webhook payloads |

**Security note:** HMAC verification is fail-closed. When a secret is empty, the corresponding webhook rejects ALL requests with 401.

### 3.4 Service Accounts (Internal)

| Variable | Value | Purpose |
|----------|-------|---------|
| `SERVICE_ACCOUNT_AI_SYSTEM_SECRET` | `Zl2wT0XTR94x0M1ZO9M2f` | Internal AI system ↔ backend auth |
| `SERVICE_ACCOUNT_BACKGROUND_WORKER_SECRET` | `FUjaWCkZtLxhyQYntXAgOdC` | Background worker ↔ backend auth |

### 3.5 Database

| Variable | Value | Purpose |
|----------|-------|---------|
| `DATABASE_URL` | `postgresql://autotgc:kg33Hwpjiz3QguUlyjNGKiGx@127.0.0.1:5434/autotgc?schema=public` | PostgreSQL connection string |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Redis connection string |

### 3.6 Auth Lockout

| Variable | Value | Purpose |
|----------|-------|---------|
| `LOCKOUT_THRESHOLD` | `5` | Failed login attempts before account is locked |

---

## 4. Infrastructure Requirements

### 4.1 Backend

| Property | Requirement |
|----------|-------------|
| **Node.js** | 20.x or later |
| **PM2 process** | `autotgc-api` on port `3000` (127.0.0.1 bind) |
| **Config file** | `/opt/autotgc/.env` (permissions 600) |
| **Logs** | `pm2 logs autotgc-api` |

### 4.2 Frontend (SPA)

| Property | Requirement |
|----------|-------------|
| **Build output** | `/opt/autotgc-frontend/dist/` |
| **Served by** | nginx (static files with SPA fallback `try_files $uri $uri/ /index.html`) |
| **API base** | Relative (`VITE_API_BASE` empty — same-origin) |

### 4.3 Nginx

| Property | Requirement |
|----------|-------------|
| **Config path** | `/www/server/panel/vhost/nginx/` |
| **Domain vhost** | `tgc-auto.conf` (server_name: `tgc-auto.thiennn.icu`) |
| **Default vhost** | `autotgc.conf` (port 8088) |
| **Proxy target** | `http://127.0.0.1:3000` |
| **SSL certs** | `/www/server/panel/vhost/cert/tgc-auto.thiennn.icu/` (acme.sh managed) |

### 4.4 PostgreSQL

| Property | Requirement |
|----------|-------------|
| **Port** | `5434` (not default 5432) |
| **User** | `autotgc` |
| **Database** | `autotgc` |
| **Schema** | `public` |
| **ORM** | Prisma (`schema.prisma`) |
| **Backup** | Manual — no automated backup configured |

### 4.5 Redis

| Property | Requirement |
|----------|-------------|
| **Port** | `6379` |
| **Used for** | Rate limiting, BullMQ job queues, realtime event bus |

---

## 5. Deployment Requirements

### 5.1 SSH Connection

```bash
# Using key-based auth (recommended):
ssh -i ~/.ssh/autotgc-server root@36.50.26.118

# Or via ~/.ssh/config shortcut:
Host autotgc
  HostName 36.50.26.118
  User root
  IdentityFile ~/.ssh/autotgc-server
```

### 5.2 Deploy Scripts (Windows)

All deploy scripts in `autotgc-backend/deploy/` use `_ssh-run.ps1` (Posh-SSH):

```powershell
# Run a command on the server
.\deploy\_ssh-run.ps1 -ServerHost 36.50.26.118 -Password '<PASSWORD>' -Command 'pm2 status'

# Run a local script on the server
.\deploy\_ssh-run.ps1 -ServerHost 36.50.26.118 -Password '<PASSWORD>' -ScriptFile .\deploy\setup-domain-panel.sh -EnvPrefix "DOMAIN=tgc-auto.thiennn.icu"
```

---

## 6. Security Requirements

| # | Requirement | Status |
|---|-------------|--------|
| 1 | SSH key-based auth (password disabled post-setup) | 🟢 Enabled |
| 2 | HTTPS with Let's Encrypt (acme.sh) on port 443 | 🟡 In progress |
| 3 | HTTP→HTTPS redirect for domain vhost | 🟡 Pending |
| 4 | CORS restricted to `https://tgc-auto.thiennn.icu` | 🔴 Currently `*` |
| 5 | Webhook HMAC verification (fail-closed) | 🟢 Enabled for FB + Website |
| 6 | Rate limiting on auth endpoints (10 req/min/IP) | 🟢 Enabled |
| 7 | Account lockout after 5 failed logins | 🟢 Enabled |
| 8 | Environment file permissions 600 | 🟢 Verified |
| 9 | Secrets never logged (only key names) | 🟢 Verified |
| 10 | Dependencies vulnerability scanning | 🔴 Not configured |

---

## 7. Cron & Scheduled Jobs

| Job | Schedule | Status | Description |
|-----|----------|--------|-------------|
| Token refresh | Every 6h | 🟢 Autopilot enabled | Refresh platform tokens before expiry |
| Analytics collection | Every 6h | 🟢 Default | Collect platform analytics data |
| Publish scan | Every minute | 🟢 Default | Scan for due scheduled posts |
| Weekly feedback | Sun 00:00 | 🟢 Default | Generate weekly AI feedback summaries |
| Weekly report | Mon 01:00 | 🟢 Default | Generate weekly company report (DRAFT) |
| Monthly report | 1st 02:00 | 🟢 Default | Generate monthly company report (DRAFT) |
| Timeline sweep | Every 30 min | 🟢 Default | Study-abroad due-item reminders |
| Auto research | Mon 02:00 | 🟢 Enabled | Per-market trend research |
| Auto plan | Mon 03:00 | 🟢 Enabled | Auto-generate content plans |
| Asset retry | Every 15 min | 🟢 Enabled | Retry failed asset renders |

---

## 8. External Integrations

| Integration | Endpoint / Key | Status |
|-------------|---------------|--------|
| **YeScale (AI)** | `https://api.yescale.io/v1` | 🟢 Configured |
| **Facebook webhook** | `WEBHOOK_SECRET_FACEBOOK` | 🟢 Enabled |
| **Website webhook** | `WEBHOOK_SECRET_WEBSITE` | 🟢 Enabled |
| **Zalo OA webhook** | `WEBHOOK_SECRET_ZALO` | 🔴 Not configured |
| **Facebook Messenger** | `INTAKE_FB_VERIFY_TOKEN` | 🔴 Not configured |
| **Platform tokens** | Facebook, TikTok | 🔴 Not configured |
| **GA4** | `GA4_PROPERTY_ID` | 🔴 Not configured |

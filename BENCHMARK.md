# AutoTGC — System-Wide Benchmark

> Measured on **2026-06-26**. Backend prod = commit `7e6eb53` (just deployed), host `36.50.26.118`.
> Methodology: codebase metrics measured locally; build/test run for real; API latency measured server-local (`127.0.0.1:3000`, 20 requests/endpoint — removes network noise); DB/system read-only.

## 1. Executive Summary

| Aspect | Assessment |
|---|---|
| Code size | Medium-large: ~50k LOC product + ~29k LOC tests |
| Test quality/coverage | **Very strong** — 944 tests, test:code ratio ≈ 0.89 |
| Build/test speed | Fast — BE build 8.1s, tests 18.9s; FE build 1.6s |
| Frontend bundle | Good — 535KB total, sensible per-page chunking |
| API latency | Acceptable but **high variance** (event-loop contention) |
| Host health | ⚠️ **Overloaded** — load ~9.3 on 8 cores |
| Data volume | Early stage — DB 12MB, largest table 220 rows |

## 2. Codebase Metrics

| Item | Files | LOC |
|---|---|---|
| Backend `src` | 220 | 32,814 |
| Backend `test` | 108 | 29,348 |
| Frontend `src` | 79 | 17,254 |
| **Total (approx.)** | **407** | **~79,400** |

Backend structure: **29 domain modules**, **22 route files**, **57 Prisma models**, **33 enums**, **11 migrations**, **7 platform adapters** (Facebook, TikTok, GA4, YouTube, Zalo, Custom CMS...). Frontend: **30 pages**, **10 shared components**, Prisma schema 1,242 lines.

**Note:** test:code ratio ≈ **0.89** (29.3k test / 32.8k src) is a very high testing investment — mostly property-based tests (fast-check) over pure logic (scoring, state machines, RBAC, parsers). A major reliability strength.

## 3. Build & Test (measured)

| Task | Time | Result |
|---|---|---|
| Backend build (`tsc`) | **8.1s** | exit 0 |
| Backend tests (Vitest) | **18.9s** (wall) / 16.8s (vitest) | **937 pass / 7 skip / 0 fail** (944 total, 107 files) |
| Frontend build (`tsc -b && vite`) | **1.6s** | exit 0 |

Tests run fast despite the large count — good for the dev loop. 7 skipped (mostly integration tests needing a real provider).

## 4. Frontend Bundle

- Total `dist`: **534.8 KB** (JS: 502.7 KB).
- Largest chunks:
  - `vendor-react` 163.7 KB (gzip **53.4 KB**)
  - `CandidateDetail` 47.5 KB (gzip 11.4 KB)
  - `index` 43.5 KB (gzip 14.0 KB)
  - `vendor-query` 39.5 KB (gzip 12.0 KB)
- **Note:** good per-page code-splitting (each page is its own lazy-loaded chunk); vendors split out for long-term caching. Total gzip ≈ ~150KB — light and reasonable for an admin SPA.

## 5. Runtime API Latency (live, server-local, 20 req/endpoint)

| Endpoint | avg | min | max |
|---|---|---|---|
| `GET /healthz` | 24.8 ms | 3.3 ms | **157.3 ms** |
| `GET /readyz` (DB+Redis) | 61.2 ms | 6.9 ms | **305.4 ms** |
| `GET /api/v1` (manifest) | 33.5 ms | 3.9 ms | 92.9 ms |
| `GET /api/leads` (gate rejects 401) | 15.1 ms | 2.9 ms | 86.2 ms |

**Key observations:**
- `min` is very low (3–7ms) → when idle, the app responds very fast.
- `max` is abnormally high for trivial endpoints (`/healthz` up to 157ms, `/readyz` 305ms) → **high variance, a sign of event-loop/CPU contention** (consistent with the high load average below).
- The auth gate (deny-by-default) rejects 401s **very cheaply** (avg 15ms, as low as 2.9ms) → not a source of contention. The gate works correctly.

## 6. System & Database

**Host:** 8 CPU cores · 12 GB RAM (6.2GB used, 5.3GB avail) · Node **v22.22.1** · Disk 53/121GB (44%).
**Load average:** ⚠️ **9.12 / 9.30 / 9.35** — above the core count (8) at all three windows → **sustained overload**, not a momentary spike.

**PM2:** `autotgc-api` (~140MB) + `autotgc-worker` (~140MB), both online, running non-root.

**Database (PostgreSQL 16):** total **12 MB**, **58 tables**. Top tables by row count:

| Table | Rows |
|---|---|
| TrendSignal | 220 |
| ContentPlanItem | 132 |
| JwtSession | 48 |
| DraftCta | 47 |
| KnowledgeEntry | 33 |
| UserAccount | 30 |
| WorkflowStep | 28 |
| ContentPersona | 26 |

**Note:** data is still very small (early-stage/seed). 30 user accounts, 48 stored JWT sessions. Query performance is not a concern at this scale; re-benchmark as data grows.

## 7. Overall Analysis & Risks

**Strengths:**
1. **Excellent test coverage** (944 tests, property-based) — a high-reliability foundation, safe to refactor.
2. **Fast build/test** — good DX.
3. **Clear layered architecture** (pure domain + thin routes + adapter pattern for platforms).
4. **Defense-in-depth security** now live: global auth gate (deny-by-default), pure RBAC, HMAC webhooks fail-closed, secrets kept out of the DB, honest refresh-token handling.
5. Compact frontend bundle, good code-splitting.

**Risks / things to watch:**
1. ⚠️ **Load average ~9.3 > 8 cores** — the host is overloaded. Needs investigation: is it the app (api+worker), Postgres, Redis, or another tenant/process on the same VM? Likely cause of the high `max` latency.
2. ⚠️ **Latency variance** (max 157–305ms on trivial endpoints) — event-loop contention. Could be heavy cron/worker jobs (node-cron once warned of "missed execution") or synchronous AI calls hogging CPU.
3. **API runs as fork/1 instance** (`API_INSTANCES` not enabled) — only one core for HTTP. On an 8-core VM, enabling cluster (2–3 instances) could reduce contention.
4. **Migration drift not yet resolved** — deploy still uses `db push` rather than `migrate deploy` (runbook exists).
5. Data is small → query/throughput performance must be re-benchmarked once production carries real load.

## 8. Recommended Next Benchmarks/Actions

1. **Investigate the ~9.3 load:** run `top -o %CPU` / `pidstat` to identify the CPU-hungry process (app vs Postgres vs other). This is priority #1.
2. **Measure real throughput** with a load tool (k6/autocannon) against one representative endpoint to find max RPS + p95/p99 under load — this benchmark only measured idle-time latency.
3. **Consider `API_INSTANCES=2`** (PM2 cluster) if event-loop contention is confirmed; watch RAM + Postgres connection count.
4. Add `.gitattributes` (`*.sh text eol=lf`) to avoid the CRLF deploy bug already encountered.
5. Re-run this benchmark after data grows and after switching to `migrate deploy`.

---
*Methodology: local metrics from working tree `7e6eb53`; build/test run directly; API latency via `curl %{time_total}` server-local 20×/endpoint (avoids network noise); system/DB read-only over SSH. Latency was measured under the machine's real load (~9.3), not an isolated environment.*

---

## 9. Bottleneck Deep-Dive + Throughput Test (additional measurement, 2026-06-26)

### 9.1 Bottleneck cause — IDENTIFIED: CPU steal on a shared VM (NOT the app)

`top` snapshot under real load:
```
%Cpu(s): 35.5 us, 4.2 sy, 0.0 id, 0.0 wa, 60.2 st   (during test: 67.0 st)
```

- **Steal time 60–67%** → the hypervisor takes ~2/3 of this VM's CPU cycles (oversubscribed host / noisy neighbors). The "8-core" VM effectively gets only ~1/3 of its compute. This is the **root cause** of the high load + latency variance.
- **idle 0% / iowait 0%** → CPU-starved, not IO-bound. `vmstat` run-queue `r`=8-10 (matches load ~9).
- **VM uptime: 111 days**, load at all three windows ~8.8–9.3 → **sustained, system-wide** overload, not a spike.

**AutoTGC is very light and stable** (not the culprit):
| Process | %CPU | RSS | restart |
|---|---|---|---|
| autotgc-api | 1.2% | ~120 MB | 0 |
| autotgc-worker | 1.2% | ~135 MB | 0 |

**Noisy neighbors on the same VM** (sharing the stolen CPU): BaoTa panel (`BT-Task`), Docker + `etcd` + `containerd`, 2× Java apps, 2× `uvicorn` (Python) apps, MinIO, multiple Postgres, a static `serve` on :5173. AutoTGC is just a small tenant on a crowded box.

**node-cron:** only **6 "missed execution" warnings total** (most recent 17 Jun, 9 days ago) → the earlier api/worker split handled this effectively; not a current issue.
**App's Postgres:** 1 active / 8 idle (~14 connections) → healthy.

### 9.2 Throughput (ApacheBench, GET /healthz, n=200, c=10)

| Metric | Value |
|---|---|
| Requests/sec | **90.6 req/s** |
| Latency p50 / p95 / p99 / max | 102 / 186 / 196 / 264 ms |
| Failed / Non-2xx | **0** (did not hit the 300/min rate limit) |
| Load before→after test | 9.32 → 9.32 (unchanged) |
| CPU steal during test | **67%** |

**Interpretation:** 90 RPS for a no-op endpoint on "8 cores" is **low** — because (a) ~67% of CPU is stolen and (b) the API runs **fork/1** (one core for HTTP). p50 102ms (vs min 3ms when idle) = event-loop queueing + CPU contention. The 200-request test did not move the load average at all → the performance ceiling is set by **infrastructure**, not code. On a non-stolen VM with cluster mode, healthz would easily reach thousands of RPS.

### 9.3 Conclusion & Action Priorities

| Priority | Action | Expected impact |
|---|---|---|
| **#1 (root cause)** | Move AutoTGC to a **non-oversubscribed** VM / guaranteed vCPU, or reduce tenants on the current VM | Removes 60-67% steal → multi-fold latency + throughput improvement |
| #2 | Enable **PM2 cluster** `API_INSTANCES=2-3` (app is cluster-ready: Redis-backed rate limit, realtime over Redis bus, sessions in Postgres) | Uses more cores for HTTP, reduces event-loop contention |
| #3 | Track steal (`top`, `sar`) periodically as an infra SLI | Early detection of noisy-neighbor degradation |

**Key message:** The AutoTGC code is **efficient, stable, and light**. The observed "bottleneck" is an **infrastructure problem (CPU steal on a shared VM)** that must be solved at the host level, not via application optimization.

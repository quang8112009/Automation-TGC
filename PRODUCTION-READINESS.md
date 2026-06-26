# AutoTGC — Đánh giá Production-Readiness

> Lập ngày **2026-06-26**. Dựa trên kiểm chứng thực tế trên prod `36.50.26.118` (backend commit lineage `745c762` / nhánh `feat/assistant-memory-embeddings-wip`).

## Tiến độ khắc phục (cập nhật 2026-06-26)

Đã xử lý bởi agent (nhánh `chore/ops-hardening`):
- ✅ **P0 #2 — Backup DB tự động:** cài `deploy/backup-db.sh` + cron daily 02:30 trên server; chạy backup thử (gzip OK) + **diễn tập restore vào DB tạm thành công** (58 bảng / 30 user / 0 lỗi). Còn thiếu: off-site (set `BACKUP_OFFSITE_DIR`).
- ✅ **P1 #6 — CRLF deploy bug:** thêm `.gitattributes` (`*.sh` = LF); verify `git archive` ra LF-only.
- ✅ **P1 #6 — Lint/CI:** cài eslint + @typescript-eslint, config `.eslintrc.json`, sửa 1 error + 2 dead import, bật lint job trong CI (lint exit 0, build sạch, 945 test pass).
- 🟡 **P1 #9 — Security headers (một phần):** thêm header bảo mật cho SPA tĩnh trong `deploy/panel-vhost.conf` (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `X-XSS-Protection`, HSTS có điều kiện) — vá khoảng trống mà helmet không phủ (index.html + /assets/ phục vụ trực tiếp bởi nginx). Còn lại: chuẩn hoá redirect HTTP→HTTPS + gỡ vhost `:8088` trùng khỏi sites-enabled (cần thao tác trên server).

Còn lại (xem bảng bên dưới): P0 #1/#3/#4/#5 + P1 #7/#8/#9 (phần còn lại)/#10.


## Kết luận

- **Ứng dụng (code): ĐẠT chất lượng production.**
- **Hạ tầng + Vận hành: CHƯA đủ production-grade** — còn lỗ hổng mức P0 (rủi ro mất dữ liệu / sập).
- Hệ đang *chạy* trên prod nhưng chưa *an toàn để dựa vào lâu dài* nếu chưa bổ sung các mục dưới.

---

## ✅ Đã tốt (đủ chuẩn)

- **Code:** 945 test / tỉ lệ test:code ≈ 0.89 (property-based), TypeScript strict, layering rõ (domain thuần + route mỏng), AppError envelope, state machine có guard.
- **Bảo mật (mạnh):** global auth gate (deny-by-default, đã verify 401), RBAC thuần, HMAC webhook fail-closed (verify), argon2 + JWT(jose), thu hồi session khi lock/đổi role/reset password, secret fail-fast + **không lưu trong DB**, refuse-run-as-root, SSRF guard (CMS adapter), rate-limit (Redis-backed), helmet.
- **Cô lập mạng:** Postgres(5434) / Redis(6379) / app(3000) đều bind **127.0.0.1** (không lộ ra ngoài).
- **Khả dụng cơ bản:** PM2 boot-persistence **enabled**, health/readyz (kiểm DB+Redis), AI-OPTIONAL + REVIEW MODE, logging có redaction secret.

---

## ❌ Thiếu — cần bổ sung (đã ưu tiên)

### P0 — Chặn / rủi ro nghiêm trọng (làm trước)

| # | Vấn đề (đã verify) | Cần bổ sung |
|---|---|---|
| 1 | **Hạ tầng quá tải:** CPU steal **60–67%**, load avg ~9.3 trên VM 8 nhân dùng chung đông (BaoTa panel, Docker/etcd/containerd, Java/Python apps, MinIO, nhiều Postgres). **SWAP = 0MB** → rủi ro OOM. 1 VM, không HA. | Chuyển sang VM/vCPU đảm bảo, ít tenant; **bật swap 2–4GB** (phao tạm thời ngay). |
| 2 | **KHÔNG có backup DB tự động.** Chỉ có pg_dump ad-hoc khi deploy (7 file, đều do quá trình deploy tạo). **Chưa từng test restore.** | Cron `pg_dump` hằng ngày + lưu **off-site** + **diễn tập restore** định kỳ. |
| 3 | Deploy DB bằng **`prisma db push --accept-data-loss`** (drift migration + cờ phá huỷ). | Chuyển sang **`prisma migrate deploy`** theo `autotgc-backend/prisma/migrations/MIGRATION-BASELINE-RUNBOOK.md` (đã soạn sẵn, có backup trước). |
| 4 | Prod chạy từ **nhánh WIP** (`feat/assistant-memory-embeddings-wip`), **không phải main/tag**, và nhánh đang bị **chỉnh sửa song song** bởi luồng khác. | Merge qua PR → **main**, **tag release**, deploy từ tag. |
| 5 | **Mật khẩu root đã lộ** (dán plaintext trong chat); SSH root bằng password. | **Đổi mật khẩu root NGAY**; chuyển sang SSH key; tắt root password login. |

### P1 — Quan trọng (làm sớm)

| # | Vấn đề | Cần bổ sung |
|---|---|---|
| 6 | Deploy thủ công (PowerShell + SSH as root); CI **thiếu lint** (eslint chưa cài); bug **CRLF** khi `git archive` (đã gặp 1 lần, đã workaround tay). | CD tự động; cài eslint + bật lint job trong CI; thêm `.gitattributes` (`*.sh text eol=lf`). |
| 7 | **Quan sát mỏng:** chỉ có health endpoint + AgentOps AI telemetry; **không có** metrics/APM, log tập trung, alerting/uptime, on-call. | Uptime monitor + alert (CPU/mem/disk/steal/healthz); gom log tập trung; error tracking (Sentry). |
| 8 | Auth: access token **24h** (dài), **không xoay refresh token**, token lưu **localStorage** (phơi nhiễm XSS). | Rút access TTL (~30–60 phút) + refresh rotation/reuse-detection; cân nhắc refresh token qua httpOnly cookie. |
| 9 | TLS/HSTS dựa vào panel; chưa có HTTP→HTTPS redirect/HSTS rõ ràng; còn vhost `:8088` trùng lặp (đã đánh dấu deprecated). | Chuẩn hoá TLS + HSTS; gỡ vhost trùng khỏi sites-enabled. |
| 10 | **Chưa có baseline throughput dưới tải thật** (mới đo idle + ab nhẹ → ~90 RPS /healthz, bị giới hạn bởi steal). | Load test (k6/autocannon) để biết RPS thật + p95/p99 dưới tải. |

### P2 — Nên có

- DB tách host riêng / managed Postgres (hiện cùng VM = single point of failure).
- Môi trường **staging** riêng để test trước khi lên prod.
- Secret manager/vault thay cho file `.env`.
- HA/redundancy (hiện chỉ 1 VM).
- `GEMINI_MAX_TOKENS` cap: code đã sẵn (commit `745c762`), chưa bật trên prod — bật sau khi đo telemetry (model đã là `deepseek-v4-flash`; nghi phạm latency chính là gateway proxy `yescale.io`).

---

## Thứ tự xử lý đề xuất

1. **Ngay:** đổi mật khẩu root (#5) + bật swap (#1) — rẻ, giảm rủi ro tức thì.
2. **Tuần này:** backup tự động + test restore (#2); merge → main → tag (#4); `.gitattributes` chống CRLF (#6).
3. **Trước khi tăng tải:** chuyển VM ít tranh chấp (#1); `migrate deploy` baseline (#3); monitoring/alerting (#7); load test (#10).

---

## Phân công (ai làm gì)

**Agent có thể làm an toàn ngay (chỉ sửa file/script, không phá prod):**
- (a) Thêm `.gitattributes` (`*.sh text eol=lf`) — chống tái diễn lỗi CRLF deploy.
- (b) Soạn script + cron backup DB hằng ngày (off-site) + runbook restore.
- (c) Thực thi `migrate deploy` baseline theo runbook (backup trước, xin xác nhận).
- (d) Cài eslint + bật lint job CI.

**Cần người (chủ dự án) quyết/thực hiện:**
- Đổi mật khẩu root + thiết lập SSH key.
- Cấp VM mới / vCPU đảm bảo (hoặc giảm tenant trên VM hiện tại).
- Duyệt merge các nhánh → main + tag release.

---

## Dữ liệu kiểm chứng (tham chiếu)

- CPU: `%Cpu(s): ... 60.2 st` (lúc load test lên 67% steal); idle 0%, iowait 0%; run-queue 8–10.
- RAM: 12GB (dùng ~6.2GB), **swap 0MB**.
- App nhẹ: autotgc-api/worker mỗi cái ~1.2% CPU, ~120–140MB, 0 restart.
- DB: PostgreSQL 16, 12MB, 58 bảng, 30 user — giai đoạn dữ liệu nhỏ.
- Backup: 7 file `.sql` ad-hoc tại `/var/backups/autotgc/`, **không có cron/timer** backup.
- PM2: boot-persistence enabled; services bind localhost.
- Smoke-test (gate live): healthz/readyz/api-v1/docs = 200; protected = 401; webhook sai HMAC = 401; SSE no-token = 401 → đúng thiết kế.

> Xem thêm `BENCHMARK.md` (mục 9) cho chi tiết nghẽn (CPU steal) + throughput.

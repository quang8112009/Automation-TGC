# Runbook: Đồng bộ lại Migration Baseline cho AutoTGC (Prisma + Postgres 16)

> **Trạng thái:** CHƯA áp dụng. Đây là tài liệu cho một phiên có kiểm soát, **backup trước**.
> **Nguyên tắc:** KHÔNG chạy lệnh phá huỷ trên prod khi chưa backup + verify. Mọi bước đều có rollback.

## 1. Vấn đề (đã xác minh)

Lịch sử migration trong `prisma/migrations/` **không khớp** với `prisma/schema.prisma`:

- Các bảng `CandidateProfile`, `JobOrder`, `Branch`, `WorkflowRun`, `WorkflowStep`,
  `ContentPlan`, `ContentPlanItem`, `KnowledgeEntry`, `TrendSignal`, `GeneratedAsset`,
  `BrandTemplate` (và các model study-abroad) **không được tạo bởi bất kỳ file migration nào**.
- Nhưng `0002_ai_reporting_ops/migration.sql` (dòng ~84) lại tham chiếu FK tới `CandidateProfile`.
- Hệ quả: chạy `prisma migrate deploy` trên một DB trống sẽ **fail** ngay tại 0002.
- Production hiện chạy được **chỉ vì** deploy dùng `prisma db push --accept-data-loss` (tạo bảng
  theo schema, không ghi lịch sử migration, không rollback).

Nguồn gốc: prod đã được dựng dần bằng `db push` thay vì `migrate deploy`, nên `_prisma_migrations`
không phản ánh đúng schema thực tế.

## 2. Mục tiêu

Chuyển prod sang quy trình migration **forward-only, có review**, mà **KHÔNG tạo lại** (DROP/CREATE)
các bảng đang có dữ liệu. Dùng đúng pattern Prisma "baseline an existing database".

## 3. File tham chiếu đã tạo (offline, không đụng DB)

- `prisma/migrations/BASELINE_full_schema.reference.sql` — toàn bộ schema hiện tại (55 CREATE TABLE),
  sinh bằng:
  ```
  npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script
  ```
  Lệnh này **không cần kết nối DB** và không thay đổi gì. Đây là nội dung sẽ dùng cho migration baseline.

## 4. Các bước thực hiện (phiên có kiểm soát)

> Chạy lần lượt. Dừng ngay nếu một bước verify không đạt.

### Bước 0 — Backup (BẮT BUỘC)
```bash
# Trên host, dưới user autotgc, đọc DATABASE_URL từ /opt/autotgc/.env
sudo -u autotgc bash -lc 'cd /opt/autotgc && set -a && . ./.env && set +a && \
  pg_dump "$DATABASE_URL" > /var/backups/autotgc/pre-baseline-$(date +%Y%m%d-%H%M%S).sql'
# Verify file > 0 byte và mở được
```

### Bước 1 — Tạo thư mục migration baseline (trong repo, máy dev)
```bash
mkdir -p prisma/migrations/0000_baseline
cp prisma/migrations/BASELINE_full_schema.reference.sql prisma/migrations/0000_baseline/migration.sql
```
> Đặt tên `0000_baseline` để nó đứng TRƯỚC `0001_init` về thứ tự. Vì sẽ được đánh dấu "đã áp dụng",
> nội dung của nó sẽ KHÔNG chạy lại trên prod.

### Bước 2 — Đánh dấu baseline + các migration hiện có là "đã áp dụng" trên prod
```bash
# KHÔNG chạy migrate deploy ở bước này. Chỉ resolve (ghi vào _prisma_migrations).
sudo -u autotgc bash -lc 'cd /opt/autotgc && \
  npx prisma migrate resolve --applied 0000_baseline'
# Nếu _prisma_migrations chưa có các bản 0001..0009, resolve --applied từng cái cho khớp thực tế:
#   npx prisma migrate resolve --applied 0001_init   (… tới 0009_job_order_assigned_to)
# Mục tiêu: `migrate status` báo tất cả đã applied, KHÔNG còn pending tạo bảng.
```

### Bước 3 — Verify
```bash
sudo -u autotgc bash -lc 'cd /opt/autotgc && npx prisma migrate status'
# PHẢI thấy: "Database schema is up to date" / không có migration pending nào tạo lại bảng.
```

### Bước 4 — Chuyển deploy script sang migrate deploy (RIÊNG, sau khi baseline ổn)
- Trong `deploy/redeploy2.sh` và `deploy/app-deploy.sh`, thay
  `prisma db push --skip-generate --accept-data-loss` bằng `prisma migrate deploy`.
- **Chưa làm trong phiên này** — chỉ làm sau khi Bước 3 xanh trên prod, và vẫn giữ bước backup trước.

## 5. Rollback

- Baseline/resolve chỉ ghi vào bảng `_prisma_migrations`, **không đổi dữ liệu**. Nếu sai:
  ```bash
  # Xoá các dòng resolve vừa thêm (hoặc restore _prisma_migrations từ backup)
  ```
- Nếu bất kỳ thao tác schema nào lỡ chạy sai: `psql "$DATABASE_URL" < /var/backups/autotgc/pre-baseline-*.sql`.

## 6. Hai vấn đề schema nên xử lý trong CÙNG phiên (migration additive mới, KHÔNG phá huỷ)

1. **CompanyReport @@unique có `scopeUserId` nullable** — Postgres coi các NULL là khác nhau, nên
   `@@unique([reportType, periodLabel, scopeUserId])` KHÔNG chặn được báo cáo company-wide trùng
   (scopeUserId = NULL). `reportService.generateForPeriod` dùng `create()` (không upsert) → có thể
   sinh báo cáo trùng kỳ.
   → Migration additive đề xuất:
   ```sql
   CREATE UNIQUE INDEX "CompanyReport_company_period_key"
     ON "CompanyReport"("reportType", "periodLabel")
     WHERE "scopeUserId" IS NULL;
   ```
2. **`LeadAssignment` thiếu FK** — `leadId`/`userId` là string trần, trùng vai trò với `Lead.assignedTo`
   (đã có FK). RBAC SALES assigned-only phụ thuộc vào dữ liệu này nên là rủi ro toàn vẹn.
   → Hoặc thêm FK tới `Lead`/`UserAccount`, hoặc hợp nhất về `Lead.assignedTo` và bỏ `LeadAssignment`.
   (Quyết định mô hình trước, rồi mới ra migration additive.)

> Cả hai chỉ nên làm bằng migration **additive** (CREATE INDEX / ADD CONSTRAINT), sau khi baseline xong,
> và vẫn backup trước.

# Dashboard — Page Overrides

> ⚠️ Quy tắc trong file này **override** `design-system/MASTER.md`. Chỉ ghi **điểm
> khác biệt** so với MASTER; mọi thứ còn lại theo MASTER (hướng A "Academia").
>
> **Page:** `autotgc-frontend/src/pages/Dashboard.tsx` (Operational Dashboard — approval
> queue, upcoming posts, failure alerts, lead KPIs, data-sync freshness).

---

## Layout Overrides
- **Bento bất đối xứng** (admin, KHÔNG phải hero landing): dùng `.bento` / `.bento__feature`
  / `.bento__side` / `.bento__half` (additive class) trên grid 12 cột. Feature cell =
  approval queue / KPI chính; side cell = sync freshness / alerts.
- **Width:** dùng `--content-max` (1320px); cho phép `--content-max-wide` (1440px) nếu cần.
- ≤1024px: gập `.bento` và mọi đa cột về **một cột** đầy đủ (Yêu cầu 10.2).

## Density
- **Cao** (Data-Dense Dashboard): tối ưu hiển thị thông tin; KPI tile gọn, gap 24px,
  4-up desktop / 2-up tablet / 1-up mobile.

## Color / Typography
- Không override — dùng đúng MASTER (Academia: navy/crimson/gold; Crimson Pro + Inter + IBM Plex Mono).
- KPI số liệu: serif display + `font-variant-numeric: tabular-nums` (count-up reduced-motion-aware).

## Interactive States (bắt buộc đủ)
- **Loading:** skeleton **shaped** theo KPI grid + bảng (không spinner chung).
- **Empty:** mô tả + gợi ý hành động (ví dụ "Chưa có bài chờ duyệt").
- **Error/502:** nội tuyến qua `Shared_UI`; 502 ⇒ "dịch vụ chưa cấu hình".

## KHÔNG áp dụng (Yêu cầu 1.5)
- ⛔ Bỏ qua "Section Order: Hero → Step 1/2/3 → CTA" mà script gợi ý — đó là **pattern
  landing**, không dùng cho dashboard quản trị.
- ⛔ Không hero, không marquee, không CTA-progression.

## Recommendations (giữ từ script, hợp admin)
- Hover tint trên hàng bảng, tooltip, smooth filter animation; bảng rộng cuộn trong `.table-wrap`.
- Cho phép multi-select / bulk action khi phù hợp; giữ nguyên hành vi dữ liệu hiện có.

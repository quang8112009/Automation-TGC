# Design System — MASTER (Design_System_Doc)

> **Vai trò:** Đây là **nguồn chân lý toàn cục** (`Design_System_Doc`) cho đợt
> `frontend-ui-redesign` của `autotgc-frontend`, theo Yêu cầu 1.2/1.3 và Design.
> Khi dựng một trang cụ thể, **kiểm `design-system/pages/<page>.md` trước**; nếu tồn
> tại thì override file này, nếu không thì dùng MASTER.

---

## Provenance — File này được sinh thế nào (Yêu cầu 1.1, 1.2)

Hỗn hợp **(a) sinh bằng script** + **(b) tổng hợp/quyết định thủ công từ dữ liệu skill**:

- **(a) Sinh bằng `ui-ux-pro-max` `search.py --design-system --persist`** — đã chạy thật:
  ```bash
  python .kiro/steering/ui-ux-pro-max/scripts/search.py \
    "internal admin SaaS dashboard data-table recruitment marketing" \
    --design-system --persist -p "AutoTGC Admin"
  python .kiro/steering/ui-ux-pro-max/scripts/search.py \
    "analytics dashboard charts funnel donut KPI data-table" \
    --design-system --persist -p "AutoTGC Admin" --page "dashboard"
  ```
  Output thô của script được lưu tại `design-system/autotgc-admin/MASTER.md` và
  `design-system/autotgc-admin/pages/dashboard.md` (giữ nguyên, không chỉnh sửa).
- **(b) Tổng hợp thủ công (file này)** — đối chiếu output script với theme "Academia"
  hiện có (`autotgc-frontend/src/styles.css` + `design-system/autotgc---thanh-giang/`),
  **chốt hướng theme A/B**, và rút lớp phủ kỷ luật từ `design-taste-frontend`. Phần
  bảng màu/typography/effects bên dưới phản ánh **hướng đã chốt (A)**, không phải màu
  generic của script.

**Tóm tắt khuyến nghị thô từ script (để tham chiếu, KHÔNG phải hướng đã chốt):**

| Hạng mục | Script (`AutoTGC Admin`) đề xuất |
|---|---|
| STYLE | **Data-Dense Dashboard** (nhiều chart/widget, bảng dữ liệu, KPI card, grid, mật độ cao) — ✅ phù hợp, **giữ** |
| Màu | Primary `#1E40AF` · Secondary `#3B82F6` · CTA `#F59E0B` · BG `#F8FAFC` · Text `#1E3A8A` (blue data + amber) — *generic, KHÔNG dùng* |
| Typography | Fira Code / Fira Sans — *generic, KHÔNG dùng* |
| Effects | Hover tooltip, row highlight on hover, smooth filter anim, loading spinner — ✅ giữ tinh thần |
| Page pattern | "Comparison Table + CTA" / "Funnel 3-Step Conversion" với *Hero* — ⛔ **đây là pattern landing, KHÔNG áp dụng** (xem mục Discipline) |
| Anti-patterns | Ornate design, no filtering, emoji-as-icon, layout-shift hover, low-contrast, instant state, invisible focus — ✅ giữ toàn bộ |

> **Lý do không lấy màu/typography của script:** script trả về palette/typography
> *generic* cho admin dashboard (blue + amber, Fira). Theme "Academia" hiện tại đã là
> một bản sắc bespoke, đã tinh chỉnh WCAG AA, đã hiện thực đầy đủ trong token layer và
> trải trên 29 trang. STYLE "Data-Dense Dashboard" + bộ anti-pattern của script **trùng
> khớp** với Academia, nên ta giữ bản sắc Academia và chỉ áp kỷ luật của script.

---

## QUYẾT ĐỊNH HƯỚNG THEME — Chốt **Option A: Tinh chỉnh "Academia"** ✅ (Yêu cầu 1.3)

Hai lựa chọn theo Design (Decision #2):

- **Option A — Tinh chỉnh theme "Academia" hiện có** *(ĐÃ CHỌN)*
- **Option B — Đặt lại giá trị token theo hướng mới** *(không chọn)*

### Vì sao chọn A
1. **Rủi ro hồi quy nhỏ nhất trên app 29 trang.** Token layer Academia đã hiện thực
   đầy đủ trong `:root` của `src/styles.css` (~150 biến, có alias tương thích ngược).
   Chọn A nghĩa là chỉ **soi/khóa lại nhất quán** và **vá điểm yếu tương phản/typography**,
   không xoay toàn bộ bản sắc.
2. **Output script xác nhận STYLE + kỷ luật, không vượt trội về bản sắc.** Script đề xuất
   đúng "Data-Dense Dashboard" và bộ anti-pattern mà Academia đã tuân thủ; màu generic
   blue/amber của script không tốt hơn một bản sắc đã AA-tuned.
3. **Academia đã thỏa các yêu cầu chất lượng:** đúng **một** họ accent (Oxford Crimson),
   **một** thang radius, **một** thang spacing, bộ status base/soft-bg/on-soft đầy đủ,
   số liệu tabular, focus ring, khối `prefers-reduced-motion`.

### Ràng buộc khi áp A (bất biến)
- **Chỉ thay GIÁ TRỊ token** khi cần (ví dụ tinh chỉnh một hex để đạt ngưỡng AA). **Không
  bao giờ** đổi **tên token** hay **tên class** trong `Class_Contract` (Yêu cầu 2, 4).
- Giữ nguyên toàn bộ **alias tương thích ngược** (`--color-cta`, `--gray-*`, `--bg`,
  `--primary`, `--radius`, `--shadow`…).
- Biểu diễn **đúng một** họ màu nhấn qua `--color-accent`.

> Chi tiết build-ready của hướng A nằm ở `design-system/autotgc---thanh-giang/MASTER.md`
> và `STYLE_BRIEF.md` (token block đầy đủ + spec từng component). File MASTER này tóm tắt
> và là điểm vào chính thức cho các task triển khai (3.1 trở đi).

---

## Global Rules — Hướng A "Academia" (nguồn chân lý màu/typography/spacing)

### Bảng màu (Color Palette)

| Vai trò | Hex | CSS Variable | Ghi chú dùng |
|------|-----|--------------|------|
| Primary (Academic Navy) | `#0F1E3D` | `--color-primary` | Sidebar spine, headings, cấu trúc |
| Primary-700 | `#16294F` | `--color-primary-700` | Hover/navy đậm |
| Secondary (Slate Blue) | `#334766` | `--color-secondary` | Text phụ, chart series |
| **Accent (Oxford Crimson)** | `#8C1D27` | `--color-accent` | **MỘT** CTA/brand accent (editorial, dùng dè) |
| Accent-hover | `#6E141C` | `--color-accent-hover` | Crimson hover |
| Gold (Prestige) | `#B08542` | `--color-gold` | Hairline flourish, marker active, nhấn KPI (không fill mảng lớn) |
| Gold-text | `#87651F` | `--color-gold-text` | Gold cho vai trò TEXT (≥4.5:1 trên ivory) |
| Background (Ivory) | `#F7F4EF` | `--color-background` | Canvas (giấy ấm) |
| Surface | `#FFFFFF` | `--surface` | Card, table, modal |
| Text (Ink) | `#1A1A1A` | `--color-text` | Body ink trên giấy |

Neutral ramp (warm stone): `--stone-50 … --stone-900` (xem token block trong STYLE_BRIEF).
Status (base/soft-bg/on-soft): `--success` `--warning` `--danger` `--info` `--neutral`,
mỗi nhóm có `*-bg` và `*-fg` đã tinh chỉnh ≥4.5:1 trên nền soft của nó (Yêu cầu 5.6, 9.1).

**Color Notes:** Navy cấu trúc + Crimson accent editorial + Gold prestige trên ivory ấm.
Crimson hiếm và có chủ đích (kỷ luật một CTA). Gold chỉ cho hairline/marker/nhấn KPI.

### Typography

- **Display / Heading:** Crimson Pro (serif học thuật) — H1–H3, KPI numerals.
- **Body / UI:** Inter (sans, hyper-legible) — body + bảng dày.
- **Mono (ID, code, metric):** IBM Plex Mono — số liệu canh `tabular-nums`.
- **Nạp font:** `<link>` Google Fonts với `display=swap` (Yêu cầu 11.3).
- **Thang chữ:** Display 40 · H1 34 · H2 24 · H3 18 · Body 15 · Small 13 · Caption 12 ·
  KPI 40 (token `--fs-*`/`--lh-*`).

### Spacing · Radius · Shadow · Motion

- **Spacing:** `--space-xs 4 · sm 8 · md 16 · lg 24 · xl 32 · 2xl 48 · 3xl 64`.
- **Radius (editorial, sharper):** `--radius-sm 3 · md 6 · lg 8 · xl 12 · pill 9999`.
- **Shadow (soft, paper-like):** `--shadow-sm … xl`, `--shadow-focus`, `--shadow-focus-crimson`.
- **Motion:** UI micro 150–300ms; reveal editorial 400–600ms; đều tôn trọng
  `prefers-reduced-motion` (Yêu cầu 9.5).

### Signature editorial devices (dùng tiết chế)
Gold hairline (~48px, 2px) dưới page title · stone divider dưới section header ·
Crimson left-rule (3px) trên nav active & hàng được chọn · small-caps tracked labels.

### Key Effects (giữ tinh thần script, hợp admin)
Hover tint trên hàng bảng, hover tooltip, KPI count-up (≤reveal), reveal-on-mount quiet
(≤300–480ms), chart entrance ≤300ms, loading **skeleton shaped** (không spinner chung).

---

## Discipline Overlay — `design-taste-frontend` (chọn lọc, Yêu cầu 1.4, 1.5)

Chỉ rút **phần kỷ luật chất lượng/chống AI-slop**. Toàn bộ `Frontend_App` được xử lý như
**UI quản trị** — kể cả màn hình lai (Trends, Insights) — nên **KHÔNG** áp quy tắc bố
cục landing/portfolio.

### ÁP DỤNG (overlay kỷ luật)
- **COLOR CONSISTENCY LOCK:** khóa **một** accent (Oxford Crimson `--color-accent`) trên
  toàn app; không "đột nhiên" thêm accent khác ở trang/khu vực khác.
- **SHAPE CONSISTENCY LOCK:** khóa **một** thang bo góc (`--radius-*`); không trộn hệ
  bo góc không có quy tắc.
- **Đủ vòng Interactive_State:** loading (skeleton shaped) / empty (có gợi ý) / error
  (nội tuyến, có `code`+`message`; 502 ⇒ "dịch vụ chưa cấu hình") / success.
- **WCAG AA contrast:** mọi cặp văn bản/nhãn-nút/biểu mẫu ≥4.5:1 (≥3:1 chữ lớn);
  kiểm nút (label vs nền nút) và form (placeholder/focus/helper/error).
- **Kỷ luật typography:** cân nặng nhất quán, `tabular-nums` cho số liệu, không nhồi
  serif lạ vào headline sans (Academia dùng serif Crimson Pro nhất quán cho display).
- **Pre-flight checklist:** icon một bộ (Lucide, không emoji), `cursor:pointer` đúng chỗ
  (không trên card tĩnh), hover không layout-shift, focus ring nhìn thấy, reduced-motion,
  responsive 375/768/1024/1440, không cuộn ngang ngoài ý muốn.

### KHÔNG ÁP DỤNG (bố cục landing/hero — Yêu cầu 1.5, áp dụng cả màn hình lai)
- ⛔ Ràng buộc **Hero** "vừa trong viewport", `pt-24` cap, HERO STACK ≤4 phần tử,
  split-hero ban — **không** dùng (kể cả pattern "Hero/Funnel/Comparison" mà script trả về).
- ⛔ EYEBROW ≤1/3 section, ZIGZAG cap, SPLIT-HEADER ban, Section-Layout-Repetition ban —
  đây là luật nhịp landing, **không** áp cho dashboard.
- ⛔ Marquee, logo-wall "Trusted by", split-screen hero, ảnh hero/`picsum`/stock,
  monogram thương hiệu giả — **không** dùng.
- ⛔ Ba dial VARIANCE/MOTION/DENSITY kiểu landing — **không** dùng; mật độ theo
  "Data-Dense Dashboard".
- ⚠️ **Icon library divergence:** `design-taste-frontend` *discourage* `lucide-react`,
  nhưng dự án đã chuẩn hóa `Icon_System` (Lucide inline-SVG). **Giữ Lucide** (skill cho
  phép khi project đã phụ thuộc) — kỷ luật "một bộ icon, stroke nhất quán" vẫn áp.
- ⚠️ Skill mặc định Tailwind/Motion/Geist; dự án **không** thêm framework UI/CSS
  (Yêu cầu 11.1). Chỉ lấy *nguyên tắc*, không lấy *stack*.

---

## Anti-Patterns (Do NOT use)
- ❌ Gradient/glassmorphism/neon lòe loẹt; ornate design.
- ❌ Emoji làm icon (dùng SVG Lucide).
- ❌ Hover gây layout-shift (scale/translate đẩy hàng xóm).
- ❌ Thiếu `cursor:pointer` ở clickable; có `cursor:pointer` ở card tĩnh.
- ❌ Text tương phản <4.5:1; crimson/gold cho body dài.
- ❌ Đổi trạng thái tức thời (luôn 150–300ms).
- ❌ Focus state vô hình.
- ❌ Hơn một CTA crimson cạnh tranh trong một view.
- ❌ Palette chart cầu vồng — dùng ramp navy→slate→gold nhất quán.

---

## Pre-Delivery Checklist
- [ ] Không emoji làm icon (chỉ SVG/Lucide), một bộ icon, stroke nhất quán
- [ ] `cursor:pointer` đúng phần tử clickable; không trên card tĩnh
- [ ] Hover mượt 150–300ms, không layout-shift
- [ ] Tương phản ≥4.5:1 (text), ≥3:1 (text lớn); kiểm nút & form
- [ ] Focus ring nhìn thấy cho điều hướng bàn phím
- [ ] `prefers-reduced-motion` được tôn trọng (reveal/shimmer/count-up)
- [ ] Responsive 375 / 768 / 1024 / 1440; không cuộn ngang ngoài ý muốn; bảng cuộn trong `.table-wrap`
- [ ] Một hệ font: Crimson Pro (display) + Inter (body) + IBM Plex Mono (số liệu); không hex lạ ngoài `:root`
- [ ] Giữ nguyên tên class `Class_Contract` (restyle, never rename)
- [ ] Đủ Interactive_State áp dụng được (loading/empty/error/success)

---

## Tham chiếu

- Output script thô: `design-system/autotgc-admin/MASTER.md`, `design-system/autotgc-admin/pages/dashboard.md`
- Token block & component spec build-ready (hướng A): `design-system/autotgc---thanh-giang/MASTER.md`, `design-system/autotgc---thanh-giang/STYLE_BRIEF.md`
- Hiện thực token: `autotgc-frontend/src/styles.css` (`:root`)
- Override theo trang: `design-system/pages/<page>.md`

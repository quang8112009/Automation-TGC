# Implementation Plan: frontend-ui-redesign

## Overview

Kế hoạch triển khai cho đợt **restyle giữ nguyên hợp đồng** của `autotgc-frontend` (React 18 + Vite + TypeScript, không Tailwind, một stylesheet toàn cục `src/styles.css` điều khiển bằng token). Trình tự bám sát Design: **(Giai đoạn 1)** chạy `ui-ux-pro-max` để sinh `design-system/MASTER.md` + override theo trang và chốt hướng theme, rồi đặt `Design_Token_Layer` trong `:root` + restyle `Layout_Shell`; **(Giai đoạn 2)** `Shared_UI` (`ui.tsx`) + `Chart_Components` (`charts.tsx`) + `Icon`, qua **Pilot Gate** trên Layout + Dashboard + một trang bảng (`Leads`); **(Giai đoạn 3)** nhân rộng 27 trang còn lại theo lô + `Login`/`Register`.

Ràng buộc xuyên suốt (theo Design & Requirements):

- Giữ nguyên 100% tên class trong `Class_Contract` — chỉ bổ sung (additive), **không** đổi tên/xóa định nghĩa (Yêu cầu 2).
- **Không** đổi định tuyến, RBAC (ADMIN/SALES), lệnh gọi API, khóa cache TanStack Query; backend ngoài phạm vi (Yêu cầu 3, 11).
- Mọi trang dùng `Theme` qua `Class_Contract`, không màu/kích thước literal nằm ngoài `Design_Token_Layer` (Yêu cầu 6.4, 13.1).
- 7 correctness property của Design ⇒ **đúng một** property test mỗi property, **≥ 100 iteration** (`fast-check`), gắn tag `// Feature: frontend-ui-redesign, Property {n}: {text}`. Tách hàm thuần khi cần: `filterNavGroups`, `classifyError`, `contrastRatio`, `resolveToken`, `definedClasses`.
- Bộ công cụ test (Vitest + @testing-library/react + jsdom + fast-check) là **devDependencies chỉ phục vụ test**, không phải framework UI/CSS (Yêu cầu 11.1).
- Cổng nghiệm thu: `tsc --noEmit` + `vite build` phải xanh, kèm static-scan no-literal + đối chiếu route/RBAC (Yêu cầu 11.5, 13.x).

> Lưu ý: các sub-task gắn `*` là **tùy chọn** (property/unit/integration test) và có thể bỏ qua cho MVP nhanh; sub-task không gắn `*` là bắt buộc. Việc triển khai (deploy) **không** nằm trong tài liệu này.

## Tasks

- [x] 1. Cài đặt công cụ kiểm thử frontend (test-only)
  - [x] 1.1 Thêm devDependencies và cấu hình test runner
    - Thêm `vitest`, `@testing-library/react`, `@testing-library/jest-dom`, `jsdom`, `fast-check` vào **devDependencies** của `autotgc-frontend/package.json` (pin version cụ thể); **không** thêm bất kỳ framework UI/CSS nào (gồm Tailwind)
    - Tạo `vitest.config.ts` (environment `jsdom`, dùng plugin React hiện có) và `test/setup.ts` (nạp `@testing-library/jest-dom`)
    - Thêm script `"test": "vitest run"` và `"test:watch": "vitest"` vào `package.json`; giữ nguyên các script `dev`/`build`/`typecheck`
    - _Requirements: 11.1_

- [x] 2. Sinh hệ thống thiết kế bằng ui-ux-pro-max và chốt hướng theme (Giai đoạn 1)
  - [x] 2.1 Chạy `search.py --design-system --persist` và lưu `Design_System_Doc`
    - Chạy `python3 steering/ui-ux-pro-max/scripts/search.py "internal admin SaaS dashboard data-table recruitment marketing" --design-system --persist -p "AutoTGC Admin"` để tạo `design-system/MASTER.md` + thư mục `design-system/pages/`; thêm override cho trang đặc thù khi cần (ví dụ `--page "dashboard"`)
    - Đối chiếu output với theme "Academia" hiện tại, **chốt hướng**: A (tinh chỉnh Academia) hoặc B (đặt lại giá trị token theo hướng mới); ghi quyết định vào `MASTER.md`. Dù A hay B, **chỉ thay giá trị token** — không đổi tên token/class
    - Rút **chỉ phần kỷ luật chất lượng** của `design-taste-frontend` (khóa một accent, khóa một thang bo góc, đủ vòng trạng thái tương tác, tương phản AA, kỷ luật typography, checklist tiền giao hàng); **không** áp quy tắc bố cục landing/hero/marquee vào bất kỳ màn hình quản trị/lai nào
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

- [x] 3. Đặt Design_Token_Layer trong `:root` và nền tảng property test
  - [x] 3.1 Áp giá trị token vào `:root` của `src/styles.css`
    - Đặt/tinh chỉnh **giá trị** token màu/typography/spacing/radius/shadow/motion theo `MASTER.md`; `:root` là nguồn khai báo duy nhất, quy tắc thành phần tham chiếu qua `var(--token)` (không lặp literal)
    - Bảo toàn toàn bộ **alias tương thích ngược** (`--color-cta`, `--gray-*`, `--bg`, `--primary`, `--radius`, `--shadow`…); biểu diễn **đúng một** họ màu nhấn bằng `--color-accent`; giữ **một** thang bo góc và **một** thang spacing; bộ ba token trạng thái (success/warning/danger/info/neutral) đầy đủ base/soft-bg/on-soft; số liệu dùng `font-variant-numeric: tabular-nums`
    - Giữ `font-display: swap` khi nạp web font, khối `@media (prefers-reduced-motion: reduce)`, và `:focus-visible` ring
    - **Không** đổi tên/xóa bất kỳ selector nào trong `Class_Contract`
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 9.3, 9.5, 11.3, 2.1, 2.3_

  - [x]* 3.2 Viết property test cho phân giải alias token
    - Tạo hàm thuần `resolveToken(name, tokenMap)` + parser dựng `tokenMap` từ `:root` (đặt trong test-support), rồi viết test
    - **Property 6: Alias token luôn phân giải về một base hợp lệ** — mọi chuỗi `var(--…)` kết thúc ở token base có literal hợp lệ, không treo (dangling) và không vòng lặp (cyclic)
    - **Validates: Requirements 4.4**
    - ≥ 100 iteration; tag `// Feature: frontend-ui-redesign, Property 6: Alias token luôn phân giải về một base hợp lệ`

  - [x]* 3.3 Viết property test cho tỷ lệ tương phản WCAG AA
    - Tạo hàm thuần `contrastRatio(fg, bg)` + tập cố định `AA_PAIRS` (cặp văn bản/nhãn-nút/biểu mẫu lấy từ giá trị token của `Theme`)
    - **Property 5: Mọi cặp tương phản của Theme đạt WCAG AA** — `contrastRatio(fg,bg) ≥ 3.0` cho chữ lớn, `≥ 4.5` cho chữ thường; kiểm `contrastRatio` đối xứng và nằm trong `[1, 21]`
    - **Validates: Requirements 9.1, 9.2, 13.3**
    - ≥ 100 iteration; tag `// Feature: frontend-ui-redesign, Property 5: Mọi cặp tương phản của Theme đạt WCAG AA`

  - [x]* 3.4 Viết property test cho bảo toàn hợp đồng class-name
    - Tạo hàm thuần `definedClasses(css)` + tập `CLASS_CONTRACT` (liệt kê ở Architecture của Design)
    - **Property 7: Hợp đồng class-name được bảo toàn** — với mọi `cls ∈ CLASS_CONTRACT`, `src/styles.css` vẫn định nghĩa ít nhất một quy tắc khớp `cls` (không class nào bị đổi tên/xóa định nghĩa)
    - **Validates: Requirements 2.1, 2.3**
    - ≥ 100 iteration; tag `// Feature: frontend-ui-redesign, Property 7: Hợp đồng class-name được bảo toàn`

- [x] 4. Restyle Layout_Shell và tách lọc nav theo vai trò
  - [x] 4.1 Tách `filterNavGroups` thành hàm thuần và nối vào `Layout.tsx`
    - Trích logic `visibleGroups` trong `components/Layout.tsx` thành hàm thuần `filterNavGroups(groups, role)` (module riêng, ví dụ `lib/nav.ts`); `Layout.tsx` import và dùng lại — giữ nguyên hành vi lọc hiện có (item hiện ⇔ `!item.roles || role∈item.roles`; loại nhóm rỗng)
    - Giữ nguyên `NAV_GROUPS` (5 nhóm tiếng Việt) và toàn bộ `to`/`label`/`roles`
    - _Requirements: 3.2, 3.5, 7.1, 13.5_

  - [x]* 4.2 Viết property test cho lọc điều hướng theo vai trò
    - **Property 1: Lọc điều hướng theo vai trò là đúng và an toàn** — với mọi `NavGroup[]` và `role ∈ {ADMIN, SALES}`, kết quả chỉ chứa item được phép, nhóm rỗng bị loại; item `roles=['ADMIN']` không bao giờ xuất hiện với `SALES`
    - **Validates: Requirements 3.2, 3.5, 13.5**
    - ≥ 100 iteration; tag `// Feature: frontend-ui-redesign, Property 1: Lọc điều hướng theo vai trò là đúng và an toàn`

  - [x] 4.3 Restyle khung Layout_Shell qua class + token
    - Restyle `components/Layout.tsx` + bổ sung (additive) class trong `styles.css` cho sidebar có nhóm, topbar (chỉ báo realtime, chuông, `user-chip` + `role-pill`, logout); **không** đổi tên class, **không** đổi hành vi
    - Giữ thu gọn 256px↔64px lưu `localStorage` (`autotgc.sidebar.collapsed`), drawer off-canvas ≤768px mở từ nút menu + scrim, đóng drawer khi đổi route; gập đa cột về 1 cột ≤1024px
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 10.1, 10.2, 2.2, 2.4_

- [x] 5. Restyle Icon_System
  - [x] 5.1 Củng cố `components/Icon.tsx` là nguồn icon duy nhất
    - Bảo đảm mọi icon dùng `stroke="currentColor"`, `fill="none"`, `viewBox="0 0 24 24"`, `strokeWidth` mặc định `1.75`; hợp đồng a11y: có `title` ⇒ `role="img"` + `aria-label` + `<title>`; không `title` ⇒ `aria-hidden`; **không** emoji
    - Chỉ **mở rộng** `IconName` nếu trang/Shared_UI cần glyph mới; không đổi cơ chế
    - _Requirements: 12.1, 12.2, 12.3, 12.4_

  - [x]* 5.2 Viết property test cho hợp đồng a11y/nét vẽ của Icon
    - **Property 2: Icon tuân thủ hợp đồng a11y và nét vẽ** — với mọi `name ∈ IconName` và có/không `title`: SVG luôn có `currentColor`/`fill=none`/`viewBox 24`/`strokeWidth 1.75`; có `title` ⇒ `role=img`+`aria-label===title`+`<title>`; không `title` ⇒ `aria-hidden` và không `aria-label`; không nhánh nào ném lỗi
    - **Validates: Requirements 12.3, 12.4**
    - ≥ 100 iteration (render bằng @testing-library/react); tag `// Feature: frontend-ui-redesign, Property 2: Icon tuân thủ hợp đồng a11y và nét vẽ`

- [x] 6. Restyle Shared_UI và Chart_Components
  - [x] 6.1 Restyle `components/ui.tsx` và tách `classifyError`
    - Restyle Loading/Skeleton (ưu tiên skeleton **shaped theo nội dung cuối**, thêm class skeleton additive), Empty (mô tả + slot `action`), `SuccessMessage`, `StatCard`/`CountUp` (tabular-nums, reduced-motion-aware), `Pagination`, `Modal` (giữ focus-trap + Esc + khóa scroll) — giữ nguyên API props
    - Tách hàm thuần `classifyError(error)` và để `ErrorMessage` dùng lại: `ApiError` 502 ⇒ `.notice` "dịch vụ chưa cấu hình"; còn lại ⇒ `.error-box` kèm `code` + `message`; lỗi thường ⇒ `.error-box` kèm `message`
    - Bảo đảm `StatusBadge` **toàn phần**: trả `"badge " + c` với `c ∈ {badge-gray|green|red|blue|yellow}`, mặc định `badge-gray`, luôn kèm nhãn text (không chỉ dùng màu)
    - Bổ sung class additive trong `styles.css` nếu cần; gắn `aria-label` cho nút chỉ-icon
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 9.4, 9.6, 5.6, 2.2_

  - [x]* 6.2 Viết property test cho tính toàn phần của StatusBadge
    - **Property 3: StatusBadge là toàn phần và không chỉ dựa vào màu** — với mọi chuỗi `status` (kể cả rỗng/lạ), trả `"badge " + c` với `c` hợp lệ, mặc định `badge-gray`, và nhãn `status` luôn hiển thị
    - **Validates: Requirements 5.6, 9.6**
    - ≥ 100 iteration; tag `// Feature: frontend-ui-redesign, Property 3: StatusBadge là toàn phần và không chỉ dựa vào màu`

  - [x]* 6.3 Viết property test cho ánh xạ hiển thị lỗi
    - **Property 4: Ánh xạ hiển thị lỗi bảo toàn mã và mô tả** — `ApiError` 502 ⇒ biến thể "notice"; `ApiError` khác ⇒ "error-box"; cả hai luôn chứa cả `code` lẫn `message`; lỗi không phải `ApiError` ⇒ "error-box" chứa thông điệp
    - **Validates: Requirements 8.3, 8.4**
    - ≥ 100 iteration; tag `// Feature: frontend-ui-redesign, Property 4: Ánh xạ hiển thị lỗi bảo toàn mã và mô tả`

  - [x] 6.4 Đưa màu literal của Chart_Components về token
    - Trong `components/charts.tsx` (BarChart/FunnelChart/DonutChart), thay `PALETTE`/`ACCENT`/ramp donut `#E3DCD0`… (hex cứng) bằng nguồn màu đọc từ token CSS (qua `getComputedStyle` của biến `--…`); giữ chữ ký các pure helper `seriesColor`, `pct`
    - _Requirements: 6.3, 6.4, 13.1_

- [x] 7. Triển khai Pilot (Layout + Dashboard + Leads)
  - [x] 7.1 Áp Theme cho pilot và xác nhận hành vi giữ nguyên
    - Restyle `pages/Dashboard.tsx` và `pages/Leads.tsx` chỉ qua `Class_Contract` + token (không literal ngoài token); dùng skeleton state-shaped khi loading, Empty có gợi ý, lỗi nội tuyến qua `Shared_UI`; bảng `Leads` cuộn ngang trong `.table-wrap`
    - **Không** đổi `useQuery`/khóa cache/endpoint/handler ghi; **không** đổi route/RBAC của hai trang
    - _Requirements: 6.1, 6.2, 8.1, 8.2, 8.3, 10.2, 10.4, 13.1, 13.2, 3.1, 3.3_

- [x] 8. Checkpoint — Cổng Pilot
  - Chạy P1–P7 + `tsc --noEmit` + `vite build` + static-scan no-literal trên pilot. Ensure all tests pass, ask the user if questions arise.

- [x] 9. Nhân rộng lô 1 — CRM tuyển dụng (Giai đoạn 3)
  - [x] 9.1 Restyle `Intake` + `FollowUps`
    - Áp Theme qua `Class_Contract` + token; đủ trạng thái loading/empty/error áp dụng được; giữ nguyên API/cache/route/RBAC
    - _Requirements: 6.2, 6.4, 8.1, 8.2, 8.3, 13.1, 13.2, 13.3_
  - [x] 9.2 Restyle `JobOrders` + `Candidates` + `CandidateDetail`
    - Áp Theme; bảng dữ liệu cuộn trong `.table-wrap`; số liệu tabular; giữ nguyên API/cache/route/RBAC
    - _Requirements: 6.2, 6.4, 8.1, 8.2, 8.3, 10.4, 13.1, 13.2, 13.3_
  - [x] 9.3 Restyle `InterviewPrep` + `Partners` + `Analytics`
    - Áp Theme; biểu đồ dùng màu token (qua `Chart_Components`); `Partners` giữ guard `RequireAuth roles={['ADMIN']}`
    - _Requirements: 6.2, 6.3, 6.4, 8.1, 8.2, 8.3, 13.1, 13.2, 13.3, 13.5_

- [x] 10. Nhân rộng lô 2 — Tổng quan + Marketing AI
  - [x] 10.1 Restyle `Reports` + `Strategy`
    - Áp Theme qua `Class_Contract` + token; đủ trạng thái áp dụng được; giữ nguyên API/cache/route/RBAC (Strategy ADMIN-only)
    - _Requirements: 6.2, 6.4, 8.1, 8.2, 8.3, 13.1, 13.2, 13.3, 13.5_
  - [x] 10.2 Restyle `Trends` + `Insights` + `AiConsultant`
    - Áp Theme; xử lý 502 ⇒ "dịch vụ chưa cấu hình" cho luồng AI; **không** áp bố cục landing dù là màn hình lai
    - _Requirements: 1.5, 6.2, 6.4, 8.3, 8.4, 13.1, 13.2, 13.3_
  - [x] 10.3 Restyle `Autopilot` + `Workflows`
    - Áp Theme; đủ trạng thái; giữ nguyên API/cache/route/RBAC (ADMIN-only)
    - _Requirements: 6.2, 6.4, 8.1, 8.2, 8.3, 13.1, 13.2, 13.3, 13.5_

- [x] 11. Nhân rộng lô 3 — Nội dung
  - [x] 11.1 Restyle `ContentPlans` + `ContentStudio`
    - Áp Theme qua `Class_Contract` + token; đủ trạng thái; xử lý 502 cho luồng AI; giữ nguyên API/cache/route/RBAC
    - _Requirements: 6.2, 6.4, 8.1, 8.2, 8.3, 8.4, 13.1, 13.2, 13.3_
  - [x] 11.2 Restyle `Drafts` + `Publishing`
    - Áp Theme; `SuccessMessage` sau thao tác ghi (duyệt/đăng); giữ nguyên API/cache/route/RBAC
    - _Requirements: 6.2, 6.4, 8.1, 8.2, 8.3, 8.5, 13.1, 13.2, 13.3_
  - [x] 11.3 Restyle `BrandAssets` + `Knowledge`
    - Áp Theme; dùng `AssetSpecView`/`AiGroundingBadge` đã restyle; giữ nguyên API/cache/route/RBAC
    - _Requirements: 6.2, 6.3, 6.4, 8.1, 8.2, 8.3, 13.1, 13.2, 13.3_

- [x] 12. Nhân rộng lô 4 — Hệ thống + Trang công khai
  - [x] 12.1 Restyle `UserManagement` + `PlatformTokens`
    - Áp Theme qua `Class_Contract` + token; bảng cuộn trong `.table-wrap`; giữ nguyên API/cache/route/RBAC (ADMIN-only)
    - _Requirements: 6.2, 6.4, 8.1, 8.2, 8.3, 10.4, 13.1, 13.2, 13.3, 13.5_
  - [x] 12.2 Restyle `DocumentCatalog` + `Settings`
    - Áp Theme; nhãn truy cập cho input/nút chỉ-icon; giữ nguyên API/cache/route/RBAC
    - _Requirements: 6.2, 6.4, 8.1, 8.2, 8.3, 9.4, 13.1, 13.2, 13.3_
  - [x] 12.3 Restyle trang công khai `Login` + `Register`
    - Áp Theme qua `Class_Contract` (`.auth-wrap`/`.auth-card`/`.auth-crest*`…) + token; tương phản AA cho biểu mẫu; giữ nguyên luồng đăng nhập/đăng ký
    - _Requirements: 6.1, 8.3, 9.1, 9.2, 9.4, 13.1, 13.3_

- [x] 13. Nghiệm thu toàn cục (Verification_Suite)
  - [x] 13.1 Chạy cổng nghiệm thu kỹ thuật và đối chiếu hồi quy
    - Chạy `tsc --noEmit` và `vite build` đến khi xanh; chạy toàn bộ property/unit test
    - Static-scan no-literal trên mọi trang (không màu/px literal ngoài token); dependency-scan xác nhận `package.json` không có Tailwind/UI framework và `App.tsx` còn `React.lazy`/`Suspense`
    - Đối chiếu route + RBAC với `App.tsx` (tập path/element, các route `RequireAuth roles={['ADMIN']}`, SALES assigned-only); chạy checklist tiền giao hàng (icon nhất quán, focus ring, reduced-motion)
    - _Requirements: 11.1, 11.2, 11.5, 13.1, 13.4, 13.5_

- [x] 14. Checkpoint cuối
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Sub-task gắn `*` là tùy chọn (property/unit/integration test) và có thể bỏ qua cho MVP; sub-task không gắn `*` là bắt buộc.
- Mỗi task tham chiếu các tiểu mục yêu cầu cụ thể để truy vết; toàn bộ Yêu cầu 1–13 được phủ qua các task.
- 7 property test ánh xạ 1–1 với 7 correctness property của Design, mỗi test ≥ 100 iteration và gắn tag `// Feature: frontend-ui-redesign, Property {n}: {text}`.
- Trình tự theo mức độ dùng chung: Token + Layout → Shared_UI/Charts/Icon → Pilot Gate → nhân rộng trang. Mỗi trang "hoàn tất" phải qua: dùng Theme qua `Class_Contract` (13.1), đủ `Interactive_State` áp dụng được (13.2), kiểm tương phản AA (13.3).
- Các sub-task nhân rộng trang chỉ sửa file trang tương ứng (dựa trên `Class_Contract` đã restyle ở Giai đoạn 1–2), **không** ghi `styles.css`, nên chạy song song an toàn.
- Triển khai (deploy) **không** thuộc tài liệu này; được xử lý riêng sau khi hoàn tất.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1"] },
    { "id": 1, "tasks": ["3.1", "4.1", "5.1"] },
    { "id": 2, "tasks": ["3.2", "3.3", "3.4", "4.2", "4.3", "5.2", "6.4"] },
    { "id": 3, "tasks": ["6.1"] },
    { "id": 4, "tasks": ["6.2", "6.3", "7.1"] },
    { "id": 5, "tasks": ["9.1", "9.2", "9.3", "10.1", "10.2", "10.3", "11.1", "11.2", "11.3", "12.1", "12.2", "12.3"] },
    { "id": 6, "tasks": ["13.1"] }
  ]
}
```

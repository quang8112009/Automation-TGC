# Requirements Document

## Introduction

Tài liệu này đặc tả yêu cầu cho tính năng **frontend-ui-redesign**: thiết kế lại (restyle) toàn bộ giao diện ứng dụng quản trị nội bộ **AutoTGC** (khách hàng: Thanh Giang — nền tảng tự động hóa marketing nội dung + CRM tuyển dụng/XKLĐ, đối tượng người dùng chủ yếu nói tiếng Việt).

Đây là một đợt **redesign giữ nguyên hợp đồng** (restyle, không viết lại): mục tiêu là nâng cấp chất lượng thị giác và trải nghiệm của lớp giao diện hiện có **mà không thay đổi hành vi dữ liệu, định tuyến, phân quyền hay API backend**. Việc thay đổi diện mạo được thực hiện chủ yếu qua lớp **design token** và lớp quy tắc trình bày trong một stylesheet toàn cục duy nhất, nhờ đó áp dụng đồng loạt cho mọi trang mà không phải sửa từng trang.

Bối cảnh kỹ thuật đã khảo sát từ codebase (`autotgc-frontend`):

- **Stack:** React 18.3 + Vite 5 + TypeScript 5.6 (strict), React Router 6.27, TanStack Query 5.59. **Không dùng Tailwind** và không có thư viện UI ngoài.
- **Styling:** Một stylesheet toàn cục duy nhất `src/styles.css`, được điều khiển hoàn toàn bởi các **CSS custom property** khai báo trong `:root` (token màu/typography/spacing/radius/shadow/motion). Chủ đề hiện tại là **"Academia / editorial học thuật"** (Academic Navy `#0F1E3D` / Oxford Crimson `#8C1D27` / Prestige Gold `#B08542` trên nền ivory ấm `#F7F4EF`; chữ hiển thị Crimson Pro + thân Inter + số liệu IBM Plex Mono).
- **Trang:** 29 file trong `src/pages` — gồm 2 trang công khai ngoài shell bảo vệ (`Login`, `Register`) và 27 trang nằm trong shell `RequireAuth + Layout` (Dashboard, Reports, Leads, Intake, FollowUps, JobOrders, Candidates, CandidateDetail, InterviewPrep, Partners, Analytics, Strategy, Trends, Insights, AiConsultant, Autopilot, Workflows, ContentPlans, ContentStudio, Drafts, Publishing, BrandAssets, Knowledge, UserManagement, PlatformTokens, DocumentCatalog, Settings). Nhiều route chỉ dành cho ADMIN.
- **Thành phần dùng chung:** `Layout.tsx` (sidebar có nhóm + topbar), `components/charts.tsx`, `components/ui.tsx` (Loading/Empty/ErrorMessage/SuccessMessage/StatusBadge/CountUp/StatCard/Pagination/Modal), `components/Icon.tsx` (Lucide dạng inline-SVG, không phụ thuộc thư viện, không emoji), `StageBadge`, `AiGroundingBadge`, `AssetSpecView`, `NotificationsBell`, `RequireAuth`.
- **Hợp đồng class-name:** Tên class CSS được nhiều trang dùng chung và `styles.css` đã ghi chú rõ là "PRESERVED (restyled, never renamed)". Đổi tên class sẽ làm vỡ giao diện các trang phụ thuộc.

Hai **skill thiết kế** được dùng làm phương pháp dẫn đường (không phải để chèn code tự động):

1. **ui-ux-pro-max** (`.kiro/steering/ui-ux-pro-max`) — bộ hướng dẫn thiết kế cho sản phẩm SaaS/dashboard; có workflow `search.py --design-system` (và `--persist`) sinh ra hệ thống thiết kế (pattern/style/màu/typography/effects/anti-patterns) và lưu thành `design-system/MASTER.md` + override theo trang. Đây là skill **phù hợp chính** cho sản phẩm dashboard/quản trị này.
2. **design-taste-frontend** ("tasteskill", `.agents/skills/design-taste-frontend`) — kỷ luật chống "AI-slop": quy tắc typography, khóa nhất quán màu/bo góc, đa dạng bố cục, trạng thái tương tác (loading/empty/error), kiểm tra tương phản WCAG AA, checklist tiền giao hàng. Skill này **tự khai báo KHÔNG dành cho dashboard/bảng dữ liệu/UI nhiều bước**, vì vậy chỉ áp dụng **phần kỷ luật/chất lượng** của skill một cách chọn lọc, **không** áp dụng các quy tắc bố cục landing-page/hero của skill.

Tài liệu cũng nắm bắt các yêu cầu cross-cutting về **khả năng truy cập (WCAG AA)**, **responsive**, **hiệu năng**, **biểu tượng/tài sản trực quan**, và **nghiệm thu/kiểm thử trực quan**.

## Glossary

- **Frontend_App**: Ứng dụng quản trị `autotgc-frontend` (React 18 + Vite + TypeScript) đang được thiết kế lại.
- **Redesign**: Đợt thiết kế lại giao diện lần này; kết quả là `Frontend_App` đã được restyle.
- **Global_Stylesheet**: Stylesheet toàn cục duy nhất `src/styles.css`.
- **Design_Token_Layer**: Tập CSS custom property khai báo trong `:root` của `Global_Stylesheet`, đóng vai trò nguồn chân lý duy nhất cho màu/typography/spacing/radius/shadow/motion.
- **Class_Contract**: Tập tên class CSS được các trang và thành phần dùng chung phụ thuộc vào (ví dụ `.card`, `.btn`, `.stat`, `.sidebar`, `.data`, `.badge`, `.page-header`, `.empty-state`, `.error-box`...).
- **Layout_Shell**: Khung giao diện bảo vệ trong `components/Layout.tsx` gồm sidebar có nhóm điều hướng và topbar.
- **Shared_UI**: Các thành phần trình bày dùng chung trong `components/ui.tsx` (Loading, Empty, ErrorMessage, SuccessMessage, StatusBadge, CountUp, StatCard, Pagination, Modal).
- **Icon_System**: Thành phần `components/Icon.tsx` — biểu tượng Lucide dạng inline-SVG, dùng `currentColor`, độ dày nét 1.75, viewBox 24×24, không phụ thuộc thư viện ngoài.
- **Chart_Components**: Thành phần biểu đồ dùng chung trong `components/charts.tsx`.
- **Redesign_Scope**: Tập trang và thành phần thuộc phạm vi của `Redesign` (xem Yêu cầu 6).
- **Design_System_Doc**: Tài liệu hệ thống thiết kế được sinh và lưu bởi `UIUX_Pro_Max_Skill` (`design-system/MASTER.md` cùng các override theo trang).
- **UIUX_Pro_Max_Skill**: Skill `ui-ux-pro-max` trong `.kiro/steering`.
- **Design_Taste_Skill**: Skill `design-taste-frontend` ("tasteskill") trong `.agents/skills`.
- **Designer**: Người (hoặc tác nhân) thực hiện `Redesign` theo tài liệu này.
- **Page**: Một thành phần trang trong `src/pages`.
- **Theme**: Bộ nhận diện trực quan (màu, typography, spacing, radius, shadow, motion) áp dụng cho toàn bộ `Frontend_App`.
- **Interactive_State**: Một trạng thái hiển thị của dữ liệu bất đồng bộ — loading, empty, error, hoặc success.
- **WCAG_AA**: Mức tuân thủ AA của WCAG 2.1 cho tương phản và thao tác bàn phím.
- **Contrast_Ratio**: Tỷ lệ tương phản màu giữa văn bản/thành phần và nền của nó.
- **Reduced_Motion**: Tùy chọn hệ điều hành `prefers-reduced-motion: reduce`.
- **Breakpoint_Set**: Bộ ngưỡng responsive chuẩn hóa của `Frontend_App` (mobile ≤ 768px, tablet 769–1024px, desktop > 1024px).
- **Backend_API**: Các endpoint HTTP của `autotgc-backend` mà `Frontend_App` gọi qua `lib/apiClient.ts` và lớp `src/api`.
- **ADMIN**: Vai trò quản trị, toàn quyền đọc/ghi mọi module.
- **SALES**: Vai trò kinh doanh, chỉ đọc dashboard và chỉ truy cập lead/ứng viên được phân công (assigned-only), không xóa.
- **Verification_Suite**: Quy trình nghiệm thu kỹ thuật của `Frontend_App` gồm `tsc --noEmit` (typecheck) và `vite build`.

## Requirements

### Requirement 1: Phương pháp thiết kế dựa trên skill dẫn đường

**User Story:** Là Designer, tôi muốn dùng các skill thiết kế đã cài để dẫn dắt hướng đi, để bản redesign nhất quán, có cơ sở và tránh "AI-slop".

#### Acceptance Criteria

1. WHEN `Designer` bắt đầu `Redesign`, THE `Designer` SHALL chạy `UIUX_Pro_Max_Skill` với chế độ `--design-system` để sinh hệ thống thiết kế gồm pattern, style, bảng màu, typography, effects và anti-patterns.
2. WHEN hệ thống thiết kế được chốt, THE `Designer` SHALL lưu hệ thống thiết kế thành `Design_System_Doc` bằng tùy chọn `--persist` để các phiên làm việc sau truy hồi được.
3. THE `Design_System_Doc` SHALL được dùng làm nguồn chân lý cho mọi quyết định màu, typography, spacing, bo góc và hiệu ứng của `Redesign`.
4. WHERE một quy tắc kỷ luật chất lượng của `Design_Taste_Skill` áp dụng được cho UI quản trị (tương phản, khóa nhất quán màu, khóa nhất quán bo góc, trạng thái tương tác, kỷ luật typography), THE `Designer` SHALL áp dụng quy tắc đó.
5. THE `Designer` SHALL KHÔNG áp dụng các quy tắc bố cục dành riêng cho landing-page/portfolio của `Design_Taste_Skill` (ví dụ ràng buộc hero, marquee, bố cục split-hero) vào bất kỳ ngữ cảnh quản trị nào của `Frontend_App`, kể cả màn hình lai vừa có thành phần dashboard vừa có nội dung tiếp thị.

### Requirement 2: Bảo toàn hợp đồng class-name (restyle, không đổi tên)

**User Story:** Là Designer, tôi muốn thay đổi diện mạo qua CSS dùng chung mà không phải sửa từng trang, để giảm rủi ro làm vỡ giao diện đang chạy.

#### Acceptance Criteria

1. THE `Redesign` SHALL giữ nguyên tất cả tên class trong `Class_Contract` mà các trang và thành phần dùng chung đang phụ thuộc.
2. WHEN `Designer` cần một kiểu trình bày mới, THE `Designer` SHALL bổ sung quy tắc hoặc class mới (additive) thay vì đổi tên class hiện có.
3. IF một class trong `Class_Contract` không còn được dùng sau `Redesign`, THEN THE `Designer` SHALL giữ lại định nghĩa của class đó để các trang phụ thuộc không bị vỡ.
4. THE `Redesign` SHALL chỉ thay đổi nội dung JSX/TSX của trang khi việc thay đổi đó cần thiết về mặt cấu trúc trình bày và không làm thay đổi hành vi dữ liệu của trang.

### Requirement 3: Bảo toàn định tuyến, phân quyền và hành vi dữ liệu

**User Story:** Là người dùng ADMIN hoặc SALES, tôi muốn mọi đường dẫn, quyền truy cập và dữ liệu hoạt động y như trước sau khi đổi giao diện, để công việc không bị gián đoạn.

#### Acceptance Criteria

1. THE `Redesign` SHALL giữ nguyên tập đường dẫn (route path) và ánh xạ route–trang hiện có trong `App.tsx`.
2. THE `Redesign` SHALL giữ nguyên các ràng buộc phân quyền theo vai trò hiện có, gồm các route chỉ dành cho `ADMIN` và quyền assigned-only của `SALES`.
3. THE `Redesign` SHALL giữ nguyên hành vi gọi `Backend_API` của mỗi trang, gồm endpoint, tham số truy vấn và khóa cache TanStack Query.
4. THE `Redesign` SHALL KHÔNG thay đổi mã nguồn, hợp đồng request/response hay hành vi của `Backend_API`.
5. WHILE `SALES` đăng nhập, THE `Layout_Shell` SHALL chỉ hiển thị các mục điều hướng mà `SALES` được phép xem, đúng như quy tắc lọc theo vai trò hiện hành.

### Requirement 4: Hệ thống design token tập trung

**User Story:** Là Designer, tôi muốn điều khiển toàn bộ diện mạo qua một lớp token duy nhất, để đổi chủ đề đồng loạt và nhất quán.

#### Acceptance Criteria

1. THE `Design_Token_Layer` SHALL là nguồn khai báo duy nhất cho các giá trị màu, typography, spacing, bo góc, đổ bóng và thời lượng/đường cong chuyển động của `Theme`.
2. WHEN `Designer` đổi một giá trị token màu chủ đạo trong `Design_Token_Layer`, THE `Frontend_App` SHALL áp dụng giá trị mới cho mọi trang dùng token đó mà không cần sửa từng trang.
3. THE `Global_Stylesheet` SHALL tham chiếu token qua biến CSS (`var(--token)`) thay vì lặp lại giá trị màu/kích thước theo từng literal trong các quy tắc thành phần.
4. THE `Design_Token_Layer` SHALL giữ lại các alias token tương thích ngược (ví dụ `--color-cta`, `--gray-*`, `--bg`) để các quy tắc và trang đang tham chiếu chúng tiếp tục hoạt động.
5. WHERE `Theme` định nghĩa một màu nhấn (accent) chính, THE `Design_Token_Layer` SHALL biểu diễn màu nhấn đó bằng một token dùng chung để toàn ứng dụng dùng đúng một màu nhấn.

### Requirement 5: Bộ nhận diện trực quan nhất quán

**User Story:** Là người dùng nội bộ, tôi muốn giao diện trông chỉn chu và nhất quán giữa các trang, để dễ đọc và tin tưởng hệ thống.

#### Acceptance Criteria

1. THE `Theme` SHALL áp dụng một bảng màu thống nhất với đúng một họ màu nhấn chính trên toàn bộ `Redesign_Scope`.
2. THE `Theme` SHALL áp dụng một thang typography thống nhất (họ chữ hiển thị, họ chữ thân, họ chữ số liệu cùng các bậc kích thước) trên toàn bộ `Redesign_Scope`.
3. THE `Theme` SHALL áp dụng một thang bo góc thống nhất cho các nhóm thành phần (nút, thẻ, ô nhập, badge) trên toàn bộ `Redesign_Scope`.
4. THE `Theme` SHALL áp dụng một thang spacing thống nhất bằng các token khoảng cách dùng chung.
5. THE `Frontend_App` SHALL hiển thị giá trị số liệu (KPI, số trong bảng) bằng họ chữ số liệu dùng chung với canh số dạng tabular.
6. IF một thành phần cần một màu trạng thái (success, warning, danger, info, neutral), THEN THE `Frontend_App` SHALL dùng token màu trạng thái dùng chung tương ứng thay vì màu literal rời rạc.

### Requirement 6: Phạm vi trang và thành phần được thiết kế lại

**User Story:** Là Designer, tôi muốn xác định rõ trang và thành phần nào nằm trong phạm vi, để bao phủ đầy đủ và không bỏ sót.

#### Acceptance Criteria

1. THE `Redesign_Scope` SHALL bao gồm `Layout_Shell` (sidebar và topbar) cùng 2 trang công khai `Login` và `Register`.
2. THE `Redesign_Scope` SHALL bao gồm toàn bộ 27 trang nằm trong shell bảo vệ được khai báo trong `App.tsx`.
3. THE `Redesign_Scope` SHALL bao gồm các thành phần dùng chung `Shared_UI`, `Chart_Components`, `StageBadge`, `AiGroundingBadge`, `AssetSpecView` và `NotificationsBell`.
4. WHEN `Designer` hoàn tất một trang trong `Redesign_Scope`, THE trang đó SHALL áp dụng `Theme` mới qua `Class_Contract` mà không còn dùng màu hoặc kích thước literal nằm ngoài `Design_Token_Layer`.
5. THE `Redesign` SHALL ưu tiên thứ tự xử lý theo mức độ dùng chung: `Design_Token_Layer` và `Layout_Shell` trước, kế đến `Shared_UI` và `Chart_Components`, sau cùng là từng `Page`.

### Requirement 7: Khung giao diện (Layout shell)

**User Story:** Là người dùng nội bộ, tôi muốn sidebar và topbar rõ ràng, gọn gàng và dễ điều hướng, để di chuyển giữa các module nhanh chóng.

#### Acceptance Criteria

1. THE `Layout_Shell` SHALL giữ nguyên cấu trúc nhóm điều hướng hiện có (Tổng quan, CRM tuyển dụng, Marketing AI, Nội dung, Hệ thống) cùng các nhãn tiếng Việt.
2. WHILE người dùng thu gọn sidebar, THE `Layout_Shell` SHALL hiển thị sidebar ở dạng thanh biểu tượng (icon rail) và giữ trạng thái thu gọn qua `localStorage`.
3. WHILE viewport rộng ≤ 768px, THE `Layout_Shell` SHALL hiển thị sidebar ở dạng ngăn kéo off-canvas mở từ nút menu trên topbar.
4. WHEN người dùng chuyển route, THE `Layout_Shell` SHALL đóng ngăn kéo sidebar trên màn hình hẹp.
5. THE `Layout_Shell` SHALL hiển thị chỉ báo kết nối realtime, chuông thông báo, danh tính người dùng cùng vai trò, và hành động đăng xuất trên topbar.

### Requirement 8: Trạng thái tương tác đầy đủ

**User Story:** Là người dùng nội bộ, tôi muốn thấy phản hồi rõ ràng khi dữ liệu đang tải, rỗng hoặc lỗi, để hiểu hệ thống đang ở trạng thái nào.

#### Acceptance Criteria

1. WHILE một truy vấn dữ liệu đang chờ, THE `Frontend_App` SHALL hiển thị trạng thái loading bằng skeleton có hình dạng tương ứng nội dung cuối thay vì chỉ một spinner chung.
2. WHEN một truy vấn dữ liệu trả về tập rỗng, THE `Frontend_App` SHALL hiển thị trạng thái empty có mô tả và (khi phù hợp) hành động gợi ý cách tạo dữ liệu.
3. IF một truy vấn hoặc thao tác `Backend_API` trả lỗi, THEN THE `Frontend_App` SHALL hiển thị thông điệp lỗi nội tuyến gồm mã lỗi và mô tả từ `ApiError`.
4. IF một thao tác `Backend_API` trả mã 502 (dịch vụ ngoài chưa cấu hình), THEN THE `Frontend_App` SHALL hiển thị thông báo "dịch vụ chưa cấu hình" thay vì thông điệp lỗi nghiêm trọng.
5. WHEN một thao tác ghi hoàn tất thành công, THE `Frontend_App` SHALL hiển thị xác nhận thành công bằng thành phần `Shared_UI` tương ứng.
6. THE `Shared_UI` SHALL cung cấp đủ bốn `Interactive_State` (loading, empty, error, success) cho các trang dùng lại.

### Requirement 9: Khả năng truy cập WCAG AA

**User Story:** Là người dùng nội bộ, tôi muốn giao diện đọc được và thao tác được bằng bàn phím, để dùng hệ thống thoải mái và đúng chuẩn.

#### Acceptance Criteria

1. THE `Frontend_App` SHALL bảo đảm `Contrast_Ratio` tối thiểu 4.5:1 cho văn bản thường và 3:1 cho văn bản lớn (≥ 18px hoặc ≥ 14px in đậm) so với nền của văn bản đó.
2. THE `Frontend_App` SHALL bảo đảm văn bản nhãn của nút đạt `Contrast_Ratio` tối thiểu so với màu nền nút của chính nút đó theo mức `WCAG_AA`.
3. WHEN người dùng điều hướng bằng bàn phím, THE `Frontend_App` SHALL hiển thị chỉ báo focus rõ ràng (focus ring) trên các phần tử tương tác.
4. THE `Frontend_App` SHALL gắn nhãn truy cập cho mọi ô nhập biểu mẫu và mọi nút chỉ có biểu tượng.
5. WHILE `Reduced_Motion` được bật, THE `Frontend_App` SHALL tắt hoặc giảm tối thiểu các hiệu ứng chuyển động (reveal, shimmer, count-up).
6. THE `Frontend_App` SHALL không dùng riêng màu sắc làm phương tiện duy nhất để truyền đạt trạng thái (kèm theo nhãn văn bản hoặc biểu tượng).

### Requirement 10: Responsive trên các ngưỡng chuẩn

**User Story:** Là người dùng nội bộ, tôi muốn giao diện hiển thị tốt trên laptop, tablet và điện thoại, để làm việc trên nhiều thiết bị.

#### Acceptance Criteria

1. THE `Frontend_App` SHALL áp dụng `Breakpoint_Set` chuẩn hóa (mobile ≤ 768px, tablet 769–1024px, desktop > 1024px) cho các bố cục đáp ứng.
2. WHILE viewport rộng ≤ 1024px, THE `Frontend_App` SHALL gập các bố cục nhiều cột (gồm lưới bento của dashboard) về một cột đầy đủ chiều rộng.
3. THE `Frontend_App` SHALL hiển thị không có cuộn ngang ngoài ý muốn ở các bề rộng 375px, 768px, 1024px và 1440px.
4. WHEN một bảng dữ liệu vượt quá bề rộng khả dụng, THE `Frontend_App` SHALL cho phép cuộn ngang trong vùng bảng (`.table-wrap`) thay vì làm tràn cả trang.

### Requirement 11: Hiệu năng và ràng buộc kỹ thuật

**User Story:** Là Designer, tôi muốn redesign không làm chậm hoặc phình ứng dụng, để giữ trải nghiệm nhanh và stack gọn.

#### Acceptance Criteria

1. THE `Redesign` SHALL không thêm phụ thuộc UI/CSS framework mới (gồm Tailwind) vào `package.json` của `Frontend_App`.
2. THE `Redesign` SHALL giữ nguyên cơ chế tách mã theo route bằng `React.lazy`/`Suspense` hiện có trong `App.tsx`.
3. WHERE `Theme` nạp phông chữ web, THE `Frontend_App` SHALL dùng `font-display: swap` để tránh chặn hiển thị văn bản.
4. THE `Redesign` SHALL giữ kiểu trình bày trong `Global_Stylesheet` dùng chung thay vì nhân bản CSS theo từng trang.
5. WHEN chạy `Verification_Suite`, THE `Frontend_App` SHALL vượt qua `tsc --noEmit` và `vite build` không lỗi.

### Requirement 12: Biểu tượng và tài sản trực quan

**User Story:** Là người dùng nội bộ, tôi muốn biểu tượng đồng bộ và chuyên nghiệp, để giao diện sạch và dễ quét nhìn.

#### Acceptance Criteria

1. THE `Frontend_App` SHALL dùng `Icon_System` làm nguồn biểu tượng duy nhất cho giao diện.
2. THE `Frontend_App` SHALL KHÔNG dùng emoji làm biểu tượng giao diện.
3. THE `Icon_System` SHALL hiển thị biểu tượng kế thừa màu hiện hành (`currentColor`) và độ dày nét thống nhất.
4. WHEN một biểu tượng mang ý nghĩa cho người dùng, THE `Icon_System` SHALL cung cấp nhãn truy cập; ngược lại biểu tượng trang trí SHALL được đánh dấu `aria-hidden`.

### Requirement 13: Nghiệm thu và kiểm thử trực quan

**User Story:** Là Designer, tôi muốn có tiêu chí nghiệm thu rõ ràng cho mỗi trang, để xác nhận redesign hoàn tất mà không gây hồi quy.

#### Acceptance Criteria

1. WHEN một trang trong `Redesign_Scope` được tuyên bố hoàn tất, THE `Designer` SHALL xác nhận trang đó dùng `Theme` qua `Class_Contract` và không còn màu/kích thước literal nằm ngoài `Design_Token_Layer`.
2. WHEN một trang trong `Redesign_Scope` được tuyên bố hoàn tất, THE `Designer` SHALL xác nhận đủ các `Interactive_State` áp dụng được (loading, empty, error) hiển thị đúng.
3. WHEN một trang trong `Redesign_Scope` được tuyên bố hoàn tất, THE `Designer` SHALL kiểm tra `Contrast_Ratio` của văn bản, nút và biểu mẫu theo mức `WCAG_AA`.
4. WHEN `Redesign` được tuyên bố hoàn tất, THE `Designer` SHALL chạy `Verification_Suite` và xác nhận không có lỗi typecheck hoặc build.
5. THE `Designer` SHALL xác nhận hành vi định tuyến và phân quyền theo vai trò không đổi sau `Redesign` bằng cách đối chiếu với `App.tsx`.

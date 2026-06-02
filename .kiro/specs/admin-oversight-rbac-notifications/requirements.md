# Requirements Document

## Introduction

Tài liệu này đặc tả yêu cầu cho gói tính năng **admin-oversight-rbac-notifications** trên nền tảng AutoTGC (khách hàng: Thanh Giang Conincon — lĩnh vực xuất khẩu lao động / XKLĐ). Mục tiêu là củng cố lớp giám sát của ADMIN, làm cho việc phân quyền (RBAC) nhất quán trên toàn hệ thống, bổ sung quản lý tài khoản nhân viên, một Bản quản lý chung (Admin Dashboard) với dòng hoạt động gần đây, và một luồng thông báo tự động thời gian thực: khi một nhân viên SALES thực hiện một hành động quan trọng (ví dụ duyệt/xác minh giấy tờ → `DocumentChecklistItem` chuyển sang `VERIFIED`), hệ thống ghi một mục nhật ký hoạt động và đẩy thông báo cho tất cả ADMIN qua hạ tầng SSE/WebSocket sẵn có.

Gói tính năng được xây dựng **bổ sung (additive)** trên kiến trúc hiện có: Fastify 4 + Prisma 5/PostgreSQL 16, Redis (ioredis) cho event bus pub/sub, JWT (jose) + RBAC thuần (`auth/rbac.ts`), Vitest + fast-check, triển khai bằng PM2 + Nginx theo thư mục `deploy/`.

Bối cảnh quan trọng đã khảo sát từ codebase:

- **RBAC hiện có là chính sách thuần** trong `src/auth/rbac.ts`: `authorize(ctx, target)` nhận `{ module, action, ownerUserId? }`. ADMIN được phép mọi thứ; SALES chỉ được `lead_management` theo assigned-only (đọc/cập nhật/cập-nhật-trạng-thái, KHÔNG xóa) và `dashboard` chỉ-đọc; mọi module khác trả `{ allowed: false, status: 403 }`. Lớp HTTP `rbacGuard` (trong `src/http/authMiddleware.ts`) dựng `ResourceTarget` cho từng route, còn `requireAuth` xác thực Bearer token và kiểm tra `JwtSession` còn `ACTIVE`.
- **Phạm vi dữ liệu theo vai trò** hiện được lặp lại ở nhiều nơi: `LeadService`, `CandidateService`, `DocumentChecklistService`, và `buildDashboardOverview` đều tự áp `where.assignedTo = actor.userId` cho SALES — đây chính là điểm cần nhất quán hóa.
- **Event bus** (`src/infra/events.ts`) có sẵn topic `notification`; lớp realtime (`src/realtime/sse.ts`, `ws.ts`, `topics.ts`) fan-out theo vai trò — ADMIN nhận mọi topic, SALES chỉ nhận `lead` + `notification`. Frontend `RealtimeContext.tsx` + `NotificationsBell.tsx` đã tiêu thụ các frame này (badge chưa-đọc, mark-as-read cục bộ).
- **Nhật ký kiểm toán hiện tại** (`AuditEntry` + `AuditLog.append`) chỉ phục vụ vòng đời Learning Insight (gắn `insightId`), append-only, KHÔNG đủ tổng quát để ghi hoạt động đa thực thể (lead/candidate/document). Cần một mô hình `ActivityLog` mới.
- **Thông báo hiện tại** chỉ là read-model phái sinh (token expiry / publish failure / insight pending) trong `dashboard/assembler.ts` — KHÔNG có thực thể `Notification` lưu trữ, không có trạng thái đã-đọc bền vững, không có người-nhận. Cần một mô hình `Notification` mới.
- **Hành động "duyệt giấy tờ"**: `DocumentChecklistService.updateStatus` đặt trạng thái sang `VERIFIED` qua route `PUT /api/v1/documents/:itemId/status`. Các hành động quan trọng khác của SALES gồm đổi giai đoạn ứng viên (`CandidateService.update`/`matchToJobOrder` → `CandidateStageHistory` + emit `notification`) và chuyển/định tính lead (`LeadService.update` → `LeadHistoryEntry`).
- **Quản lý tài khoản** hiện chỉ có `register` (luôn tạo role ADMIN), `login` (có khóa tài khoản sau ngưỡng), `refresh`, `logout`. CHƯA có endpoint liệt kê/khóa/mở khóa/đổi role/đặt-lại-mật-khẩu cho nhân viên.

Các nhóm năng lực trong tài liệu này:

1. Mô hình dữ liệu mới: `Notification` và `ActivityLog` (bổ sung, có index, append-only-friendly).
2. Phân quyền Role (RBAC enforcement): củng cố + nhất quán hóa chính sách ADMIN vs SALES ở cả lớp route và xuyên suốt các module.
3. Quản lý tài khoản nhân viên (Admin user management).
4. Admin Dashboard (Bản quản lý chung) + dòng "Hoạt động gần đây".
5. Luồng thông báo tự động (Activity → Notification fan-out cho mọi ADMIN, thời gian thực).
6. Tính nhất quán (single source of truth cho RBAC; logging + notification tập trung; append-only).

Ngoài ra, tài liệu nắm bắt yêu cầu **kiểm thử** (property-based với fast-check ≥100 trường hợp cho logic thuần) và **triển khai** (migration Prisma, build, deploy) như tiêu chí chấp nhận ở phần cross-cutting.

## Glossary

- **AutoTGC_System**: Toàn bộ nền tảng AutoTGC (backend Fastify + frontend React).
- **ADMIN**: Vai trò quản trị; toàn quyền đọc/ghi/xóa trên mọi module, quản lý tài khoản, xem thống kê toàn công ty và toàn bộ nhật ký hoạt động + thông báo.
- **SALES**: Vai trò nhân viên kinh doanh/tư vấn; chỉ truy cập ứng viên và lead được phân công cho mình (assigned-only), chỉ xem thống kê cá nhân, không quản lý tài khoản, không xóa.
- **RBAC_Service**: Thành phần đánh giá chính sách phân quyền thuần (`src/auth/rbac.ts`), hàm `authorize(ctx, target)`; là nguồn chân lý duy nhất cho quyết định phân quyền.
- **Auth_Context**: Bộ định danh người gọi đã xác thực `{ userId, role }` dùng cho `RBAC_Service`.
- **Resource_Target**: Mô tả tài nguyên được yêu cầu `{ module, action, ownerUserId? }` mà `RBAC_Service` đánh giá.
- **Rbac_Guard**: PreHandler HTTP (`rbacGuard` trong `src/http/authMiddleware.ts`) dựng `Resource_Target` cho từng route rồi gọi `RBAC_Service`.
- **Auth_Middleware**: PreHandler `requireAuth` xác thực Bearer access token và xác nhận `JwtSession` còn `ACTIVE`.
- **Assigned_Only**: Quy tắc giới hạn SALES chỉ thao tác trên tài nguyên có `assignedTo` bằng chính `userId` của người đó.
- **Personal_Stats**: Thống kê chỉ tính trên dữ liệu được phân công cho người gọi (SALES).
- **Company_Stats**: Thống kê tính trên toàn bộ dữ liệu công ty (chỉ ADMIN).
- **User_Account**: Tài khoản người dùng (`UserAccount`) gồm `username`, `email`, `role` (ADMIN|SALES), cờ `locked`, bộ đếm `failedLoginCount`.
- **User_Management_Service**: Thành phần quản lý tài khoản nhân viên (liệt kê, tạo SALES, khóa/mở khóa, đổi role, đặt-lại-mật-khẩu).
- **Notification**: Bản ghi thông báo bền vững gắn với một người nhận (`recipientUserId`), gồm loại, thông điệp, tham chiếu thực thể nguồn (tùy chọn), trạng thái đã-đọc, và `createdAt`.
- **Notification_Service**: Thành phần tạo và truy vấn `Notification`, đồng thời phát sự kiện realtime trên topic `notification`.
- **Activity_Log**: Bản ghi nhật ký hoạt động bền vững (`ActivityLog`) gồm `actorUserId`, `action`/loại sự kiện, loại + id thực thể đích, `detail` (JSON), và `createdAt`; append-only.
- **Activity_Logger**: Thành phần ghi `Activity_Log` (chỉ có thao tác thêm; không sửa/không xóa).
- **Important_Action**: Một hành động nghiệp vụ quan trọng của nhân viên cần được giám sát; trong phạm vi tài liệu gồm: xác minh giấy tờ (đặt `DocumentChecklistItem` sang `VERIFIED`), đổi giai đoạn ứng viên (`CandidateStage`), và chuyển/định tính lead (`LeadStatus` sang `QUALIFIED` hoặc `CONVERTED`).
- **Document_Checklist_Item**: Mục giấy tờ/chứng chỉ gắn với một ứng viên (`DocumentChecklistItem`), trạng thái nộp thuộc `PENDING | SUBMITTED | VERIFIED | REJECTED`.
- **Event_Bus**: Bus sự kiện miền (`src/infra/events.ts`) hỗ trợ pub/sub qua Redis, fallback in-process; phát `DomainEvent { topic, type, payload, at }`.
- **Realtime_Layer**: Lớp truyền tin thời gian thực (SSE `GET /api/v1/stream`, WebSocket `GET /api/v1/ws`) tiêu thụ `Event_Bus` và fan-out theo vai trò.
- **Notification_Topic**: Topic `notification` của `Event_Bus` dùng để đẩy thông báo cho client.
- **Admin_Dashboard**: Bản quản lý chung của ADMIN gồm các chỉ số tổng công ty và dòng "Hoạt động gần đây".
- **Recent_Activity_Feed**: Danh sách các `Activity_Log` mới nhất hiển thị trên `Admin_Dashboard`.
- **Sales_Dashboard**: Dashboard chỉ-đọc, phạm vi cá nhân (assigned-only) của SALES.
- **HTTP_Status**: Mã trạng thái HTTP; tập hợp được phép theo quy ước dự án là {200, 201, 202, 400, 401, 403, 404, 409, 423, 500, 502}.

## Requirements

### Requirement 1: Mô hình dữ liệu Notification

**User Story:** Là ADMIN, tôi muốn hệ thống lưu trữ thông báo gắn với từng người nhận, để tôi xem lại và đánh dấu đã đọc các thông báo về hoạt động của nhân viên.

#### Acceptance Criteria

1. THE `AutoTGC_System` SHALL định nghĩa một mô hình `Notification` gồm các thuộc tính: định danh, `recipientUserId`, loại thông báo (kind/type), thông điệp (message), tham chiếu thực thể nguồn tùy chọn (loại thực thể và id), cờ đã-đọc (mặc định chưa-đọc), và `createdAt`.
2. THE `Notification` SHALL liên kết mỗi bản ghi với đúng một `recipientUserId` là định danh của một `User_Account`.
3. WHEN một `Notification` được tạo, THE `AutoTGC_System` SHALL khởi tạo cờ đã-đọc ở giá trị chưa-đọc.
4. THE `AutoTGC_System` SHALL tạo chỉ mục (index) trên `Notification` theo `recipientUserId` và theo `createdAt` để truy vấn theo người nhận và theo thời gian hiệu quả.
5. THE `Notification` SHALL là thay đổi bổ sung (additive) không sửa đổi cấu trúc của các mô hình hiện có.
6. WHERE một `Notification` tham chiếu một thực thể nguồn, THE `Notification` SHALL lưu loại thực thể và định danh thực thể đó dưới dạng thuộc tính tùy chọn nhận giá trị rỗng khi không có nguồn.

### Requirement 2: Mô hình dữ liệu ActivityLog

**User Story:** Là ADMIN, tôi muốn mọi hành động quan trọng của nhân viên được ghi lại bất biến, để tôi truy vết ai đã làm gì, với thực thể nào, vào lúc nào.

#### Acceptance Criteria

1. THE `AutoTGC_System` SHALL định nghĩa một mô hình `ActivityLog` gồm các thuộc tính: định danh, `actorUserId`, loại hành động (action/eventType), loại thực thể đích, định danh thực thể đích, `detail` dạng JSON, và `createdAt`.
2. THE `Activity_Logger` SHALL chỉ cung cấp thao tác thêm bản ghi `ActivityLog`, không cung cấp thao tác cập nhật hoặc xóa (append-only).
3. THE `AutoTGC_System` SHALL tạo chỉ mục (index) trên `ActivityLog` theo `actorUserId`, theo cặp (loại thực thể đích, định danh thực thể đích), và theo `createdAt`.
4. WHEN một `ActivityLog` được tạo, THE `AutoTGC_System` SHALL gán `createdAt` bằng thời điểm máy chủ ghi nhận.
5. THE `ActivityLog` SHALL là thay đổi bổ sung (additive) không sửa đổi cấu trúc của các mô hình hiện có, bao gồm cả `AuditEntry` hiện tại.
6. THE `Activity_Logger` SHALL lưu trường `detail` nguyên trạng dưới dạng cột JSON mà không làm biến đổi nội dung do người gọi cung cấp.

### Requirement 3: Chính sách RBAC cho SALES (assigned-only và phạm vi cá nhân)

**User Story:** Là người quản trị, tôi muốn nhân viên SALES bị giới hạn đúng phạm vi được phân công, để dữ liệu của nhân viên khác và dữ liệu toàn công ty không bị lộ.

#### Acceptance Criteria

1. WHERE người gọi có vai trò SALES và `Resource_Target` thuộc module `lead_management` với `ownerUserId` khác `userId` của người gọi, THE `RBAC_Service` SHALL từ chối với mã trạng thái 403.
2. WHERE người gọi có vai trò SALES và `Resource_Target` thuộc module `lead_management` với action là `delete`, THE `RBAC_Service` SHALL từ chối với mã trạng thái 403.
3. WHERE người gọi có vai trò SALES và `Resource_Target` thuộc module `lead_management` với action thuộc {`read`, `update`, `status_update`} và `ownerUserId` bằng `userId` của người gọi, THE `RBAC_Service` SHALL cho phép.
4. WHEN `LeadService`, `CandidateService` hoặc `DocumentChecklistService` truy vấn danh sách cho người gọi có vai trò SALES, THE `AutoTGC_System` SHALL giới hạn kết quả về các bản ghi có `assignedTo` bằng `userId` của người gọi (`Personal_Stats`/assigned-only).
5. WHEN `AutoTGC_System` tính thống kê cho người gọi có vai trò SALES, THE `AutoTGC_System` SHALL chỉ tính trên dữ liệu có `assignedTo` bằng `userId` của người gọi (`Personal_Stats`).
6. IF người gọi có vai trò SALES yêu cầu thống kê toàn công ty (`Company_Stats`), THEN THE `RBAC_Service` SHALL từ chối với mã trạng thái 403.
7. WHERE người gọi có vai trò SALES và `Resource_Target` thuộc module `dashboard` với action chỉ-đọc, THE `RBAC_Service` SHALL cho phép.
8. IF người gọi có vai trò SALES và `Resource_Target` thuộc module `dashboard` với action ghi (create/update/delete/status_update), THEN THE `RBAC_Service` SHALL từ chối với mã trạng thái 403.
9. IF người gọi có vai trò SALES và `Resource_Target` thuộc bất kỳ module nào ngoài {`lead_management`, `dashboard`}, THEN THE `RBAC_Service` SHALL từ chối với mã trạng thái 403.

### Requirement 4: Toàn quyền ADMIN và thực thi RBAC tại lớp route

**User Story:** Là ADMIN, tôi muốn có toàn quyền trên hệ thống và muốn lớp route luôn áp dụng phân quyền trước khi chạy nghiệp vụ, để quyền truy cập được kiểm soát nhất quán.

#### Acceptance Criteria

1. WHERE người gọi có vai trò ADMIN, THE `RBAC_Service` SHALL cho phép mọi `Resource_Target` trên mọi module và mọi action.
2. WHEN một yêu cầu tới một endpoint được bảo vệ thiếu access token hợp lệ hoặc phiên không còn `ACTIVE`, THE `Auth_Middleware` SHALL từ chối với mã trạng thái 401 trước khi `Rbac_Guard` chạy.
3. WHEN một yêu cầu tới một endpoint được bảo vệ đã xác thực nhưng `RBAC_Service` trả về không cho phép, THE `Rbac_Guard` SHALL từ chối với mã trạng thái 403 và không thực thi nghiệp vụ của endpoint.
4. WHEN một route truy cập tài nguyên gắn chủ sở hữu (lead hoặc ứng viên) theo định danh, THE `Rbac_Guard` SHALL phân giải `ownerUserId` từ trường `assignedTo` của tài nguyên đó trước khi gọi `RBAC_Service`.
5. THE `AutoTGC_System` SHALL chỉ trả về các mã trạng thái thuộc tập `HTTP_Status` cho phép của dự án.

### Requirement 5: Quản lý tài khoản nhân viên (ADMIN)

**User Story:** Là ADMIN, tôi muốn quản lý tài khoản nhân viên SALES (tạo, khóa/mở khóa, đổi role, đặt-lại mật khẩu), để kiểm soát quyền truy cập của đội ngũ.

#### Acceptance Criteria

1. WHERE người gọi có vai trò ADMIN, THE `User_Management_Service` SHALL trả về danh sách các `User_Account` gồm `username`, `email`, `role`, và trạng thái khóa.
2. WHEN ADMIN tạo một tài khoản SALES với `username`, `email`, mật khẩu hợp lệ, THE `User_Management_Service` SHALL tạo một `User_Account` với `role` bằng SALES.
3. IF ADMIN tạo tài khoản với `username` đã tồn tại, THEN THE `User_Management_Service` SHALL từ chối với mã trạng thái 409.
4. IF yêu cầu tạo tài khoản thiếu `username`, `email`, hoặc mật khẩu hợp lệ, THEN THE `User_Management_Service` SHALL từ chối với mã trạng thái 400.
5. WHEN ADMIN khóa một `User_Account`, THE `User_Management_Service` SHALL đặt cờ `locked` của tài khoản đó thành đã-khóa.
6. WHEN ADMIN mở khóa một `User_Account`, THE `User_Management_Service` SHALL đặt cờ `locked` thành chưa-khóa và đặt lại `failedLoginCount` về 0.
7. WHEN ADMIN đổi `role` của một `User_Account` sang một giá trị thuộc {ADMIN, SALES}, THE `User_Management_Service` SHALL lưu `role` mới cho tài khoản đó.
8. WHEN ADMIN đặt-lại mật khẩu cho một `User_Account`, THE `User_Management_Service` SHALL lưu mật khẩu mới ở dạng băm (hash) và không lưu mật khẩu ở dạng văn bản thường.
9. IF người gọi có vai trò SALES yêu cầu bất kỳ endpoint quản lý tài khoản nào, THEN THE `RBAC_Service` SHALL từ chối với mã trạng thái 403.
10. WHEN một `User_Account` bị khóa và sau đó thử đăng nhập, THE `AutoTGC_System` SHALL từ chối đăng nhập với mã trạng thái 423.

### Requirement 6: Admin Dashboard — tổng quan toàn công ty và dòng hoạt động

**User Story:** Là ADMIN, tôi muốn một bản quản lý chung hiển thị các chỉ số toàn công ty và dòng hoạt động gần đây, để giám sát vận hành và tiến độ công việc của nhân viên.

#### Acceptance Criteria

1. WHEN người gọi có vai trò ADMIN yêu cầu tổng quan dashboard, THE `Admin_Dashboard` SHALL trả về các chỉ số phạm vi toàn công ty (`Company_Stats`) gồm tối thiểu: tổng số lead, phễu ứng viên theo `CandidateStage`, và số mục đang chờ duyệt.
2. WHEN người gọi có vai trò ADMIN yêu cầu tổng quan dashboard, THE `Admin_Dashboard` SHALL bao gồm `Recent_Activity_Feed` lấy từ `ActivityLog` sắp xếp theo `createdAt` giảm dần (mới nhất trước).
3. WHERE người gọi có vai trò SALES yêu cầu tổng quan dashboard, THE `Sales_Dashboard` SHALL chỉ trả về các chỉ số phạm vi cá nhân (`Personal_Stats`) giới hạn theo dữ liệu được phân công cho người đó.
4. IF người gọi có vai trò SALES yêu cầu tổng quan dashboard, THEN THE `AutoTGC_System` SHALL không đưa `Recent_Activity_Feed` toàn công ty hoặc bất kỳ `Company_Stats` nào vào phản hồi.
5. WHEN người gọi có vai trò ADMIN yêu cầu danh sách hoạt động gần đây có phân trang, THE `AutoTGC_System` SHALL trả về các mục `ActivityLog` theo trang với thứ tự `createdAt` giảm dần.
6. WHERE `Recent_Activity_Feed` trả về một mục, THE `AutoTGC_System` SHALL kèm theo trong mục đó người thực hiện (`actorUserId`), loại hành động, loại + định danh thực thể đích, và thời điểm (`createdAt`).
7. IF số mục bắt buộc dùng để tính một chỉ số tỷ lệ dẫn xuất bằng 0, THEN THE `Admin_Dashboard` SHALL trả về `INSUFFICIENT_DATA` cho chỉ số đó thay vì thực hiện phép chia.

### Requirement 7: Ghi nhật ký hoạt động khi nhân viên thực hiện hành động quan trọng

**User Story:** Là ADMIN, tôi muốn mỗi hành động quan trọng của nhân viên được ghi vào nhật ký hoạt động, để có dấu vết kiểm toán đầy đủ.

#### Acceptance Criteria

1. WHEN một người dùng xác minh một `Document_Checklist_Item` khiến trạng thái chuyển sang `VERIFIED`, THE `Activity_Logger` SHALL thêm đúng một `ActivityLog` ghi nhận `actorUserId`, loại hành động xác minh giấy tờ, loại + định danh của mục giấy tờ đích, và thời điểm.
2. WHEN một người dùng đổi giai đoạn của một ứng viên (`CandidateStage`) thành công, THE `Activity_Logger` SHALL thêm đúng một `ActivityLog` ghi nhận `actorUserId`, giai đoạn trước và giai đoạn sau trong `detail`, định danh ứng viên đích, và thời điểm.
3. WHEN một người dùng chuyển trạng thái một lead sang `QUALIFIED` hoặc `CONVERTED` thành công, THE `Activity_Logger` SHALL thêm đúng một `ActivityLog` ghi nhận `actorUserId`, trạng thái trước và sau trong `detail`, định danh lead đích, và thời điểm.
4. WHEN một `Important_Action` hoàn tất thành công, THE `AutoTGC_System` SHALL ghi đúng một mục `ActivityLog` tương ứng với hành động đó (một hành động → đúng một mục nhật ký).
5. IF hành động nghiệp vụ nền tảng bị từ chối hoặc ném lỗi, THEN THE `Activity_Logger` SHALL không thêm `ActivityLog` cho hành động đó.
6. THE `ActivityLog` của một `Important_Action` SHALL nhất quán với hành động đã tạo ra nó (cùng `actorUserId` và cùng thực thể đích với thao tác nghiệp vụ).

### Requirement 8: Phát thông báo thời gian thực cho mọi ADMIN

**User Story:** Là ADMIN, tôi muốn được thông báo ngay khi nhân viên thực hiện hành động quan trọng, để theo dõi tiến độ mà không phải tải lại trang.

#### Acceptance Criteria

1. WHEN một `Important_Action` hoàn tất thành công, THE `Notification_Service` SHALL tạo đúng một `Notification` cho mỗi `User_Account` có vai trò ADMIN.
2. WHEN một `Important_Action` hoàn tất thành công, THE `Notification_Service` SHALL phát một sự kiện trên `Notification_Topic` của `Event_Bus` để `Realtime_Layer` fan-out tới các phiên ADMIN đang kết nối.
3. THE `Notification` được tạo cho một `Important_Action` SHALL chứa đủ ngữ cảnh gồm người thực hiện (`actorUserId`), loại hành động, và loại + định danh thực thể đích để ADMIN truy vết tiến độ.
4. WHEN số lượng `User_Account` có vai trò ADMIN tại thời điểm hành động là N, THE `Notification_Service` SHALL tạo đúng N bản ghi `Notification` (mỗi ADMIN đúng một bản ghi, không trùng lặp).
5. IF việc tạo `Notification` hoặc phát sự kiện realtime ném lỗi, THEN THE `AutoTGC_System` SHALL không hoàn tác (rollback) và không làm thất bại hành động nghiệp vụ nền tảng đã thành công.
6. IF `Realtime_Layer` không phân phát được tới một phiên (mất kết nối), THEN THE `AutoTGC_System` SHALL giữ nguyên các bản ghi `Notification` đã lưu để ADMIN truy xuất lại khi tải danh sách thông báo.
7. WHEN một phiên ADMIN đang kết nối nhận một frame trên `Notification_Topic`, THE `Realtime_Layer` SHALL chuyển tiếp frame đó theo đúng chính sách topic-theo-vai-trò hiện có.

### Requirement 9: Truy vấn và đánh dấu đã đọc thông báo

**User Story:** Là ADMIN, tôi muốn xem danh sách thông báo của mình và đánh dấu đã đọc, để quản lý các mục cần chú ý.

#### Acceptance Criteria

1. WHEN người gọi đã xác thực yêu cầu danh sách thông báo của mình, THE `Notification_Service` SHALL trả về các `Notification` có `recipientUserId` bằng `userId` của người gọi, sắp xếp theo `createdAt` giảm dần.
2. WHEN người gọi đánh dấu một `Notification` của mình là đã đọc, THE `Notification_Service` SHALL đặt cờ đã-đọc của bản ghi đó thành đã-đọc.
3. IF người gọi đánh dấu đã đọc một `Notification` có `recipientUserId` khác `userId` của người gọi, THEN THE `Notification_Service` SHALL từ chối với mã trạng thái 403.
4. WHEN người gọi yêu cầu số lượng thông báo chưa đọc, THE `Notification_Service` SHALL trả về số bản ghi `Notification` của người gọi có cờ ở giá trị chưa-đọc.
5. THE đánh-dấu-đã-đọc SHALL là phép toán lũy đẳng: đánh dấu đã đọc một `Notification` đã ở trạng thái đã-đọc SHALL giữ nguyên trạng thái đã-đọc và không tạo thêm bản ghi.
6. IF `Notification` cần đánh dấu không tồn tại, THEN THE `Notification_Service` SHALL trả về mã trạng thái 404.

### Requirement 10: Tính nhất quán của phân quyền và nhật ký/thông báo

**User Story:** Là kỹ sư, tôi muốn quy tắc phân quyền và việc ghi nhật ký/phát thông báo được tập trung và áp dụng đồng nhất, để tránh sai lệch giữa các module.

#### Acceptance Criteria

1. THE `RBAC_Service` SHALL là nguồn chân lý duy nhất cho mọi quyết định phân quyền, được biểu diễn dưới dạng chính sách thuần trong `src/auth/rbac.ts`.
2. WHEN cùng một `Auth_Context` và cùng một `Resource_Target` được đánh giá nhiều lần, THE `RBAC_Service` SHALL trả về cùng một quyết định (xác định, không phụ thuộc trạng thái ngoài).
3. THE `AutoTGC_System` SHALL áp dụng cùng một quy tắc assigned-only của SALES một cách đồng nhất cho leads, ứng viên, giấy tờ, báo cáo và thống kê.
4. THE `Activity_Logger` và `Notification_Service` SHALL được gọi qua một điểm phát tập trung cho mỗi `Important_Action`, thay vì lặp lại logic ghi nhật ký/phát thông báo riêng lẻ ở từng route.
5. WHEN một `Important_Action` được xử lý qua điểm phát tập trung, THE `AutoTGC_System` SHALL tạo đúng một `ActivityLog` và đúng một `Notification` cho mỗi ADMIN (một hành động → một mục nhật ký → một thông báo cho mỗi ADMIN).
6. THE `ActivityLog` và `AuditEntry` SHALL là append-only và không cung cấp đường dẫn API sửa hoặc xóa bản ghi.
7. WHERE một module mới gắn tài nguyên có chủ sở hữu cho SALES, THE module đó SHALL phân quyền qua `RBAC_Service` với `ownerUserId` phân giải từ `assignedTo` thay vì tự định nghĩa quy tắc phân quyền riêng.

### Requirement 11: Kiểm thử (Vitest + fast-check)

**User Story:** Là kỹ sư, tôi muốn các phần logic thuần được kiểm thử property-based, để bảo đảm tính đúng đắn của phân quyền và luồng thông báo trước khi triển khai.

#### Acceptance Criteria

1. THE `AutoTGC_System` SHALL có property test bằng fast-check cho `RBAC_Service` xác nhận: ADMIN luôn được phép; SALES bị từ chối 403 cho module ngoài {`lead_management`, `dashboard`}; SALES assigned-only đúng theo `ownerUserId`; và SALES bị từ chối ghi trên `dashboard`.
2. THE `AutoTGC_System` SHALL có property test cho logic fan-out thông báo xác nhận: với một tập `User_Account` bất kỳ, số `Notification` tạo ra bằng đúng số tài khoản có vai trò ADMIN và mỗi ADMIN nhận đúng một bản ghi.
3. THE `AutoTGC_System` SHALL có property test cho tính nhất quán nhật-ký/thông-báo xác nhận: mỗi `Important_Action` sinh đúng một `ActivityLog` và đúng một `Notification` cho mỗi ADMIN.
4. THE `AutoTGC_System` SHALL có property test cho phân tách phạm vi thống kê xác nhận: thống kê của SALES chỉ tính trên dữ liệu được phân công cho người đó, còn thống kê ADMIN tính trên toàn bộ dữ liệu.
5. THE `AutoTGC_System` SHALL có property test cho tính lũy đẳng của thao tác đánh-dấu-đã-đọc `Notification`.
6. WHEN bộ kiểm thử chạy, THE `AutoTGC_System` SHALL thực thi mỗi property test với tối thiểu 100 trường hợp sinh ngẫu nhiên.

### Requirement 12: Migration và triển khai

**User Story:** Là kỹ sư vận hành, tôi muốn gói tính năng được di trú dữ liệu và triển khai an toàn theo quy trình hiện có, để đưa tính năng lên môi trường máy chủ.

#### Acceptance Criteria

1. WHEN có thay đổi mô hình dữ liệu cho `Notification` và `ActivityLog`, THE `AutoTGC_System` SHALL kèm theo một migration Prisma tạo các bảng và chỉ mục mới mà không sửa đổi các bảng hiện có ngoài việc bổ sung.
2. THE `AutoTGC_System` SHALL biên dịch thành công (`npm run build`) trước khi triển khai.
3. WHEN triển khai, THE `AutoTGC_System` SHALL chạy dưới tiến trình PM2 với người dùng không phải root và sau reverse proxy Nginx theo cấu hình trong thư mục `deploy/`.
4. IF một biến môi trường bí mật bắt buộc bị thiếu khi khởi động, THEN THE `AutoTGC_System` SHALL dừng khởi động (fail fast) và chỉ ghi log tên biến bí mật, không ghi giá trị.
5. THE `AutoTGC_System` SHALL giữ các endpoint mới (quản lý tài khoản, thông báo, hoạt động) sau lớp `Auth_Middleware` và `RBAC_Service`, không tạo endpoint không xác thực.

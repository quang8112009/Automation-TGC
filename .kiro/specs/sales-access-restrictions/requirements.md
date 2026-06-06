# Requirements Document

## Introduction

Tài liệu này đặc tả việc điều chỉnh quyền truy cập của vai trò SALES trong AutoTGC. Đây là một thay đổi chính sách RBAC có chủ đích: nó **sửa đổi** ràng buộc hiện hành trong steering ("SALES is assigned-only for leads and read-only for the dashboard"). Thay đổi gồm bốn nhóm tách biệt:

1. **Mở rộng quyền (gain access):** Cho phép SALES quản lý (manage) một số bề mặt cấu hình hiện đang giới hạn cho ADMIN — platform tokens (bộ token nền tảng), bộ giấy tờ (document checklist/catalog) và cơ sở tri thức (knowledge base). *Phạm vi chính xác của mục platform token cần được làm rõ trong quá trình review — xem Requirement 1 và mục Open Questions.*
2. **Siết phạm vi dữ liệu (assigned-only):** SALES chỉ được thấy đơn hàng / job-order / ứng viên do chính SALES đó thêm vào hoặc được giao (assigned), không thấy dữ liệu của người khác.
3. **Siết mục ứng viên & nuôi dưỡng 1-1:** Mục ứng viên (candidates) và luồng nuôi dưỡng 1-1 (1-on-1 nurturing / follow-up) cũng phải giới hạn assigned-only như trên.
4. **Gỡ bỏ quyền (lose access):** SALES không còn được xem phân tích tuyển dụng (recruitment analytics: funnel, by-market, by-source, conversion-by-job-order) — trả về 403 bất kể đã scope theo assigned hay chưa.

Đặc tả này mô tả HÀNH VI mong muốn (cái gì), không mô tả cách hiện thực (để dành cho design). Hợp đồng tích hợp hiện hành (RBAC thuần trong `auth/rbac.ts`, các guard theo route, scoping ở service layer) được tham chiếu làm hiện trạng, không thiết kế lại ở đây.

## Glossary

- **Authorization_Service**: Module chính sách RBAC thuần trong `src/auth/rbac.ts` (hàm `authorize`), nguồn quyết định phân quyền duy nhất, deterministic và property-testable.
- **RBAC_Guard**: Cơ chế thực thi phân quyền theo từng route (`rbacGuard` trong `src/http/authMiddleware.ts`), gọi Authorization_Service trước handler.
- **SALES**: Vai trò nhân viên kinh doanh. Hiện tại assigned-only với lead và read-only với dashboard; đặc tả này sửa đổi chính sách đó.
- **ADMIN**: Vai trò quản trị, full read/write mọi module.
- **Module**: Đơn vị phân quyền trong taxonomy của Authorization_Service: `strategy`, `generation`, `publishing`, `analytics`, `feedback`, `lead_management`, `settings`, `dashboard`, `user_management`.
- **Action**: Hành động phân quyền: `read`, `create`, `update`, `delete`, `status_update`, `company_stats`.
- **Assigned_Owner**: Người dùng được gán sở hữu một tài nguyên (lead/candidate/job-order) qua trường `assignedTo`. Đối chiếu bằng helper thuần `isAssignedOwner`.
- **Assigned_Only_Scope**: Quy tắc giới hạn dữ liệu sao cho SALES chỉ thấy tài nguyên có `assignedTo` bằng `userId` của chính SALES đó.
- **Candidate**: Hồ sơ ứng viên tuyển dụng (`candidateProfile`), có trường `assignedTo`.
- **Job_Order**: Đơn hàng tuyển dụng (`job-order`).
- **Nurturing_1_1**: Luồng nuôi dưỡng / theo dõi 1-1 đối với một ứng viên cụ thể (follow-up theo từng ứng viên).
- **Platform_Token**: Bộ token truy cập nền tảng (`/api/platform-tokens`), hiện guard bằng module `settings`.
- **Document_Checklist**: Danh sách giấy tờ theo từng ứng viên (`/api/v1/candidates/:id/documents*`), hiện guard `lead_management`, assigned-only.
- **Document_Catalog**: Bộ giấy tờ mặc định theo thị trường (`/api/v1/document-catalog/:market`), hiện ADMIN-only.
- **Knowledge_Base**: Cơ sở tri thức dùng để grounding cho AI consultant (`KnowledgeService`); `create`/`update`/`deactivate` là quản lý, `list`/`search` là truy xuất.
- **Recruitment_Analytics**: Các endpoint phân tích tuyển dụng ứng viên: funnel, by-market, by-source, conversion-by-job-order (`CandidateAnalyticsService`).
- **Collection_Endpoint**: Endpoint cấp danh sách/tổng hợp (list/stats/search/analytics) không gắn với một `:id` cụ thể.
- **Audit_Log**: Bản ghi nhật ký hoạt động phân quyền/quản trị (ActivityLog) phục vụ giám sát.

## Requirements

### Requirement 1: SALES quản lý Platform Tokens, Document Catalog và Knowledge Base

**User Story:** As a SALES user, I want to manage platform tokens, the document catalog, and the knowledge base, so that I can maintain the configuration and reference materials I need without depending on an ADMIN.

> **Cần làm rõ (Open Question — quyết định trong review):** Yêu cầu gốc gộp "platform token" cùng với "bộ giấy tờ" và "cơ sở tri thức" trong một ý. Cần xác nhận liệu SALES có thực sự được quản lý **Platform_Token** (vốn là bí mật cấu hình nền tảng, đang ADMIN-only) hay chỉ được quản lý tài liệu/tri thức. Các acceptance criteria dưới đây giả định SALES được cấp quyền cho cả ba bề mặt; nếu phạm vi thu hẹp, AC 1.1–1.2 sẽ được điều chỉnh tương ứng.

#### Acceptance Criteria

1. WHEN người dùng SALES (đã được cấp quyền settings/read) yêu cầu xem danh sách Platform_Token, THE Authorization_Service SHALL trả về danh sách các bản ghi Platform_Token chỉ gồm metadata (định danh, tên nền tảng, trạng thái, thời điểm cập nhật gần nhất) và KHÔNG trả về bất kỳ giá trị bí mật nào của token.
2. WHEN người dùng SALES (đã được cấp quyền settings/update) yêu cầu làm mới (refresh) một Platform_Token theo định danh hợp lệ, THE Authorization_Service SHALL thực hiện làm mới token đó và trả về metadata đã cập nhật (trạng thái và thời điểm cập nhật) mà KHÔNG trả về giá trị bí mật của token.
3. IF người dùng SALES yêu cầu một thao tác trên Platform_Token mà không có quyền tương ứng (settings/read cho đọc, settings/update cho làm mới), THEN THE Authorization_Service SHALL từ chối thao tác, trả về lỗi cho biết không đủ quyền, và giữ nguyên trạng thái và giá trị hiện tại của Platform_Token (không thay đổi, không xóa).
4. WHEN người dùng SALES (đã được cấp quyền) yêu cầu xem Document_Catalog, THE Authorization_Service SHALL trả về danh sách các mục trong Document_Catalog.
5. WHEN người dùng SALES (đã được cấp quyền) yêu cầu cập nhật một mục trong Document_Catalog với dữ liệu hợp lệ, THE Authorization_Service SHALL lưu thay đổi và trả về mục đã cập nhật.
6. WHEN người dùng SALES (đã được cấp quyền) yêu cầu tạo một mục Knowledge_Base với dữ liệu hợp lệ, THE Authorization_Service SHALL tạo mục mới với trạng thái active và trả về mục đã tạo.
7. WHEN người dùng SALES (đã được cấp quyền) yêu cầu cập nhật một mục Knowledge_Base hiện có với dữ liệu hợp lệ, THE Authorization_Service SHALL lưu thay đổi và trả về mục đã cập nhật.
8. WHEN người dùng SALES (đã được cấp quyền) yêu cầu vô hiệu hóa (deactivate) một mục Knowledge_Base hiện có, THE Authorization_Service SHALL đổi trạng thái mục đó sang inactive mà KHÔNG xóa bản ghi, và giữ lại toàn bộ dữ liệu của mục.
9. WHEN người dùng SALES (đã được cấp quyền) yêu cầu đọc hoặc tìm kiếm Knowledge_Base, THE Authorization_Service SHALL trả về các mục Knowledge_Base khớp với tiêu chí truy vấn.
10. THE Authorization_Service SHALL cho phép ADMIN thực hiện đầy đủ quyền đọc và ghi (ghi gồm tạo, cập nhật và xóa) trên Platform_Token, Document_Catalog và Knowledge_Base, bất kể trạng thái hoặc cấu hình của chính sách phân quyền.

### Requirement 2: Giới hạn assigned-only cho Job Orders và đơn hàng của SALES

**User Story:** As a SALES user, I want the orders and job-orders view to show only the records I created or was assigned, so that I am not exposed to other people's data.

#### Acceptance Criteria

1. WHEN một SALES user yêu cầu danh sách Job_Order qua Collection_Endpoint, THE Job_Order_Service SHALL trả về với mã trạng thái 200 chỉ các Job_Order mà SALES đó được gán làm Assigned_Owner, và loại trừ khỏi kết quả mọi Job_Order mà SALES đó không phải Assigned_Owner.
2. WHEN một SALES user yêu cầu danh sách Job_Order qua Collection_Endpoint nhưng không có Job_Order nào thuộc Assigned_Only_Scope của SALES đó, THE Job_Order_Service SHALL trả về mã trạng thái 200 với một danh sách rỗng (không chứa phần tử nào).
3. IF một SALES user yêu cầu một Job_Order cụ thể theo `:id` mà SALES đó không phải Assigned_Owner, THEN THE Authorization_Service SHALL từ chối với mã trạng thái 403, trả về envelope lỗi báo hiệu truy cập bị từ chối, và KHÔNG trả về bất kỳ trường dữ liệu nào của Job_Order được yêu cầu.
4. WHEN một SALES user yêu cầu tổng hợp/thống kê trên tập Job_Order, THE Job_Order_Service SHALL tính toán chỉ trên các Job_Order thuộc Assigned_Only_Scope của SALES đó và loại trừ mọi Job_Order ngoài phạm vi đó khỏi kết quả tổng hợp.
5. IF một SALES user thực hiện thao tác `delete` trên module `lead_management`, THEN THE Authorization_Service SHALL từ chối với mã trạng thái 403, trả về envelope lỗi báo hiệu thao tác bị từ chối, và KHÔNG xóa hay thay đổi bất kỳ bản ghi nào.

### Requirement 3: Giới hạn assigned-only cho Candidates và Nurturing 1-1

**User Story:** As a SALES user, I want the candidates list and 1-on-1 nurturing view to show only my assigned candidates, so that my workspace reflects only the people I am responsible for.

#### Acceptance Criteria

1. WHEN một SALES user yêu cầu danh sách Candidate qua Collection_Endpoint, THE Candidate_Service SHALL trả về chỉ các Candidate mà SALES đó là Assigned_Owner, và SHALL trả về danh sách rỗng nếu SALES đó không phải Assigned_Owner của bất kỳ Candidate nào.
2. WHEN một SALES user yêu cầu tìm kiếm Candidate qua Collection_Endpoint, THE Candidate_Service SHALL giới hạn kết quả chỉ gồm các Candidate thuộc Assigned_Only_Scope (tập các Candidate mà SALES đó là Assigned_Owner) của SALES đó, và SHALL loại bỏ mọi Candidate ngoài phạm vi này khỏi tập kết quả khớp tìm kiếm.
3. WHEN một SALES user yêu cầu thống kê Candidate (`stats`) qua Collection_Endpoint, THE Candidate_Service SHALL tính toán chỉ trên các Candidate thuộc Assigned_Only_Scope của SALES đó, và SHALL loại trừ mọi Candidate ngoài phạm vi này khỏi mọi giá trị tổng hợp được trả về.
4. IF một SALES user yêu cầu một Candidate cụ thể theo `:id` mà SALES đó không phải Assigned_Owner, THEN THE Authorization_Service SHALL từ chối yêu cầu với mã trạng thái 403, SHALL không trả về bất kỳ trường dữ liệu nào của Candidate đó, và SHALL trả về thông báo lỗi cho biết quyền truy cập bị từ chối.
5. IF một SALES user yêu cầu dữ liệu Nurturing_1_1 của một Candidate mà SALES đó không phải Assigned_Owner, THEN THE Authorization_Service SHALL từ chối yêu cầu với mã trạng thái 403, SHALL không trả về bất kỳ dữ liệu Nurturing_1_1 nào của Candidate đó, và SHALL trả về thông báo lỗi cho biết quyền truy cập bị từ chối.
6. WHEN một SALES user yêu cầu danh sách hoặc tổng hợp Nurturing_1_1 qua Collection_Endpoint, THE Candidate_Service SHALL giới hạn dữ liệu chỉ gồm Nurturing_1_1 của các Candidate thuộc Assigned_Only_Scope của SALES đó.
7. WHEN một SALES user là Assigned_Owner của một Candidate yêu cầu đọc hoặc cập nhật Document_Checklist của Candidate đó, THE Authorization_Service SHALL cho phép thao tác đọc và cập nhật Document_Checklist đó.
8. IF một SALES user yêu cầu đọc hoặc cập nhật Document_Checklist của một Candidate mà SALES đó không phải Assigned_Owner, THEN THE Authorization_Service SHALL từ chối yêu cầu với mã trạng thái 403, SHALL không thực hiện bất kỳ thay đổi nào lên Document_Checklist, và SHALL trả về thông báo lỗi cho biết quyền truy cập bị từ chối.

### Requirement 4: Đóng lỗ hổng RBAC ở tầng Collection_Endpoint

**User Story:** As a security owner, I want assigned-only enforcement to be reliable at the authorization layer for collection endpoints, so that a service-layer mistake cannot leak other users' data.

#### Acceptance Criteria

1. WHEN một SALES user gọi bất kỳ Collection_Endpoint nào thuộc module `lead_management` (list/stats/search cho Candidate hoặc Job_Order), THE RBAC_Guard SHALL áp dụng Assigned_Only_Scope tại tầng authorization trước khi gọi tầng service, sao cho tập kết quả trả về chỉ chứa các tài nguyên mà SALES đó là Assigned_Owner và loại bỏ 100% tài nguyên có Assigned_Owner khác.
2. IF tầng service trả về một tập dữ liệu cho Collection_Endpoint chứa ít nhất một tài nguyên mà SALES đang gọi không phải là Assigned_Owner, THEN THE RBAC_Guard SHALL loại bỏ toàn bộ các tài nguyên không khớp Assigned_Owner đó khỏi response trước khi trả về cho người gọi, sao cho không có tài nguyên của người dùng khác bị lộ trong kết quả cuối cùng.
3. THE Authorization_Service SHALL đánh giá phân quyền một cách deterministic sao cho với cùng một bộ (AuthContext, ResourceTarget), mọi lần đánh giá đều trả về cùng một AuthzDecision (cùng giá trị allow/deny và cùng Assigned_Only_Scope), không phụ thuộc thời điểm gọi hay thứ tự gọi.
4. WHERE một tài nguyên có `ownerUserId` không xác định (chưa gán hoặc không tồn tại), THE Authorization_Service SHALL coi tài nguyên đó là KHÔNG khớp Assigned_Owner đối với SALES và loại tài nguyên đó khỏi tập kết quả của SALES.
5. IF việc đánh giá Assigned_Only_Scope cho một Collection_Endpoint không hoàn tất được (ví dụ thiếu AuthContext hoặc lỗi khi xác định Assigned_Owner), THEN THE RBAC_Guard SHALL từ chối yêu cầu theo hướng fail-closed (trả về phản hồi từ chối truy cập, không trả bất kỳ tài nguyên nào) và SHALL không trả về tập dữ liệu chưa được lọc.

### Requirement 5: Gỡ bỏ Recruitment Analytics đối với SALES

**User Story:** As an ADMIN, I want SALES to lose access to recruitment analytics, so that funnel and conversion insights remain an ADMIN-only capability.

#### Acceptance Criteria

1. IF một người dùng có vai trò SALES gửi yêu cầu tới bất kỳ endpoint Recruitment_Analytics nào (funnel, by-market, by-source, conversion-by-job-order), THEN THE Authorization_Service SHALL từ chối với mã trạng thái 403 và trả về envelope lỗi `{ error: { code, message } }` với mã lỗi cho biết quyền bị từ chối (ForbiddenError), và THE Authorization_Service SHALL KHÔNG bao gồm bất kỳ dữ liệu analytics nào trong response body.
2. IF một người dùng có vai trò SALES gửi yêu cầu tới bất kỳ endpoint Recruitment_Analytics nào, THEN THE Authorization_Service SHALL thực hiện quyết định từ chối truy cập trong lớp RBAC trước khi thực thi bất kỳ truy vấn analytics nào (không có truy vấn dữ liệu nào được khởi chạy trước phản hồi 403).
3. IF một người dùng có vai trò SALES gửi yêu cầu tới bất kỳ endpoint Recruitment_Analytics nào, THEN THE Authorization_Service SHALL trả về 403 bất kể phạm vi (scoping) được gán cho người dùng đó, không có ngoại lệ dựa trên lead/job-order được phân công.
4. WHEN một người dùng có vai trò ADMIN gửi yêu cầu hợp lệ tới bất kỳ endpoint Recruitment_Analytics nào (funnel, by-market, by-source, conversion-by-job-order), THE Authorization_Service SHALL trả về mã trạng thái 200 cùng tập dữ liệu analytics đầy đủ tương ứng với endpoint được yêu cầu.

### Requirement 6: Deny-by-default và chống leo thang đặc quyền

**User Story:** As a security owner, I want the revised SALES policy to remain deny-by-default with no privilege escalation, so that expanding some surfaces does not accidentally open others.

#### Acceptance Criteria

1. THE Authorization_Service SHALL áp dụng nguyên tắc từ-chối-mặc-định (deny-by-default): mọi cặp (module, action) của SALES không khớp tường minh với một mục trong danh sách cho phép (explicit allow-list) SHALL bị từ chối với mã trạng thái 403 kèm chỉ báo lỗi nêu rõ truy cập bị từ chối.
2. IF người gọi có vai trò SALES và yêu cầu thuộc module `user_management` với bất kỳ action đọc hoặc ghi nào (read/create/update/delete/status_update), THEN THE Authorization_Service SHALL từ chối với mã trạng thái 403 và THE System SHALL không thay đổi bất kỳ dữ liệu nào.
3. IF người gọi có vai trò SALES và yêu cầu thuộc module `dashboard` với action thuộc {`create`, `update`, `delete`}, THEN THE Authorization_Service SHALL từ chối với mã trạng thái 403 và THE System SHALL không thay đổi bất kỳ dữ liệu nào.
4. IF người gọi có vai trò SALES yêu cầu `company_stats` qua module `dashboard`, THEN THE Authorization_Service SHALL từ chối với mã trạng thái 403.
5. WHERE người gọi có vai trò SALES và yêu cầu thuộc một module trong {`strategy`, `generation`, `publishing`, `analytics`, `feedback`} chưa được cấp quyền tường minh trong allow-list, IF người gọi yêu cầu module đó với bất kỳ action nào, THEN THE Authorization_Service SHALL từ chối với mã trạng thái 403, độc lập với mọi quyền đã được cấp trên các module khác (chống leo thang đặc quyền).
6. WHEN người gọi có vai trò SALES yêu cầu một phép đọc trên module `dashboard` không thuộc `company_stats`, THE Authorization_Service SHALL cho phép và THE System SHALL trả về dữ liệu dashboard phạm vi cá nhân.
7. IF Authorization_Service từ chối một yêu cầu, THEN THE System SHALL không thực thi nghiệp vụ của endpoint, SHALL giữ nguyên trạng thái dữ liệu (state-preservation), và SHALL không cấp thêm bất kỳ quyền nào vượt quá allow-list của vai trò gọi (no-privilege-escalation).

### Requirement 7: Giám sát và nhật ký phân quyền

**User Story:** As an ADMIN, I want authorization decisions and SALES management actions to be observable, so that I can audit the revised policy.

#### Acceptance Criteria

1. WHEN một thao tác quản lý của SALES trên Platform_Token, Document_Catalog hoặc Knowledge_Base hoàn tất thành công, THE Audit_Log SHALL ghi một bản ghi gồm: userId của người thực hiện, tên module, loại hành động, tài nguyên đích, dấu thời gian UTC theo mili-giây, và kết quả "success", trong vòng tối đa 5 giây kể từ khi thao tác hoàn tất.
2. IF một yêu cầu của SALES bị từ chối phân quyền, THEN THE Authorization_Service SHALL trả về envelope `{ error: { code, message } }` với mã trạng thái 403 và từ chối thực thi mà không thay đổi trạng thái của tài nguyên đích.
3. WHEN một yêu cầu của SALES bị từ chối phân quyền, THE Audit_Log SHALL ghi một bản ghi gồm: userId của người thực hiện, tên module, loại hành động, tài nguyên đích, dấu thời gian UTC theo mili-giây, và kết quả "denied", trong vòng tối đa 5 giây kể từ khi yêu cầu bị từ chối.
4. THE Audit_Log SHALL không lưu bất kỳ giá trị bí mật nào (token, mật khẩu, khóa) trong bản ghi; mọi giá trị bí mật SHALL được thay thế bằng một dấu hiệu che (redacted marker).
5. WHEN ADMIN truy xuất các bản ghi audit, THE Audit_Log SHALL trả về các trường bắt buộc (userId, module, hành động, tài nguyên đích, dấu thời gian UTC theo mili-giây, kết quả) trong vòng tối đa 3 giây.

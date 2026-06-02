# Requirements Document

## Introduction

Tài liệu này đặc tả yêu cầu cho gói nâng cấp **ai-reporting-and-ops-enhancements** trên nền tảng AutoTGC (khách hàng: Thanh Giang Conincon — lĩnh vực xuất khẩu lao động / XKLĐ). Gói nâng cấp gồm bốn nhóm năng lực, xây dựng bổ sung (additive) trên kiến trúc hiện có: Fastify 4 + Prisma 5/PostgreSQL 16, Redis (ioredis/BullMQ), JWT (jose) + RBAC (ADMIN/SALES), Google Gemini (ngoại vi, tùy chọn), Vitest + fast-check, triển khai bằng PM2 + Nginx.

Bối cảnh quan trọng đã khảo sát từ codebase:

- Hệ thống ĐÃ có module recruitment (`CandidateProfile`, `JobOrder`, `Branch`, state machine ứng viên, luồng promote Lead → Candidate) và analytics ứng viên (funnel, by-market, by-source, conversion-by-job-order).
- ĐÃ có `RecruitmentConsultantAgent` + `KnowledgeService`: "huấn luyện AI" trong hệ thống nghĩa là **retrieval grounding** (truy hồi `KnowledgeEntry` rồi ghép prompt có thứ tự xác định) cộng **diễn giải bằng Gemini khi được cấu hình**; khi không có khóa Gemini thì trả về câu trả lời nền xác định (`aiGenerated: false`). Đây KHÔNG phải mô hình fine-tune.
- ĐÃ có `FeedbackEngine` (phân tích hiệu năng hằng tuần → Learning Insight ở REVIEW MODE) và cron `weekly-feedback`, nhưng CHƯA có báo cáo công ty dạng TUẦN/THÁNG được lưu trữ.
- Lịch nội dung ĐÃ có `PUT /api/strategy/calendar/:id/reschedule` và `ContentPlanItem.orderIndex`, nhưng CHƯA có hành vi kéo–thả nhiều mục/ghi nhận thứ tự hàng loạt.
- CHƯA có mô hình giấy tờ/chứng chỉ (document checklist) cho ứng viên.

Bốn nhóm năng lực:

1. **Mô hình phân tích AI cho báo cáo tự động (TUẦN/THÁNG)** — pipeline LLM-orchestrated (đã chốt: KHÔNG train model riêng) tổng hợp dữ liệu analytics có sẵn để sinh báo cáo công ty theo định kỳ, có REVIEW MODE + RBAC.
2. **Trợ lý Công việc TGC (TGC Work Assistant)** — chuyển đổi tính năng "tư vấn AI" thành trợ lý nội bộ trả lời câu hỏi công việc của nhân viên, grounding trên dữ liệu/tài liệu công ty, phân quyền ADMIN vs SALES.
3. **Tối ưu UX bằng kéo–thả (drag-and-drop)** — cho lịch nội dung và hàng đợi duyệt, ghi nhận thứ tự/đổi lịch xuống backend.
4. **Checklist giấy tờ/chứng chỉ theo ứng viên** — bộ giấy tờ mặc định theo quốc gia/thị trường, có thể cấu hình và cho phép thêm loại giấy tờ tùy biến (mở rộng module recruitment hiện có).

Ngoài ra, tài liệu nắm bắt yêu cầu **kiểm thử** (property-based với fast-check khi phù hợp) và **triển khai** như tiêu chí chấp nhận ở phần cross-cutting.

## Glossary

- **AutoTGC_System**: Toàn bộ nền tảng AutoTGC (backend Fastify + frontend React).
- **Report_Engine**: Thành phần thuần (pure) sinh nội dung báo cáo TUẦN/THÁNG từ dữ liệu analytics đã tổng hợp; có thể gọi Gemini để diễn giải.
- **Report_Scheduler**: Tiến trình cron đăng ký các tác vụ định kỳ tạo báo cáo TUẦN/THÁNG.
- **Company_Report**: Bản ghi báo cáo công ty được lưu trong cơ sở dữ liệu, thuộc một loại kỳ (WEEKLY hoặc MONTHLY) với trạng thái vòng đời.
- **Report_State_Machine**: Hàm chuyển trạng thái có kiểm soát cho `Company_Report` (DRAFT → IN_REVIEW → APPROVED, và DRAFT/IN_REVIEW → ARCHIVED).
- **Report_Period**: Khoảng thời gian `[from, to)` của một báo cáo (tuần hoặc tháng) tính theo UTC.
- **Gemini_Service**: Dịch vụ Google Gemini ngoại vi, được cấu hình tùy chọn qua khóa API.
- **Work_Assistant**: "Trợ lý Công việc TGC (TGC Work Assistant)" — agent hỏi–đáp nội bộ cho nhân viên, grounding trên `Knowledge_Base` và dữ liệu nghiệp vụ trong phạm vi quyền của người hỏi.
- **Knowledge_Base**: Tập `KnowledgeEntry` đang hoạt động (active) dùng để grounding cho `Work_Assistant`.
- **Assistant_Answer**: Kết quả trả về của `Work_Assistant` gồm văn bản trả lời, danh sách nguồn grounding, và cờ `aiGenerated`.
- **Schedule_Board**: Màn hình lịch nội dung hỗ trợ kéo–thả các `ContentPlanItem` / mục lịch.
- **Approval_Queue**: Hàng đợi duyệt nội dung (bản nháp chờ duyệt) hỗ trợ kéo–thả để sắp thứ tự ưu tiên.
- **Reorder_Request**: Yêu cầu cập nhật thứ tự (và/hoặc ngày đăng) cho một tập mục sau thao tác kéo–thả.
- **Candidate_Profile**: Hồ sơ ứng viên XKLĐ (`CandidateProfile`) hiện có.
- **Document_Checklist**: Tập các mục giấy tờ/chứng chỉ gắn với một `Candidate_Profile`.
- **Document_Checklist_Item**: Một mục giấy tờ trong `Document_Checklist`, có loại, trạng thái nộp, bắt buộc/tùy chọn, và nguồn (mặc định theo thị trường hoặc tùy biến).
- **Document_Type_Catalog**: Danh mục các loại giấy tờ mặc định theo thị trường/quốc gia, có thể cấu hình.
- **Market**: Mã thị trường XKLĐ chuẩn hóa (JAPAN, KOREA, GERMANY, TAIWAN, AUSTRALIA, LITHUANIA, EUROPE, DOMESTIC, OTHER) theo `markets.ts`.
- **ADMIN**: Vai trò quản trị, toàn quyền đọc/ghi mọi module.
- **SALES**: Vai trò kinh doanh, chỉ đọc dashboard và chỉ truy cập ứng viên/lead được phân công (assigned-only), không xóa.
- **RBAC_Service**: Thành phần đánh giá chính sách phân quyền thuần (`auth/rbac.ts`).
- **Review_Mode**: Chế độ yêu cầu con người phê duyệt trước khi kết quả AI ảnh hưởng dữ liệu chính thức.
- **Audit_Log**: Bản ghi nhật ký kiểm toán cho các sự kiện quan trọng (tạo/sửa/duyệt/từ chối).

## Requirements

### Requirement 1: Tổng hợp dữ liệu analytics cho báo cáo định kỳ

**User Story:** Là ADMIN, tôi muốn hệ thống tự động tổng hợp dữ liệu hiệu năng và phễu tuyển dụng theo kỳ, để có cơ sở dữ liệu nhất quán cho báo cáo TUẦN/THÁNG.

#### Acceptance Criteria

1. WHEN `Report_Engine` tổng hợp dữ liệu cho một `Report_Period`, THE `Report_Engine` SHALL chỉ đưa vào các bản ghi có `scoredAt` hoặc `createdAt` thuộc khoảng `[from, to)` của kỳ đó.
2. WHEN `Report_Engine` tính các chỉ số tỷ lệ dẫn xuất, THE `Report_Engine` SHALL loại trừ mọi bản ghi `PerformanceRecord` có nhãn `INSUFFICIENT_DATA` khỏi đầu vào tính trung bình.
3. IF mẫu số của một chỉ số dẫn xuất bằng 0, THEN THE `Report_Engine` SHALL gán chỉ số đó bằng giá trị `INSUFFICIENT_DATA` thay vì thực hiện phép chia.
4. THE `Report_Engine` SHALL tính các tổng hợp gồm: số nội dung đã xuất bản, các tỷ lệ hiệu năng trung bình theo `scoring`, số lead theo nguồn, và phễu ứng viên theo `CandidateStage` cho `Report_Period`.
5. WHERE người yêu cầu báo cáo có vai trò SALES, THE `Report_Engine` SHALL chỉ tổng hợp dữ liệu ứng viên và lead được phân công cho người đó.
6. WHERE người yêu cầu báo cáo có vai trò SALES, THE `Report_Engine` SHALL loại trừ khỏi báo cáo mọi bản ghi ứng viên hoặc lead chưa được phân công cho bất kỳ ai trong `Report_Period`.

### Requirement 2: Sinh nội dung báo cáo TUẦN/THÁNG

**User Story:** Là ADMIN, tôi muốn hệ thống sinh báo cáo TUẦN và THÁNG có cấu trúc rõ ràng, để nắm nhanh tình hình kinh doanh và hiệu quả nội dung.

#### Acceptance Criteria

1. WHEN `Report_Engine` tạo một `Company_Report`, THE `Report_Engine` SHALL gán `reportType` là một trong hai giá trị `WEEKLY` hoặc `MONTHLY`.
2. THE `Report_Engine` SHALL sinh báo cáo gồm các phần: tóm tắt điều hành, chỉ số hiệu năng nội dung, phễu tuyển dụng theo thị trường, danh sách điểm nổi bật, và danh sách khuyến nghị.
3. WHERE `Gemini_Service` được cấu hình khóa API hợp lệ, THE `Report_Engine` SHALL dùng `Gemini_Service` để diễn giải phần tóm tắt điều hành và đánh dấu báo cáo `aiGenerated = true`.
4. IF `Gemini_Service` không được cấu hình hoặc trả lỗi, THEN THE `Report_Engine` SHALL sinh phần tóm tắt điều hành theo bản tổng hợp xác định từ dữ liệu và đánh dấu báo cáo `aiGenerated = false`.
5. IF không có bản ghi dữ liệu hợp lệ nào trong `Report_Period`, THEN THE `Report_Engine` SHALL tạo `Company_Report` với trạng thái `INSUFFICIENT_DATA` và không sinh khuyến nghị suy đoán.
6. THE `Report_Engine` SHALL sinh cùng một nội dung báo cáo cho cùng một tập dữ liệu đầu vào và cùng `Report_Period` khi không dùng `Gemini_Service` (tính xác định để kiểm thử).

### Requirement 3: Lưu trữ và vòng đời báo cáo (Review Mode)

**User Story:** Là ADMIN, tôi muốn báo cáo đi qua quy trình duyệt và được lưu lịch sử, để kiểm soát chất lượng trước khi công bố nội bộ.

#### Acceptance Criteria

1. WHEN một `Company_Report` được tạo, THE `AutoTGC_System` SHALL lưu báo cáo ở trạng thái khởi tạo `DRAFT`.
2. WHEN ADMIN gửi yêu cầu chuyển trạng thái báo cáo, THE `Report_State_Machine` SHALL chỉ cho phép các bước hợp lệ: `DRAFT → IN_REVIEW`, `IN_REVIEW → APPROVED`, `DRAFT → ARCHIVED`, `IN_REVIEW → ARCHIVED`.
3. IF yêu cầu chuyển trạng thái không nằm trong tập bước hợp lệ, THEN THE `Report_State_Machine` SHALL từ chối với mã trạng thái 409 và giữ nguyên trạng thái hiện tại.
4. WHEN ADMIN chỉnh sửa nội dung một `Company_Report` ở trạng thái `DRAFT` hoặc `IN_REVIEW`, THE `AutoTGC_System` SHALL lưu phiên bản nội dung đã chỉnh sửa.
5. WHEN trạng thái một `Company_Report` chuyển sang `APPROVED`, THE `Audit_Log` SHALL ghi một mục gồm mã báo cáo, người thực hiện, và thời điểm.
6. THE `AutoTGC_System` SHALL lưu giữ các `Company_Report` đã tạo để truy xuất theo `reportType` và `Report_Period`.

### Requirement 4: Lập lịch tạo báo cáo định kỳ

**User Story:** Là ADMIN, tôi muốn báo cáo TUẦN và THÁNG được tạo tự động theo lịch, để không phải tạo thủ công mỗi kỳ.

#### Acceptance Criteria

1. THE `Report_Scheduler` SHALL đăng ký một tác vụ tạo báo cáo `WEEKLY` và một tác vụ tạo báo cáo `MONTHLY` với biểu thức cron có thể cấu hình qua biến môi trường.
2. WHEN một tác vụ định kỳ của `Report_Scheduler` chạy, THE `Report_Scheduler` SHALL tạo một `Company_Report` ở trạng thái `DRAFT` cho kỳ vừa kết thúc.
3. IF một lần chạy tác vụ định kỳ ném lỗi, THEN THE `Report_Scheduler` SHALL ghi log lỗi kèm tên tác vụ và thời điểm thất bại, và không làm dừng tiến trình hoặc các tác vụ khác.
4. WHEN một báo cáo định kỳ mới được tạo, THE `AutoTGC_System` SHALL không tự động chuyển báo cáo sang `APPROVED` (tôn trọng `Review_Mode`).

### Requirement 5: Phân quyền truy cập và xuất báo cáo

**User Story:** Là ADMIN, tôi muốn kiểm soát ai xem được báo cáo nào, để dữ liệu nhạy cảm chỉ đến đúng người.

#### Acceptance Criteria

1. WHERE người dùng có vai trò ADMIN, THE `RBAC_Service` SHALL cho phép đọc, chỉnh sửa, chuyển trạng thái mọi `Company_Report`.
2. WHERE người dùng có vai trò SALES, THE `RBAC_Service` SHALL chỉ cho phép đọc các `Company_Report` ở trạng thái `APPROVED`.
3. IF người dùng SALES yêu cầu chỉnh sửa hoặc chuyển trạng thái một `Company_Report`, THEN THE `RBAC_Service` SHALL từ chối với mã trạng thái 403.
4. WHEN ADMIN yêu cầu xuất một `Company_Report` đã `APPROVED`, THE `AutoTGC_System` SHALL trả về biểu diễn báo cáo có thể tải xuống ở định dạng văn bản có cấu trúc.

### Requirement 6: Trợ lý Công việc TGC — hỏi đáp nội bộ có grounding

**User Story:** Là nhân viên (ADMIN hoặc SALES), tôi muốn hỏi trợ lý nội bộ về công việc và nhận câu trả lời dựa trên dữ liệu/tài liệu công ty, để xử lý công việc nhanh hơn.

#### Acceptance Criteria

1. WHEN một nhân viên đã xác thực gửi câu hỏi tới `Work_Assistant`, THE `Work_Assistant` SHALL truy hồi các `KnowledgeEntry` đang hoạt động liên quan nhất từ `Knowledge_Base` để làm dữ liệu nền.
2. WHERE `Gemini_Service` được cấu hình khóa API hợp lệ, THE `Work_Assistant` SHALL dùng dữ liệu nền đã truy hồi để tạo `Assistant_Answer` với `aiGenerated = true`.
3. IF `Gemini_Service` không được cấu hình hoặc trả lỗi, THEN THE `Work_Assistant` SHALL trả về `Assistant_Answer` xác định được tổng hợp từ dữ liệu nền với `aiGenerated = false`, thay vì ném lỗi 502.
4. THE `Work_Assistant` SHALL kèm theo trong `Assistant_Answer` danh sách các nguồn `KnowledgeEntry` đã dùng để grounding.
5. IF câu hỏi rỗng sau khi loại bỏ khoảng trắng, THEN THE `Work_Assistant` SHALL trả về lỗi xác thực với mã trạng thái 400.
6. THE `Work_Assistant` SHALL trả lời bằng tiếng Việt.

### Requirement 7: Trợ lý Công việc TGC — phạm vi dữ liệu theo vai trò

**User Story:** Là người quản trị, tôi muốn trợ lý chỉ tiết lộ dữ liệu nghiệp vụ trong phạm vi quyền của người hỏi, để tránh rò rỉ thông tin giữa các vai trò.

#### Acceptance Criteria

1. WHEN `Work_Assistant` xử lý câu hỏi của người dùng ADMIN, THE `Work_Assistant` SHALL được phép tham chiếu dữ liệu nghiệp vụ thuộc mọi ứng viên và lead.
2. WHERE người hỏi có vai trò SALES, THE `Work_Assistant` SHALL chỉ tham chiếu dữ liệu ứng viên và lead được phân công cho người đó.
3. IF câu hỏi của người dùng SALES yêu cầu dữ liệu của ứng viên hoặc lead không được phân công cho người đó, THEN THE `Work_Assistant` SHALL loại trừ dữ liệu ngoài phạm vi khỏi `Assistant_Answer`.
4. THE `Work_Assistant` SHALL được truy cập sau lớp xác thực và `RBAC_Service` theo đúng cơ chế guard hiện có.
5. THE `Work_Assistant` SHALL không đưa giá trị bí mật (khóa API, thông tin xác thực) vào prompt hoặc `Assistant_Answer`.

### Requirement 8: Quản trị Knowledge Base cho trợ lý

**User Story:** Là ADMIN, tôi muốn quản lý kho tri thức làm nền cho trợ lý, để câu trả lời luôn cập nhật và chính xác.

#### Acceptance Criteria

1. WHEN ADMIN tạo một `KnowledgeEntry` với đầy đủ `category`, `title`, `content`, THE `AutoTGC_System` SHALL lưu mục đó ở trạng thái hoạt động (active).
2. IF yêu cầu tạo `KnowledgeEntry` thiếu `category`, `title`, hoặc `content`, THEN THE `AutoTGC_System` SHALL từ chối với mã trạng thái 400.
3. WHEN ADMIN đánh dấu một `KnowledgeEntry` là không hoạt động, THE `Work_Assistant` SHALL loại trừ mục đó khỏi dữ liệu nền truy hồi.
4. WHERE người dùng có vai trò SALES, THE `RBAC_Service` SHALL từ chối thao tác tạo hoặc cập nhật `KnowledgeEntry` với mã trạng thái 403.

### Requirement 9: Kéo–thả lịch nội dung (Schedule_Board)

**User Story:** Là ADMIN, tôi muốn kéo–thả các mục trong lịch nội dung để sắp xếp lại thứ tự và đổi ngày đăng, để lập kế hoạch trực quan và nhanh hơn.

#### Acceptance Criteria

1. WHEN ADMIN thả một mục trong `Schedule_Board` sang một ngày mới, THE `AutoTGC_System` SHALL cập nhật ngày mục tiêu (`targetDate`) của `ContentPlanItem` tương ứng theo vị trí thả.
2. WHEN ADMIN sắp xếp lại thứ tự các mục trong cùng một nhóm của `Schedule_Board`, THE `AutoTGC_System` SHALL lưu `orderIndex` mới sao cho thứ tự hiển thị khớp với thứ tự sau khi kéo–thả.
3. THE `AutoTGC_System` SHALL bảo toàn tập hợp các `ContentPlanItem` trước và sau một `Reorder_Request` (không thêm, không mất mục) — chỉ thay đổi thứ tự và/hoặc ngày.
4. WHEN một `ScheduledPost` ở trạng thái `SCHEDULED` được kéo sang thời điểm mới, THE `AutoTGC_System` SHALL áp dụng quy tắc đổi lịch hiện có (chỉ cho phép thời điểm trong tương lai so với hiện tại).
5. IF mục được kéo là `ScheduledPost` không ở trạng thái `SCHEDULED`, THEN THE `AutoTGC_System` SHALL từ chối đổi lịch với mã trạng thái 409 và giữ nguyên thời điểm.
6. IF thời điểm mới của một `ScheduledPost` không ở tương lai, THEN THE `AutoTGC_System` SHALL từ chối với mã trạng thái 400 và giữ nguyên thời điểm.
7. WHERE người dùng có vai trò SALES, THE `RBAC_Service` SHALL từ chối thao tác kéo–thả thay đổi lịch nội dung với mã trạng thái 403.

### Requirement 10: Kéo–thả hàng đợi duyệt (Approval_Queue)

**User Story:** Là ADMIN, tôi muốn kéo–thả để sắp thứ tự ưu tiên các bản nháp trong hàng đợi duyệt, để xử lý các mục quan trọng trước.

#### Acceptance Criteria

1. WHEN ADMIN sắp xếp lại các mục trong `Approval_Queue` bằng kéo–thả, THE `AutoTGC_System` SHALL lưu thứ tự ưu tiên mới của các mục.
2. THE `AutoTGC_System` SHALL bảo toàn tập hợp các mục trong `Approval_Queue` trước và sau một `Reorder_Request` (không thêm, không mất mục).
3. WHEN `Approval_Queue` được tải lại sau khi sắp xếp, THE `AutoTGC_System` SHALL hiển thị các mục theo đúng thứ tự ưu tiên đã lưu.
4. THE `Reorder_Request` SHALL là phép toán lũy đẳng: áp dụng lại cùng một `Reorder_Request` trên cùng trạng thái SHALL cho kết quả thứ tự giống lần áp dụng đầu tiên.

### Requirement 11: Mô hình dữ liệu checklist giấy tờ ứng viên

**User Story:** Là chuyên viên tuyển dụng, tôi muốn mỗi ứng viên có một checklist giấy tờ/chứng chỉ, để theo dõi hồ sơ còn thiếu gì.

#### Acceptance Criteria

1. THE `AutoTGC_System` SHALL liên kết mỗi `Document_Checklist_Item` với đúng một `Candidate_Profile`.
2. THE `Document_Checklist_Item` SHALL gồm các thuộc tính: loại giấy tờ, nhãn hiển thị, trạng thái nộp, cờ bắt buộc, và nguồn (mặc-định-theo-thị-trường hoặc tùy-biến).
3. WHEN trạng thái nộp của một `Document_Checklist_Item` được cập nhật, THE `AutoTGC_System` SHALL chỉ chấp nhận một trong các giá trị: `PENDING`, `SUBMITTED`, `VERIFIED`, `REJECTED`.
4. WHEN một `Candidate_Profile` bị xóa, THE `AutoTGC_System` SHALL xóa các `Document_Checklist_Item` liên kết với ứng viên đó.

### Requirement 12: Bộ giấy tờ mặc định theo thị trường (có thể cấu hình)

**User Story:** Là ADMIN, tôi muốn mỗi thị trường/quốc gia có bộ giấy tờ mặc định, để checklist tự khởi tạo đúng yêu cầu từng nước.

#### Acceptance Criteria

1. THE `Document_Type_Catalog` SHALL định nghĩa một bộ loại giấy tờ mặc định cho mỗi `Market` được hỗ trợ.
2. WHEN một `Document_Checklist` được khởi tạo cho một `Candidate_Profile` có `desiredMarket` xác định, THE `AutoTGC_System` SHALL tạo các `Document_Checklist_Item` tương ứng với bộ giấy tờ mặc định của thị trường đó.
3. WHERE `Candidate_Profile` không có `desiredMarket`, THE `AutoTGC_System` SHALL khởi tạo `Document_Checklist` theo bộ giấy tờ mặc định của thị trường `OTHER`.
4. THE `AutoTGC_System` SHALL cho phép ADMIN cấu hình (đọc và cập nhật) bộ giấy tờ mặc định của từng `Market`.
5. WHEN `Document_Type_Catalog` của một thị trường được cập nhật, THE `AutoTGC_System` SHALL không thay đổi các `Document_Checklist_Item` đã tồn tại của các ứng viên hiện có.

### Requirement 13: Loại giấy tờ tùy biến và cập nhật checklist

**User Story:** Là chuyên viên tuyển dụng, tôi muốn thêm loại giấy tờ tùy biến cho từng ứng viên, để xử lý các trường hợp đặc thù ngoài bộ mặc định.

#### Acceptance Criteria

1. WHEN người dùng được phân công thêm một `Document_Checklist_Item` tùy biến cho một `Candidate_Profile`, THE `AutoTGC_System` SHALL tạo mục với nguồn `CUSTOM`.
2. IF nhãn hiển thị của một `Document_Checklist_Item` tùy biến rỗng sau khi loại bỏ khoảng trắng, THEN THE `AutoTGC_System` SHALL từ chối với mã trạng thái 400.
3. WHEN người dùng được phân công đánh dấu một `Document_Checklist_Item` là đã nộp, THE `AutoTGC_System` SHALL ghi nhận trạng thái `SUBMITTED` và thời điểm cập nhật.
4. THE `AutoTGC_System` SHALL tính chỉ số hoàn thành hồ sơ bằng tỷ lệ số `Document_Checklist_Item` bắt buộc đã ở trạng thái `VERIFIED` trên tổng số mục bắt buộc.
5. IF tổng số mục bắt buộc bằng 0, THEN THE `AutoTGC_System` SHALL trả về chỉ số hoàn thành là `INSUFFICIENT_DATA` thay vì thực hiện phép chia.
6. WHERE người dùng có vai trò SALES, THE `RBAC_Service` SHALL chỉ cho phép xem và cập nhật `Document_Checklist` của các ứng viên được phân công cho người đó, và từ chối với mã 403 cho ứng viên không được phân công.

### Requirement 14: Kiểm thử (Vitest + fast-check)

**User Story:** Là kỹ sư, tôi muốn các phần logic thuần được kiểm thử property-based, để bảo đảm tính đúng đắn trước khi triển khai.

#### Acceptance Criteria

1. THE `AutoTGC_System` SHALL có property test bằng fast-check cho logic thuần của `Report_Engine` (lọc theo kỳ, loại trừ `INSUFFICIENT_DATA`, an toàn chia 0, tính xác định).
2. THE `AutoTGC_System` SHALL có property test cho `Report_State_Machine` xác nhận chỉ các bước hợp lệ được chấp nhận và mọi bước khác trả 409.
3. THE `AutoTGC_System` SHALL có property test cho logic xếp hạng/grounding của `Work_Assistant` (xác định, ổn định thứ tự, loại trừ mục không hoạt động).
4. THE `AutoTGC_System` SHALL có property test cho `Reorder_Request` xác nhận bảo toàn tập hợp mục và tính lũy đẳng của việc sắp thứ tự.
5. THE `AutoTGC_System` SHALL có property test cho chỉ số hoàn thành `Document_Checklist` xác nhận an toàn chia 0 và biên giá trị `[0, 1]`.
6. WHEN bộ kiểm thử chạy, THE `AutoTGC_System` SHALL thực thi mỗi property test với tối thiểu 100 trường hợp sinh ngẫu nhiên.

### Requirement 15: Triển khai lên máy chủ

**User Story:** Là kỹ sư vận hành, tôi muốn gói nâng cấp được triển khai an toàn theo quy trình hiện có, để đưa tính năng lên môi trường máy chủ.

#### Acceptance Criteria

1. WHEN có thay đổi mô hình dữ liệu, THE `AutoTGC_System` SHALL kèm theo migration Prisma cho các bảng/cột mới.
2. THE `AutoTGC_System` SHALL biên dịch thành công (`npm run build`) trước khi triển khai.
3. WHEN triển khai, THE `AutoTGC_System` SHALL chạy dưới tiến trình PM2 với người dùng không phải root và sau reverse proxy Nginx theo cấu hình trong thư mục `deploy/`.
4. IF một biến môi trường bí mật bắt buộc bị thiếu khi khởi động, THEN THE `AutoTGC_System` SHALL dừng khởi động (fail fast) và chỉ ghi log tên biến bí mật, không ghi giá trị.
5. THE `AutoTGC_System` SHALL giữ các endpoint mới sau lớp xác thực và `RBAC_Service`, không tạo endpoint không xác thực.

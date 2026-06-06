# Requirements Document

## Introduction

Tài liệu này đặc tả yêu cầu cho gói tính năng **study-abroad-ai-advisor-suite** trên nền tảng AutoTGC (khách hàng: Thanh Giang Conincon — lĩnh vực du học / xuất khẩu lao động, XKLĐ). Gói tính năng bổ sung năm nhóm năng lực tư vấn du học bằng AI, xây dựng **bổ sung (additive)** trên kiến trúc hiện có và tái sử dụng tối đa các khối đã có, không nhân bản logic: Fastify 4 + Prisma 5/PostgreSQL 16, Redis (ioredis/BullMQ), JWT (jose) + RBAC thuần (`auth/rbac.ts`), Google Gemini (ngoại vi, tùy chọn), Vitest + fast-check, triển khai bằng PM2 + Nginx theo thư mục `deploy/`.

Bối cảnh quan trọng đã khảo sát từ codebase:

- **Đối chiếu điều kiện chương trình** đã có module `destinationMatcher` (thuần, xác định) chấm điểm 0..100 độ phù hợp hồ sơ ứng viên với `DestinationProgram` (tuổi/giới tính/ngôn ngữ/ngân sách/ngành), trả về `eligible` + `blockers`. Đây là độ phù hợp điều kiện đầu vào (eligibility), CHƯA phải xác suất trúng tuyển (admission likelihood) theo ngưỡng học thuật.
- **Chấm điểm tài chính/học bổng** đã có `scholarshipMatcher` (thuần) tính tổng chi phí, % học bổng ước tính (theo GPA/IELTS so với ngưỡng chương trình), chi phí ròng và khả năng chi trả. `DestinationProgram` đã có các cột tài chính/học thuật: `tuitionPerYearVndM`, `livingCostPerYearVndM`, `scholarshipMaxPct`, `minGpa`, `minIelts`. `StudentFinance` mô hình hóa `gpa` (thang 10) và `ielts`.
- **Hồ sơ ứng viên** `CandidateProfile` hiện CHƯA có cột `gpa` hay điểm test ngôn ngữ chuẩn hóa; chỉ có `japaneseLevel` (NONE|N5..N1), `otherLanguage` (free text), `education` (free text), `dob`. Đây là khoảng trống dữ liệu học thuật cần bổ sung cho việc chấm xác suất trúng tuyển.
- **Tư vấn AI có grounding** đã có `RecruitmentConsultantAgent` + `KnowledgeService` (truy hồi `KnowledgeEntry` đang hoạt động → ghép prompt xác định → gọi Gemini khi có khóa; khi không có khóa hoặc lỗi thì trả lời nền xác định, `aiGenerated:false`, KHÔNG ném 502). `WorkAssistant` là facade hỏi–đáp nội bộ + `scopeBusinessData` (assigned-only cho SALES).
- **Tư vấn visa** đã có `VisaAdvisor` + `visaCatalog` (bộ checklist theo quốc gia: USA/UK/CANADA/AUSTRALIA/JAPAN..., mỗi task có `leadDays`) + `withDeadlines` (suy ra hạn từ ngày nhập học, không bao giờ sinh hạn sau ngày nhập học) + `VisaCase`/`VisaTask`/`LogisticsPlan`. Đây là nguồn tri thức quốc gia/loại visa để tái sử dụng cho mô phỏng phỏng vấn và theo dõi mốc thời gian.
- **Nuôi dưỡng chủ động** đã có `FollowUpEngine` (thuần) + `FollowUpTask` (hàng đợi nhắc, idempotent qua trạng thái) và hạ tầng oversight/notification realtime (`Notification` + `ActivityLog` + topic `notification`) — tái sử dụng cho Timeline Agent.
- **Checklist giấy tờ** đã có `DocumentChecklistService` + `DocumentChecklistItem` + `completionMetric` (an toàn chia 0, trả `INSUFFICIENT_DATA` khi không có mục bắt buộc) — tái sử dụng cho điểm sẵn sàng hồ sơ.
- **Báo cáo theo REVIEW MODE** đã có mẫu `CompanyReport` + `Report_State_Machine` (DRAFT → IN_REVIEW → APPROVED, → ARCHIVED; 409 khi chuyển sai) — tái dùng làm khuôn cho vòng đời bản nháp SOP/CV và bản tường thuật lộ trình.

Năm nhóm năng lực trong tài liệu này:

1. **Chấm xác suất trúng tuyển + phân loại Reach/Match/Safety** — module thuần ước lượng khả năng trúng tuyển (0..1) của một hồ sơ với một chương trình theo tín hiệu học thuật (GPA thang cấu hình, IELTS/TOEFL/JLPT, trình độ học vấn, mức độ phù hợp tài chính tái dùng `scholarshipMatcher`) so với ngưỡng chương trình; phân band REACH/MATCH/SAFETY; an toàn thiếu dữ liệu (`INSUFFICIENT_DATA`); gợi ý lấp khoảng cách (gap) có căn cứ.
2. **Trợ lý viết & chấm SOP/Essay/Thư động lực/CV** — sinh bản nháp grounding theo hồ sơ + chương trình (Gemini-optional, fallback có cấu trúc xác định); chấm bài hiện có theo rubric thuần (giới hạn [0,1], an toàn chia 0); vòng đời bản nháp REVIEW MODE (DRAFT → IN_REVIEW → APPROVED, → ARCHIVED).
3. **Luyện phỏng vấn visa (mô phỏng tương tác)** — agent grounding sinh bộ câu hỏi theo quốc gia/loại visa (tái dùng tri thức quốc gia của `visaCatalog`), nhận câu trả lời và phản hồi có căn cứ; lưu phiên luyện tập; lõi chấm điểm thuần + property-test; không bịa chính sách lãnh sự.
4. **Agent dòng thời gian hồ sơ chủ động** — theo dõi nhiều hồ sơ ứng tuyển song song mỗi ứng viên, tính mốc/việc sắp tới (tái dùng `withDeadlines` + `VisaTask`), nhắc chủ động (tái dùng oversight/notification realtime); lõi tính ưu tiên/mốc thuần + xác định; nhắc lũy đẳng (không trùng nhắc cho cùng một việc đến hạn).
5. **Lộ trình Du học → Nghề nghiệp → Định cư (ROI) + điểm Sẵn sàng hồ sơ** — bộ ước lượng lộ trình/ROI thuần (chi phí du học tái dùng chi phí ròng `scholarshipMatcher`, định hướng việc làm sau tốt nghiệp, ghi chú lộ trình định cư grounding theo kho tri thức — KHÔNG cam kết định cư bịa đặt) và điểm Sẵn sàng hồ sơ (0..1, an toàn chia 0) tổng hợp mức độ sẵn sàng nộp hồ sơ với gợi ý gap có căn cứ; REVIEW MODE cho bản tường thuật AI.

Mọi năng lực có sinh nội dung AI đều theo mẫu **Gemini-OPTIONAL**: khi không có khóa Gemini hoặc Gemini lỗi thì trả về kết quả nền xác định (deterministic grounded fallback) với `aiGenerated:false` và KHÔNG ném 502; luôn gắn cờ `aiGenerated`; không bao giờ nhúng giá trị bí mật vào prompt/câu trả lời. Mọi đầu ra AI cần con người duyệt trước khi coi là chính thức/gửi đi đều đi qua **REVIEW MODE**. Mọi route gắn ứng viên đều áp **assigned-only** cho SALES qua `RBAC_Service` với `ownerUserId` phân giải từ `candidate.assignedTo`.

Ngoài ra, tài liệu nắm bắt yêu cầu **kiểm thử** (property-based với fast-check, ≥100 trường hợp cho mọi logic thuần), **tính trung thực của AI** (Gemini-optional), và **migration & triển khai** như tiêu chí chấp nhận ở phần cross-cutting.

### Câu hỏi mở & giả định (cần chốt trong giai đoạn phân tích/thiết kế)

Một số quyết định mô hình dữ liệu thực sự còn mơ hồ; ghi lại ở đây để giải quyết trong giai đoạn thiết kế. Các giả định mặc định (Default) được dùng nếu không có chỉ đạo khác.

- **OQ-1 (Tín hiệu học thuật — nơi lưu):** `CandidateProfile` chưa có `gpa`/điểm test chuẩn hóa. Lưu trực tiếp dưới dạng các cột bổ sung trên `CandidateProfile`, hay tách thành mô hình `AcademicProfile` 1–1? *Default (ĐÃ CHỐT):* tạo mô hình `AcademicProfile` (1–1 với `CandidateProfile`) chứa `gpa`, `gpaScale`, `ielts`, `toefl`, `jlpt`, `educationLevel` để giữ `CandidateProfile` ổn định và mở rộng được. Đây là migration bổ sung, không phá vỡ bảng hiện có.
- **OQ-2 (Ngưỡng học thuật của chương trình):** `DestinationProgram` đã có `minGpa`, `minIelts`. Có cần thêm `minToefl`, `minJlpt`, `selectivity` (độ chọn lọc 0..1 để phân band) không? *Default:* thêm các cột tùy chọn (nullable) `minToefl`, `minJlpt`, `selectivityTier` (ví dụ HIGH|MEDIUM|LOW) trên `DestinationProgram` qua migration bổ sung; khi thiếu thì coi như không ràng buộc chiều đó.
- **OQ-3 (Thang GPA cấu hình):** Hồ sơ Việt Nam dùng thang 10; nhiều chương trình dùng thang 4.0. *Default (ĐÃ CHỐT):* lưu `gpa` kèm `gpaScale` và chuẩn hóa về [0,1] trong lõi chấm điểm bằng công thức tuyến tính `gpa / gpaScale`, chỉ thực hiện khi `gpaScale > 0` (điều kiện tiên quyết); khi `gpaScale` không hợp lệ thì coi chiều GPA là thiếu dữ liệu, không bịa quy đổi.
- **OQ-4 (ApplicationCase vs VisaCase):** Nhóm 4 cần theo dõi nhiều hồ sơ ứng tuyển song song. `VisaCase` hiện gắn 1 quốc gia + checklist visa. Một "đơn ứng tuyển chương trình" (program application) có vòng đời rộng hơn (nộp hồ sơ trường → nhận offer → visa → nhập học). *Default:* tạo mô hình `ApplicationCase` mới (gắn `candidateId` + `programId` + `intakeLabel`) để biểu diễn một đơn ứng tuyển; `VisaCase` tiếp tục biểu diễn phần visa và có thể tham chiếu mềm tới `ApplicationCase`. Đây là OPEN QUESTION quan trọng cần xác nhận.
- **OQ-5 (Nhắc qua kênh nào):** Timeline Agent nên nhắc qua `Notification` nội bộ (cho nhân viên phụ trách) hay cả qua kênh ứng viên (`FollowUpTask`)? *Default:* phạm vi gói này nhắc nội bộ cho nhân viên phụ trách qua hạ tầng `Notification`/realtime; nhắc ứng viên qua `FollowUpTask` để mở rộng sau.
- **OQ-6 (Lưu nội dung SOP/CV):** Một mô hình chung `EssayDraft` cho mọi loại văn bản (SOP|MOTIVATION|CV) hay tách mô hình? *Default:* một mô hình `EssayDraft` với trường `docType` để tránh trùng lặp vòng đời/REVIEW MODE.
- **OQ-7 (Quy đổi điểm xác suất):** Đầu ra dùng 0..1 hay 0..100? *Default (ĐÃ CHỐT):* lõi thuần trả 0..1; lớp trình bày có thể nhân 100 để hiển thị. Mọi property test kiểm tra trên thang [0,1].

## Glossary

- **AutoTGC_System**: Toàn bộ nền tảng AutoTGC (backend Fastify + frontend React).
- **ADMIN**: Vai trò quản trị; toàn quyền đọc/ghi trên mọi module.
- **SALES**: Vai trò nhân viên kinh doanh/tư vấn; chỉ truy cập ứng viên và lead được phân công cho mình (assigned-only), dashboard chỉ-đọc, không xóa.
- **RBAC_Service**: Thành phần đánh giá chính sách phân quyền thuần (`src/auth/rbac.ts`), hàm `authorize(ctx, target)`; nguồn chân lý duy nhất cho mọi quyết định phân quyền.
- **Rbac_Guard**: PreHandler HTTP (`rbacGuard`) dựng `Resource_Target` cho từng route rồi gọi `RBAC_Service`; phân giải `ownerUserId` từ `assignedTo` của tài nguyên.
- **Auth_Middleware**: PreHandler `requireAuth` xác thực Bearer access token và xác nhận `JwtSession` còn `ACTIVE`.
- **Assigned_Only**: Quy tắc giới hạn SALES chỉ thao tác trên tài nguyên có `assignedTo` bằng chính `userId` của người đó.
- **Gemini_Service**: Dịch vụ Google Gemini ngoại vi, cấu hình tùy chọn qua khóa API.
- **AI_Generated_Flag**: Cờ `aiGenerated` đính kèm mọi đầu ra có khả năng do AI sinh; `true` khi văn bản do `Gemini_Service` tạo, `false` khi là kết quả nền xác định.
- **Review_Mode**: Chế độ yêu cầu con người phê duyệt trước khi một đầu ra AI được coi là chính thức hoặc được gửi đi.
- **HTTP_Status**: Tập mã trạng thái HTTP được phép của dự án: {200, 201, 202, 400, 401, 403, 404, 409, 423, 500, 502}.
- **Candidate_Profile**: Hồ sơ ứng viên du học/XKLĐ (`CandidateProfile`) hiện có.
- **Academic_Profile**: Tập tín hiệu học thuật chuẩn hóa của một ứng viên (GPA + thang điểm, IELTS/TOEFL/JLPT, trình độ học vấn); mô hình bổ sung 1–1 với `Candidate_Profile` (xem OQ-1).
- **Destination_Program**: Chương trình du học/đích đến (`DestinationProgram`) gồm điều kiện đầu vào và các cột tài chính/học thuật (`minGpa`, `minIelts`, học phí, sinh hoạt phí, % học bổng).
- **Destination_Matcher**: Module thuần đối chiếu điều kiện đầu vào hồ sơ với `Destination_Program` (eligibility), trả về điểm phù hợp + `blockers`.
- **Scholarship_Matcher**: Module thuần tính chi phí, % học bổng ước tính, chi phí ròng và khả năng chi trả (`scholarshipMatcher`).
- **Admission_Scorer**: Module THUẦN ước lượng xác suất trúng tuyển (0..1) của một `Academic_Profile` với một `Destination_Program` dựa trên tín hiệu học thuật + mức phù hợp tài chính + ngưỡng chương trình.
- **Admission_Band**: Phân loại một chương trình thành REACH | MATCH | SAFETY dựa trên điểm xác suất trúng tuyển và độ chọn lọc chương trình.
- **Gap_Suggestion**: Gợi ý xác định, có căn cứ về điều ứng viên cần cải thiện (ví dụ nâng IELTS lên mức ngưỡng, khoảng cách GPA) để đưa một chương trình REACH tiến gần MATCH; chỉ dùng số liệu từ ngưỡng chương trình, không bịa số mới.
- **Essay_Writer**: Thành phần sinh bản nháp SOP/Thư động lực/CV grounding theo `Candidate_Profile` + `Destination_Program` (Gemini-optional).
- **Essay_Reviewer**: Lõi THUẦN chấm một bài viết theo rubric xác định (cấu trúc, độ liên quan với chương trình, giới hạn độ dài, sự hiện diện của các phần bắt buộc), trả điểm [0,1] + danh sách phản hồi hành động.
- **Essay_Draft**: Bản ghi bản nháp văn bản (`EssayDraft`) gồm `docType` (SOP | MOTIVATION | CV), nội dung, `aiGenerated`, và trạng thái vòng đời.
- **Essay_State_Machine**: Hàm chuyển trạng thái có kiểm soát cho `Essay_Draft` (DRAFT → IN_REVIEW → APPROVED; DRAFT/IN_REVIEW → ARCHIVED).
- **Interview_Agent**: Agent grounding sinh bộ câu hỏi phỏng vấn visa theo quốc gia/loại visa và phản hồi câu trả lời ứng viên (Gemini-optional).
- **Interview_Question_Bank**: Ngân hàng câu hỏi xác định theo quốc gia/loại visa dùng làm fallback và nền grounding cho `Interview_Agent`.
- **Interview_Session**: Phiên luyện phỏng vấn được lưu (`InterviewSession`) gồm câu hỏi, câu trả lời, phản hồi, và điểm.
- **Interview_Scorer**: Lõi THUẦN chấm câu trả lời phỏng vấn theo rubric xác định, trả điểm [0,1].
- **Visa_Catalog**: Bộ checklist visa theo quốc gia + bộ tính hạn (`visaCatalog`, `withDeadlines`); nguồn tri thức quốc gia/loại visa.
- **Visa_Case**: Hồ sơ visa của một ứng viên cho một quốc gia (`VisaCase`) với checklist `VisaTask`.
- **Application_Case**: Một đơn ứng tuyển chương trình của ứng viên (gắn `candidateId` + `programId` + đợt nhập học), biểu diễn vòng đời ứng tuyển rộng hơn visa (xem OQ-4).
- **Timeline_Agent**: Thành phần tính mốc/việc sắp tới trên TẤT CẢ `Application_Case`/`Visa_Case` của một ứng viên và nhắc chủ động.
- **Timeline_Computer**: Lõi THUẦN tính danh sách việc đến hạn + mức ưu tiên, xác định và bảo toàn tập việc.
- **Due_Item**: Một việc có hạn (`Visa_Task`/mốc ứng tuyển) thuộc một `Application_Case`/`Visa_Case`, dùng để tính nhắc.
- **Reminder**: Nhắc chủ động cho một `Due_Item` sắp đến hạn; lũy đẳng theo `Due_Item` (không nhắc trùng cho cùng một việc đến hạn).
- **Roadmap_Estimator**: Lõi THUẦN ước lượng lộ trình Du học → Nghề nghiệp → Định cư và ROI (chi phí ròng tái dùng `Scholarship_Matcher`), grounding theo kho tri thức, KHÔNG cam kết định cư bịa đặt.
- **Roadmap_Narrative**: Bản tường thuật lộ trình bằng ngôn ngữ tự nhiên (Gemini-optional) đi qua `Review_Mode`.
- **Readiness_Scorer**: Lõi THUẦN tính điểm Sẵn sàng hồ sơ (0..1, an toàn chia 0) từ % giấy tờ hoàn tất, sự hiện diện tín hiệu học thuật, và trình độ ngôn ngữ so với mục tiêu.
- **Knowledge_Base**: Tập `KnowledgeEntry` đang hoạt động dùng để grounding cho mọi agent.
- **Notification_Service**: Thành phần tạo/truy vấn `Notification` và phát sự kiện realtime trên topic `notification` (tái dùng).
- **INSUFFICIENT_DATA**: Giá trị nhãn thay cho một chỉ số khi dữ liệu bắt buộc thiếu hoặc mẫu số bằng 0, thay vì thực hiện phép chia hoặc trả điểm gây hiểu nhầm.

## Requirements

---

## Nhóm 1 — Chấm xác suất trúng tuyển + phân loại Reach/Match/Safety

### Requirement 1: Tín hiệu học thuật chuẩn hóa của ứng viên

**User Story:** Là chuyên viên tư vấn, tôi muốn lưu các tín hiệu học thuật chuẩn hóa của ứng viên (GPA theo thang, IELTS/TOEFL/JLPT, trình độ học vấn), để hệ thống có cơ sở chấm xác suất trúng tuyển.

#### Acceptance Criteria

1. THE `AutoTGC_System` SHALL định nghĩa một `Academic_Profile` liên kết 1–1 với một `Candidate_Profile`, gồm các thuộc tính tùy chọn: `gpa`, `gpaScale`, `ielts`, `toefl`, `jlpt`, và `educationLevel`.
2. THE `Academic_Profile` SHALL là thay đổi bổ sung (additive) không sửa đổi destructive cấu trúc của `Candidate_Profile` hiện có.
3. WHEN một `gpa` được lưu vào `Academic_Profile`, THE `AutoTGC_System` SHALL lưu kèm `gpaScale` tương ứng (ví dụ 10 hoặc 4.0).
4. IF `gpa` được cung cấp nằm ngoài khoảng `[0, gpaScale]`, THEN THE `AutoTGC_System` SHALL từ chối với mã trạng thái 400.
5. IF `ielts` được cung cấp nằm ngoài khoảng `[0, 9]`, THEN THE `AutoTGC_System` SHALL từ chối với mã trạng thái 400.
6. WHERE người gọi có vai trò SALES, THE `RBAC_Service` SHALL chỉ cho phép đọc và cập nhật `Academic_Profile` của các ứng viên được phân công cho người đó, và từ chối với mã 403 cho ứng viên không được phân công.

### Requirement 2: Chấm xác suất trúng tuyển (Admission_Scorer)

**User Story:** Là chuyên viên tư vấn, tôi muốn một điểm xác suất trúng tuyển của một ứng viên với một chương trình, để tư vấn chọn trường có cơ sở.

#### Acceptance Criteria

1. WHEN `Admission_Scorer` chấm một cặp (`Academic_Profile`, `Destination_Program`), THE `Admission_Scorer` SHALL trả về một điểm xác suất trúng tuyển thuộc khoảng đóng `[0, 1]`.
2. THE `Admission_Scorer` SHALL là hàm thuần (pure) và xác định: cùng một đầu vào SHALL luôn cho cùng một điểm.
3. WHEN `Admission_Scorer` tính điểm, THE `Admission_Scorer` SHALL tổng hợp các tín hiệu học thuật (GPA chuẩn hóa về `[0,1]` theo `gpaScale`, điểm ngôn ngữ IELTS/TOEFL/JLPT, trình độ học vấn) và mức độ phù hợp tài chính lấy từ `Scholarship_Matcher`.
4. WHEN cần chuẩn hóa GPA, THE `Admission_Scorer` SHALL chỉ thực hiện chuẩn hóa `gpa / gpaScale` khi `gpaScale` lớn hơn 0 (điều kiện tiên quyết); nếu không, SHALL coi chiều GPA là thiếu dữ liệu thay vì thực hiện phép chia.
5. IF mọi tín hiệu học thuật bắt buộc để chấm một chiều ngưỡng của chương trình đều thiếu, THEN THE `Admission_Scorer` SHALL trả về `INSUFFICIENT_DATA` cho cặp đó thay vì một điểm gây hiểu nhầm.
6. IF `gpaScale` bằng 0 hoặc không xác định khi cần chuẩn hóa GPA, THEN THE `Admission_Scorer` SHALL coi chiều GPA là thiếu dữ liệu thay vì thực hiện phép chia.
7. WHERE một chương trình đặt một ngưỡng (ví dụ `minIelts`) mà ứng viên đáp ứng, THE `Admission_Scorer` SHALL cho chiều đó đóng góp điểm không âm tỉ lệ với mức vượt ngưỡng.
8. WHERE một chương trình đặt một ngưỡng mà ứng viên không đạt, THE `Admission_Scorer` SHALL cho chiều đó đóng góp 0 và không nâng điểm vì các chiều khác vượt ngưỡng.

### Requirement 3: Phân loại Reach/Match/Safety (Admission_Band)

**User Story:** Là chuyên viên tư vấn, tôi muốn mỗi chương trình được phân loại REACH/MATCH/SAFETY và sắp xếp ổn định, để trình bày danh mục trường cân đối cho ứng viên.

#### Acceptance Criteria

1. WHEN `Admission_Scorer` trả về điểm cho một chương trình, THE `Admission_Band` SHALL phân loại chương trình đó thành đúng một trong ba band: `REACH`, `MATCH`, hoặc `SAFETY`.
2. THE `Admission_Band` SHALL phân loại xác định: cùng một điểm và cùng độ chọn lọc chương trình SHALL luôn cho cùng một band.
3. WHEN nhiều chương trình có cùng điểm và cùng band, THE `AutoTGC_System` SHALL sắp xếp chúng theo tiêu chí phá hòa (tie-break) xác định và ổn định (theo tên rồi theo định danh).
4. WHERE điểm xác suất của một cặp là `INSUFFICIENT_DATA`, THE `Admission_Band` SHALL không gán band REACH/MATCH/SAFETY mà đánh dấu chương trình đó là `INSUFFICIENT_DATA`.
5. THE `Admission_Band` SHALL gán band sao cho điểm cao hơn không bao giờ cho band kém thuận lợi hơn so với điểm thấp hơn ở cùng độ chọn lọc (tính đơn điệu theo điểm).
6. WHEN `Admission_Band` phân band, THE `Admission_Band` SHALL tính đến độ chọn lọc (selectivity) của chương trình; hai chương trình có cùng điểm nhưng độ chọn lọc khác nhau CÓ THỂ được gán band khác nhau một cách xác định (phân band nhận biết độ chọn lọc).
7. IF `Admission_Scorer` tạo ra một điểm số nhưng gắn cờ điểm đó là không đáng tin do vấn đề chất lượng dữ liệu, THEN THE `Admission_Band` SHALL đánh dấu chương trình đó là `INSUFFICIENT_DATA` thay vì gán band REACH/MATCH/SAFETY.

### Requirement 4: Gợi ý lấp khoảng cách (Gap_Suggestion)

**User Story:** Là ứng viên, tôi muốn biết cần cải thiện gì để một trường REACH trở nên khả thi hơn, để có kế hoạch chuẩn bị rõ ràng.

#### Acceptance Criteria

1. WHEN một chương trình được phân loại `REACH` do ứng viên dưới một hoặc nhiều ngưỡng, THE `Gap_Suggestion` SHALL liệt kê xác định các chiều chưa đạt kèm ngưỡng mục tiêu lấy từ chương trình.
2. THE `Gap_Suggestion` SHALL chỉ dùng các số liệu ngưỡng do `Destination_Program` công bố và SHALL không bịa thêm số liệu nằm ngoài các ngưỡng đó.
3. WHERE ứng viên đã đáp ứng mọi ngưỡng của một chương trình, THE `Gap_Suggestion` SHALL trả về danh sách gợi ý rỗng cho chương trình đó.
4. IF không có ngưỡng nào của chương trình được công bố để so sánh, THEN THE `Gap_Suggestion` SHALL trả về `INSUFFICIENT_DATA` thay vì gợi ý suy đoán.
5. THE `Gap_Suggestion` SHALL là hàm thuần và xác định: cùng một đầu vào SHALL cho cùng một danh sách gợi ý theo cùng thứ tự.
6. IF dữ liệu ngưỡng tồn tại nhưng không thể so sánh một cách có ý nghĩa (sai định dạng, lỗi thời, hoặc không đầy đủ), THEN THE `Gap_Suggestion` SHALL trả về `INSUFFICIENT_DATA`.
7. IF dữ liệu để xác minh ngưỡng không sẵn có, THEN THE `Gap_Suggestion` SHALL trả về `INSUFFICIENT_DATA` ngay cả khi ứng viên có vẻ đã đáp ứng mọi điều kiện, để phân biệt "danh sách rỗng đã xác minh" với "không thể xác minh".

### Requirement 5: API chấm trúng tuyển và phân quyền

**User Story:** Là chuyên viên tư vấn, tôi muốn gọi API chấm trúng tuyển cho một ứng viên qua danh mục chương trình, để nhận danh sách Reach/Match/Safety kèm gợi ý.

#### Acceptance Criteria

1. WHEN một người dùng đã xác thực yêu cầu chấm trúng tuyển cho một ứng viên, THE `AutoTGC_System` SHALL trả về danh sách chương trình kèm điểm, `Admission_Band`, và `Gap_Suggestion` cho từng chương trình.
2. THE `AutoTGC_System` SHALL giữ endpoint chấm trúng tuyển sau `Auth_Middleware` và `RBAC_Service`, không tạo endpoint không xác thực.
3. WHERE người gọi có vai trò SALES, THE `RBAC_Service` SHALL chỉ cho phép chấm trúng tuyển cho các ứng viên được phân công cho người đó, với `ownerUserId` phân giải từ `candidate.assignedTo`.
4. IF người gọi có vai trò SALES yêu cầu chấm trúng tuyển cho một ứng viên không được phân công, THEN THE `RBAC_Service` SHALL từ chối với mã trạng thái 403.
5. IF ứng viên được yêu cầu không tồn tại, THEN THE `AutoTGC_System` SHALL trả về mã trạng thái 404.
6. WHERE người gọi có vai trò ADMIN, THE `RBAC_Service` SHALL cho phép chấm trúng tuyển cho BẤT KỲ ứng viên nào bất kể phân công.

---

## Nhóm 2 — Trợ lý viết & chấm SOP / Essay / Thư động lực / CV

### Requirement 6: Sinh bản nháp SOP/Thư động lực/CV (Essay_Writer)

**User Story:** Là ứng viên, tôi muốn nhận bản nháp SOP/thư động lực/CV bám theo hồ sơ và chương trình mục tiêu, để có điểm khởi đầu cho bài viết của mình.

#### Acceptance Criteria

1. WHEN một người dùng đã xác thực yêu cầu sinh một `Essay_Draft` với `docType` thuộc {SOP, MOTIVATION, CV}, THE `Essay_Writer` SHALL sinh một bản nháp grounding theo `Candidate_Profile` và `Destination_Program` mục tiêu.
2. WHERE `Gemini_Service` được cấu hình khóa API hợp lệ, THE `Essay_Writer` SHALL dùng `Gemini_Service` để soạn bản nháp và đặt `aiGenerated = true`.
3. IF `Gemini_Service` không được cấu hình hoặc trả lỗi, THEN THE `Essay_Writer` SHALL sinh một bản nháp có cấu trúc xác định từ dữ liệu hồ sơ + chương trình với `aiGenerated = false`, thay vì ném lỗi 502.
4. THE `Essay_Writer` SHALL không nhúng bất kỳ giá trị bí mật nào (khóa API, thông tin xác thực) vào prompt hoặc bản nháp.
5. WHEN một `Essay_Draft` được sinh, THE `AutoTGC_System` SHALL lưu bản nháp ở trạng thái khởi tạo `DRAFT`.
6. IF `docType` được yêu cầu không thuộc {SOP, MOTIVATION, CV}, THEN THE `AutoTGC_System` SHALL từ chối với mã trạng thái 400.
7. WHEN một người dùng đã xác thực yêu cầu sinh một `Essay_Draft`, THE `Essay_Writer` SHALL cho phép người dùng chọn rõ ràng giữa chế độ sinh bằng AI và chế độ sinh có cấu trúc xác định bất kể tình trạng sẵn sàng của `Gemini_Service`, bổ sung cho hành vi fallback Gemini-optional.

### Requirement 7: Chấm bài theo rubric (Essay_Reviewer)

**User Story:** Là chuyên viên tư vấn, tôi muốn chấm một bài viết của ứng viên theo rubric, để đưa phản hồi cải thiện cụ thể.

#### Acceptance Criteria

1. WHEN `Essay_Reviewer` chấm một bài viết, THE `Essay_Reviewer` SHALL trả về một điểm tổng thuộc khoảng đóng `[0, 1]` và một danh sách phản hồi hành động.
2. THE `Essay_Reviewer` SHALL là hàm thuần và xác định: cùng một bài viết và cùng tiêu chí rubric SHALL cho cùng một điểm và cùng danh sách phản hồi.
3. THE `Essay_Reviewer` SHALL chấm theo các tiêu chí rubric xác định gồm tối thiểu: cấu trúc, độ liên quan tới chương trình, tuân thủ giới hạn độ dài, và sự hiện diện của các phần bắt buộc.
4. IF tổng trọng số các tiêu chí rubric bằng 0, THEN THE `Essay_Reviewer` SHALL trả về điểm mặc định `0.0` (giới hạn trong `[0, 1]`) và tiếp tục chấm thay vì thực hiện phép chia hoặc hard-fail.
5. IF nội dung bài viết rỗng sau khi loại bỏ khoảng trắng, THEN THE `AutoTGC_System` SHALL từ chối yêu cầu chấm bài với mã trạng thái 400.
6. THE `Essay_Reviewer` SHALL không bao giờ trả về điểm nằm ngoài khoảng `[0, 1]` cho bất kỳ bài viết đầu vào nào.

### Requirement 8: Vòng đời bản nháp (Review Mode)

**User Story:** Là ADMIN, tôi muốn bản nháp SOP/CV đi qua quy trình duyệt trước khi coi là chính thức, để kiểm soát chất lượng nội dung gửi đi.

#### Acceptance Criteria

1. WHEN ADMIN hoặc người dùng được phân công gửi yêu cầu chuyển trạng thái một `Essay_Draft`, THE `Essay_State_Machine` SHALL chỉ cho phép các bước hợp lệ: `DRAFT → IN_REVIEW`, `IN_REVIEW → APPROVED`, `DRAFT → ARCHIVED`, `IN_REVIEW → ARCHIVED`.
2. IF yêu cầu chuyển trạng thái không nằm trong tập bước hợp lệ, THEN THE `Essay_State_Machine` SHALL từ chối với mã trạng thái 409 và giữ nguyên trạng thái hiện tại.
3. WHILE một `Essay_Draft` chưa ở trạng thái `APPROVED` (bao gồm mọi trạng thái không phải APPROVED như `DRAFT` và `IN_REVIEW`), THE `AutoTGC_System` SHALL không coi bản nháp đó là nội dung chính thức để gửi cho ứng viên.
4. WHEN một `Essay_Draft` chuyển sang `APPROVED`, THE `AutoTGC_System` SHALL ghi nhận người thực hiện và thời điểm phê duyệt.
5. THE `Essay_State_Machine` SHALL là hàm chuyển trạng thái thuần và xác định.
6. WHEN một `Essay_Draft` đạt trạng thái `APPROVED`, THE `AutoTGC_System` SHALL coi bản nháp là đã duyệt nhưng vẫn chưa chính thức được gửi đi cho tới khi hoàn tất các bước bổ sung (trạng thái `APPROVED` không tự động đồng nghĩa với "đã gửi").

### Requirement 9: Phân quyền cho bản nháp văn bản

**User Story:** Là người quản trị, tôi muốn nhân viên SALES chỉ thao tác với bản nháp của ứng viên được phân công, để tránh rò rỉ giữa các vai trò.

#### Acceptance Criteria

1. THE `AutoTGC_System` SHALL liên kết mỗi `Essay_Draft` với đúng một `Candidate_Profile`.
2. WHERE người gọi có vai trò SALES, THE `RBAC_Service` SHALL chỉ cho phép tạo, đọc, chấm, và chuyển trạng thái `Essay_Draft` của các ứng viên được phân công cho người đó, với `ownerUserId` phân giải từ `candidate.assignedTo`.
3. IF người gọi có vai trò SALES thao tác trên `Essay_Draft` của ứng viên không được phân công, THEN THE `RBAC_Service` SHALL từ chối với mã trạng thái 403.
4. WHERE người gọi có vai trò ADMIN, THE `RBAC_Service` SHALL cho phép thao tác trên mọi `Essay_Draft`.
5. THE `AutoTGC_System` SHALL giữ mọi endpoint của bản nháp văn bản sau `Auth_Middleware` và `RBAC_Service`, không tạo endpoint không xác thực.
6. IF hệ thống không thể xác định quyền truy cập của vai trò ADMIN, THEN THE `RBAC_Service` SHALL mặc định cấp quyền truy cập ADMIN (mặc định ưu tiên ADMIN).

---

## Nhóm 3 — Luyện phỏng vấn visa (mô phỏng tương tác)

### Requirement 10: Sinh bộ câu hỏi phỏng vấn theo quốc gia/loại visa

**User Story:** Là ứng viên, tôi muốn luyện phỏng vấn với bộ câu hỏi phù hợp với loại visa của mình (ví dụ F-1/USA, UK), để chuẩn bị tốt cho buổi phỏng vấn thật.

#### Acceptance Criteria

1. WHEN một người dùng đã xác thực bắt đầu một `Interview_Session` cho một quốc gia/loại visa, THE `Interview_Agent` SHALL trả về một bộ câu hỏi grounding theo tri thức quốc gia của `Visa_Catalog`.
2. WHERE `Gemini_Service` được cấu hình khóa API hợp lệ, THE `Interview_Agent` SHALL dùng `Gemini_Service` để soạn câu hỏi và đặt `aiGenerated = true`.
3. IF `Gemini_Service` không được cấu hình hoặc trả lỗi, THEN THE `Interview_Agent` SHALL trả về bộ câu hỏi từ `Interview_Question_Bank` xác định với `aiGenerated = false`, thay vì ném lỗi 502.
4. WHERE `Gemini_Service` được cấu hình/hoạt động bình thường nhưng quốc gia/loại visa được yêu cầu KHÔNG có trong `Visa_Catalog`, THE `Interview_Agent` SHALL dùng bộ câu hỏi fallback xác định từ `Interview_Question_Bank` và đặt `aiGenerated = false` (KHÔNG sinh câu hỏi bằng AI cho quốc gia không xác định) thay vì ném lỗi.
5. THE `Interview_Agent` SHALL không nhúng bất kỳ giá trị bí mật nào vào prompt hoặc câu hỏi.
6. IF phát hiện giá trị bí mật trong một prompt, THEN THE `Interview_Agent` SHALL làm thất bại yêu cầu thay vì âm thầm loại bỏ giá trị bí mật, bổ sung cho việc không bao giờ nhúng giá trị bí mật theo thiết kế.

### Requirement 11: Phản hồi và chấm điểm câu trả lời phỏng vấn

**User Story:** Là ứng viên, tôi muốn nhận phản hồi và điểm cho câu trả lời phỏng vấn của mình, để biết cần cải thiện ở đâu.

#### Acceptance Criteria

1. WHEN ứng viên gửi câu trả lời cho các câu hỏi của một `Interview_Session`, THE `Interview_Agent` SHALL trả về phản hồi grounding cho từng câu trả lời.
2. WHEN `Interview_Scorer` chấm một câu trả lời, THE `Interview_Scorer` SHALL trả về một điểm thuộc khoảng đóng `[0, 1]`.
3. THE `Interview_Scorer` SHALL là hàm thuần và xác định: cùng một câu trả lời và cùng tiêu chí SHALL cho cùng một điểm.
4. THE `Interview_Agent` SHALL không bịa đặt chính sách lãnh sự hoặc kết quả phỏng vấn; phản hồi SHALL grounding theo `Knowledge_Base` và `Visa_Catalog`.
5. IF tổng trọng số tiêu chí chấm bằng 0, THEN THE `Interview_Scorer` SHALL được phép trả về ĐỒNG THỜI cả cờ `INSUFFICIENT_DATA` và một giá trị điểm, thay vì thực hiện phép chia.
6. THE `Interview_Scorer` SHALL không bao giờ trả về điểm nằm ngoài khoảng `[0, 1]`.

### Requirement 12: Lưu trữ phiên luyện phỏng vấn và phân quyền

**User Story:** Là chuyên viên tư vấn, tôi muốn lưu lại phiên luyện phỏng vấn của ứng viên, để theo dõi tiến bộ qua các lần luyện.

#### Acceptance Criteria

1. WHEN một `Interview_Session` hoàn tất một vòng hỏi–đáp, THE `AutoTGC_System` SHALL lưu phiên gồm câu hỏi, câu trả lời, phản hồi, và điểm.
2. THE `AutoTGC_System` SHALL liên kết mỗi `Interview_Session` với đúng một `Candidate_Profile`.
3. WHERE người gọi có vai trò SALES, THE `RBAC_Service` SHALL chỉ cho phép tạo và xem `Interview_Session` của các ứng viên được phân công cho người đó, với `ownerUserId` phân giải từ phân công ứng viên TẠI THỜI ĐIỂM TẠO PHIÊN (không dùng phân công hiện tại).
4. IF người gọi có vai trò SALES thao tác trên `Interview_Session` của ứng viên không được phân công, THEN THE `RBAC_Service` SHALL từ chối với mã trạng thái 403.
5. THE `AutoTGC_System` SHALL giữ mọi endpoint luyện phỏng vấn sau `Auth_Middleware` và `RBAC_Service`, không tạo endpoint không xác thực.

---

## Nhóm 4 — Agent dòng thời gian hồ sơ chủ động

### Requirement 13: Theo dõi nhiều hồ sơ ứng tuyển song song

**User Story:** Là chuyên viên tư vấn, tôi muốn theo dõi nhiều đơn ứng tuyển song song của một ứng viên, để không bỏ lỡ mốc của bất kỳ chương trình nào.

#### Acceptance Criteria

1. THE `AutoTGC_System` SHALL cho phép một `Candidate_Profile` có nhiều `Application_Case` song song, mỗi `Application_Case` gắn với một `Destination_Program` và một đợt nhập học.
2. THE `Application_Case` SHALL là thay đổi bổ sung (additive) không sửa đổi destructive cấu trúc của các mô hình hiện có (`Visa_Case`, `Candidate_Profile`).
3. WHEN một `Application_Case` được tạo cho một quốc gia có trong `Visa_Catalog`, THE `AutoTGC_System` SHALL khởi tạo các `Due_Item` từ checklist quốc gia tương ứng kèm hạn suy ra từ ngày nhập học bằng `withDeadlines`.
4. WHERE một `Application_Case` chưa có ngày nhập học mục tiêu, THE `AutoTGC_System` SHALL biểu diễn các `Due_Item` của hồ sơ đó với hạn chưa xác định thay vì một hạn bịa đặt.

### Requirement 14: Tính mốc và việc sắp tới (Timeline_Computer)

**User Story:** Là chuyên viên tư vấn, tôi muốn thấy danh sách việc sắp đến hạn trên tất cả hồ sơ của một ứng viên theo thứ tự ưu tiên, để xử lý việc gấp trước.

#### Acceptance Criteria

1. WHEN `Timeline_Computer` tính dòng thời gian cho một ứng viên, THE `Timeline_Computer` SHALL gộp các `Due_Item` từ TẤT CẢ `Application_Case` và `Visa_Case` của ứng viên đó.
2. THE `Timeline_Computer` SHALL là hàm thuần và xác định: cùng tập `Due_Item` và cùng thời điểm tham chiếu SHALL cho cùng kết quả theo cùng thứ tự.
3. THE `Timeline_Computer` SHALL bảo toàn tập hợp `Due_Item` đầu vào: mọi `Due_Item` đầu vào hợp lệ SHALL xuất hiện đúng một lần trong kết quả (không thêm, không mất, không trùng).
4. WHEN `Timeline_Computer` sắp xếp các `Due_Item`, THE `Timeline_Computer` SHALL sắp theo hạn tăng dần (sớm nhất trước) với tiêu chí phá hòa xác định và ổn định.
5. WHERE một `Due_Item` có hạn chưa xác định, THE `Timeline_Computer` SHALL xếp `Due_Item` đó sau các việc đã có hạn xác định theo một quy tắc xác định.
6. WHERE TẤT CẢ `Due_Item` đều có hạn chưa xác định, THE `Timeline_Computer` SHALL coi đây là trường hợp hợp lệ và sắp xếp các việc chưa có hạn theo một tiêu chí phụ xác định.
7. WHEN `Timeline_Computer` tính việc "đến hạn tiếp theo", THE `Timeline_Computer` SHALL chỉ xét các `Due_Item` chưa hoàn tất.

### Requirement 15: Nhắc chủ động và tính lũy đẳng

**User Story:** Là chuyên viên tư vấn, tôi muốn được nhắc khi một việc sắp đến hạn, mà không bị nhắc trùng cho cùng một việc, để tránh nhiễu thông báo.

#### Acceptance Criteria

1. WHEN một `Due_Item` bước vào cửa sổ nhắc (sắp đến hạn), THE `Timeline_Agent` SHALL tạo một `Reminder` cho người phụ trách qua `Notification_Service`.
2. THE việc tạo `Reminder` SHALL lũy đẳng theo `Due_Item`: với cùng một `Due_Item` đến hạn, `Timeline_Agent` SHALL không tạo nhiều hơn một `Reminder` chưa xử lý cho cùng một việc. Tính lũy đẳng chỉ áp dụng cho một `Reminder` còn ở trạng thái chưa xử lý/đang chờ của cùng một `Due_Item`.
3. WHEN `Reminder` hiện có của một `Due_Item` không còn ở trạng thái đang chờ (đã xử lý hoặc đã hủy), THE `Timeline_Agent` SHALL được phép tạo một `Reminder` mới cho `Due_Item` đó.
4. WHEN `Timeline_Agent` chạy lại trên cùng một trạng thái dữ liệu, THE `Timeline_Agent` SHALL không tạo thêm `Reminder` trùng cho các `Due_Item` đã được nhắc.
5. IF việc tạo `Reminder` hoặc phát sự kiện realtime ném lỗi, THEN THE `AutoTGC_System` SHALL không làm thất bại hoặc hoàn tác việc tính dòng thời gian đã thành công.
6. WHEN một `Due_Item` đã hoàn tất trước khi nhắc được gửi, THE `Timeline_Agent` SHALL không tạo `Reminder` cho `Due_Item` đó.

---

## Nhóm 5 — Lộ trình Du học → Nghề nghiệp → Định cư (ROI) + điểm Sẵn sàng hồ sơ

### Requirement 16: Ước lượng lộ trình & ROI (Roadmap_Estimator)

**User Story:** Là ứng viên, tôi muốn ước lượng chi phí, định hướng nghề nghiệp và lộ trình định cư của một chương trình, để cân nhắc đầu tư du học có cơ sở.

#### Acceptance Criteria

1. WHEN `Roadmap_Estimator` ước lượng ROI cho một cặp (`Candidate_Profile`, `Destination_Program`), THE `Roadmap_Estimator` SHALL tính chi phí du học bằng chi phí ròng lấy từ `Scholarship_Matcher`.
2. THE `Roadmap_Estimator` SHALL là hàm thuần và xác định: cùng một đầu vào SHALL cho cùng một kết quả ước lượng.
3. THE `Roadmap_Estimator` SHALL grounding định hướng việc làm sau tốt nghiệp và ghi chú lộ trình định cư theo `Knowledge_Base`, và SHALL không cam kết hay bảo đảm kết quả định cư.
4. IF mẫu số của một chỉ số ROI dẫn xuất bằng 0, THEN THE `Roadmap_Estimator` SHALL trả về `INSUFFICIENT_DATA` cho chỉ số đó thay vì thực hiện phép chia.
5. IF bất kỳ dữ liệu chi phí hoặc tài chính bắt buộc nào để tính ROI bị thiếu, THEN THE `Roadmap_Estimator` SHALL LUÔN trả về `INSUFFICIENT_DATA` thay vì một con số ROI gây hiểu nhầm (mọi trường hợp thiếu dữ liệu tài chính bắt buộc đều ngăn việc xuất ra con số ROI).

### Requirement 17: Bản tường thuật lộ trình (Review Mode)

**User Story:** Là chuyên viên tư vấn, tôi muốn một bản tường thuật lộ trình dễ đọc cho ứng viên, được duyệt trước khi gửi, để bảo đảm nội dung chính xác.

#### Acceptance Criteria

1. WHERE `Gemini_Service` được cấu hình khóa API hợp lệ, THE `Roadmap_Narrative` SHALL dùng `Gemini_Service` để diễn giải bản ước lượng và đặt `aiGenerated = true`.
2. IF `Gemini_Service` không được cấu hình hoặc trả lỗi, THEN THE `Roadmap_Narrative` SHALL sinh bản tường thuật xác định từ kết quả `Roadmap_Estimator` với `aiGenerated = false`, thay vì ném lỗi 502.
3. WHILE một `Roadmap_Narrative` chưa được duyệt, THE `AutoTGC_System` SHALL không coi bản tường thuật đó là nội dung chính thức để gửi cho ứng viên, bất kể phương pháp sinh (kể cả bản tường thuật xác định cũng cần được duyệt trước khi chính thức).
4. THE `Roadmap_Narrative` SHALL không nhúng bất kỳ giá trị bí mật nào vào prompt hoặc bản tường thuật.
5. THE `Roadmap_Narrative` SHALL không phát biểu cam kết định cư bịa đặt vượt quá nội dung grounding từ `Knowledge_Base`.

### Requirement 18: Điểm Sẵn sàng hồ sơ (Readiness_Scorer)

**User Story:** Là chuyên viên tư vấn, tôi muốn một điểm Sẵn sàng hồ sơ cho mỗi ứng viên kèm gợi ý còn thiếu gì, để biết hồ sơ nào sẵn sàng nộp.

#### Acceptance Criteria

1. WHEN `Readiness_Scorer` chấm một ứng viên, THE `Readiness_Scorer` SHALL trả về một điểm sẵn sàng thuộc khoảng đóng `[0, 1]`.
2. THE `Readiness_Scorer` SHALL là hàm thuần và xác định: cùng một đầu vào SHALL cho cùng một điểm.
3. THE `Readiness_Scorer` SHALL tổng hợp tối thiểu: tỷ lệ giấy tờ hoàn tất (tái dùng `completionMetric`), sự hiện diện của tín hiệu học thuật, và trình độ ngôn ngữ so với mục tiêu.
4. IF tổng số thành phần đầu vào dùng để tính điểm bằng 0, THEN THE `Readiness_Scorer` SHALL trả về `INSUFFICIENT_DATA` thay vì thực hiện phép chia.
5. WHEN một chương trình mục tiêu được phân loại chưa sẵn sàng do thiếu thành phần, THE `Readiness_Scorer` SHALL kèm theo `Gap_Suggestion` có căn cứ cho các thành phần còn thiếu.
6. THE `Readiness_Scorer` SHALL không bao giờ trả về điểm nằm ngoài khoảng `[0, 1]`.

---

## Yêu cầu xuyên suốt (cross-cutting)

### Requirement 19: Kiểm thử (Vitest + fast-check)

**User Story:** Là kỹ sư, tôi muốn mọi logic thuần được kiểm thử property-based, để bảo đảm tính đúng đắn trước khi triển khai.

#### Acceptance Criteria

1. THE `AutoTGC_System` SHALL có property test bằng fast-check cho `Admission_Scorer` xác nhận: điểm luôn thuộc `[0, 1]`, tính xác định, an toàn chia 0 khi chuẩn hóa GPA, và trả `INSUFFICIENT_DATA` khi thiếu tín hiệu bắt buộc.
2. THE `AutoTGC_System` SHALL có property test cho `Admission_Band` xác nhận tính xác định của phân band và tính đơn điệu theo điểm ở cùng độ chọn lọc.
3. THE `AutoTGC_System` SHALL có property test cho `Essay_Reviewer` xác nhận điểm luôn thuộc `[0, 1]`, tính xác định, và an toàn chia 0 (khi tổng trọng số bằng 0 thì trả về điểm mặc định `0.0`, không bao giờ `NaN` hay nằm ngoài khoảng).
4. THE `AutoTGC_System` SHALL có property test cho `Interview_Scorer` xác nhận điểm luôn thuộc `[0, 1]` và an toàn chia 0.
5. THE `AutoTGC_System` SHALL có property test cho `Timeline_Computer` xác nhận bảo toàn tập hợp `Due_Item` (không thêm, không mất, không trùng), tính xác định, và thứ tự hạn tăng dần.
6. THE `AutoTGC_System` SHALL có property test cho tính lũy đẳng của việc tạo `Reminder`: chạy lại trên cùng trạng thái SHALL không tạo `Reminder` trùng.
7. THE `AutoTGC_System` SHALL có property test cho `Readiness_Scorer` xác nhận điểm luôn thuộc `[0, 1]` và an toàn chia 0.
8. THE `AutoTGC_System` SHALL có property test cho `Roadmap_Estimator` xác nhận tính xác định và an toàn chia 0 (trả `INSUFFICIENT_DATA`).
9. THE `AutoTGC_System` SHALL có property test cho `Essay_State_Machine` xác nhận chỉ các bước hợp lệ được chấp nhận và mọi bước khác trả 409.
10. WHEN bộ kiểm thử chạy, THE `AutoTGC_System` SHALL thực thi mỗi property test với tối thiểu 100 trường hợp sinh ngẫu nhiên.

### Requirement 20: Tính trung thực của AI (Gemini-optional)

**User Story:** Là người quản trị, tôi muốn hệ thống không bao giờ tuyên bố sai về đầu ra AI, để giữ độ tin cậy và an toàn dữ liệu.

#### Acceptance Criteria

1. WHERE bất kỳ năng lực nào trả về nội dung có thể do AI sinh, THE `AutoTGC_System` SHALL kèm theo cờ `AI_Generated_Flag` phản ánh đúng nguồn sinh nội dung.
2. IF `Gemini_Service` không được cấu hình hoặc trả lỗi, THEN THE `AutoTGC_System` SHALL trả về kết quả nền xác định với `aiGenerated = false` và SHALL không ném lỗi 502 vì lý do thiếu AI; WHERE `Gemini_Service` hoạt động bình thường, THE `AutoTGC_System` SHALL diễn giải đầu ra bằng `Gemini_Service` và đặt `aiGenerated = true` (kết quả không phải luôn xác định).
3. THE `AutoTGC_System` SHALL không tuyên bố một đầu ra là do AI sinh khi đầu ra đó được sinh bằng nhánh nền xác định.
4. THE `AutoTGC_System` SHALL không nhúng giá trị bí mật (khóa API, thông tin xác thực) vào bất kỳ prompt hoặc câu trả lời nào.
5. WHEN một đầu ra AI cần được con người duyệt trước khi gửi đi, THE `AutoTGC_System` SHALL giữ đầu ra đó ở `Review_Mode` cho tới khi được phê duyệt.

### Requirement 21: Migration và triển khai

**User Story:** Là kỹ sư vận hành, tôi muốn gói tính năng được di trú dữ liệu và triển khai an toàn theo quy trình hiện có, để đưa tính năng lên môi trường máy chủ.

#### Acceptance Criteria

1. WHEN có thay đổi mô hình dữ liệu (`Academic_Profile`, `Essay_Draft`, `Interview_Session`, `Application_Case`, và các cột ngưỡng bổ sung trên `Destination_Program`), THE `AutoTGC_System` SHALL kèm theo (các) migration Prisma bổ sung tạo bảng/cột mới mà không sửa đổi destructive các bảng hiện có.
2. THE `AutoTGC_System` SHALL biên dịch thành công (`npm run build`) trước khi triển khai.
3. WHEN triển khai, THE `AutoTGC_System` SHALL chạy dưới tiến trình PM2 với người dùng không phải root và sau reverse proxy Nginx theo cấu hình trong thư mục `deploy/`.
4. IF một biến môi trường bí mật bắt buộc bị thiếu khi khởi động, THEN THE `AutoTGC_System` SHALL dừng khởi động (fail fast) và chỉ ghi log tên biến bí mật, không ghi giá trị.
5. IF bất kỳ biến môi trường/bí mật bắt buộc nào bị thiếu khi khởi động, THEN THE `AutoTGC_System` SHALL buộc toàn bộ tiến trình dừng ngay lập tức (fail fast) và SHALL không tiếp tục ở trạng thái khởi động một phần ngay cả khi việc ghi log thành công.
6. THE `AutoTGC_System` SHALL giữ mọi endpoint mới sau `Auth_Middleware` và `RBAC_Service`, không tạo endpoint không xác thực.
7. THE `AutoTGC_System` SHALL chỉ trả về các mã trạng thái thuộc tập `HTTP_Status` cho phép của dự án.

### Requirement 22: Nhất quán phân quyền assigned-only

**User Story:** Là người quản trị, tôi muốn quy tắc assigned-only của SALES được áp dụng đồng nhất cho mọi năng lực mới gắn ứng viên, để tránh sai lệch giữa các module.

#### Acceptance Criteria

1. THE `AutoTGC_System` SHALL áp dụng cùng một quy tắc assigned-only của SALES một cách đồng nhất cho mọi tài nguyên gắn ứng viên mới: chấm trúng tuyển, bản nháp văn bản, phiên phỏng vấn, dòng thời gian, lộ trình, và điểm sẵn sàng.
2. WHERE một route mới gắn tài nguyên có chủ sở hữu cho SALES, THE route đó SHALL phân quyền qua `RBAC_Service` với `ownerUserId` phân giải từ `candidate.assignedTo` thay vì tự định nghĩa quy tắc phân quyền riêng.
3. WHEN cùng một ngữ cảnh người gọi và cùng một tài nguyên đích được đánh giá nhiều lần, THE `RBAC_Service` SHALL trả về cùng một quyết định (xác định).
4. WHERE người gọi có vai trò ADMIN, THE `RBAC_Service` SHALL cho phép mọi thao tác trên các tài nguyên mới của gói tính năng này.
5. WHERE người gọi có vai trò SALES, THE `RBAC_Service` SHALL cho phép toàn quyền CRUD (tạo, đọc, cập nhật, xóa) trên các tài nguyên mới của gói tính năng (phiên phỏng vấn, điểm sẵn sàng, bản nháp văn bản, v.v.) của các ứng viên được phân công cho người đó, không chỉ quyền đọc.
6. IF người gọi chưa xác thực hoặc phiên không còn `ACTIVE`, THEN THE `Auth_Middleware` SHALL từ chối với mã trạng thái 401 trước khi `Rbac_Guard` chạy.
7. IF trạng thái xác thực của một yêu cầu không thể được xác minh, THEN THE `Auth_Middleware` SHALL thất bại một cách an toàn và từ chối yêu cầu với mã trạng thái 401, không bao giờ mặc định cho phép yêu cầu đi qua.

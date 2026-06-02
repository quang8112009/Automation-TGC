# Implementation Plan: ai-reporting-and-ops-enhancements

## Overview

Kế hoạch triển khai bốn nhóm năng lực (báo cáo công ty AI TUẦN/THÁNG, Trợ lý Công việc TGC, UX kéo–thả, checklist giấy tờ ứng viên) theo kiến trúc additive trên AutoTGC (Fastify 4 + Prisma 5/PostgreSQL 16, Vitest + fast-check, PM2 + Nginx). Các bước được sắp xếp tăng dần: bắt đầu từ schema/migration Prisma, kế đến các module logic thuần kèm property test (fast-check, ≥100 lần chạy) viết song song, rồi tới các service, wiring route + RBAC, frontend, và cuối cùng là các tác vụ kiểm chứng/triển khai xuyên suốt.

Ngôn ngữ triển khai: **TypeScript** (theo đúng thiết kế và steering). Mỗi correctness property trong design được hiện thực bằng **đúng một** property test trong `autotgc-backend/test/ai-reporting-and-ops.properties.test.ts`, mỗi test gắn comment `// Feature: ai-reporting-and-ops-enhancements, Property {n}: ...` và chạy `fc.assert(..., { numRuns: 100 })` trở lên.

## Tasks

- [x] 1. Nền tảng dữ liệu — Prisma schema & migration
  - [x] 1.1 Bổ sung enums, models và cột mới (additive) vào `autotgc-backend/prisma/schema.prisma`
    - Thêm enums: `ReportType` (WEEKLY|MONTHLY), `ReportStatus` (DRAFT|IN_REVIEW|APPROVED|ARCHIVED|INSUFFICIENT_DATA), `DocSubmissionStatus` (PENDING|SUBMITTED|VERIFIED|REJECTED), `DocSource` (DEFAULT|CUSTOM)
    - Thêm model `CompanyReport` (id, reportType, periodFrom, periodTo, periodLabel, status @default(DRAFT), content Json, aiGenerated, scopeUserId?, createdBy?, timestamps; `@@index([reportType, periodFrom])`, `@@index([status])`, `@@unique([reportType, periodLabel, scopeUserId])`)
    - Thêm model `DocumentChecklistItem` (candidateId, relation tới `CandidateProfile` với `onDelete: Cascade`, type, label, status @default(PENDING), required @default(true), source @default(DEFAULT), note?, submittedAt?, timestamps; `@@index([candidateId])`, `@@index([status])`) và quan hệ ngược `documents DocumentChecklistItem[]` trên `CandidateProfile`
    - Thêm model `DocumentTypeCatalog` (market @unique, docs Json @default("[]"), timestamps)
    - Thêm cột `priorityIndex Int @default(0)` vào `ContentDraft` và `LearningInsight`
    - _Requirements: 2.1, 3.1, 3.6, 10.1, 11.1, 11.2, 11.4, 12.1, 15.1_

  - [x] 1.2 Sinh client và tạo migration Prisma
    - Chạy `npm run prisma:generate`, sau đó `npx prisma migrate dev --name ai_reporting_ops` (local) để tạo file migration cho các bảng/cột mới
    - Xác minh migration biên dịch và phản ánh đúng schema; không sửa dữ liệu hiện có
    - _Requirements: 15.1_

- [x] 2. Report_Engine & Report_State_Machine (logic thuần + property test)
  - [x] 2.1 Hiện thực `autotgc-backend/src/reporting/reportEngine.ts` + `autotgc-backend/src/reporting/types.ts`
    - Định nghĩa types (`ReportType`, `ReportPeriod`, `ReportInputRow`, `ReportContent`, `ReportScope`) và export các hàm thuần: `filterByPeriod`, `applyScope`, `averageRate`, `aggregateReport`, `buildDeterministicSummary`, `isInsufficient`
    - An toàn chia 0 → `'INSUFFICIENT_DATA'`; loại bản ghi `PerformanceRecord` nhãn `INSUFFICIENT_DATA` khỏi trung bình; tổng hợp xác định (không phụ thuộc Gemini)
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 2.2, 2.4, 2.5, 2.6_
    - _Properties: 1, 2, 3, 4, 5, 6_

  - [x] 2.2 Viết property test cho lọc theo kỳ
    - **Property 1: Lọc theo kỳ chỉ giữ bản ghi trong [from, to)**
    - **Validates: Requirements 1.1**
    - File: `autotgc-backend/test/ai-reporting-and-ops.properties.test.ts`; tag `// Feature: ai-reporting-and-ops-enhancements, Property 1: ...`; `fc.assert` ≥100 runs

  - [x] 2.3 Viết property test cho trung bình rate
    - **Property 2: Trung bình rate loại trừ INSUFFICIENT_DATA và an toàn chia 0**
    - **Validates: Requirements 1.2, 1.3**
    - Tag `// Feature: ai-reporting-and-ops-enhancements, Property 2: ...`; khẳng định không bao giờ `NaN`/`Infinity`; ≥100 runs

  - [x] 2.4 Viết property test cho phạm vi SALES
    - **Property 3: Phạm vi SALES chỉ giữ dữ liệu được phân công**
    - **Validates: Requirements 1.5, 1.6**
    - Tag `// Feature: ai-reporting-and-ops-enhancements, Property 3: ...`; ≥100 runs

  - [x] 2.5 Viết property test cho tổng hợp báo cáo
    - **Property 4: Tổng hợp báo cáo nhất quán và đầy đủ cấu trúc**
    - **Validates: Requirements 1.4, 2.2**
    - Tag `// Feature: ai-reporting-and-ops-enhancements, Property 4: ...`; kiểm tra đủ 5 phần, tổng bucket khớp số bản ghi, giá trị đếm không âm; ≥100 runs

  - [x] 2.6 Viết property test cho tính xác định khi không dùng Gemini
    - **Property 5: Báo cáo xác định khi không dùng Gemini**
    - **Validates: Requirements 2.4, 2.6**
    - Tag `// Feature: ai-reporting-and-ops-enhancements, Property 5: ...`; deep-equal qua nhiều lần gọi; `aiGenerated=false`; ≥100 runs

  - [x] 2.7 Viết property test cho trạng thái thiếu dữ liệu
    - **Property 6: Thiếu dữ liệu không sinh khuyến nghị suy đoán**
    - **Validates: Requirements 2.5**
    - Tag `// Feature: ai-reporting-and-ops-enhancements, Property 6: ...`; `isInsufficient`→true ⇒ `recommendations.length===0` + `INSUFFICIENT_DATA`; ≥100 runs

  - [x] 2.8 Hiện thực `autotgc-backend/src/reporting/reportStateMachine.ts`
    - Export `ReportStatus`, `REPORT_TRANSITIONS`, `reportTransition(current, target)` trả `{ok:true,status}` cho bước hợp lệ và `{ok:false,status:409}` cho bước sai (mẫu `insightStateMachine.ts`)
    - _Requirements: 3.2, 3.3_
    - _Properties: 7_

  - [x] 2.9 Viết property test cho Report_State_Machine
    - **Property 7: Report_State_Machine chỉ chấp nhận bước hợp lệ**
    - **Validates: Requirements 3.2, 3.3**
    - Tag `// Feature: ai-reporting-and-ops-enhancements, Property 7: ...`; ≥100 runs

- [x] 3. Report service, export, scheduler & routes
  - [x] 3.1 Hiện thực `autotgc-backend/src/reporting/reportExport.ts`
    - Hàm thuần serialize `ReportContent` thành văn bản/markdown có cấu trúc để tải xuống
    - _Requirements: 5.4_

  - [x] 3.2 Hiện thực `autotgc-backend/src/reporting/reportService.ts`
    - I/O Prisma: `generateForPeriod` (đọc PerformanceRecord/Lead/Candidate trong [from,to), gọi `aggregateReport`, tùy chọn Gemini → `aiGenerated=true`, lỗi/không key → `buildDeterministicSummary` `aiGenerated=false`, rỗng → `INSUFFICIENT_DATA` + `recommendations=[]`); `get`/`list` (guard SALES chỉ thấy `APPROVED`); `updateContent` (chỉ DRAFT/IN_REVIEW, khác → 409); `transition` (gọi `reportTransition`, sang APPROVED ghi `AuditLog`); `export` (chỉ APPROVED, khác → 409)
    - _Requirements: 2.1, 2.3, 3.1, 3.4, 3.5, 3.6, 5.1, 5.2, 5.3, 5.4_
    - _Properties: 8_

  - [x] 3.3 Viết property test cho phạm vi đọc của SALES
    - **Property 8: SALES chỉ đọc được báo cáo APPROVED**
    - **Validates: Requirements 5.2**
    - Tag `// Feature: ai-reporting-and-ops-enhancements, Property 8: ...`; SALES list/get chỉ trả APPROVED, non-APPROVED → 403; ≥100 runs

  - [x] 3.4 Viết unit test cho `reportService`
    - File `autotgc-backend/test/reportService.test.ts`: tạo DRAFT (3.1), reportType WEEKLY/MONTHLY (2.1), Gemini stub → `aiGenerated=true` (2.3), audit khi APPROVED (3.5), sửa khi DRAFT/IN_REVIEW & 409 khi khác (3.4), export APPROVED & 409 khi chưa APPROVED (5.4)
    - _Requirements: 2.1, 2.3, 3.1, 3.4, 3.5, 5.4_

  - [x] 3.5 Hiện thực `autotgc-backend/src/reporting/reportScheduler.ts`
    - `registerReportJobs(scheduler, deps)` đăng ký job `weekly-company-report` (`CRON_WEEKLY_REPORT`, mặc định `0 1 * * 1`) và `monthly-company-report` (`CRON_MONTHLY_REPORT`, mặc định `0 2 1 * *`); mỗi job gọi `generateForPeriod(type, previousPeriod, {role:'ADMIN', userId:'background-worker'})` tạo DRAFT, không auto-APPROVED
    - _Requirements: 4.1, 4.2, 4.4_

  - [x] 3.6 Viết integration/smoke test cho scheduler
    - File `autotgc-backend/test/reportScheduler.test.ts`: đăng ký đúng 2 job với cron từ env (4.1); job ném lỗi được bắt + log tên job + thời điểm, không crash tiến trình hoặc job khác (4.3)
    - _Requirements: 4.1, 4.3_

  - [x] 3.7 Hiện thực `autotgc-backend/src/reporting/routes.ts` (`registerReportingRoutes`)
    - Đăng ký POST `/api/v1/reports/generate`, GET `/api/v1/reports`, GET `/api/v1/reports/:id`, PUT `/api/v1/reports/:id`, POST `/api/v1/reports/:id/transition`, GET `/api/v1/reports/:id/export`; tất cả sau `requireAuth` + `rbacGuard` (module `analytics`); guard đọc cho SALES map sang quyết định read-APPROVED ở tầng service; SALES ghi/transition → 403
    - _Requirements: 5.1, 5.2, 5.3, 15.5_

- [ ] 4. Checkpoint — Báo cáo công ty
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Trợ lý Công việc TGC (Work_Assistant)
  - [x] 5.1 Hiện thực `autotgc-backend/src/recruitment/agent/workAssistant.ts`
    - Export `scopeBusinessData` (ADMIN giữ tất cả; SALES chỉ `assignedTo===userId`) và facade `WorkAssistant.ask` (chuẩn hóa câu hỏi; truy hồi `KnowledgeEntry` active qua `KnowledgeService.search` ranking thuần; Gemini optional → `aiGenerated=true`, fallback xác định `buildGroundedAnswer` `aiGenerated=false`, kèm `sources`, trả lời tiếng Việt; không nhúng secret vào prompt/answer); tái dùng `consultantAgent.ts`, không xóa class cũ
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.6, 7.1, 7.2, 7.3, 7.5, 8.3_
    - _Properties: 9, 10, 11_

  - [x] 5.2 Viết property test cho xếp hạng grounding
    - **Property 9: Xếp hạng grounding chỉ dùng entry active, ổn định và xác định**
    - **Validates: Requirements 6.1, 6.4, 8.3**
    - Tag `// Feature: ai-reporting-and-ops-enhancements, Property 9: ...`; chỉ entry active, sắp theo điểm không tăng (tie-break title), `sources` khớp, xác định; ≥100 runs

  - [x] 5.3 Viết property test cho fallback không ném lỗi
    - **Property 10: Trợ lý không ném lỗi khi vắng Gemini**
    - **Validates: Requirements 6.3**
    - Tag `// Feature: ai-reporting-and-ops-enhancements, Property 10: ...`; với mọi câu hỏi không rỗng, không có Gemini → `aiGenerated=false`, không reject/502; ≥100 runs

  - [x] 5.4 Viết property test cho phạm vi dữ liệu nghiệp vụ
    - **Property 11: Phạm vi dữ liệu nghiệp vụ theo vai trò**
    - **Validates: Requirements 7.1, 7.2, 7.3**
    - Tag `// Feature: ai-reporting-and-ops-enhancements, Property 11: ...`; ADMIN trả toàn bộ, SALES chỉ `assignedTo===userId`; ≥100 runs

  - [x] 5.5 Thêm route `/api/v1/ai/assistant` vào `autotgc-backend/src/recruitment/agent/routes.ts`
    - POST `/api/v1/ai/assistant` sau `requireAuth` + `rbacGuard` (map `dashboard`/`read` để cả ADMIN và SALES qua); validate câu hỏi rỗng sau trim → `ValidationError` 400; gọi `WorkAssistant.ask`; scoping dữ liệu do service đảm nhiệm. Knowledge admin tái dùng route hiện có (`GET/POST /api/v1/knowledge`, `PUT /api/v1/knowledge/:id`)
    - _Requirements: 6.5, 7.4, 8.1, 8.2, 8.4, 15.5_

  - [x] 5.6 Viết unit/edge test cho trợ lý
    - File `autotgc-backend/test/workAssistant.test.ts`: Gemini stub → `aiGenerated=true` (6.2); câu hỏi whitespace → 400 (6.5); fallback trả lời tiếng Việt (6.6); prompt/answer không chứa secret (7.5); thiếu field knowledge → 400 (8.2)
    - _Requirements: 6.2, 6.5, 6.6, 7.5, 8.2_

- [x] 6. UX kéo–thả (Schedule_Board & Approval_Queue)
  - [x] 6.1 Hiện thực `autotgc-backend/src/content/reorder.ts`
    - Hàm thuần dùng chung: `applyReorder<T extends Reorderable>(items, req)` (bảo toàn tập id, gán `orderIndex` theo vị trí trong `orderedIds`, lũy đẳng) và `validateReorder(items, req)` (id lạ/trùng → `ValidationError` 400)
    - _Requirements: 9.2, 9.3, 10.1, 10.2, 10.4_
    - _Properties: 12, 13_

  - [x] 6.2 Viết property test cho bảo toàn tập hợp & thứ tự
    - **Property 12: Reorder bảo toàn tập hợp và phản ánh đúng thứ tự**
    - **Validates: Requirements 9.2, 9.3, 10.1, 10.2**
    - Tag `// Feature: ai-reporting-and-ops-enhancements, Property 12: ...`; cùng tập id, `orderIndex` khớp vị trí trong `orderedIds`; ≥100 runs

  - [x] 6.3 Viết property test cho tính lũy đẳng
    - **Property 13: Reorder là phép toán lũy đẳng**
    - **Validates: Requirements 10.4**
    - Tag `// Feature: ai-reporting-and-ops-enhancements, Property 13: ...`; `applyReorder(applyReorder(items,req),req) === applyReorder(items,req)`; ≥100 runs

  - [x] 6.4 Hiện thực `autotgc-backend/src/content/scheduleBoardService.ts`
    - `rescheduleItem(itemId, targetDate)` đổi `ContentPlanItem.targetDate`; `reorderItems(planId, req)` ghi `orderIndex` qua `applyReorder`; `rescheduleScheduledPost(postId, newTime)` gọi thẳng `CalendarService.reschedule` (tái dùng guard SCHEDULED-only → 409, future-only → 400)
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6_

  - [x] 6.5 Hiện thực `autotgc-backend/src/recruitment/approvalQueueService.ts` và cập nhật `autotgc-backend/src/dashboard/assembler.ts`
    - `approvalQueueService.reorder(req)` dùng `applyReorder` ghi `priorityIndex` cho `ContentDraft`/`LearningInsight`; sửa `buildApprovalQueue` ưu tiên `priorityIndex` tăng dần rồi mới đến deadline
    - _Requirements: 10.1, 10.3_
    - _Properties: 14_

  - [x] 6.6 Viết property test cho thứ tự Approval_Queue
    - **Property 14: Approval_Queue hiển thị theo thứ tự ưu tiên đã lưu**
    - **Validates: Requirements 10.3**
    - Tag `// Feature: ai-reporting-and-ops-enhancements, Property 14: ...`; `buildApprovalQueue` sắp theo `priorityIndex` không giảm; ≥100 runs

  - [x] 6.7 Wiring route kéo–thả trong `autotgc-backend/src/routes/index.ts`
    - POST `/api/v1/content-plans/:planId/reorder` (`strategy`/update), PUT `/api/v1/content-plan-items/:id/reschedule` (`strategy`/update), POST `/api/v1/approval-queue/reorder` (`feedback`/update); tất cả sau `requireAuth` + `rbacGuard`, SALES → 403; tái dùng route hiện có PUT `/api/v1/strategy/calendar/:id/reschedule`
    - _Requirements: 9.1, 9.2, 9.7, 10.1, 15.5_

  - [x] 6.8 Viết unit/edge test cho reorder & reschedule
    - File `autotgc-backend/test/scheduleBoard.test.ts`: đổi lịch non-SCHEDULED → 409 (9.5); thời điểm không tương lai → 400 (9.6); SALES kéo–thả → 403 (9.7); `validateReorder` id lạ/trùng → 400
    - _Requirements: 9.5, 9.6, 9.7_

- [x] 7. Checklist giấy tờ ứng viên
  - [x] 7.1 Hiện thực `autotgc-backend/src/recruitment/documents/documentCatalog.ts`
    - `DEFAULT_DOC_CATALOG` (bộ mặc định theo Market: JAPAN/KOREA/GERMANY/TAIWAN/DOMESTIC/OTHER, `type` mã ổn định + `label` tiếng Việt) và `defaultDocsForMarket(market)` thuần, fallback `OTHER`
    - _Requirements: 12.1, 12.3_
    - _Properties: 15_

  - [x] 7.2 Viết property test cho fallback bộ giấy tờ
    - **Property 15: Bộ giấy tờ mặc định fallback về OTHER**
    - **Validates: Requirements 12.3**
    - Tag `// Feature: ai-reporting-and-ops-enhancements, Property 15: ...`; market null/không hỗ trợ → bộ `OTHER`; ≥100 runs

  - [x] 7.3 Hiện thực `autotgc-backend/src/recruitment/documents/completion.ts`
    - `completionMetric(items)` = (số mục required ở VERIFIED)/(tổng mục required); tổng required = 0 → `'INSUFFICIENT_DATA'`; kết quả luôn ∈ [0,1], không `NaN`/`Infinity`
    - _Requirements: 13.4, 13.5_
    - _Properties: 16_

  - [x] 7.4 Viết property test cho chỉ số hoàn thành
    - **Property 16: Chỉ số hoàn thành đúng công thức, an toàn chia 0, và trong [0, 1]**
    - **Validates: Requirements 13.4, 13.5**
    - Tag `// Feature: ai-reporting-and-ops-enhancements, Property 16: ...`; ≥100 runs

  - [x] 7.5 Hiện thực `autotgc-backend/src/recruitment/documents/validation.ts` và `documentChecklistService.ts`
    - `initForCandidate` (khởi tạo từ catalog theo `desiredMarket`, fallback OTHER); `list` (kèm `completion`); `addCustom` (source CUSTOM, nhãn rỗng sau trim → 400); `updateStatus` (chỉ 4 enum, ngoài tập → 400; SUBMITTED ghi `submittedAt`)
    - _Requirements: 11.3, 12.2, 12.3, 13.1, 13.2, 13.3_

  - [x] 7.6 Hiện thực `DocumentCatalogService` trong `autotgc-backend/src/recruitment/documents/`
    - `get(market)` và `update(market, docs)` cho ADMIN cấu hình; cập nhật catalog KHÔNG ảnh hưởng `DocumentChecklistItem` đã tạo
    - _Requirements: 12.4, 12.5_

  - [x] 7.7 Viết unit/edge test cho checklist & catalog service
    - File `autotgc-backend/test/documentChecklist.test.ts`: init theo market (12.2); addCustom → source CUSTOM (13.1); nhãn rỗng → 400 (13.2); updateStatus SUBMITTED ghi `submittedAt` (13.3); trạng thái ngoài enum → 400 (11.3); cập nhật catalog không đổi checklist cũ (12.5)
    - _Requirements: 11.3, 12.2, 12.5, 13.1, 13.2, 13.3_

  - [x] 7.8 Hiện thực `autotgc-backend/src/recruitment/documents/routes.ts`
    - GET/POST `/api/v1/candidates/:id/documents`, POST `/api/v1/candidates/:id/documents/init`, PUT `/api/v1/documents/:itemId/status`, GET/PUT `/api/v1/document-catalog/:market`; sau `requireAuth` + `rbacGuard`; SALES assigned-only qua `candidateTargetById`, ứng viên không phân công → 403
    - _Requirements: 13.6, 15.5_

  - [x] 7.9 Viết integration test cho cascade delete
    - File `autotgc-backend/test/documentChecklist.integration.test.ts`: xóa `CandidateProfile` → xóa các `DocumentChecklistItem` liên kết
    - _Requirements: 11.4_

- [ ] 8. Checkpoint — Backend domain hoàn chỉnh
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. App wiring & cấu hình
  - [x] 9.1 Đăng ký các registrar route mới trong `autotgc-backend/src/app.ts`
    - Gọi `registerReportingRoutes`, route assistant, route reorder/reschedule, route documents/catalog (mẫu `registerRecruitmentRoutes`); đảm bảo tất cả nằm sau auth + RBAC
    - _Requirements: 15.5_

  - [x] 9.2 Wiring scheduler vào `autotgc-backend/src/infra/jobs.ts`
    - Chèn `registerReportJobs(scheduler, deps)` trong `startScheduledJobs`; lỗi job được `NodeCronScheduler` bắt + log
    - _Requirements: 4.1, 4.3_

  - [x] 9.3 Thêm biến cấu hình cron vào `autotgc-backend/src/infra/config.ts` và `autotgc-backend/.env.example`
    - Khai báo `CRON_WEEKLY_REPORT` (mặc định `0 1 * * 1`) và `CRON_MONTHLY_REPORT` (mặc định `0 2 1 * *`) dạng optional secrets (có mặc định, không thêm secret bắt buộc); thêm hai dòng vào `.env.example`
    - _Requirements: 4.1, 15.4_

- [x] 10. Frontend (React 18 + react-query, HTML5 Drag & Drop gốc)
  - [x] 10.1 Trang Reports — `autotgc-frontend/src/pages/Reports.tsx` + `autotgc-frontend/src/api/reports.ts`
    - Danh sách báo cáo TUẦN/THÁNG với badge trạng thái, nút chuyển trạng thái (ADMIN), nút export tải file; SALES chỉ thấy APPROVED; thêm route vào `autotgc-frontend/src/App.tsx` + mục menu trong `autotgc-frontend/src/components/Layout.tsx`
    - _Requirements: 5.1, 5.2, 5.4_

  - [x] 10.2 Schedule_Board DnD — mở rộng `autotgc-frontend/src/pages/Strategy.tsx` + `autotgc-frontend/src/api/strategy.ts`
    - Kéo–thả `ContentPlanItem` sang ngày khác (`PUT /content-plan-items/:id/reschedule`) và sắp thứ tự (`POST /content-plans/:planId/reorder` với `orderedIds`); đổi lịch `ScheduledPost` tái dùng `PUT /strategy/calendar/:id/reschedule`; optimistic update + rollback khi 400/409
    - _Requirements: 9.1, 9.2, 9.4_

  - [x] 10.3 Approval_Queue DnD — mở rộng `autotgc-frontend/src/pages/Dashboard.tsx`
    - Kéo–thả sắp ưu tiên các mục chờ duyệt, gọi `POST /approval-queue/reorder`; render lại theo `priorityIndex`
    - _Requirements: 10.1, 10.3_

  - [x] 10.4 Document checklist UI — mở rộng `autotgc-frontend/src/pages/CandidateDetail.tsx` + `autotgc-frontend/src/api/recruitment.ts`
    - Hiển thị checklist + thanh tiến độ (hiển thị "Chưa đủ dữ liệu" khi `INSUFFICIENT_DATA`); nút khởi tạo theo thị trường; thêm loại tùy biến; đổi trạng thái nộp
    - _Requirements: 11.2, 13.1, 13.3, 13.4_

  - [x] 10.5 Trang quản trị Document_Type_Catalog (ADMIN)
    - Trang mới cho ADMIN đọc/cập nhật bộ giấy tờ mặc định theo Market (`GET/PUT /document-catalog/:market`); thêm route vào `autotgc-frontend/src/App.tsx` + menu
    - _Requirements: 12.4_

- [ ] 11. Kiểm chứng xuyên suốt & triển khai
  - [x] 11.1 Biên dịch backend
    - Chạy `npm run build` trong `autotgc-backend/`; sửa mọi lỗi type/compile trước khi tiếp tục
    - _Requirements: 15.2_

  - [x] 11.2 Chạy toàn bộ bộ test
    - Chạy `npm test` trong `autotgc-backend/`; xác nhận toàn bộ unit/integration/property test xanh và mỗi property test chạy ≥100 trường hợp
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6_

  - [ ] 11.3 Triển khai qua scripts `deploy/`
    - Chạy quy trình trong `autotgc-backend/deploy/` (`app-deploy.sh`: `prisma generate` + `prisma migrate deploy`, `npm run build`, restart PM2 qua `deploy/pm2.config.js` dưới user non-root, sau Nginx `deploy/nginx-autotgc.conf`)
    - _Requirements: 15.1, 15.2, 15.3_

- [ ] 12. Checkpoint cuối — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Các sub-task gắn hậu tố `*` là test tùy chọn (property/unit/integration), có thể bỏ qua cho MVP nhanh nhưng nên thực hiện để đảm bảo đúng đắn.
- Mỗi correctness property (1–16) được hiện thực bằng đúng một property test trong `autotgc-backend/test/ai-reporting-and-ops.properties.test.ts`, gắn comment `// Feature: ai-reporting-and-ops-enhancements, Property {n}: ...`, chạy fast-check với `numRuns ≥ 100` (Req 14.6).
- Mỗi task tham chiếu requirement (và property nơi áp dụng) để truy vết.
- Mọi route mới đứng sau `requireAuth` + `rbacGuard`; mã trạng thái thuộc tập cho phép; Gemini là optional với fallback xác định.
- Thay đổi schema là additive; migration kèm theo (Req 15.1).

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["2.1", "2.8", "5.1", "6.1", "7.1", "7.3"] },
    { "id": 3, "tasks": ["2.2", "3.1", "5.5", "6.4", "6.5", "7.5", "7.6"] },
    { "id": 4, "tasks": ["2.3", "3.2", "6.7", "7.8", "5.6"] },
    { "id": 5, "tasks": ["2.4", "3.5", "3.7", "6.8", "7.7", "7.9"] },
    { "id": 6, "tasks": ["2.5", "3.4", "3.6"] },
    { "id": 7, "tasks": ["2.6", "9.1", "9.2", "9.3"] },
    { "id": 8, "tasks": ["2.7", "10.1", "10.2", "10.3", "10.4"] },
    { "id": 9, "tasks": ["2.9", "10.5"] },
    { "id": 10, "tasks": ["3.3"] },
    { "id": 11, "tasks": ["5.2"] },
    { "id": 12, "tasks": ["5.3"] },
    { "id": 13, "tasks": ["5.4"] },
    { "id": 14, "tasks": ["6.2"] },
    { "id": 15, "tasks": ["6.3"] },
    { "id": 16, "tasks": ["6.6"] },
    { "id": 17, "tasks": ["7.2"] },
    { "id": 18, "tasks": ["7.4"] },
    { "id": 19, "tasks": ["11.1"] },
    { "id": 20, "tasks": ["11.2"] },
    { "id": 21, "tasks": ["11.3"] }
  ]
}
```

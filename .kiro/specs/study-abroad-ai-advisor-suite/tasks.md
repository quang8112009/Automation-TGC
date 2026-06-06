# Implementation Plan: study-abroad-ai-advisor-suite

## Overview

Kế hoạch triển khai năm nhóm năng lực tư vấn du học bằng AI (chấm xác suất trúng tuyển + Reach/Match/Safety, trợ lý viết & chấm SOP/Essay/CV, luyện phỏng vấn visa, agent dòng thời gian hồ sơ, lộ trình ROI + điểm sẵn sàng) theo kiến trúc additive trên AutoTGC (Fastify 4 + Prisma 5/PostgreSQL 16, Vitest + fast-check, PM2 + Nginx). Các bước được sắp xếp tăng dần theo hướng test-driven: bắt đầu từ schema/migration Prisma, kế đến từng module logic thuần kèm property test (fast-check, ≥100 lần chạy), rồi tới các service (I/O), wiring route + RBAC, wiring `app.ts` + scheduler, frontend tối thiểu, và cuối cùng là các tác vụ kiểm chứng/triển khai xuyên suốt.

Ngôn ngữ triển khai: **TypeScript** (theo đúng thiết kế và steering — không dùng pseudocode). Mỗi correctness property (1–10) trong design được hiện thực bằng **đúng một** property test, đặt theo module (`autotgc-backend/test/<module>.properties.test.ts`), mỗi test gắn comment `// Feature: study-abroad-ai-advisor-suite, Property {n}: ...` và chạy `fc.assert(..., { numRuns: 100 })` trở lên. Mọi đường AI theo mẫu Gemini-optional (fallback xác định, cờ `aiGenerated`, không bao giờ ném 502); mọi route gắn ứng viên áp SALES assigned-only qua `candidate.assignedTo`.

## Tasks

- [x] 1. Nền tảng dữ liệu — Prisma schema & migration
  - [x] 1.1 Bổ sung enums, models và cột mới (additive) vào `autotgc-backend/prisma/schema.prisma`
    - Thêm enums: `EssayDocType` (SOP|MOTIVATION|CV), `EssayStatus` (DRAFT|IN_REVIEW|APPROVED|ARCHIVED), `ApplicationStatus` (PLANNING|SUBMITTED|OFFER|VISA|ENROLLED|WITHDRAWN|REJECTED)
    - Thêm model `AcademicProfile` (1–1 với `CandidateProfile` qua `candidateId @unique`, `onDelete: Cascade`; `gpa`, `gpaScale`, `ielts`, `toefl`, `jlpt`, `educationLevel` đều nullable; `@@index([candidateId])`)
    - Thêm model `EssayDraft` (candidateId + relation cascade, `docType EssayDocType`, `programId?`, `content`, `aiGenerated @default(false)`, `status EssayStatus @default(DRAFT)`, `approvedBy?`, `approvedAt?`, timestamps; `@@index([candidateId])`, `@@index([status])`)
    - Thêm model `InterviewSession` (candidateId + relation cascade, `country`, `visaType @default("")`, `questions Json`, `answers Json`, `feedback Json`, `score Float?`, `assignedAtCreation String?` — snapshot `candidate.assignedTo` lúc tạo, `aiGenerated @default(false)`, timestamps; `@@index([candidateId])`)
    - Thêm model `ApplicationCase` (candidateId + relation cascade, `programId?`, `intakeLabel`, `targetIntakeDate?`, `status ApplicationStatus @default(PLANNING)`, `visaCaseId?` soft link, `createdBy?`, timestamps, quan hệ `dueItems`; `@@index([candidateId])`, `@@index([status])`) và model `ApplicationDueItem` (caseId + relation cascade, `code`, `label`, `category @default("DOCUMENT")`, `required @default(true)`, `dueAt DateTime?`, `status @default("PENDING")`, `done @default(false)`, timestamps; `@@index([caseId])`, `@@index([dueAt])`)
    - Thêm model `ReminderLog` (`dueItemId`, `dueItemType @default("APPLICATION")`, `windowKey`, `status @default("PENDING")`, `notificationId?`, `createdAt`; `@@unique([dueItemId, windowKey])` cho lũy đẳng; `@@index([status])`)
    - Thêm model `RoadmapNarrative` (candidateId + relation cascade, `programId?`, `estimate Json`, `narrative`, `aiGenerated @default(false)`, `status EssayStatus @default(DRAFT)` tái dùng vòng đời REVIEW MODE, `approvedBy?`, `approvedAt?`, timestamps; `@@index([candidateId])`, `@@index([status])`)
    - Thêm cột nullable `minToefl Int?`, `minJlpt String?`, `selectivityTier String?` (HIGH|MEDIUM|LOW) trên `DestinationProgram` (thiếu → không ràng buộc chiều đó / coi như MEDIUM khi phân band)
    - Thêm quan hệ ngược trên `CandidateProfile`: `academic AcademicProfile?`, `essays EssayDraft[]`, `interviews InterviewSession[]`, `applications ApplicationCase[]`, `roadmaps RoadmapNarrative[]` (không sửa cột hiện có)
    - Toàn bộ là `CREATE TYPE`/`CREATE TABLE`/`ADD COLUMN`; không `DROP`/`ALTER ... DROP`, không đổi kiểu cột hiện có
    - _Requirements: 1.1, 1.2, 2.1, 6.1, 6.5, 8.4, 9.1, 11.2, 12.2, 12.3, 13.1, 13.2, 13.4, 15.2, 16.1, 17.3, 21.1_

  - [x] 1.2 Sinh client và tạo migration Prisma
    - Chạy `npm run prisma:generate`, sau đó `npx prisma migrate dev --name study_abroad_advisor` (local) để tạo file migration cho các bảng/cột/enums mới
    - Xác minh migration biên dịch và phản ánh đúng schema; chỉ thêm mới (additive), không sửa dữ liệu hiện có
    - _Requirements: 21.1_

- [x] 2. Admissions — logic thuần + property test (`src/admissions/`)
  - [x] 2.1 Hiện thực `autotgc-backend/src/admissions/types.ts` + `autotgc-backend/src/admissions/admissionScorer.ts`
    - Định nghĩa types dùng chung: `AdmissionBandValue`, `SelectivityTier`, `AcademicSignals`, `ProgramThresholds`, `GapItem`, `AdmissionResult`
    - Export `normalizeGpa(gpa, gpaScale)`: chỉ chuẩn hóa `gpa / gpaScale` khi `gpaScale > 0` (điều kiện tiên quyết); ngược lại trả `undefined` (coi chiều GPA thiếu dữ liệu, không chia)
    - Export `scoreAdmission(academic, thresholds, finance)`: tổng hợp các chiều học thuật (GPA chuẩn hóa, IELTS/TOEFL/JLPT, học vấn) + chiều phù hợp tài chính lấy từ `scholarshipMatcher.scoreFinance` (tái dùng, KHÔNG tự tính lại chi phí); chiều đạt ngưỡng đóng góp điểm không âm tỉ lệ mức vượt ngưỡng, chiều không đạt đóng góp 0 và không được nâng nhờ chiều khác; thuần + xác định, luôn ∈ [0,1]; mọi tín hiệu bắt buộc thiếu → `'INSUFFICIENT_DATA'`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8_
    - _Properties: 1_

  - [x] 2.2 Hiện thực `autotgc-backend/src/admissions/admissionBand.ts`
    - Export `BAND_CUTOFFS` (ngưỡng band phụ thuộc độ chọn lọc: HIGH cần điểm cao hơn LOW để cùng band; thiếu `selectivityTier` → coi như MEDIUM)
    - Export `classifyBand(score, selectivity)`: gán đúng một band `REACH|MATCH|SAFETY` khi điểm là số ∈ [0,1]; passthrough `'INSUFFICIENT_DATA'`; xác định và đơn điệu theo điểm ở cùng độ chọn lọc
    - Export `bandRank(band)`: hạng band cho so sánh đơn điệu (SAFETY=2 ≻ MATCH=1 ≻ REACH=0)
    - _Requirements: 3.1, 3.2, 3.4, 3.5, 3.6, 3.7_
    - _Properties: 2_

  - [x] 2.3 Hiện thực `autotgc-backend/src/admissions/gapSuggestion.ts`
    - Export `suggestGaps(academic, thresholds)`: liệt kê các chiều chưa đạt kèm ngưỡng mục tiêu lấy TỪ chương trình (không bịa số mới); đáp ứng mọi ngưỡng đã xác minh → `[]`; không có ngưỡng công bố / ngưỡng không so sánh được / không verify được → `'INSUFFICIENT_DATA'`; thuần + xác định (cùng đầu vào → cùng danh sách cùng thứ tự)
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7_
    - _Properties: 3_

  - [x]* 2.4 Viết property test cho chấm trúng tuyển
    - **Property 1: Điểm trúng tuyển trong [0,1], xác định, an toàn chuẩn hóa GPA, và INSUFFICIENT_DATA khi thiếu tín hiệu**
    - **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 19.1**
    - File: `autotgc-backend/test/admissions.properties.test.ts`; tag `// Feature: study-abroad-ai-advisor-suite, Property 1: ...`; khẳng định kết quả ∈ [0,1] hoặc `INSUFFICIENT_DATA`, không `NaN`/`Infinity`, chuẩn hóa GPA chỉ khi `gpaScale > 0`, tính xác định; `fc.assert(..., { numRuns: 100 })` trở lên

  - [x]* 2.5 Viết property test cho phân band
    - **Property 2: Phân band xác định, nhận biết độ chọn lọc, đơn điệu theo điểm, và passthrough INSUFFICIENT_DATA**
    - **Validates: Requirements 3.1, 3.2, 3.4, 3.5, 3.6, 3.7, 19.2**
    - File: `autotgc-backend/test/admissions.properties.test.ts`; tag `// Feature: study-abroad-ai-advisor-suite, Property 2: ...`; khẳng định `s1 ≤ s2` ở cùng độ chọn lọc ⇒ `bandRank(classifyBand(s2)) ≥ bandRank(classifyBand(s1))`; `fc.assert(..., { numRuns: 100 })` trở lên

  - [x]* 2.6 Viết property test cho gợi ý gap
    - **Property 3: Gợi ý gap chỉ dùng ngưỡng chương trình, xác định, và phân biệt rỗng-đã-xác minh với INSUFFICIENT_DATA**
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7**
    - File: `autotgc-backend/test/admissions.properties.test.ts`; tag `// Feature: study-abroad-ai-advisor-suite, Property 3: ...`; khẳng định mọi `target` đều bằng một ngưỡng do chương trình công bố, tính xác định, phân biệt `[]` với `INSUFFICIENT_DATA`; `fc.assert(..., { numRuns: 100 })` trở lên

- [x] 3. Essays — logic thuần + property test (`src/essays/`)
  - [x] 3.1 Hiện thực `autotgc-backend/src/essays/essayStateMachine.ts`
    - Export `EssayStatus`, `ESSAY_TRANSITIONS`, `essayTransition(current, target)` trả `{ ok:true, status:target }` cho bước hợp lệ `{DRAFT→IN_REVIEW, IN_REVIEW→APPROVED, DRAFT→ARCHIVED, IN_REVIEW→ARCHIVED}` và `{ ok:false, status:409 }` cho bước sai (mẫu `reportStateMachine.ts`); thuần + xác định
    - _Requirements: 8.1, 8.2, 8.5_
    - _Properties: 10_

  - [x] 3.2 Hiện thực `autotgc-backend/src/essays/essayReviewer.ts` + `autotgc-backend/src/essays/types.ts`
    - Định nghĩa `EssayDocType`, `RubricCriterion`, `EssayReview`
    - Export `reviewEssay(content, docType, rubric)`: trung bình CÓ TRỌNG SỐ các tiêu chí (cấu trúc, độ liên quan, giới hạn độ dài, các phần bắt buộc); thuần + xác định; tổng trọng số = 0 → trả điểm mặc định `0.0` (∈[0,1]) và TIẾP TỤC chấm, không chia, không hard-fail; không bao giờ trả điểm ngoài [0,1]
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.6_
    - _Properties: 4_

  - [x]* 3.3 Viết property test cho chấm essay
    - **Property 4: Điểm chấm essay trong [0,1], xác định, và an toàn khi tổng trọng số bằng 0**
    - **Validates: Requirements 7.1, 7.2, 7.4, 7.6, 19.3**
    - File: `autotgc-backend/test/essays.properties.test.ts`; tag `// Feature: study-abroad-ai-advisor-suite, Property 4: ...`; khẳng định `score` ∈ [0,1] không `NaN`/`Infinity`, tổng trọng số 0 → `0.0`, cùng bài + cùng rubric → cùng `score` và cùng feedback; `fc.assert(..., { numRuns: 100 })` trở lên

  - [x]* 3.4 Viết property test cho state machine essay
    - **Property 10: Essay_State_Machine chỉ chấp nhận bước hợp lệ**
    - **Validates: Requirements 8.1, 8.2, 8.5, 17.3, 19.9**
    - File: `autotgc-backend/test/essays-statemachine.properties.test.ts`; tag `// Feature: study-abroad-ai-advisor-suite, Property 10: ...`; khẳng định `{ ok:true }` ⇔ cặp thuộc tập hợp lệ, mọi cặp khác → `{ ok:false, status:409 }`, hàm thuần xác định; `fc.assert(..., { numRuns: 100 })` trở lên

- [x] 4. Interview prep — logic thuần + property test (`src/interviewprep/`)
  - [x] 4.1 Hiện thực `autotgc-backend/src/interviewprep/interviewQuestionBank.ts` + `autotgc-backend/src/interviewprep/types.ts`
    - Định nghĩa `InterviewQuestion`
    - Export `questionBankFor(country, visaType?)`: bộ câu hỏi xác định theo quốc gia/loại visa, grounding tri thức quốc gia của `visaCatalog` (tái dùng `normalizeCountry`/`hasCountryTemplate`); quốc gia không có template → bộ câu hỏi chung an toàn; thuần + xác định
    - _Requirements: 10.1, 10.3, 10.4_

  - [x] 4.2 Hiện thực `autotgc-backend/src/interviewprep/interviewScorer.ts`
    - Định nghĩa `AnswerCriterion`, `InterviewScore`
    - Export `scoreAnswer(criteria)`: chấm theo rubric xác định, thuần; luôn ∈ [0,1]; tổng trọng số = 0 → trả ĐỒNG THỜI `insufficientData=true` VÀ một `score` hữu hạn (mặc định `0.0`), không chia
    - _Requirements: 11.2, 11.3, 11.5, 11.6_
    - _Properties: 5_

  - [x]* 4.3 Viết property test cho chấm phỏng vấn
    - **Property 5: Điểm chấm phỏng vấn trong [0,1] và dual-return khi tổng trọng số bằng 0**
    - **Validates: Requirements 11.2, 11.3, 11.5, 11.6, 19.4**
    - File: `autotgc-backend/test/interviewprep.properties.test.ts`; tag `// Feature: study-abroad-ai-advisor-suite, Property 5: ...`; khẳng định `score` ∈ [0,1] không `NaN`/`Infinity`, tổng trọng số 0 → `insufficientData=true` kèm `score` hữu hạn, hàm thuần xác định; `fc.assert(..., { numRuns: 100 })` trở lên

- [x] 5. Applications & timeline — logic thuần + property test (`src/applications/`)
  - [x] 5.1 Hiện thực `autotgc-backend/src/applications/timelineComputer.ts` + `autotgc-backend/src/applications/types.ts`
    - Định nghĩa `DueItem`
    - Export `computeTimeline(items, now)`: gộp `Due_Item` mọi `ApplicationCase` + `VisaCase`, thuần + xác định; BẢO TOÀN TẬP (mỗi item hợp lệ xuất hiện đúng một lần); sắp `dueAt` tăng dần, tie-break ổn định (`dueAt`, rồi `code`, rồi `id`); `dueAt = null` xếp SAU mọi việc có hạn (sắp theo `code`, `id`); tất cả `null` vẫn hợp lệ
    - Export `nextDue(items, now)`: chỉ xét `Due_Item` chưa hoàn tất
    - Export `inReminderWindow(item, now, windowDays)`: cờ "trong cửa sổ nhắc" theo leadDays trước hạn (chưa hoàn tất, có hạn xác định)
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7_
    - _Properties: 6_

  - [x]* 5.2 Viết property test cho dòng thời gian
    - **Property 6: Dòng thời gian bảo toàn tập, xác định, sắp hạn tăng dần với hạn-undefined xếp cuối**
    - **Validates: Requirements 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7, 19.5**
    - File: `autotgc-backend/test/applications.properties.test.ts`; tag `// Feature: study-abroad-ai-advisor-suite, Property 6: ...`; khẳng định cùng multiset id, thứ tự `dueAt` không giảm với `null` xếp cuối, tính xác định, và `nextDue` không bao giờ trả item `done===true`; `fc.assert(..., { numRuns: 100 })` trở lên

- [x] 6. Roadmap & readiness — logic thuần + property test (`src/roadmap/`)
  - [x] 6.1 Hiện thực `autotgc-backend/src/roadmap/roadmapEstimator.ts` + `autotgc-backend/src/roadmap/types.ts`
    - Định nghĩa `RoadmapEstimate`, `KnowledgeNote`
    - Export `estimateRoadmap(student, program, knowledge, expectedAnnualIncomeVndM?)`: thuần + xác định; `netCostPerYearVndM` lấy đúng từ `scholarshipMatcher.scoreFinance` (tái dùng, không tự tính lại); mẫu số ROI = 0 hoặc thiếu dữ liệu tài chính bắt buộc → `'INSUFFICIENT_DATA'` cho chỉ số đó; `careerNotes`/`prPathwayNotes` grounding `Knowledge_Base`, KHÔNG cam kết định cư
    - _Requirements: 16.1, 16.2, 16.4, 16.5_
    - _Properties: 9_

  - [x] 6.2 Hiện thực `autotgc-backend/src/roadmap/readinessScorer.ts`
    - Định nghĩa `ReadinessResult`
    - Export `scoreReadiness(input)`: trung bình các thành phần hiện diện — tỷ lệ giấy tờ (tái dùng `completionMetric`), sự hiện diện tín hiệu học thuật, trình độ ngôn ngữ so với mục tiêu; thuần + xác định, luôn ∈ [0,1]; tổng số thành phần đầu vào = 0 → `'INSUFFICIENT_DATA'` (không chia); kèm `Gap_Suggestion` có căn cứ cho thành phần thiếu (tái dùng `GapItem` của admissions)
    - _Requirements: 18.1, 18.2, 18.3, 18.4, 18.6_
    - _Properties: 8_

  - [x]* 6.3 Viết property test cho ước lượng lộ trình
    - **Property 9: Ước lượng lộ trình xác định, tái dùng chi phí ròng, và INSUFFICIENT_DATA khi thiếu dữ liệu tài chính**
    - **Validates: Requirements 16.1, 16.2, 16.4, 16.5, 19.8**
    - File: `autotgc-backend/test/roadmap.properties.test.ts`; tag `// Feature: study-abroad-ai-advisor-suite, Property 9: ...`; khẳng định tính xác định, `netCostPerYearVndM === scoreFinance(student, program).netCostPerYearVndM`, mẫu số 0/thiếu tài chính → `INSUFFICIENT_DATA`; `fc.assert(..., { numRuns: 100 })` trở lên

  - [x]* 6.4 Viết property test cho điểm sẵn sàng
    - **Property 8: Điểm sẵn sàng hồ sơ trong [0,1], xác định, và an toàn chia 0**
    - **Validates: Requirements 18.1, 18.2, 18.4, 18.6, 19.7**
    - File: `autotgc-backend/test/roadmap.properties.test.ts`; tag `// Feature: study-abroad-ai-advisor-suite, Property 8: ...`; khẳng định `score` ∈ [0,1] không `NaN`/`Infinity` hoặc `INSUFFICIENT_DATA` khi tổng thành phần = 0, hàm thuần xác định; `fc.assert(..., { numRuns: 100 })` trở lên

- [x] 7. Services (I/O) — mô phỏng `visaService` SALES scoping
  - [x] 7.1 Hiện thực `autotgc-backend/src/admissions/admissionService.ts`
    - `upsertAcademic(candidateId, input, actor)`: validate `gpa ∈ [0, gpaScale]` → 400 (Req 1.4), `ielts ∈ [0, 9]` → 400 (Req 1.5); `getAcademic`; `scoreCandidate(candidateId, actor)` chấm toàn danh mục chương trình active → `AdmissionResult[]`, sắp ổn định: band thuận lợi trước, rồi điểm giảm dần, rồi tên, rồi id; cặp `INSUFFICIENT_DATA` xếp cuối
    - SALES assigned-only qua `candidate.assignedTo` (ngoài phạm vi → 403), ADMIN mọi ứng viên, ứng viên không tồn tại → 404
    - _Requirements: 1.3, 1.4, 1.5, 1.6, 5.1, 5.3, 5.4, 5.5, 5.6_

  - [x] 7.2 Hiện thực `autotgc-backend/src/essays/essayService.ts` + `autotgc-backend/src/essays/essayWriter.ts`
    - `essayWriter.ts`: export `buildStructuredDraft(ctx, docType)` (bản nháp xác định, không secret) và class `EssayWriter.write(ctx, docType, mode)` Gemini-optional — `mode='STRUCTURED'` luôn `aiGenerated=false`; `mode='AI'` dùng Gemini khi có key (`aiGenerated=true`), không key/lỗi → fallback xác định `aiGenerated=false`, KHÔNG ném 502; không nhúng secret
    - `essayService.ts`: `create` (docType ∉ {SOP,MOTIVATION,CV} → 400, lưu DRAFT); `review` (content rỗng sau trim → 400, trả `EssayReview`); `transition` (gọi `essayTransition`, `ok:false` → 409, APPROVED ghi `approvedBy`/`approvedAt`); `list`; SALES full CRUD trên ứng viên được phân công, ngoài phạm vi → 403, ADMIN mọi bản nháp; `ownerUserId` từ `candidate.assignedTo`
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 7.5, 8.2, 8.4, 9.2, 9.3, 9.4, 20.1, 20.2, 22.5_

  - [x] 7.3 Hiện thực `autotgc-backend/src/interviewprep/interviewService.ts` + `autotgc-backend/src/interviewprep/interviewAgent.ts`
    - `interviewAgent.ts`: class `InterviewAgent` Gemini-optional — Gemini có key & quốc gia CÓ trong `visaCatalog` → dùng Gemini (`aiGenerated=true`); không key/lỗi HOẶC quốc gia KHÔNG có template → `questionBankFor`, `aiGenerated=false` (không sinh AI cho quốc gia lạ); phát hiện secret trong prompt → fail request; `reviewAnswers` grounding `Knowledge_Base` + `Visa_Catalog`, không bịa chính sách lãnh sự
    - `interviewService.ts`: `create` SNAPSHOT `candidate.assignedTo` vào `assignedAtCreation` cho RBAC tại thời điểm tạo; `answer` (lưu câu trả lời + phản hồi + điểm); `score`; `list`; SALES assigned-only resolve từ `assignedAtCreation`
    - _Requirements: 10.2, 10.5, 10.6, 11.1, 11.4, 12.1, 12.2, 12.3, 12.4, 12.5_

  - [x] 7.4 Hiện thực `autotgc-backend/src/applications/applicationService.ts` + `autotgc-backend/src/applications/timelineAgent.ts`
    - `applicationService.ts`: `createCase` (tạo `ApplicationCase`; quốc gia CÓ trong `visaCatalog` → init `ApplicationDueItem` qua `checklistFor` + `withDeadlines`; chưa có `targetIntakeDate` → `dueAt=null`, không bịa hạn); `timeline` (gộp mọi `ApplicationCase` + `VisaCase`, gọi `computeTimeline`)
    - `timelineAgent.ts`: `sweepDueReminders(now)` tạo Reminder lũy đẳng qua `ReminderLog @@unique(dueItemId, windowKey)` (chỉ tính cho Reminder còn pending của cùng Due_Item; Reminder đã RESOLVED/CANCELLED → cho phép tạo mới; chạy lại cùng trạng thái → không trùng); Due_Item đã hoàn tất → không nhắc; lỗi tạo Reminder/realtime được nuốt best-effort, KHÔNG hoàn tác tính dòng thời gian
    - _Requirements: 13.1, 13.3, 13.4, 14.1, 15.1, 15.2, 15.3, 15.5, 15.6_

  - [x]* 7.5 Viết property test cho lũy đẳng nhắc dòng thời gian
    - **Property 7: Tạo Reminder là lũy đẳng theo Due_Item**
    - **Validates: Requirements 15.2, 15.4, 19.6**
    - File: `autotgc-backend/test/applications-reminder.properties.test.ts`; tag `// Feature: study-abroad-ai-advisor-suite, Property 7: ...`; dùng in-memory fake store mô phỏng `@@unique(dueItemId, windowKey)`; khẳng định chạy `sweepDueReminders` hai lần liên tiếp tạo thêm 0 Reminder ở lần hai và mỗi Due_Item có không quá một Reminder pending cho cùng cửa sổ; `fc.assert(..., { numRuns: 100 })` trở lên
    - _Properties: 7_

  - [x] 7.6 Hiện thực `autotgc-backend/src/roadmap/roadmapService.ts` + `autotgc-backend/src/roadmap/roadmapNarrative.ts`
    - `roadmapNarrative.ts`: class `RoadmapNarrative` Gemini-optional — có key → diễn giải `aiGenerated=true`; không key/lỗi → bản tường thuật xác định từ `RoadmapEstimate`, `aiGenerated=false`, KHÔNG ném 502; không nhúng secret, không cam kết định cư bịa đặt
    - `roadmapService.ts`: `estimate` (gọi `estimateRoadmap`); `readiness` (gọi `scoreReadiness`); `createNarrative` (lưu `RoadmapNarrative` ở DRAFT — REVIEW MODE); `transitionNarrative` (tái dùng `essayTransition`, bước sai → 409); SALES assigned-only, ADMIN mọi ứng viên
    - _Requirements: 16.1, 16.5, 17.1, 17.2, 17.3, 17.4, 17.5, 18.1, 18.5_

- [x] 8. Route + RBAC wiring — mỗi module một `routes.ts`
  - [x] 8.1 Hiện thực `autotgc-backend/src/admissions/routes.ts` (`registerAdmissionsRoutes`)
    - GET/PUT `/api/v1/candidates/:id/academic-profile`, POST `/api/v1/candidates/:id/admissions/score`; sau `requireAuth` + `rbacGuard` (module `lead_management`); `ownerUserId` từ `candidate.assignedTo` (mẫu `candidateTargetById`); SALES assigned-only → 403 ngoài phạm vi; chỉ dùng tập mã trạng thái cho phép
    - _Requirements: 1.6, 5.2, 5.3, 5.4, 21.6, 21.7_

  - [x] 8.2 Hiện thực `autotgc-backend/src/essays/routes.ts` (`registerEssayRoutes`)
    - POST/GET `/api/v1/candidates/:id/essays`, POST `/api/v1/candidates/:id/essays/:essayId/review`, POST `/api/v1/candidates/:id/essays/:essayId/transition`, DELETE `/api/v1/candidates/:id/essays/:essayId` (map action `update` để SALES full CRUD); sau `requireAuth` + `rbacGuard`; `ownerUserId` từ `candidate.assignedTo`
    - _Requirements: 9.2, 9.3, 9.4, 9.5, 22.5_

  - [x] 8.3 Hiện thực `autotgc-backend/src/interviewprep/routes.ts` (`registerInterviewPrepRoutes`)
    - POST/GET `/api/v1/candidates/:id/interview-sessions`, POST `/api/v1/candidates/:id/interview-sessions/:sessionId/answer`, POST `/api/v1/candidates/:id/interview-sessions/:sessionId/score`; sau `requireAuth` + `rbacGuard`; `ownerUserId` resolve từ `assignedAtCreation` của phiên (không dùng phân công hiện tại)
    - _Requirements: 12.3, 12.4, 12.5_

  - [x] 8.4 Hiện thực `autotgc-backend/src/applications/routes.ts` (`registerApplicationRoutes`)
    - POST/GET `/api/v1/candidates/:id/applications`, GET `/api/v1/candidates/:id/applications/timeline`; sau `requireAuth` + `rbacGuard`; `ownerUserId` từ `candidate.assignedTo`; SALES assigned-only
    - _Requirements: 13.1, 14.1, 22.1, 22.2, 22.4_

  - [x] 8.5 Hiện thực `autotgc-backend/src/roadmap/routes.ts` (`registerRoadmapRoutes`)
    - POST `/api/v1/candidates/:id/roadmap`, GET `/api/v1/candidates/:id/roadmap/readiness`, POST `/api/v1/candidates/:id/roadmap/narrative`, POST `/api/v1/candidates/:id/roadmap/narrative/:nid/transition`; sau `requireAuth` + `rbacGuard`; `ownerUserId` từ `candidate.assignedTo`; bước state machine sai → 409
    - _Requirements: 17.3, 18.1, 22.1, 22.2, 22.4_

- [x] 9. Wiring & scheduler
  - [x] 9.1 Đăng ký các registrar route mới trong `autotgc-backend/src/app.ts`
    - Gọi `registerAdmissionsRoutes`, `registerEssayRoutes`, `registerInterviewPrepRoutes`, `registerApplicationRoutes`, `registerRoadmapRoutes` (mẫu các `registerXxxRoutes` hiện có); đảm bảo tất cả nằm sau `requireAuth` + `rbacGuard`, không tạo endpoint không xác thực
    - _Requirements: 21.6_

  - [x] 9.2 Đăng ký job quét nhắc dòng thời gian trong `autotgc-backend/src/infra/jobs.ts`
    - Chèn job `study-timeline-sweep` vào `startScheduledJobs` (mẫu `registerReportJobs`) gọi `TimelineAgent.sweepDueReminders(now)`; cron `CRON_TIMELINE_SWEEP` (optional, mặc định `*/30 * * * *`); lỗi job được `NodeCronScheduler` bắt + log theo tên job + timestamp; thêm dòng `CRON_TIMELINE_SWEEP` vào `autotgc-backend/.env.example`
    - _Requirements: 15.1, 21.4_

- [x] 10. Frontend tối thiểu (React 18 + react-query) — additive, tái dùng API client + `RealtimeContext`
  - [x] 10.1 Panel Admissions Reach/Match/Safety — `autotgc-frontend/src/api/studyAdvisor.ts` + component `AdmissionsPanel.tsx`, wire vào `autotgc-frontend/src/pages/CandidateDetail.tsx`
    - Form học thuật (gpa/gpaScale/ielts/toefl/jlpt), nút chấm trúng tuyển, hiển thị danh sách chương trình theo band REACH/MATCH/SAFETY + điểm + gaps; hiển thị "Chưa đủ dữ liệu" khi `INSUFFICIENT_DATA`
    - _Requirements: 1.1, 5.1_

  - [x] 10.2 Section Essays (list + review) — component `EssaysPanel.tsx`, wire vào `autotgc-frontend/src/pages/CandidateDetail.tsx`
    - Tạo bản nháp (chọn `docType` + `mode` AI|STRUCTURED), danh sách bản nháp với badge trạng thái + cờ `aiGenerated`, nút chấm rubric hiển thị điểm + feedback, nút chuyển trạng thái (REVIEW MODE)
    - _Requirements: 6.1, 7.1, 8.1_

  - [x] 10.3 Trang luyện phỏng vấn — `autotgc-frontend/src/pages/InterviewPrep.tsx` + route/menu trong `autotgc-frontend/src/App.tsx`
    - Tạo phiên theo quốc gia/loại visa, hiển thị bộ câu hỏi + cờ `aiGenerated`, nhập câu trả lời nhận phản hồi grounding, xem điểm phiên
    - _Requirements: 10.1, 11.1, 12.1_

  - [x] 10.4 Section Timeline hồ sơ — component `TimelinePanel.tsx`, wire vào `autotgc-frontend/src/pages/CandidateDetail.tsx`
    - Tạo `ApplicationCase` (program + intake), hiển thị dòng thời gian gộp mọi case theo hạn tăng dần (hạn chưa xác định xếp cuối), đánh dấu việc đến hạn tiếp theo
    - _Requirements: 13.1, 14.1_

  - [x] 10.5 Section Roadmap + Readiness — component `RoadmapPanel.tsx`, wire vào `autotgc-frontend/src/pages/CandidateDetail.tsx`
    - Hiển thị ước lượng ROI (chi phí ròng, ghi chú nghề/định cư, "Chưa đủ dữ liệu" khi `INSUFFICIENT_DATA`), điểm sẵn sàng + gaps, tạo/duyệt bản tường thuật lộ trình (REVIEW MODE) với cờ `aiGenerated`
    - _Requirements: 16.1, 17.3, 18.1, 18.5_

- [x] 11. Kiểm chứng xuyên suốt & triển khai
  - [x] 11.1 Biên dịch backend
    - Chạy `npm run build` trong `autotgc-backend/`; sửa mọi lỗi type/compile trước khi tiếp tục
    - _Requirements: 21.2_

  - [x] 11.2 Chạy toàn bộ bộ test
    - Chạy `npm test` trong `autotgc-backend/`; xác nhận toàn bộ property/unit/integration test xanh và mỗi property test (1–10) chạy ≥100 trường hợp
    - _Requirements: 19.1, 19.2, 19.3, 19.4, 19.5, 19.6, 19.7, 19.8, 19.9, 19.10_

  - [x] 11.3 Lint và quét secret
    - Chạy `npm run lint` và `npm run secret-scan` trong `autotgc-backend/`; xác nhận không nhúng secret vào prompt/answer và không log giá trị bí mật
    - _Requirements: 20.4, 21.4_

  - [x] 11.4 Ghi chú runbook triển khai
    - Soạn `autotgc-backend/deploy/DEPLOY-RUNBOOK-study-abroad-advisor.md`: `prisma migrate deploy`, build, restart PM2 dưới user non-root sau Nginx, fail-fast secrets (chỉ log tên biến khi thiếu)
    - _Requirements: 21.1, 21.3, 21.4, 21.5_

- [x] 12. Checkpoint cuối — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Các sub-task gắn hậu tố `*` là test tùy chọn (property test), có thể bỏ qua cho MVP nhanh nhưng nên thực hiện để đảm bảo đúng đắn.
- Mỗi correctness property (1–10) được hiện thực bằng đúng một property test theo module (`autotgc-backend/test/<module>.properties.test.ts`), gắn comment `// Feature: study-abroad-ai-advisor-suite, Property {n}: ...`, chạy fast-check với `numRuns ≥ 100` (Req 19.10). Property 7 tách file riêng (`applications-reminder.properties.test.ts`) để cô lập fake store.
- Mỗi task tham chiếu requirement (và property nơi áp dụng) để truy vết.
- Mọi route mới đứng sau `requireAuth` + `rbacGuard`; mã trạng thái thuộc tập cho phép; Gemini là optional với fallback xác định (`aiGenerated=false`, không 502).
- Thay đổi schema là additive; migration kèm theo (Req 21.1).

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["2.1", "3.1", "3.2", "4.1", "4.2", "5.1", "6.1"] },
    { "id": 3, "tasks": ["2.2", "2.3", "6.2", "2.4", "3.3", "3.4", "4.3", "5.2", "6.3", "7.2", "7.3", "7.4"] },
    { "id": 4, "tasks": ["2.5", "6.4", "7.1", "7.5", "7.6", "8.2", "8.3", "8.4", "9.2"] },
    { "id": 5, "tasks": ["2.6", "8.1", "8.5"] },
    { "id": 6, "tasks": ["9.1"] },
    { "id": 7, "tasks": ["10.1", "10.3"] },
    { "id": 8, "tasks": ["10.2"] },
    { "id": 9, "tasks": ["10.4"] },
    { "id": 10, "tasks": ["10.5"] },
    { "id": 11, "tasks": ["11.1"] },
    { "id": 12, "tasks": ["11.2", "11.3"] },
    { "id": 13, "tasks": ["11.4"] }
  ]
}
```

# Implementation Plan: deepseek-v4-model-migration

## Overview

Kế hoạch hiện thực việc chuyển nhà cung cấp sinh **văn bản** sang DeepSeek V4 theo `design.md`. Nguyên tắc: **migration là thay đổi cấu hình sau seam** — KHÔNG đổi điểm gọi consumer, KHÔNG đổi Prisma schema. Các bước xây dựng tăng dần:

1. Tách lõi cấu hình thuần (`aiTextConfig.ts`) + helper bất biến AI-OPTIONAL (`enforceAiGeneratedFlag`).
2. Đổi tên `GeminiClient`→`AiTextClient` (giữ alias) và tách `extractText` thành hàm thuần export được.
3. Lắp ráp lại `composeServices` (parse + fail-fast + 1 thể hiện chia sẻ, mặc định `deepseek-v4-flash`), giữ nguyên tuyến media.
4. Tái grounding (xác nhận/bảo toàn thứ tự lắp ráp prompt xác định, degrade nhẹ) + tích hợp guard cờ `aiGenerated`.
5. Tài liệu vận hành (`.env.example`, runbook) và xác minh cuối (build/test/lint/secret-scan).

Ngôn ngữ: TypeScript (strict), Vitest + fast-check (đã có trong stack). Mỗi property test tối thiểu `{ numRuns: 100 }` và gắn nhãn:
`// Feature: deepseek-v4-model-migration, Property {N}: {property_text}`. Test đặt dưới `autotgc-backend/test/`.

## Tasks

- [x] 1. Tạo module cấu hình AI text thuần `src/infra/aiTextConfig.ts` (Config_Parser + Pretty_Printer)
  - [x] 1.1 Định nghĩa kiểu + hằng số + `parseAiTextConfig` + `parseAiTextConfigFromSecrets`
    - Tạo tệp mới `autotgc-backend/src/infra/aiTextConfig.ts`
    - Khai báo `AiTextConfig` ĐÚNG bốn thuộc tính `{provider, baseUrl, model, timeout}`, các kiểu `RawAiTextConfig`, `ConfigParseResult` (`ConfigParseOk`/`ConfigParseError` với `invalidKey: 'baseUrl' | 'model'`)
    - Khai báo hằng số `AI_TEXT_DEFAULT_MODEL='deepseek-v4-flash'`, `AI_TEXT_DEFAULT_TIMEOUT_MS=20000`, `AI_TEXT_MIN_TIMEOUT_MS=100`
    - `parseAiTextConfig`: chuẩn hóa timeout (hợp lệ ⇔ số hữu hạn, `>0`, `>=100`; ngược lại `20000`); mặc định model `deepseek-v4-flash` khi vắng; từ chối `baseUrl`/`model` rỗng/khoảng-trắng và chỉ rõ `invalidKey`; KHÔNG nhận/giữ apiKey trong `AiTextConfig`
    - `parseAiTextConfigFromSecrets(secrets)`: đọc `GEMINI_BASE_URL`/`GEMINI_MODEL`/`GEMINI_TIMEOUT_MS` từ `SecretLoader` rồi gọi `parseAiTextConfig`
    - _Requirements: 2.1, 2.2, 2.3, 6.1, 6.4, 6.5_

  - [x]* 1.2 Viết property test cho `parseAiTextConfig`
    - Tệp `test/aiTextConfig.properties.test.ts`, fast-check `{ numRuns: 100 }` (R7.1)
    - **Property 1: Config hợp lệ tạo đối tượng đúng bốn thuộc tính** — **Validates: Requirements 6.1**
    - **Property 2: Chuẩn hóa timeout** — **Validates: Requirements 2.3, 6.4**
    - **Property 10: Từ chối cấu hình không hợp lệ và chỉ rõ khóa sai** — **Validates: Requirements 6.5**
    - **Property 12: Mặc định model** — **Validates: Requirements 2.2**
    - Generators phủ edge case: chuỗi rỗng/khoảng-trắng/Unicode; timeout NaN/Infinity/âm/<100/chuỗi-số/chuỗi-không-số/vắng mặt

  - [x] 1.3 Hiện thực `printAiTextConfig` (Pretty_Printer) + `parsePrintedAiTextConfig`
    - Trong cùng `src/infra/aiTextConfig.ts`
    - `printAiTextConfig`: in `khóa=giá trị` mỗi dòng cho đúng bốn thuộc tính, biểu diễn ổn định, KHÔNG chứa apiKey/bất kỳ bí mật nào
    - `parsePrintedAiTextConfig`: đọc lại text → `AiTextConfig` đối xứng (round-trip), chuẩn hóa `timeout` về số
    - _Requirements: 6.2, 6.3_

  - [x]* 1.4 Viết property test cho Pretty_Printer (round-trip + không lộ bí mật)
    - Tệp `test/aiTextConfig-printer.properties.test.ts`, fast-check `{ numRuns: 100 }` (R7.1)
    - **Property 11: Round-trip in→đọc cấu hình** — **Validates: Requirements 6.3**
    - **Property 7: Không lộ bí mật trong đầu ra** (phần (a): văn bản `printAiTextConfig` không chứa apiKey) — **Validates: Requirements 2.6, 6.2**

- [x] 2. Đổi tên client `GeminiClient`→`AiTextClient` và tách `extractText` (`src/infra/aiTextClient.ts`)
  - [x] 2.1 Đổi tên tệp + lớp, giữ alias, tách `extractText` thuần, đổi chữ ký constructor
    - Đổi tên `autotgc-backend/src/infra/gemini.ts` → `src/infra/aiTextClient.ts`; đổi `GeminiClient`→`AiTextClient`; thêm `export { AiTextClient as GeminiClient }` để import cũ không gãy
    - Tách `extractText(body: unknown): string | undefined` thành **hàm thuần export được**: `content` chuỗi → trả nguyên; `content` mảng `{type,text}` → ghép các `text` kiểu chuỗi theo thứ tự, bỏ phần không có `text` chuỗi, KHÔNG chèn ký tự phân tách; rỗng/không có text/kết quả rỗng → `undefined`
    - Constructor mới `(apiKey: string | undefined, config: AiTextConfig, httpClient?: HttpClient)`; gọi `POST {config.baseUrl}/chat/completions` với `{model: config.model, messages:[{role:'user', content: prompt}]}`, header `Authorization: Bearer <key>`, `timeoutMs = config.timeout`
    - Bảo toàn hành vi + ba lỗi nội bộ 502: `AI_NOT_CONFIGURED` (thiếu apiKey hoặc baseUrl, KHÔNG gọi mạng), `AI_REQUEST_FAILED` (lỗi mạng/timeout/`!res.ok`), `AI_BAD_RESPONSE` (`extractText` trả `undefined`)
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.4, 2.5, 2.7, 2.8, 3.6, 3.7, 7.2, 7.7, 7.8_

  - [x]* 2.2 Viết property test cho `extractText`
    - Tệp `test/aiTextClient-extract.properties.test.ts`, fast-check `{ numRuns: 100 }` (R7.1)
    - **Property 3: Bóc tách nội dung — chuỗi và ghép mảng** — **Validates: Requirements 1.2, 1.3, 7.2, 7.7**
    - **Property 5: Phản hồi không có nội dung văn bản** (nhánh `extractText` → `undefined`) — **Validates: Requirements 3.7, 7.8**
    - Generators: `content` chuỗi rỗng/không rỗng/Unicode; mảng có phần thiếu `text` hoặc `text` không phải chuỗi; body không phải object

  - [x]* 2.3 Viết property test cho `generateContent` qua `HttpClient` mock
    - Tệp `test/aiTextClient-generate.properties.test.ts`, tiêm `HttpClient` giả, fast-check `{ numRuns: 100 }` (R7.1)
    - **Property 4: Guard thiếu cấu hình kết nối** (apiKey vắng/rỗng/khoảng-trắng HOẶC baseUrl rỗng ⇒ `AI_NOT_CONFIGURED`, không gọi `HttpClient`; ngược lại gọi đúng `{baseUrl}/chat/completions`) — **Validates: Requirements 2.4, 2.5, 2.8**
    - **Property 5: AI_BAD_RESPONSE** (2xx nhưng không bóc được chuỗi không rỗng ⇒ `AI_BAD_RESPONSE`) — **Validates: Requirements 3.7, 7.8**
    - **Property 6: AI_REQUEST_FAILED** (`HttpClient` ném hoặc `ok=false` ⇒ `AI_REQUEST_FAILED`) — **Validates: Requirements 3.6**
    - **Property 7: Không lộ bí mật trong đầu ra** (phần (b): thân JSON gửi đi không chứa apiKey) — **Validates: Requirements 2.7**
    - **Property 13: Thân yêu cầu mang model + messages không rỗng + prompt** (model = `config.model`, `messages` không rỗng chứa prompt, header `Authorization: Bearer <key>`) — **Validates: Requirements 1.1**
    - **Property 15: Mã trạng thái HTTP thuộc tập cho phép** (mọi lỗi `AiTextClient` ⇒ `AppError.status === 502`) — **Validates: Requirements 7.3**

- [x] 3. Helper bất biến AI-OPTIONAL `enforceAiGeneratedFlag`
  - [x] 3.1 Hiện thực `enforceAiGeneratedFlag` (hàm thuần)
    - Tạo `autotgc-backend/src/infra/aiOptional.ts` với `enforceAiGeneratedFlag<T extends { aiGenerated: boolean }>(result, source: 'AI' | 'FALLBACK'): T`
    - Khi `source === 'FALLBACK'` và `result.aiGenerated === true` ⇒ trả bản sao với `aiGenerated=false`; ngược lại trả nguyên `result`
    - _Requirements: 3.3, 3.4_

  - [x]* 3.2 Viết property test cho `enforceAiGeneratedFlag`
    - Tệp `test/aiOptional.properties.test.ts`, fast-check `{ numRuns: 100 }` (R7.1)
    - **Property 9: Hàm guard cờ aiGenerated** — **Validates: Requirements 3.4**

- [x] 4. Lắp ráp lại `composeServices` (`src/infra/services.ts`)
  - [x] 4.1 Cập nhật wiring: parse cấu hình, fail-fast, một `AiTextClient` chia sẻ
    - Trong `composeServices`: gọi `parseAiTextConfigFromSecrets(secrets)`; nếu `!ok` ⇒ `throw new Error('AI text config invalid: key "..." ...')` (fail-fast, chỉ nêu tên khóa, KHÔNG giá trị)
    - Dựng `new AiTextClient(secrets.optional('GEMINI_API_KEY'), parsed.config)` và chia sẻ **cùng một** thể hiện cho HTTP layer + scheduled jobs; mặc định model `deepseek-v4-flash` khi `GEMINI_MODEL` vắng
    - GIỮ NGUYÊN `createMediaRenderProvider(secrets)` và toàn bộ wiring khóa media `GEMINI_IMAGE_*`/`VEO_*` (không đụng)
    - _Requirements: 1.5, 2.2, 8.3, 8.4_

  - [x]* 4.2 Viết unit test cho composition + fail-fast khởi động
    - Tệp `test/services-composition.test.ts`
    - Khẳng định cùng một thể hiện `AiTextClient` được dùng chung (R1.5); cấu hình không hợp lệ ⇒ `composeServices` ném lỗi fail-fast (R8.4); thiếu bí mật bắt buộc ⇒ dừng trước `listen`, log chỉ tên bí mật (R8.5)
    - _Requirements: 1.5, 8.4, 8.5_

  - [x]* 4.3 Viết test cô lập tuyến media (media isolation)
    - Tệp `test/media-isolation.test.ts`
    - Khẳng định Config_Parser AI text KHÔNG đọc `GEMINI_IMAGE_*`/`VEO_*`; media provider dựng từ khóa riêng và endpoint `POST {base}/images/generations` không đổi sau migration (R4.1, R4.2); neither modality ⇒ assets SPEC_READY, không gọi images endpoint (R4.3); đúng một modality ⇒ chỉ tổng hợp modality đã cấu hình (R4.4)
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

- [x] 5. Tái grounding (Re_Grounding) + tích hợp guard AI-OPTIONAL ở consumer
  - [x] 5.1 Xác nhận/bảo toàn thứ tự lắp ráp prompt xác định + degrade nhẹ + tích hợp guard cờ
    - Rà soát các builder hiện có (`buildSystemPrompt`, `buildQuestionPrompt`, `buildEssayPrompt`, `buildNarrativePrompt`...) để đảm bảo thứ tự cố định knowledge → persona → brand → analytics và tính thuần (cùng đầu vào ⇒ cùng prompt)
    - Đảm bảo degrade nhẹ khi `KnowledgeService.search` trả rỗng/lỗi: builder vẫn lắp ráp từ ngữ cảnh còn lại và tiếp tục theo AI-OPTIONAL (R5.8)
    - Áp `enforceAiGeneratedFlag(result, 'FALLBACK')` tại các nhánh fallback của consumer (essays/interviewprep/recruitment/roadmap/reporting/marketing) để bảo toàn bất biến `aiGenerated=false`; KHÔNG đổi chữ ký/điểm gọi seam
    - _Requirements: 3.3, 5.1, 5.2, 5.8_

  - [x]* 5.2 Viết property test cho prompt builder (xác định + không lộ bí mật)
    - Tệp `test/regrounding-prompt.properties.test.ts`, fast-check `{ numRuns: 100 }` (R7.1)
    - **Property 14: Prompt grounding xác định và độc lập nhà cung cấp** (gọi hai lần cùng đầu vào ⇒ chuỗi bằng nhau; segment theo thứ tự cố định; truyền nguyên vào `messages`) — **Validates: Requirements 5.1, 5.2**
    - **Property 7: Không lộ bí mật trong đầu ra** (phần (c): prompt lắp ráp không chứa apiKey) — **Validates: Requirements 5.6**

  - [x]* 5.3 Viết property test cho bất biến AI-OPTIONAL của consumer
    - Tệp `test/consumer-ai-optional.properties.test.ts`, seam AI giả (ném `AI_NOT_CONFIGURED`/`AI_REQUEST_FAILED`/`AI_BAD_RESPONSE` hoặc trả text), fast-check `{ numRuns: 100 }`
    - **Property 8: Bất biến AI-OPTIONAL của consumer** (seam ném ⇒ Deterministic_Fallback cùng tập trường cấp cao, nội dung không rỗng, `aiGenerated=false`, không để 502 lan tới người dùng cuối; seam trả text ⇒ dùng text với `aiGenerated=true`) — **Validates: Requirements 3.1, 3.2, 3.5, 3.8, 7.4**
    - Bao gồm trường hợp fallback tự rỗng/không hợp lệ được phép thất bại (R7.6)
    - _Requirements: 3.1, 3.2, 3.5, 3.8, 7.4, 7.6_

  - [x]* 5.4 Viết test Review_Mode không đổi sau migration
    - Tệp `test/review-mode.test.ts`
    - Khẳng định mọi đầu ra AI vẫn đi qua state machine duyệt; không loại đầu ra nào (kể cả xác nhận đơn giản, kể cả tình huống khẩn cấp) bỏ qua phê duyệt của con người
    - _Requirements: 5.3, 5.4, 5.5_

  - [x]* 5.5 Viết integration test opt-in gọi nhà cung cấp thật
    - Tệp `test/aiTextClient.integration.test.ts`; chỉ chạy khi có khóa trong môi trường, `skip` khi không có khóa
    - Khẳng định khi cấu hình thật, `generateContent` trả văn bản thật và consumer được phép dùng phản hồi thật thay vì bắt buộc fallback
    - _Requirements: 7.5_

- [x] 6. Checkpoint — Đảm bảo toàn bộ test pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Tài liệu cấu hình & vận hành
  - [x] 7.1 Cập nhật `autotgc-backend/.env.example` mô tả khóa DeepSeek
    - Cập nhật mô tả `GEMINI_API_KEY`/`GEMINI_MODEL`/`GEMINI_BASE_URL`/`GEMINI_TIMEOUT_MS` cho gateway DeepSeek V4 tương thích OpenAI (giá trị rỗng, KHÔNG chứa bí mật thật); giữ nhóm khóa media `GEMINI_IMAGE_*`/`VEO_*` tách biệt; không hardcode host/IP/khóa
    - _Requirements: 2.9, 8.2_

  - [x] 7.2 Tạo runbook `autotgc-backend/deploy/DEPLOY-RUNBOOK-deepseek-v4-migration.md`
    - Liệt kê khóa cần đặt (base URL, DeepSeek_Model_Id, khóa API, timeout)
    - Các bước xác minh sau triển khai: mỗi bước nêu rõ **một hành động** + **một kết quả kỳ vọng quan sát được**; bao gồm xác nhận `aiGenerated=true` khi cấu hình DeepSeek và Deterministic_Fallback `aiGenerated=false` khi không cấu hình
    - Bước **rollback** về nhà cung cấp trước khi xác minh thất bại; ghi chú fine-tuning trọng số là **ngoài phạm vi** Phase hiện tại
    - _Requirements: 5.7, 8.1, 8.6, 8.7_

- [x] 8. Xác minh tích hợp cuối
  - [x] 8.1 Chạy build/test/lint/secret-scan và sửa lỗi phát sinh
    - Từ `autotgc-backend/`: `npm run build`, `npm test`, `npm run lint`, `npm run secret-scan`
    - Khẳng định alias `GeminiClient` giữ import cũ không gãy; không điểm gọi consumer nào thay đổi; không thay đổi Prisma schema; mọi mã trạng thái thuộc tập cho phép `{200,201,202,400,401,403,404,409,423,500,502}`
    - _Requirements: 1.4, 7.3, 8.2, 8.3_

## Notes

- Các sub-task gắn `*` là tùy chọn (test) và có thể bỏ qua để ra MVP nhanh hơn; các sub-task KHÔNG gắn `*` là cốt lõi bắt buộc.
- Mỗi property test ánh xạ tới một property trong `design.md` và tham chiếu requirement clause tương ứng; tối thiểu `{ numRuns: 100 }` mỗi property (R7.1).
- Phủ property: P1/P2/P10/P12 → 1.2; P11/P7(a) → 1.4; P3/P5 → 2.2; P4/P5/P6/P7(b)/P13/P15 → 2.3; P9 → 3.2; P14/P7(c) → 5.2; P8 → 5.3. Cả 15 property đều có ít nhất một test task.
- Migration KHÔNG đổi điểm gọi consumer và KHÔNG đổi Prisma schema; tuyến media giữ nguyên nhà cung cấp/khóa/endpoint.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "3.1", "7.1", "7.2"] },
    { "id": 1, "tasks": ["1.2", "1.3", "2.1", "3.2"] },
    { "id": 2, "tasks": ["1.4", "2.2", "2.3", "4.1", "5.1"] },
    { "id": 3, "tasks": ["4.2", "4.3", "5.2", "5.3", "5.4", "5.5"] },
    { "id": 4, "tasks": ["8.1"] }
  ]
}
```

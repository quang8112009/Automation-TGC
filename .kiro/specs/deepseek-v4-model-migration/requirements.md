# Requirements Document

## Introduction

Tài liệu này đặc tả yêu cầu cho việc **chuyển model AI sinh văn bản của AutoTGC sang DeepSeek V4** và "huấn luyện lại" model mới theo tri thức đã có sẵn trên hệ thống, theo từng spec.

Bối cảnh kỹ thuật (đã xác minh trong codebase, dùng làm chân lý nền):

- Tích hợp AI sinh văn bản đã được tập trung trong một lớp trừu tượng duy nhất `GeminiClient` (`autotgc-backend/src/infra/gemini.ts`), trỏ tới một cổng (gateway) **tương thích OpenAI ChatCompletions**: xác thực `Authorization: Bearer <key>`, gọi `POST {baseUrl}/chat/completions` với thân `{model, messages:[...]}`, đọc kết quả theo cấu trúc OpenAI `{choices:[{message:{content}}]}` (và chấp nhận `content` dạng mảng `{type,text}`).
- Mọi consumer AI lấy seam qua giao diện thuần `ContentGenerator { generateContent(prompt): Promise<string> }` (`src/strategy/personaService.ts`); `GeminiClient` thỏa mãn giao diện này về cấu trúc. Việc composition diễn ra ở một chỗ duy nhất `composeServices` (`src/infra/services.ts`), đọc khóa/model/base-url/timeout từ `SecretLoader`.
- Khóa cấu hình sinh **văn bản**: `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_BASE_URL` (phải là base `/v1` của gateway), `GEMINI_TIMEOUT_MS` (mặc định 20000ms, dưới `proxy_read_timeout` của nginx).
- Sinh **media** (ảnh/video) là tuyến **TÁCH BIỆT** (`GEMINI_IMAGE_*`, `VEO_*`, endpoint `POST {base}/images/generations`) qua nhà cung cấp riêng. DeepSeek **không** cung cấp sinh ảnh/video, nên việc chuyển sang DeepSeek **chỉ áp dụng cho sinh văn bản**; tuyến media giữ nguyên nhà cung cấp hiện tại.
- DeepSeek V4 (xác minh qua web, 06/2026): phát hành chính thức 24/04/2026, giấy phép MIT, API **tương thích OpenAI** và Anthropic. Model id: `deepseek-v4-pro` (chất lượng cao) và `deepseek-v4-flash` (rẻ/nhanh hơn); ngữ cảnh 1M, đầu ra tối đa 384K. Id cũ `deepseek-chat`/`deepseek-reasoner` ánh xạ chế độ non-thinking/thinking của v4-flash và sẽ ngừng hỗ trợ từ 24/07/2026. Vì API tương thích OpenAI ChatCompletions, cấu trúc request hiện tại của `GeminiClient` dùng được chỉ với thay đổi base URL + model + key.
- Bất biến cốt lõi của sản phẩm là mẫu **AI-OPTIONAL**: khi thiếu khóa AI hoặc nhà cung cấp lỗi/timeout, hệ thống trả về kết quả nền xác định (deterministic grounded fallback) với `aiGenerated = false` và **KHÔNG** ném 502 cho người dùng cuối (client ném 502 nội bộ; các agent bắt lỗi và fallback). Các consumer gồm: essays (Essay_Writer), interviewprep (Interview_Agent), agent tư vấn tuyển dụng + KnowledgeService grounding, roadmap narrative, reporting (reportEngine), và marketing (content/research/planning).

**Làm rõ phạm vi "huấn luyện lại model theo tri thức sẵn có":** Với DeepSeek V4 qua API, đây **KHÔNG** phải fine-tuning trọng số. Nó nghĩa là **tái grounding (re-grounding)**: đảm bảo các system/context prompt, KnowledgeBase (các `KnowledgeEntry` đang active), personas, brand knowledge và ngữ cảnh từ analytics được lắp ráp và truyền đúng cho model mới, đồng thời xác thực chất lượng/tương đương đầu ra so với nhà cung cấp trước. Fine-tuning trọng số thật sự được coi là **ngoài phạm vi (Phase 2)** và chỉ được ghi chú, không triển khai trong spec này.

## Glossary

- **AutoTGC_System**: Toàn bộ backend AutoTGC (Fastify 4 + Prisma 5/PostgreSQL 16) là chủ thể chịu trách nhiệm cho các hành vi mô tả dưới đây.
- **AI_Text_Provider**: Nhà cung cấp model sinh văn bản đang dùng. Sau migration, giá trị mục tiêu là **DeepSeek V4** qua cổng tương thích OpenAI ChatCompletions.
- **AI_Text_Client**: Lớp client sinh văn bản (`GeminiClient` hiện tại trong `src/infra/gemini.ts`) cài đặt giao diện `Content_Generator`; chịu trách nhiệm gọi `POST {base}/chat/completions` với Bearer auth và bóc tách nội dung theo cấu trúc OpenAI.
- **Content_Generator**: Giao diện seam thuần `{ generateContent(prompt: string): Promise<string> }` mà mọi consumer AI phụ thuộc vào (`src/strategy/personaService.ts`).
- **Service_Composer**: Hàm `composeServices` (`src/infra/services.ts`) lắp ráp `AI_Text_Client` và các service dùng chung một lần cho cả HTTP layer và scheduled jobs.
- **Secret_Store**: Nguồn cấu hình/bí mật nạp qua `SecretLoader`; cung cấp `require`/`optional` và fail-fast khi thiếu bí mật bắt buộc.
- **DeepSeek_Model_Id**: Định danh model DeepSeek được chọn, thuộc tập {`deepseek-v4-pro`, `deepseek-v4-flash`} (id hợp lệ khác do nhà cung cấp công bố cũng được chấp nhận như giá trị cấu hình).
- **Media_Generation**: Tuyến sinh ảnh/video tách biệt (`GEMINI_IMAGE_*`, `VEO_*`) gọi `POST {base}/images/generations`; nằm ngoài phạm vi chuyển sang DeepSeek.
- **AI_Optional_Pattern**: Mẫu bắt buộc trong đó khi thiếu khóa hoặc nhà cung cấp lỗi/timeout, AutoTGC_System trả kết quả nền xác định với `aiGenerated = false` và không ném 502 cho người dùng cuối.
- **AI_Generated_Flag**: Cờ `aiGenerated` đính kèm mọi đầu ra có khả năng do AI sinh; `true` khi văn bản do AI_Text_Provider tạo, `false` khi là kết quả nền xác định.
- **Deterministic_Fallback**: Đầu ra nền xác định được lắp ráp từ dữ liệu có sẵn (knowledge, hồ sơ, kết quả tính toán thuần) khi AI không khả dụng.
- **Knowledge_Base**: Tập `KnowledgeEntry` đang active do `KnowledgeService` truy hồi để grounding câu trả lời.
- **Re_Grounding**: Quy trình "huấn luyện lại" theo nghĩa lắp ráp đúng tri thức (Knowledge_Base, personas, brand knowledge, ngữ cảnh analytics) vào prompt cho AI_Text_Provider mới — KHÔNG phải fine-tuning trọng số.
- **Review_Mode**: Chế độ yêu cầu con người phê duyệt trước khi một đầu ra AI được coi là chính thức hoặc được gửi đi.
- **HTTP_Status**: Tập mã trạng thái HTTP được phép của dự án: {200, 201, 202, 400, 401, 403, 404, 409, 423, 500, 502}.
- **Pretty_Printer**: Hàm thuần in một cấu hình AI_Text_Provider (provider, base URL, model, timeout) thành biểu diễn văn bản chuẩn hóa, không lộ giá trị bí mật.
- **Config_Parser**: Hàm thuần đọc/diễn giải cấu hình AI_Text_Provider từ các khóa của Secret_Store thành một đối tượng cấu hình đã chuẩn hóa.

## Requirements

### Requirement 1: Chuyển nhà cung cấp sinh văn bản sang DeepSeek V4

**User Story:** Là quản trị viên nền tảng, tôi muốn AutoTGC sinh văn bản bằng DeepSeek V4 thay vì model trước, để tận dụng chất lượng/chi phí của model mới mà không phải viết lại các consumer.

#### Acceptance Criteria

1. WHERE Secret_Store cung cấp cấu hình AI_Text_Provider hợp lệ trỏ tới DeepSeek (base URL không rỗng, DeepSeek_Model_Id không rỗng và khóa API có mặt), THE AI_Text_Client SHALL gửi yêu cầu sinh văn bản tới `POST {base}/chat/completions` với thân JSON gồm trường `model` bằng DeepSeek_Model_Id đang cấu hình và trường `messages` là một mảng không rỗng chứa prompt của consumer, kèm header `Authorization: Bearer <key>`.
2. WHEN AI_Text_Client nhận phản hồi thành công (mã trạng thái HTTP 2xx và thân JSON phân giải được) từ AI_Text_Provider, THE AI_Text_Client SHALL bóc tách nội dung trợ lý từ phần tử đầu tiên của mảng `choices` theo cấu trúc OpenAI ChatCompletions `choices[0].message.content`.
3. WHERE phản hồi trả `content` dưới dạng mảng các phần `{type, text}`, THE AI_Text_Client SHALL ghép các trường `text` có kiểu chuỗi của các phần theo đúng thứ tự xuất hiện trong mảng, bỏ qua các phần không có `text` kiểu chuỗi và không chèn ký tự phân tách giữa các phần, thành một chuỗi kết quả duy nhất.
4. THE AI_Text_Client SHALL giữ nguyên giao diện `Content_Generator` (`generateContent(prompt): Promise<string>`) để các consumer hiện có không phải thay đổi điểm gọi.
5. WHEN Service_Composer lắp ráp các dịch vụ dùng chung lúc khởi động, THE Service_Composer SHALL cung cấp cho mọi consumer AI cùng một thể hiện AI_Text_Client được cấu hình theo DeepSeek_Model_Id phân giải từ Secret_Store.

### Requirement 2: Cấu hình và bí mật cho DeepSeek

**User Story:** Là kỹ sư vận hành, tôi muốn cấu hình DeepSeek (base URL, model, khóa, timeout) qua biến môi trường/secret store, để chuyển nhà cung cấp mà không sửa mã ứng dụng và không lộ bí mật.

#### Acceptance Criteria

1. THE Config_Parser SHALL đọc cấu hình AI_Text_Provider (base URL, DeepSeek_Model_Id, khóa API, timeout) từ Secret_Store.
2. WHERE DeepSeek_Model_Id không được cấu hình, THE Service_Composer SHALL dùng DeepSeek_Model_Id mặc định `deepseek-v4-flash`.
3. WHERE giá trị timeout không được cấu hình, không phải số dương hữu hạn, hoặc nhỏ hơn ngưỡng tối thiểu 100 mili-giây, THE AI_Text_Client SHALL dùng timeout mặc định 20000 mili-giây.
4. IF khóa API của AI_Text_Provider vắng mặt khi một yêu cầu sinh văn bản được phát ra, THEN THE AI_Text_Client SHALL không gọi AI_Text_Provider và SHALL ném lỗi nội bộ mã 502 `AI_NOT_CONFIGURED` để consumer nhận biết AI chưa được cấu hình.
5. IF base URL của AI_Text_Provider vắng mặt khi một yêu cầu sinh văn bản được phát ra, THEN THE AI_Text_Client SHALL không gọi AI_Text_Provider và SHALL ném lỗi nội bộ mã 502 `AI_NOT_CONFIGURED` để consumer nhận biết AI chưa được cấu hình.
6. THE AutoTGC_System SHALL không ghi nhật ký giá trị bí mật của AI_Text_Provider; khi ghi nhật ký liên quan đến một bí mật, THE AutoTGC_System SHALL chỉ ghi tên (khóa định danh) của bí mật đó.
7. THE AI_Text_Client SHALL không nhúng bất kỳ giá trị bí mật nào (khóa API, thông tin xác thực) vào prompt hoặc kết quả.
8. WHEN cả khóa API lẫn base URL của AI_Text_Provider đều có mặt và một yêu cầu sinh văn bản được phát ra, THE AI_Text_Client SHALL gọi AI_Text_Provider thay vì rẽ vào nhánh `AI_NOT_CONFIGURED`.
9. THE AutoTGC_System SHALL cập nhật tệp `.env.example` để mô tả các khóa cấu hình DeepSeek mà không chứa bất kỳ giá trị bí mật thật nào.

### Requirement 3: Bảo toàn mẫu AI-OPTIONAL sau migration

**User Story:** Là người dùng cuối, tôi muốn các tính năng AI vẫn hoạt động khi DeepSeek chưa cấu hình hoặc gặp lỗi, để hệ thống không bao giờ trả 502 cho tôi vì lý do thiếu AI.

#### Acceptance Criteria

1. IF AI_Text_Provider không được cấu hình, hoặc trả lỗi, hoặc không phản hồi trong thời hạn timeout đã cấu hình (mặc định 20000 mili-giây), THEN THE AutoTGC_System SHALL trả về Deterministic_Fallback không rỗng với `aiGenerated = false` và đáp ứng người dùng cuối bằng một phản hồi thành công thuộc HTTP_Status {200, 201, 202}, không trả mã 502 cho người dùng cuối vì lý do thiếu AI.
2. WHEN AI_Text_Provider sinh văn bản thành công (trả về nội dung văn bản không rỗng), THE AutoTGC_System SHALL dùng văn bản đó và đặt AI_Generated_Flag bằng `true`.
3. THE AutoTGC_System SHALL không tuyên bố một đầu ra là do AI sinh (AI_Generated_Flag = `true`) khi đầu ra đó được tạo bằng nhánh Deterministic_Fallback; trong trường hợp đó AI_Generated_Flag SHALL bằng `false`.
4. THE AutoTGC_System SHALL kiểm tra ràng buộc này lúc chạy: WHEN một đầu ra được tạo bằng nhánh Deterministic_Fallback nhưng AI_Generated_Flag bằng `true`, THE AutoTGC_System SHALL coi đó là vi phạm bất biến và đặt lại AI_Generated_Flag bằng `false`.
5. WHEN AI_Text_Provider đã sinh xong văn bản thành công trước khi trở nên không khả dụng, THE AutoTGC_System SHALL dùng văn bản đã sinh đó và đặt AI_Generated_Flag bằng `true` thay vì rẽ sang Deterministic_Fallback.
6. IF AI_Text_Client gặp lỗi mạng hoặc bị hủy do vượt timeout đã cấu hình (mặc định 20000 mili-giây), THEN THE AI_Text_Client SHALL biểu thị lỗi nội bộ mã 502 `AI_REQUEST_FAILED` để consumer thực thi nhánh fallback.
7. IF AI_Text_Provider trả phản hồi không có nội dung văn bản, THEN THE AI_Text_Client SHALL biểu thị lỗi nội bộ mã 502 `AI_BAD_RESPONSE` để consumer thực thi nhánh fallback.
8. WHEN một consumer hiện có bất kỳ (Essay_Writer, Interview_Agent, agent tư vấn tuyển dụng, Roadmap narrative, reportEngine, marketing content/research/planning) gặp AI_Text_Provider không khả dụng sau khi chuyển nhà cung cấp, THE AutoTGC_System SHALL trả về Deterministic_Fallback với `aiGenerated = false` cho consumer đó, bảo toàn AI_Optional_Pattern.

### Requirement 4: Không phá vỡ tuyến sinh media

**User Story:** Là chủ sản phẩm, tôi muốn việc chuyển sinh văn bản sang DeepSeek không ảnh hưởng tới sinh ảnh/video, để các tính năng media tiếp tục chạy trên nhà cung cấp riêng của chúng.

#### Acceptance Criteria

1. THE AutoTGC_System SHALL lấy toàn bộ cấu hình Media_Generation chỉ từ các khóa riêng (`GEMINI_IMAGE_*`, `VEO_*`) và gọi endpoint `POST {base}/images/generations`, và SHALL không đọc bất kỳ khóa cấu hình AI_Text_Provider nào (`GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_BASE_URL`, `GEMINI_TIMEOUT_MS`) cho Media_Generation.
2. WHEN cấu hình AI_Text_Provider được thay đổi sang DeepSeek, THE Service_Composer SHALL lắp ráp nhà cung cấp Media_Generation với cùng base URL, cùng bộ khóa (`GEMINI_IMAGE_*`, `VEO_*`) và cùng endpoint `POST {base}/images/generations` như trước khi thay đổi.
3. WHERE cả hai modality ảnh và video đều không được cấu hình, THE AutoTGC_System SHALL giữ brand assets ở trạng thái SPEC_READY (đã khai báo nhưng chưa tổng hợp nội dung media) và SHALL không gọi endpoint `POST {base}/images/generations`.
4. WHERE đúng một trong hai modality ảnh hoặc video được cấu hình, THE AutoTGC_System SHALL chỉ tổng hợp modality đã cấu hình qua endpoint `POST {base}/images/generations` và SHALL giữ brand assets của modality chưa cấu hình ở trạng thái SPEC_READY.

### Requirement 5: Tái grounding tri thức cho model mới ("huấn luyện lại")

**User Story:** Là chuyên viên nội dung/tư vấn, tôi muốn DeepSeek trả lời bám sát tri thức sẵn có của hệ thống, để chất lượng tư vấn không suy giảm sau khi đổi model.

#### Acceptance Criteria

1. WHEN một consumer grounding yêu cầu sinh văn bản với cùng một bộ đầu vào, THE AutoTGC_System SHALL lắp ráp một cách xác định (cùng đầu vào luôn cho cùng prompt) một prompt chứa tri thức liên quan từ Knowledge_Base (tập KnowledgeEntry đang active), persona, brand knowledge và ngữ cảnh analytics theo thứ tự cố định trước khi gọi AI_Text_Provider.
2. WHEN lắp ráp prompt cho cùng một đầu vào, THE Re_Grounding SHALL truyền cho AI_Text_Provider mới cùng tập tri thức nền như đã truyền cho nhà cung cấp trước (cùng tập KnowledgeEntry đang active, cùng persona, cùng brand knowledge, cùng ngữ cảnh analytics), để phần tri thức của prompt là như nhau bất kể nhà cung cấp.
3. WHILE một đầu ra AI chưa được con người phê duyệt, THE AutoTGC_System SHALL không coi đầu ra đó là chính thức để gửi đi, bất kể nhà cung cấp sinh ra nó (Review_Mode).
4. THE AutoTGC_System SHALL giữ mọi đầu ra AI trong Review_Mode cho tới khi có phê duyệt của con người, không cho phép bất kỳ loại đầu ra nào (kể cả phản hồi xác nhận đơn giản hay phản hồi tiêu chuẩn) bỏ qua bước phê duyệt.
5. IF một tình huống được coi là khẩn cấp và không có người duyệt sẵn sàng, THEN THE AutoTGC_System SHALL vẫn chờ phê duyệt của con người và SHALL không gửi đi chính thức bất kỳ đầu ra AI chưa phê duyệt nào.
6. THE AutoTGC_System SHALL không nhúng giá trị bí mật vào prompt grounding.
7. IF người dùng yêu cầu fine-tuning trọng số của model, THEN THE AutoTGC_System SHALL không thực hiện fine-tuning trọng số và SHALL ghi chú yêu cầu đó là ngoài phạm vi Phase hiện tại.
8. IF không có KnowledgeEntry nào đang active hoặc việc truy hồi Knowledge_Base thất bại, THEN THE AutoTGC_System SHALL lắp ráp prompt từ phần ngữ cảnh còn khả dụng và tiếp tục theo AI_Optional_Pattern thay vì làm lỗi cho người dùng cuối.

### Requirement 6: Đọc và in cấu hình AI_Text_Provider có round-trip

**User Story:** Là kỹ sư, tôi muốn việc đọc và in cấu hình nhà cung cấp AI là nhất quán và kiểm chứng được, để tránh sai lệch khi chuyển đổi cấu hình giữa các môi trường.

#### Acceptance Criteria

1. WHEN Config_Parser đọc một bộ khóa cấu hình hợp lệ (base URL là chuỗi không rỗng và DeepSeek_Model_Id là chuỗi không rỗng), THE Config_Parser SHALL tạo ra một đối tượng cấu hình chuẩn hóa gồm đúng bốn thuộc tính: provider, base URL, DeepSeek_Model_Id và timeout.
2. WHEN Pretty_Printer in một đối tượng cấu hình chuẩn hóa, THE Pretty_Printer SHALL tạo biểu diễn văn bản không chứa giá trị khóa API hay bất kỳ giá trị bí mật nào.
3. WHEN một đối tượng cấu hình chuẩn hóa hợp lệ được in (print) rồi đọc lại (parse), THE AutoTGC_System SHALL cho ra một đối tượng cấu hình có cả bốn thuộc tính (provider, base URL, DeepSeek_Model_Id, timeout) bằng đúng với đối tượng ban đầu (thuộc tính round-trip).
4. IF một giá trị timeout không phải số dương hữu hạn được cung cấp, THEN THE Config_Parser SHALL thay bằng giá trị timeout mặc định 20000 mili-giây thay vì để giá trị không hợp lệ.
5. IF base URL hoặc DeepSeek_Model_Id vắng mặt hoặc là chuỗi rỗng, THEN THE Config_Parser SHALL từ chối bộ khóa cấu hình đó và biểu thị khóa nào không hợp lệ thay vì tạo một đối tượng cấu hình thiếu thuộc tính.

### Requirement 7: Xác thực tương đương chất lượng và kiểm thử

**User Story:** Là kỹ sư đảm bảo chất lượng, tôi muốn kiểm chứng đầu ra DeepSeek đáp ứng cùng kỳ vọng grounding/cấu trúc và mọi logic thuần được phủ test, để tự tin phát hành migration.

#### Acceptance Criteria

1. THE AutoTGC_System SHALL phủ mỗi logic thuần bị tác động bởi migration — gồm Config_Parser (đọc cấu hình), Pretty_Printer (in cấu hình đã chuẩn hóa) và logic bóc tách nội dung phản hồi của AI_Text_Client — bằng property-based test dùng fast-check với tối thiểu 100 trường hợp sinh cho mỗi logic.
2. WHEN AI_Text_Client nhận phản hồi thành công có trường `content` là chuỗi, THE AI_Text_Client SHALL trả về chính chuỗi `content` đó làm kết quả của `generateContent`.
3. WHEN AutoTGC_System trả lỗi qua HTTP, THE AutoTGC_System SHALL chỉ dùng các mã thuộc tập HTTP_Status được phép {200, 201, 202, 400, 401, 403, 404, 409, 423, 500, 502}.
4. WHEN một consumer grounding (thuộc tập consumer nêu ở Yêu cầu 3: Essay_Writer, Interview_Agent, agent tư vấn tuyển dụng, Roadmap narrative, reportEngine, marketing content/research/planning) chạy với AI_Text_Provider không được cấu hình trong môi trường kiểm thử, THE consumer SHALL trả về Deterministic_Fallback có cùng tập trường ở cấp cao nhất như đầu ra khi AI sinh thành công, với AI_Generated_Flag bằng `false` và các trường nội dung được điền không rỗng từ dữ liệu nền xác định.
5. WHERE AI_Text_Provider được cấu hình trong môi trường kiểm thử, THE consumer SHALL được phép gọi AI thật và dùng phản hồi thật thay vì bắt buộc rẽ vào Deterministic_Fallback.
6. IF nội dung Deterministic_Fallback tự nó rỗng hoặc không hợp lệ, THEN THE consumer SHALL được phép để nhánh fallback thất bại (không bắt buộc trả về fallback rỗng/không hợp lệ).
7. WHEN AI_Text_Client nhận phản hồi thành công có trường `content` là mảng các phần `{type, text}`, THE AI_Text_Client SHALL ghép các giá trị `text` theo đúng thứ tự xuất hiện trong mảng thành một chuỗi kết quả duy nhất.
8. IF phản hồi của AI_Text_Provider có `content` rỗng, mảng `content` không chứa phần `text` nào, hoặc kết quả bóc tách là chuỗi rỗng, THEN THE AI_Text_Client SHALL biểu thị lỗi nội bộ 502 `AI_BAD_RESPONSE` để consumer thực thi nhánh Deterministic_Fallback.

### Requirement 8: Triển khai và migration vận hành

**User Story:** Là kỹ sư vận hành, tôi muốn quy trình triển khai migration rõ ràng và không chứa giá trị nhạy cảm, để chuyển sang DeepSeek an toàn trên môi trường thật.

#### Acceptance Criteria

1. THE AutoTGC_System SHALL cung cấp ghi chú runbook triển khai liệt kê các khóa cấu hình DeepSeek cần đặt (base URL, DeepSeek_Model_Id, khóa API, timeout) và các bước xác minh sau triển khai, trong đó mỗi bước xác minh nêu rõ một hành động và một kết quả kỳ vọng quan sát được.
2. THE AutoTGC_System SHALL không hardcode host máy chủ, địa chỉ IP, khóa API hay thông tin xác thực trong mã ứng dụng.
3. WHEN cấu hình AI_Text_Provider trỏ tới DeepSeek được áp dụng lúc khởi động, THE Service_Composer SHALL lắp ráp AI_Text_Client mà không cần thay đổi mã nguồn consumer.
4. WHILE quá trình lắp ráp AI_Text_Client diễn ra lúc khởi động, IF việc lắp ráp thất bại do giá trị cấu hình không hợp lệ, THEN THE AutoTGC_System SHALL làm thất bại toàn bộ tiến trình khởi động (fail-fast) thay vì khởi động một phần.
5. IF một bí mật bắt buộc cho khởi động vắng mặt, THEN THE AutoTGC_System SHALL dừng trước khi lắng nghe (fail-fast), thoát với trạng thái lỗi, và ghi nhật ký chỉ tên bí mật bị thiếu thay vì giá trị của nó.
6. WHEN thực hiện bước xác minh sau triển khai, THE runbook SHALL yêu cầu xác nhận rằng sinh văn bản trả AI_Generated_Flag = `true` khi DeepSeek được cấu hình, và trả Deterministic_Fallback với `aiGenerated = false` khi không được cấu hình.
7. THE runbook SHALL bao gồm bước rollback về nhà cung cấp trước đó để áp dụng khi bước xác minh thất bại.

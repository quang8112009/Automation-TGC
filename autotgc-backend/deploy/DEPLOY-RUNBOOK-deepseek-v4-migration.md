# Operator Deploy Runbook — `deepseek-v4-model-migration` (Task 7.2)

Runbook này hướng dẫn triển khai việc **chuyển AI sinh văn bản của AutoTGC sang DeepSeek V4**
qua cổng (gateway) **YeScale** tương thích OpenAI ChatCompletions. Đây là **thay đổi cấu hình
sau seam** (base URL + model + key + timeout) — KHÔNG đổi mã consumer, KHÔNG đổi Prisma schema
(Req 8.3). Runbook phải được **người vận hành** thực thi từ máy có quyền truy cập secret
store/vault và mạng tới máy chủ.

> Migration này **chỉ áp dụng cho sinh văn bản**. Tuyến sinh **media (ảnh/video)** là tuyến
> **TÁCH BIỆT**, dùng khóa riêng (`GEMINI_IMAGE_*`, `VEO_*`) và **KHÔNG bị thay đổi** bởi
> migration này (Req 4).

## 1. Mục tiêu

- Chuyển nhà cung cấp **sinh văn bản** sang **DeepSeek V4** qua gateway **YeScale**
  (OpenAI-compatible: `Authorization: Bearer <key>`, `POST {baseUrl}/chat/completions`,
  thân `{model, messages:[...]}`, đọc `choices[0].message.content`).
- Bảo toàn mẫu **AI-OPTIONAL**: thiếu khóa hoặc nhà cung cấp lỗi/timeout ⇒ Deterministic_Fallback
  với `aiGenerated=false`, **không** trả 502 cho người dùng cuối (Req 3).
- Media (ảnh/video) **KHÔNG đổi** — tiếp tục chạy trên nhà cung cấp/khóa/endpoint hiện tại (Req 4).

## 2. Khóa cần đặt (đặt qua secret store/vault — KHÔNG ghi giá trị thật vào runbook)

Tên khóa **giữ nguyên** `GEMINI_*` (ổn định vận hành); chỉ **giá trị** trỏ sang DeepSeek. Mô tả
chi tiết trong `autotgc-backend/.env.example`.

| Khóa | Mục đích | Bắt buộc để gọi AI? | Mặc định |
|---|---|---|---|
| `GEMINI_BASE_URL` | Base `/v1` của gateway YeScale (client tự nối `/chat/completions`). Ví dụ `https://api.yescale.io/v1`. | Có (thiếu ⇒ `AI_NOT_CONFIGURED` ⇒ fallback) | — |
| `GEMINI_MODEL` | DeepSeek_Model_Id: `deepseek-v4-flash` (mặc định, rẻ/nhanh) hoặc `deepseek-v4-pro` (chất lượng cao). Id hợp lệ khác do nhà cung cấp công bố cũng chấp nhận. | Không | `deepseek-v4-flash` |
| `GEMINI_API_KEY` | **Khóa bí mật** của gateway. Đặt qua secret store/vault; **KHÔNG commit**, **KHÔNG ghi giá trị** vào runbook/log (chỉ ghi *tên* khóa — Req 2.6). | Có (thiếu ⇒ `AI_NOT_CONFIGURED` ⇒ fallback) | — |
| `GEMINI_TIMEOUT_MS` | Timeout (ms) cho request văn bản đi ra. Mặc định `20000`. Giá trị không phải số dương hữu hạn, hoặc dưới **sàn tối thiểu 100ms**, sẽ được chuẩn hóa về `20000`. | Không | `20000` |

> Khóa media (`GEMINI_IMAGE_*`, `VEO_*`) **không** thuộc cấu hình AI text và **không** được
> Config_Parser của AI text đọc (Req 4.1). Đặt/giữ chúng độc lập như trước.

## 3. Các bước xác minh sau triển khai

Mỗi bước nêu rõ **một hành động** và **một kết quả kỳ vọng quan sát được** (Req 8.1, 8.6).

### 3.1 Khởi động & fail-fast (Req 8.4, 8.5)

- **Hành động:** Đặt đủ khóa bắt buộc rồi khởi động app (PM2 restart `autotgc-backend`).
  ```bash
  sudo -u autotgc bash -lc 'pm2 restart autotgc-backend && pm2 list'
  curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/healthz   # expect 200
  ```
- **Kết quả kỳ vọng:** Tiến trình lắng nghe được; `/healthz` trả `200`; PM2 process `online`
  và **không** chạy bằng root.
- **Hành động (mặt bù — thiếu cấu hình hợp lệ):** Tạm bỏ một secret **bắt buộc** rồi khởi động.
- **Kết quả kỳ vọng:** App **fail-fast**, dừng **trước khi** lắng nghe, thoát với trạng thái lỗi;
  log chỉ in **TÊN** khóa thiếu (ví dụ `JWT_SECRET`), **không** in giá trị bí mật.

### 3.2 Gọi một tính năng AI khi cấu hình đầy đủ ⇒ `aiGenerated=true` (Req 8.6)

- **Hành động:** Với `GEMINI_BASE_URL` + `GEMINI_API_KEY` (+ tùy chọn `GEMINI_MODEL`) đã đặt
  hợp lệ, gọi một tính năng AI grounding (ví dụ Essay_Writer hoặc agent tư vấn tuyển dụng) qua
  API tương ứng (sau auth).
- **Kết quả kỳ vọng:** Phản hồi `200/201/202`, trường nội dung không rỗng, và cờ
  **`aiGenerated=true`** (văn bản do DeepSeek V4 sinh).

### 3.3 Bỏ khóa ⇒ Deterministic_Fallback với `aiGenerated=false`, KHÔNG 502 (Req 8.6, 3.1, 3.8)

- **Hành động:** Tạm gỡ `GEMINI_API_KEY` (hoặc `GEMINI_BASE_URL`), restart, rồi gọi **cùng**
  tính năng AI ở bước 3.2.
- **Kết quả kỳ vọng:** Phản hồi vẫn `200/201/202` với nội dung nền không rỗng và cờ
  **`aiGenerated=false`** (Deterministic_Fallback). Người dùng cuối **KHÔNG** nhận `502`
  (lỗi 502 `AI_NOT_CONFIGURED` chỉ là nội bộ giữa client và consumer).
- **Sau khi xác minh:** Đặt lại khóa đã gỡ và restart để khôi phục chế độ AI đầy đủ.

### 3.4 Media vẫn hoạt động độc lập (Req 4)

- **Hành động:** Kích hoạt một thao tác sinh ảnh/video (hoặc kiểm tra trạng thái brand assets)
  với cấu hình media (`GEMINI_IMAGE_*`/`VEO_*`) như trước migration.
- **Kết quả kỳ vọng:** Tuyến media hoạt động **không đổi** — vẫn gọi `POST {base}/images/generations`
  theo khóa riêng; trạng thái assets không bị migration văn bản tác động. Khi không cấu hình
  modality nào, brand assets giữ `SPEC_READY` (không gọi images endpoint).

## 4. Rollback (áp dụng khi bước xác minh ở mục 3 thất bại — Req 8.7)

Migration là thay đổi cấu hình, nên rollback = **trỏ cấu hình về nhà cung cấp trước đó** và restart.
Không cần đổi mã hay schema.

- **Hành động:**
  1. Trong secret store/vault, đặt lại `GEMINI_BASE_URL`, `GEMINI_MODEL`, `GEMINI_API_KEY`
     về **giá trị của nhà cung cấp trước đó** (giá trị lấy từ vault — KHÔNG ghi vào runbook).
     Nếu cần, đặt lại `GEMINI_TIMEOUT_MS` về giá trị trước.
  2. Cập nhật `/opt/autotgc/.env` (mode `600`, owner `autotgc`) tương ứng, rồi restart:
     ```bash
     sudo -u autotgc bash -lc 'pm2 restart autotgc-backend && pm2 list'
     curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/healthz   # expect 200
     ```
- **Kết quả kỳ vọng:** App khởi động lại bình thường; bước 3.2 lại cho `aiGenerated=true` với
  nhà cung cấp cũ. Vì seam `ContentGenerator` không đổi, không cần build lại mã để rollback.

## 5. Ghi chú — phạm vi "huấn luyện lại" (Req 5.7)

- "Huấn luyện lại model theo tri thức sẵn có" trong Phase hiện tại là **Re_Grounding (retrieval)**:
  lắp ráp đúng Knowledge_Base (KnowledgeEntry đang active), persona, brand knowledge và ngữ cảnh
  analytics vào prompt theo thứ tự cố định cho model mới.
- **Fine-tuning trọng số model là NGOÀI phạm vi** Phase hiện tại (Phase 2). Runbook này
  **không** thực hiện và **không** yêu cầu huấn luyện trọng số. Nếu có yêu cầu fine-tuning trọng
  số, ghi nhận là ngoài phạm vi và không triển khai trong migration này.

## 6. Bảo mật (Req 8.2, 2.6, 2.7)

- **Không hardcode** host/IP, khóa API hay thông tin xác thực trong mã ứng dụng hay trong runbook.
  Tất cả secrets nạp qua `SecretLoader` từ secret store/vault.
- **Không log giá trị bí mật:** khi ghi nhật ký liên quan đến một secret, hệ thống chỉ ghi **tên**
  (khóa định danh) của secret, không ghi giá trị.
- **Không nhúng** khóa API vào prompt hay kết quả; Pretty_Printer in cấu hình **không** lộ giá trị bí mật.
- **Không commit `.env` thật.** `.env.example` chỉ chứa mô tả khóa với giá trị rỗng. File
  `/opt/autotgc/.env` trên máy chủ đặt mode `600`, owner `autotgc`. Chạy `npm run secret-scan`
  trước khi commit để đảm bảo không lọt bí mật vào git.
- App **từ chối chạy bằng root** (`assertNotRoot`) và **fail-fast** khi thiếu secret bắt buộc.

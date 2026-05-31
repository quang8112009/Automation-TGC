# Use Case: Generate AI Content

**Description:** Tạo nội dung marketing tự động dựa trên persona đã thiết lập, mục tiêu chuyển đổi và lĩnh vực cụ thể.

**Precondition:** Persona đã được định nghĩa. Người dùng đã đăng nhập vào hệ thống.

**Postcondition:** Bản nháp nội dung được lưu vào hệ thống và sẵn sàng để kiểm duyệt hoặc lên lịch.

## Actors
- **AI System**
- **Content Manager**

## Data Entities
- **Persona**
- **Content Draft**
- **AI Prompt Context**

## Flows
### EXCEPTION: AI Generation Error
1. AI System không thể tạo nội dung do lỗi hệ thống hoặc thiếu dữ liệu ngữ cảnh.
2. AI System thông báo lỗi đến Content Manager.
3. Content Manager thực hiện lại thao tác hoặc điều chỉnh từ khóa/persona.

### MAIN: Main Flow
1. Content Manager chọn lĩnh vực (ví dụ: XKLĐ) và Persona tương ứng.
2. Content Manager chọn mục tiêu bài viết (Ví dụ: Chuyển đổi Lead, Tăng lượt xem).
3. Content Manager nhập chủ đề hoặc từ khóa gợi ý.
4. AI System tải AI Prompt Context (enriched từ Analytics Feedback Loop), bao gồm: top performing topics, best CTA patterns, avoid topics, optimal content length theo platform. **Cold start:** Nếu chưa đủ dữ liệu (AI Prompt Context rỗng hoặc thiếu), hệ thống dùng Default Context (chỉ gồm Persona + Domain Context + tone mặc định) và đánh dấu nội dung là 'generated_without_feedback' — quá trình generation KHÔNG được fail vì lý do thiếu context.
5. AI System phân tích ngữ cảnh từ Persona đã chọn kết hợp với AI Prompt Context.
6. AI System tạo bản nháp nội dung (Title, Body, CTA).
7. Content Manager xem trước bản nháp và thực hiện chỉnh sửa nếu cần.
8. Content Manager xác nhận lưu nội dung.

## Business Rules
- Prompt tạo nội dung phải tuân theo cấu trúc: [Vai trò chuyên gia] + [Ngữ cảnh lĩnh vực] + [Mục tiêu chuyển đổi cụ thể (Lead/View/Follow)] + [Tone-of-voice quy định] + [Yêu cầu CTA bắt buộc] + [Performance Context từ Analytics: top topics, best CTAs, avoid topics] + [Yêu cầu CTA dựa trên best CTA patterns].
- Nội dung tạo ra phải chứa ít nhất một Call-to-Action (CTA).
- Mục tiêu bài viết (Lead/View/Follow) là bắt buộc.
- Phải chọn ít nhất một Persona đã định nghĩa.
- **Cold start fallback:** Khi AI Prompt Context chưa có dữ liệu (giai đoạn đầu), generation vẫn hoạt động với Default Context; phần Performance Context được bỏ qua an toàn thay vì gây lỗi.
- **Media Asset:** AI sinh nội dung dạng text (Title/Body/CTA, kèm script gợi ý nếu cần). Với nền tảng bắt buộc media (TikTok), bản nháp phải được đính kèm Media Asset (video/ảnh do người dùng cung cấp) trước khi đủ điều kiện lên lịch đăng (xem use case Automate Content Posting). Sản xuất/biên tập video nằm ngoài phạm vi Phase 1.
- AI sử dụng Google Gemini API (model gemini-2.5-flash) để tạo nội dung.

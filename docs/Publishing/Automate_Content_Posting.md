# Use Case: Automate Content Posting

**Description:** Tự động lên lịch và đăng tải nội dung lên các kênh.

**Precondition:** Người dùng đã đăng nhập và bản nháp đã được phê duyệt.

**Postcondition:** Bài viết được đặt lịch và tự động đăng thành công trên hệ thống.

## Actors
- **AI System**
- **System Background Worker**
- **Content Manager**

## Data Entities
- **Scheduled Post**
- **Content Draft**
- **Media Asset** (ảnh/video đính kèm — bắt buộc cho TikTok)
- **Platform Token** (access token + thời hạn của từng nền tảng)

## Flows
### ALT: Invalid Schedule Time
1. Content Manager chọn thời gian đã qua. 
2. Hệ thống thông báo lỗi 'Thời gian không hợp lệ' và yêu cầu chọn lại.

### MAIN: Scheduling Flow
1. Content Manager chọn một 'Content Draft' đã được duyệt. 
2. Hệ thống hiển thị danh sách các nền tảng (Facebook, TikTok, Website) khả dụng. 
3. Content Manager chọn (một hoặc nhiều) nền tảng và thiết lập ngày, giờ đăng bài cụ thể cho từng nền tảng. Mỗi cặp (Draft × Nền tảng) tạo ra một 'Scheduled Post' độc lập.
4. **Hệ thống kiểm tra yêu cầu media theo nền tảng (media requirement check):**
   - TikTok: BẮT BUỘC có Media Asset là video hoặc photo-carousel. Nếu Draft chưa có media hợp lệ → từ chối lên lịch và yêu cầu bổ sung.
   - Facebook: cho phép text-only, text+ảnh, hoặc video.
   - Website: cho phép text + featured image (tùy chọn).
5. Hệ thống kiểm tra giới hạn nội dung theo nền tảng (độ dài mô tả, định dạng media).
6. Hệ thống kiểm tra tính hợp lệ của thời gian (phải là tương lai). 
7. Hệ thống lưu cấu hình lên lịch và cập nhật trạng thái bài viết thành 'Scheduled'. 
8. Hệ thống xác nhận lịch đã được đặt thành công.

### MAIN: Execution Flow
1. System Background Worker liên tục kiểm tra các bài viết có trạng thái 'Scheduled' đã đến giờ đăng.
2. Worker **giành khóa (lock) bằng idempotency key** trên Scheduled Post (chuyển trạng thái 'Scheduled' → 'Publishing') trước khi gọi API, đảm bảo không có 2 tiến trình cùng đăng một bài.
3. Worker kiểm tra Platform Token còn hiệu lực. Nếu token sắp/đã hết hạn → thử refresh; nếu refresh thất bại → chuyển bài sang 'Failed' với lý do 'TOKEN_EXPIRED' và cảnh báo Content Manager (KHÔNG retry mù).
4. Worker gọi API của nền tảng (Facebook, TikTok, Website) để đăng nội dung và đính kèm media. Mỗi lần gọi mang một idempotency key duy nhất để tránh đăng trùng khi mạng lỗi.
5. Nếu đăng tải thành công, hệ thống cập nhật trạng thái bài viết thành 'Published' và lưu lại ID của bài đăng (Post ID) + post_url từ nền tảng.
6. Nếu thất bại do lỗi tạm thời (network, rate limit 5xx/429), hệ thống tự động retry tối đa 3 lần theo cơ chế exponential backoff.
7. Nếu vẫn thất bại sau 3 lần, hoặc lỗi không thể phục hồi (4xx, nội dung vi phạm chính sách), hệ thống chuyển bài sang trạng thái 'Failed', lưu mã lỗi và thông báo cho Content Manager. Content Manager có thể sửa và lên lịch lại (Failed → Scheduled).

### EXCEPTION: Platform Token Expired
1. Tại thời điểm đăng, Platform Token đã hết hạn và không refresh được.
2. Hệ thống chuyển Scheduled Post sang 'Failed' (lý do 'TOKEN_EXPIRED').
3. Hệ thống gửi cảnh báo đến Dashboard + email yêu cầu Content Manager kết nối/cấp lại quyền nền tảng.

## Business Rules
- Hệ thống Publishing phải tích hợp API chính thức của các nền tảng (Facebook Graph API, TikTok Content Posting API) để đăng tải tự động.
- **Content Status Lifecycle (đầy đủ):** DRAFT → APPROVED → SCHEDULED → PUBLISHING → PUBLISHED. Nhánh lỗi: PUBLISHING → FAILED → (sửa) → SCHEDULED. Trạng thái 'PUBLISHING' và 'FAILED' là bắt buộc để state machine không bị kẹt và không đăng trùng.
- **Idempotency:** Mỗi Scheduled Post mang một idempotency key; Worker phải lock bài trước khi gọi API và chỉ một tiến trình được phép đăng. Nếu API đã đăng thành công nhưng cập nhật DB lỗi, lần quét sau phải nhận diện qua Post ID/idempotency key và KHÔNG đăng lại.
- **Media theo nền tảng:** TikTok bắt buộc video hoặc photo-carousel; một Content Draft chỉ có text KHÔNG đủ điều kiện đăng TikTok. Facebook/Website chấp nhận text hoặc text+media.
- Mỗi nền tảng có giới hạn độ dài nội dung riêng biệt (ví dụ: TikTok < 2200 ký tự cho mô tả, bao gồm hashtags).
- **Token:** Worker phải kiểm tra hiệu lực Platform Token trước khi đăng; token sắp hết hạn được refresh chủ động bởi job 12h/lần (xem API Catalog). Token chết tại thời điểm đăng → Failed + cảnh báo, không retry mù.
- Thời gian đăng bài phải là tương lai.
- Bài viết phải ở trạng thái 'Approved' mới được lên lịch.
- Retry chỉ áp dụng cho lỗi tạm thời (5xx, 429, network); lỗi 4xx/vi phạm chính sách chuyển thẳng sang 'Failed'.

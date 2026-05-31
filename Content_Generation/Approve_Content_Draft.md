# Use Case: Approve/Reject Content Draft

**Description:** Content Manager phê duyệt hoặc từ chối bản nháp nội dung trước khi lên lịch đăng (Flow phê duyệt bản nháp).

**Precondition:** 
- Content Manager đã đăng nhập thành công.
- Có ít nhất một bản nháp nội dung ở trạng thái 'Draft'.

**Postcondition:** 
- Trạng thái bản nháp được cập nhật thành 'Approved' hoặc 'Rejected'.
- Nếu Rejected, bản nháp quay lại trạng thái có thể chỉnh sửa kèm lý do từ chối.

## Actors
- **Content Manager**

## Data Entities
- **Content Draft**

## Flows

### MAIN: Approve/Reject Flow
1. Content Manager xem danh sách bản nháp (drafts) đang chờ duyệt.
2. Content Manager chọn một draft để xem chi tiết.
3. Hệ thống hiển thị bản xem trước (preview) của nội dung trên các nền tảng giả định.
4. Content Manager chọn 'Approve' (Phê duyệt) hoặc 'Reject' (Từ chối).
5. Nếu chọn 'Approve': hệ thống cập nhật trạng thái draft thành 'Approved' để sẵn sàng lên lịch.
6. Nếu chọn 'Reject': Content Manager bắt buộc phải nhập lý do từ chối. Hệ thống cập nhật trạng thái draft thành 'Rejected'.

### ALT: Reject with feedback
1. Tại bước 4 của luồng MAIN, nếu Content Manager chọn 'Reject'.
2. Hệ thống hiển thị form nhập lý do từ chối.
3. Content Manager nhập feedback chi tiết để yêu cầu sửa đổi (hoặc yêu cầu AI tự động sửa lại).
4. Hệ thống lưu feedback và đưa bản nháp về trạng thái chỉnh sửa.

## Business Rules
- Chỉ các draft có trạng thái 'Draft' mới có thể được phê duyệt hoặc từ chối.
- Bắt buộc phải xem bản preview trước khi thực hiện hành động duyệt.
- Hành động từ chối (Reject) bắt buộc phải kèm theo lý do/feedback để định hướng cho lần sửa đổi sau.
- Content Status Lifecycle: DRAFT → APPROVED → SCHEDULED → PUBLISHING → PUBLISHED. Nhánh từ chối: DRAFT → REJECTED → DRAFT. Nhánh lỗi đăng bài: PUBLISHING → FAILED → SCHEDULED (sau khi sửa). (Chi tiết trạng thái PUBLISHING/FAILED xem use case Automate Content Posting.)

# Use Case: Manage Content Drafts

**Description:** Quản lý (xem, sửa, xóa) các bản nháp nội dung đã được tạo bởi AI.

**Precondition:** Người dùng đã đăng nhập vào hệ thống.

**Postcondition:** Bản nháp được cập nhật hoặc xóa khỏi hệ thống.

## Actors
- **Content Manager**

## Data Entities
- **Content Draft**

## Flows
### ALT: Delete Draft
1. Content Manager chọn xóa bản nháp.
2. Hệ thống hiển thị hộp thoại xác nhận.
3. Content Manager xác nhận xóa.
4. Hệ thống xóa bản nháp khỏi cơ sở dữ liệu.

### MAIN: Main Flow
1. Content Manager xem danh sách các bản nháp nội dung.
2. Content Manager chọn một bản nháp để xem chi tiết hoặc sửa.
3. Content Manager thực hiện thay đổi nội dung (tiêu đề, body, CTA).
4. Content Manager lưu bản nháp.

## Business Rules
- Khi xóa bản nháp, hệ thống phải yêu cầu xác nhận.
- Chỉ có thể sửa bản nháp trạng thái 'Draft'.


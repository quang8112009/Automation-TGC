# Use Case: Manage Content Calendar

**Description:** Lên kế hoạch, xem tổng quan và quản lý lịch trình phát hành nội dung trên các nền tảng khác nhau.

**Precondition:** Người dùng đã đăng nhập vào hệ thống. Có các bài viết ở trạng thái 'Approved', 'Scheduled', hoặc 'Published'.

**Postcondition:** Lịch phát hành nội dung được tổ chức hợp lý, các thay đổi về thời gian đăng bài được cập nhật.

## Actors
- **Content Manager**

## Data Entities
- **Content Calendar**
- **Scheduled Post**

## Flows
### MAIN: View Content Calendar
1. Content Manager truy cập tính năng Quản lý lịch nội dung (Content Calendar).
2. Hệ thống hiển thị lịch dưới dạng xem theo tháng, tuần hoặc ngày.
3. Trên lịch hiển thị các bài viết với trạng thái tương ứng (màu sắc phân biệt cho Scheduled, Published, Draft).

### MAIN: Drag & Drop Rescheduling
1. Content Manager chọn một bài viết ở trạng thái 'Scheduled' trên lịch.
2. Kéo và thả bài viết sang một ngày hoặc khung giờ khác.
3. Hệ thống tự động kiểm tra tính hợp lệ của thời gian mới (phải là tương lai).
4. Hệ thống cập nhật thời gian lên lịch mới vào cơ sở dữ liệu và thông báo thành công.

### ALT: Invalid Reschedule Time
1. Trong quá trình kéo thả, Content Manager chọn thời gian trong quá khứ.
2. Hệ thống từ chối cập nhật và hiển thị cảnh báo lỗi.

## Business Rules
- Chỉ các bài viết có trạng thái 'Scheduled' mới có thể được thay đổi lịch thông qua thao tác kéo thả.
- Thời gian sau khi thay đổi bắt buộc phải là thời điểm trong tương lai.
- Giao diện lịch cần hiển thị rõ nền tảng đăng tải (Facebook, TikTok, Website) của từng bài viết.
- Lịch dùng màu sắc phân biệt trạng thái, bao gồm cả 'Failed' (đăng lỗi) để Content Manager dễ phát hiện và lên lịch lại.

# Use Case: View Operational Dashboard

**Description:** Tổng quan hiệu quả nội dung, trạng thái bài đăng, danh sách chờ duyệt (Approval Queue) và tổng quan Lead (Lead Overview).

**Precondition:** Người dùng đã đăng nhập.

**Postcondition:** Dashboard hiển thị đầy đủ thông tin tổng quan.

## Actors
- **Content Manager**

## Data Entities
- **KPI Metrics**
- **Dashboard**
- **Content Draft**
- **Lead Data**

## Flows
### ALT: Data Synchronization Alert
1. Hệ thống không tìm thấy dữ liệu đồng bộ mới. 
2. Hệ thống hiển thị cảnh báo 'Dữ liệu chưa được cập nhật' và gợi ý người dùng thực hiện đồng bộ thủ công.

### MAIN
1. Content Manager truy cập Dashboard. 
2. Hệ thống tổng hợp dữ liệu từ Analytics Data, trạng thái bản nháp (Drafts) và Lead Data. 
3. Hệ thống hiển thị các biểu đồ tổng quan về lượt View, Lead, Follow (Lead Overview). 
4. Hệ thống hiển thị danh sách chờ duyệt (Approval Queue) gồm các bài viết đang ở trạng thái 'Draft' cần phê duyệt VÀ các AI Insight đang 'Pending Review'.
5. Hệ thống hiển thị danh sách các bài viết sắp đăng trong 7 ngày tới ('Scheduled').
6. Hệ thống hiển thị mục cảnh báo các bài đăng 'Failed' (kèm lý do, ví dụ TOKEN_EXPIRED) để Content Manager xử lý/lên lịch lại, và cảnh báo token nền tảng sắp hết hạn.

## Business Rules
- Dữ liệu hiển thị trên Dashboard phải được cập nhật từ lần đồng bộ gần nhất (chu kỳ chuẩn 6 giờ/lần).
- Approval Queue ưu tiên hiển thị các bài viết được tạo gần nhất hoặc sắp tới hạn.
- Dashboard phải hiển thị các bài 'Failed' và cảnh báo token sắp hết hạn để đảm bảo luồng Publishing không bị gián đoạn âm thầm.

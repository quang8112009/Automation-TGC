# Use Case: Manage Leads

**Description:** Theo dõi, quản lý, và phân loại danh sách khách hàng tiềm năng (Leads) thu thập được từ các chiến dịch nội dung.

**Precondition:** Người dùng có quyền truy cập vào module Lead Management. Hệ thống đã có dữ liệu Leads từ Analytics hoặc các nguồn khác.

**Postcondition:** Thông tin Leads được cập nhật, phân loại hoặc gán cho nhân viên tư vấn.

## Actors
- **Content Manager**
- **Sales/Consultant**

## Data Entities
- **Lead**
- **Campaign/Content Source**

## Flows
### MAIN: View & Filter Leads
1. Content Manager truy cập module Lead Management.
2. Hệ thống hiển thị danh sách tất cả các Leads thu thập được.
3. Content Manager có thể lọc Leads theo nguồn gốc (bài viết, nền tảng, thời gian), trạng thái (Mới, Đang tư vấn, Chốt, Hủy) và thông tin liên hệ.

### MAIN: Update Lead Status
1. Content Manager hoặc Sales chọn một Lead từ danh sách.
2. Cập nhật trạng thái của Lead (ví dụ: chuyển từ 'Mới' sang 'Đang tư vấn').
3. Nhập thêm ghi chú hoặc thông tin chi tiết từ quá trình tư vấn.
4. Hệ thống lưu lại lịch sử cập nhật.

### ALT: Export Leads
1. Content Manager chọn tính năng xuất dữ liệu Leads.
2. Chọn các tiêu chí cần xuất.
3. Hệ thống tạo và tải xuống file (CSV/Excel) chứa thông tin Leads tương ứng.

## Business Rules
- Mỗi Lead phải được gắn liền với một nguồn (Source/Content Post) cụ thể để đo lường hiệu quả.
- Chỉ nhân sự có quyền mới được cập nhật trạng thái và xuất dữ liệu Lead. Cụ thể: vai trò ADMIN/Content Manager có toàn quyền; vai trò SALES/Consultant chỉ cập nhật trạng thái và ghi chú cho Lead được gán cho mình, và có thể xuất dữ liệu trong phạm vi được phép (theo RBAC định nghĩa ở use case Login/Register).
- Trạng thái mặc định khi nhận Lead mới là 'New'.

# Use Case: Login/Register

**Description:** Xác thực người dùng và đăng ký tài khoản mới để truy cập vào hệ thống.

**Precondition:** Người dùng có tài khoản hợp lệ hoặc cần tạo tài khoản mới.

**Postcondition:** Người dùng được đăng nhập vào hệ thống và nhận được JWT session.

## Actors
- **Content Manager**
- **Sales/Consultant** (vai trò hạn chế — chủ yếu thao tác trên Lead Management)

## Data Entities
- **User Account**
- **Role** (vai trò + tập quyền)
- **JWT Session**

## Flows
### MAIN: Login Flow
1. Content Manager nhập Username và Password.
2. Hệ thống kiểm tra thông tin đăng nhập trong cơ sở dữ liệu.
3. Nếu hợp lệ, hệ thống cấp JWT session token và quyền truy cập.

### ALT: Login Failure
1. Content Manager nhập sai thông tin.
2. Hệ thống thông báo lỗi và yêu cầu nhập lại.

### MAIN: Register Flow
1. Content Manager chọn 'Đăng ký tài khoản'.
2. Content Manager nhập thông tin: Username, Email, Password, Xác nhận Password.
3. Hệ thống kiểm tra tính hợp lệ (email format, password >= 8 ký tự, username chưa tồn tại).
4. Hệ thống tạo tài khoản và lưu vào cơ sở dữ liệu.
5. Hệ thống cấp JWT Access Token + Refresh Token.
6. Hệ thống chuyển hướng đến Dashboard.

### ALT: Logout
1. Content Manager chọn 'Đăng xuất'.
2. Hệ thống vô hiệu hóa token hiện tại.
3. Hệ thống chuyển hướng về trang đăng nhập.

## Business Rules
- Email phải đúng định dạng.
- Mật khẩu phải có ít nhất 8 ký tự.
- Username là bắt buộc.
- JWT Access Token hết hạn sau 24 giờ.
- Refresh Token hết hạn sau 30 ngày.
- Khóa tài khoản sau 5 lần đăng nhập sai liên tiếp.
- **Phân quyền (RBAC) — Phase 1:** Hệ thống có 2 vai trò người dùng:
  - **ADMIN / Content Manager:** toàn quyền (Strategy, Generation, Publishing, Analytics, Feedback Review, Lead Management, Settings).
  - **SALES / Consultant:** chỉ truy cập Lead Management (xem, cập nhật trạng thái, ghi chú lead được gán) và Dashboard ở chế độ chỉ đọc. KHÔNG truy cập Strategy/Generation/Publishing/Settings.
  - "AI System" và "System Background Worker" là tác nhân hệ thống (service account nội bộ), không phải tài khoản đăng nhập của người dùng.
- Mọi endpoint phải kiểm tra quyền theo vai trò (authorization) sau khi xác thực JWT.

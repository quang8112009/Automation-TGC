# Use Case: Define Content Persona & Strategy

**Description:** Thiết lập các đặc điểm, tone-of-voice, và chân dung khách hàng mục tiêu cho từng lĩnh vực dịch vụ (Du học, XKLĐ, v.v.) để định hướng AI.

**Precondition:** Người dùng đã đăng nhập vào hệ thống.

**Postcondition:** Thông tin Persona được lưu trữ và sẵn sàng để sử dụng làm ngữ cảnh (context) cho AI.

## Actors
- **Content Manager**
- **AI System**

## Data Entities
- **Domain Context**
- **Persona**

## Flows
### ALT: Update Existing Persona
1. Content Manager chọn chỉnh sửa Persona đã có.
2. Content Manager cập nhật các thông tin thuộc tính của Persona.
3. Hệ thống cập nhật thông tin trong cơ sở dữ liệu.

### MAIN: Main Flow
1. Content Manager chọn lĩnh vực cần định nghĩa (Ví dụ: Du học Nhật Bản).
2. Content Manager nhập các thông tin thuộc tính của Persona: tên persona, độ tuổi, sở thích, nhu cầu, nỗi đau (pain points).
3. Content Manager chọn phong cách viết (tone-of-voice: thân thiện, chuyên gia, truyền cảm hứng, v.v.).
4. Hệ thống kiểm tra dữ liệu đầu vào.
5. Hệ thống lưu cấu hình Persona vào cơ sở dữ liệu.

### ALT: AI Recommendation Flow
1. Content Manager chọn lĩnh vực cần định nghĩa.
2. Content Manager nhấn nút 'Gợi ý Persona bằng AI'.
3. AI System phân tích lĩnh vực và dữ liệu thị trường để đề xuất các thuộc tính Persona (độ tuổi, sở thích, nhu cầu, nỗi đau) và tone-of-voice phù hợp.
4. Content Manager xem xét các đề xuất từ AI.
5. Content Manager có thể chấp nhận toàn bộ, chỉnh sửa một phần, hoặc từ chối đề xuất.
6. Sau khi xác nhận, hệ thống lưu cấu hình Persona vào cơ sở dữ liệu.

## Business Rules
- Chân dung khách hàng phải mô tả ít nhất 3 đặc điểm chính (độ tuổi, nhu cầu, nỗi đau).
- Tone-of-voice không được để trống.
- Tên lĩnh vực là bắt buộc.

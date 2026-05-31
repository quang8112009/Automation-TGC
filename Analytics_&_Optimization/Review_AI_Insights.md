# Use Case: Review AI Insights

**Description:** Phê duyệt hoặc đánh giá các đề xuất tối ưu hóa (Insights) do AI System tạo ra dựa trên hiệu suất nội dung (Review Mode).

**Precondition:** AI System đã phân tích dữ liệu hiệu quả và tạo ra các Insights/Đề xuất mới. Người dùng đã đăng nhập.

**Postcondition:** Các Insights được người dùng duyệt sẽ được áp dụng làm ngữ cảnh hoặc định hướng cho chiến lược nội dung tiếp theo.

## Actors
- **Content Manager**
- **AI System**

## Data Entities
- **AI Insight**
- **Analytics Data**
- **Domain Context / Persona**

## Flows
### MAIN: Review & Approve Insight
1. Content Manager truy cập danh sách các AI Insights đang chờ duyệt.
2. Hệ thống hiển thị các đề xuất (Ví dụ: "Bài đăng video ngắn trên TikTok lúc 20h đang mang lại tỷ lệ Lead cao nhất, đề xuất tăng cường tần suất").
3. Content Manager chọn một Insight để xem chi tiết, bao gồm dữ liệu phân tích minh chứng.
4. Content Manager nhấn "Approve" (Phê duyệt).
5. Hệ thống cập nhật trạng thái của Insight thành "Approved". Việc áp dụng thay đổi thực tế (cập nhật Persona/Calendar/AI Prompt Context) do **Strategy Update Processor** thực hiện ngay sau khi insight được Approved — Strategy Update Processor là nguồn sự thật duy nhất cho mọi thay đổi chiến lược. Insight chỉ ở trạng thái "Approved" không tự ý sửa dữ liệu; mọi thay đổi đi qua processor để đảm bảo audit log và tính nhất quán.

### ALT: Reject or Modify Insight
1. Tại bước 4 của luồng MAIN, Content Manager không đồng ý với đề xuất.
2. Content Manager chọn "Reject" (Từ chối) và nhập lý do, HOẶC tiến hành "Modify" (Chỉnh sửa) nội dung đề xuất cho phù hợp với chiến lược thực tế.
3. Hệ thống lưu lại trạng thái "Rejected" hoặc cập nhật Insight mới do người dùng chỉnh sửa.

## Business Rules
- AI Insights phải được đính kèm với dữ liệu hiệu suất (Metrics) rõ ràng làm cơ sở.
- Các Insights được phê duyệt (Approved) sẽ được **Strategy Update Processor** áp dụng và tự động trở thành dữ liệu đầu vào (Context) cho các đợt Generate AI Content tiếp theo. Insight không tự sửa dữ liệu trực tiếp — mọi thay đổi đi qua Strategy Update Processor (nguồn sự thật duy nhất, có ghi audit log).
- Insights có vòng đời: New -> Pending Review -> Approved/Rejected.

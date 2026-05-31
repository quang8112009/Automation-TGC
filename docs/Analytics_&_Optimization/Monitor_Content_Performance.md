# Use Case: Monitor Content Performance

**Description:** Theo dõi KPI (View, Lead, Follow) và phân tích hiệu quả.

**Precondition:** Người dùng đã đăng nhập và bài viết đã được đăng tải.

**Postcondition:** Dữ liệu hiệu quả bài viết được cập nhật và lưu trữ.

## Actors
- **AI System**
- **Content Manager**

## Data Entities
- **Analytics Data**
- **Content Post**

## Flows
### EXCEPTION: Platform API Error
1. Kết nối API đến nền tảng social gặp lỗi. 
2. Hệ thống ghi nhật ký lỗi (Log error) và thông báo cho người dùng biết dữ liệu chưa được cập nhật mới nhất.

### MAIN
1. Hệ thống tự động kết nối API với các nền tảng social/website để lấy dữ liệu lượt View, Like, Follow, Lead của từng bài viết. 
2. Hệ thống khớp dữ liệu này với bài viết tương ứng trong cơ sở dữ liệu. 
3. Hệ thống tính toán các chỉ số chuyển đổi dựa trên công thức quy định. 
4. Hệ thống lưu trữ dữ liệu hiệu quả vào 'Analytics Data'. 
5. Hệ thống hiển thị biểu đồ hiệu quả chi tiết cho người dùng.

## Business Rules
- Analytics phải tích hợp webhook hoặc API từ nền tảng để thu thập dữ liệu hiệu quả (lượt view, follow, lead) về database. **Chu kỳ đồng bộ chuẩn toàn hệ thống là 6 giờ/lần** (thống nhất với CRON schedule trong API Catalog và Data Flow — không còn mốc 24h).
- Tỷ lệ chuyển đổi = (Số Lead / Số View) * 100.
- **Quy ước xử lý mẫu số = 0:** Nếu View = 0 (bài mới đăng hoặc nền tảng không trả View), `conversion_rate` được gán = 0 và bài viết gắn nhãn `INSUFFICIENT_DATA`; bài KHÔNG được đưa vào Performance Scoring/Feedback Loop cho đến khi có View > 0. Quy ước tương tự áp dụng cho mọi chỉ số có mẫu số (reach, view).
- **Khả dụng metrics theo nền tảng (platform metric availability):**
  - **Facebook:** impressions (views), reach, reactions/likes, comments, shares, clicks → tính đủ conversion / engagement / CTA / follow rate.
  - **Website (GA4):** pageviews, sessions, conversions, engaged sessions → conversion / engagement rate.
  - **TikTok:** CHỈ có `view_count`, `like_count`, `comment_count`, `share_count`. KHÔNG có `reach` và follower-growth per-post. Với TikTok: `engagement_rate = (like + comment + share) / view × 100`; các chỉ số dựa trên `reach` và `follow_rate` KHÔNG áp dụng.
  - **Lead/conversion từ TikTok** được quy về qua redirect bio link → Website form (UTM), không đo trực tiếp trên TikTok.
- Dữ liệu hiệu quả phải được đồng bộ ít nhất 6 giờ một lần.

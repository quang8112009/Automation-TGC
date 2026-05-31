# Thiết Kế Luồng Dữ Liệu: Analytics → Content Strategy (AI Feedback Loop)

> **Phiên bản:** 1.2  
> **Ngày tạo:** 29/05/2026  
> **Cập nhật:** 30/05/2026 — Chốt chu kỳ thu thập 6h; bổ sung quy tắc divide-by-zero, platform metric availability (TikTok), cold start, và Strategy Update Processor là nguồn sự thật (R11–R14)  
> **Mô tả:** Tài liệu mô tả chi tiết cách dữ liệu hiệu quả (Analytics) được truyền ngược lại module Content Strategy, tạo vòng phản hồi khép kín (Closed-Loop Feedback) để AI tự học và điều chỉnh chiến lược nội dung — mọi thay đổi đều cần Content Manager phê duyệt (REVIEW MODE).

---

## 1. Tổng Quan Kiến Trúc Luồng Phản Hồi

Hệ thống AutoTGC vận hành theo mô hình **Closed-Loop AI Feedback**, trong đó dữ liệu hiệu quả từ các nền tảng (Facebook, TikTok, Website) được thu thập, phân tích bởi **Google Gemini AI**, và chuyển đổi thành "tín hiệu học" (Learning Signals). Mọi đề xuất thay đổi chiến lược đều được đưa vào **hàng chờ phê duyệt** (REVIEW MODE) để Content Manager xác nhận trước khi áp dụng.

### 1.1 Sơ Đồ Tổng Quan (High-Level Data Flow)

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                        AUTOTGC - CLOSED-LOOP AI FEEDBACK                        │
│                                                                                 │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │   CONTENT     │    │   CONTENT     │    │  PUBLISHING   │    │  ANALYTICS   │  │
│  │   STRATEGY    │───▶│  GENERATION   │───▶│               │───▶│              │  │
│  │              │    │   (AI)        │    │              │    │              │  │
│  └──────┬───────┘    └──────────────┘    └──────────────┘    └──────┬───────┘  │
│         ▲                                                            │          │
│         │              ┌──────────────────┐                         │          │
│         │              │   AI FEEDBACK     │                         │          │
│         └──────────────│   LOOP ENGINE     │◀────────────────────────┘          │
│                        │  (Self-Learning)  │                                    │
│                        └──────────────────┘                                    │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Chi Tiết Luồng Dữ Liệu (Detailed Data Flow)

### 2.1 Giai Đoạn 1: Thu Thập Dữ Liệu Hiệu Quả (Data Collection)

**Nguồn dữ liệu:**  
Dữ liệu được thu thập từ các nền tảng thông qua API/Webhook theo **chu kỳ chuẩn 6 giờ/lần** (thống nhất toàn hệ thống với CRON schedule và use case Monitor Content Performance).

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Facebook    │     │   TikTok    │     │   Website   │
│  Graph API   │     │ Content API │     │  Google     │
│              │     │             │     │  Analytics  │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │
       ▼                   ▼                   ▼
┌──────────────────────────────────────────────────────┐
│              DATA COLLECTION LAYER                    │
│                                                      │
│  Thu thập Raw Metrics cho từng Content Post:          │
│  ┌─────────────────────────────────────────────┐     │
│  │  post_id          : ID bài viết nội bộ       │     │
│  │  platform         : facebook|tiktok|website  │     │
│  │  views            : Lượt xem                 │     │
│  │  likes            : Lượt thích               │     │
│  │  shares           : Lượt chia sẻ             │     │
│  │  comments         : Lượt bình luận           │     │
│  │  follows          : Lượt follow mới          │     │
│  │  leads            : Số lead (form, message)  │     │
│  │  click_through    : Lượt click CTA           │     │
│  │  reach            : Số người tiếp cận        │     │
│  │  collected_at     : Thời điểm thu thập       │     │
│  └─────────────────────────────────────────────┘     │
│                                                      │
└───────────────────────┬──────────────────────────────┘
                        │
                        ▼
                 ┌──────────────┐
                 │ Analytics DB │
                 │ (Raw Data)   │
                 └──────┬───────┘
                        │
                        ▼
```

### 2.2 Giai Đoạn 2: Tính Toán & Phân Loại Hiệu Quả (Performance Scoring)

```
┌──────────────────────────────────────────────────────────────────────┐
│                  PERFORMANCE SCORING ENGINE                          │
│                                                                      │
│  Input: Raw Metrics từ Analytics DB                                  │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  BƯỚC 1: Tính toán chỉ số chuyển đổi (Conversion Metrics)    │  │
│  │                                                                │  │
│  │  • conversion_rate = (leads / views) × 100                     │  │
│  │  • engagement_rate = (likes + comments + shares) / reach × 100 │  │
│  │  • cta_click_rate  = (click_through / views) × 100             │  │
│  │  • follow_rate     = (follows / reach) × 100                   │  │
│  └────────────────────────────────────────────────────────────────┘  │

  ────────────────────────────────────────────────────────────────────
  ⚠️ QUY TẮC AN TOÀN KHI TÍNH (bổ sung):

  • Mẫu số = 0 (views = 0 hoặc reach = 0): KHÔNG chia. Gán chỉ số = 0
    và label = "INSUFFICIENT_DATA". Bài này bị loại khỏi Pattern
    Recognition cho đến khi có views/reach > 0.

  • Khả dụng metric theo nền tảng (platform metric availability):
    - Facebook : đủ views, reach, click_through, follows
                 → tính được cả 4 chỉ số.
    - Website  : pageviews, sessions, conversions (GA4)
                 → conversion_rate, engagement_rate.
    - TikTok   : CHỈ có view, like, comment, share (API không trả
                 reach & follower-growth per-post).
                 → engagement_rate = (like+comment+share)/view × 100.
                   reach-based metrics (follow_rate) và reach-based
                   engagement KHÔNG áp dụng cho TikTok.
                 → Lead/conversion của TikTok quy về qua redirect bio
                   link → Website form (UTM), không đo trực tiếp.

  • Chỉ số nào không khả dụng trên một nền tảng được đánh dấu null và
    BỎ QUA khi gom nhóm (không coi là 0 để tránh kéo trung bình sai).
  ────────────────────────────────────────────────────────────────────

│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  BƯỚC 2: Gắn nhãn hiệu quả (Performance Label)               │  │
│  │                                                                │  │
│  │  Dựa trên ngưỡng (threshold) được cấu hình:                   │  │
│  │                                                                │  │
│  │  IF conversion_rate ≥ HIGH_THRESHOLD (ví dụ: 5%)              │  │
│  │     → label = "HIGH_PERFORMER"                                │  │
│  │  ELSE IF conversion_rate ≥ MID_THRESHOLD (ví dụ: 2%)         │  │
│  │     → label = "AVERAGE_PERFORMER"                             │  │
│  │  ELSE                                                          │  │
│  │     → label = "LOW_PERFORMER"                                 │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  BƯỚC 3: Trích xuất đặc trưng nội dung (Content Features)    │  │
│  │                                                                │  │
│  │  Cho mỗi bài viết, trích xuất metadata:                       │  │
│  │  • domain_category   : Lĩnh vực (XKLĐ, Du học, Visa,...)     │  │
│  │  • content_topic     : Chủ đề cụ thể (Điều dưỡng Nhật Bản)  │  │
│  │  • persona_id        : Persona đã sử dụng                    │  │
│  │  • tone_of_voice     : Phong cách viết                        │  │
│  │  • objective         : Mục tiêu (Lead / View / Follow)        │  │
│  │  • platform          : Nền tảng đăng                          │  │
│  │  • post_time_slot    : Khung giờ đăng (sáng/trưa/tối)        │  │
│  │  • content_length    : Độ dài nội dung                        │  │
│  │  • has_cta           : Có CTA hay không                       │  │
│  │  • cta_type          : Loại CTA (form/message/call)           │  │
│  │  • media_type        : Loại media (image/video/text)          │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  Output: Performance Record                                          │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  {                                                             │  │
│  │    post_id, platform, domain_category, content_topic,          │  │
│  │    persona_id, tone_of_voice, objective, post_time_slot,       │  │
│  │    conversion_rate, engagement_rate, cta_click_rate,           │  │
│  │    follow_rate, performance_label, scored_at                   │  │
│  │  }                                                             │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
└───────────────────────────────┬──────────────────────────────────────┘
                                │
                                ▼
                   ┌─────────────────────┐
                   │  Performance Data    │
                   │  (Scored Records)    │
                   └──────────┬──────────┘
                              │
                              ▼
```

### 2.3 Giai Đoạn 3: AI Feedback Loop Engine (Lõi tự học — Powered by Google Gemini)

Đây là thành phần cốt lõi, sử dụng **Google Gemini API** để phân tích dữ liệu hiệu quả đã ghi nhận và tạo ra **Learning Insights** — các tín hiệu phản hồi có cấu trúc.

```
┌──────────────────────────────────────────────────────────────────────────┐
│                     AI FEEDBACK LOOP ENGINE                              │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │  MODULE A: PATTERN RECOGNITION (Nhận dạng xu hướng)               │  │
│  │                                                                    │  │
│  │  Phân tích tổng hợp Performance Records theo nhiều chiều:          │  │
│  │                                                                    │  │
│  │  1. Theo Lĩnh vực (domain_category):                              │  │
│  │     GROUP BY domain_category                                       │  │
│  │     → AVG(conversion_rate), COUNT(HIGH_PERFORMER)                 │  │
│  │     → Kết quả: "XKLĐ ngành Điều dưỡng" có avg_conversion = 7.2%  │  │
│  │                                                                    │  │
│  │  2. Theo Chủ đề (content_topic):                                  │  │
│  │     GROUP BY content_topic                                         │  │
│  │     → Xếp hạng top chủ đề hiệu quả cao nhất                     │  │
│  │                                                                    │  │
│  │  3. Theo Persona + Tone:                                          │  │
│  │     GROUP BY persona_id, tone_of_voice                             │  │
│  │     → Persona nào + Tone nào cho kết quả tốt nhất?               │  │
│  │                                                                    │  │
│  │  4. Theo Nền tảng + Khung giờ:                                    │  │
│  │     GROUP BY platform, post_time_slot                              │  │
│  │     → Nền tảng nào, giờ nào cho engagement cao nhất?              │  │
│  │                                                                    │  │
│  │  5. Theo Loại CTA + Mục tiêu:                                    │  │
│  │     GROUP BY cta_type, objective                                   │  │
│  │     → CTA dạng nào chuyển đổi tốt nhất cho mục tiêu Lead?        │  │
│  │                                                                    │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                              │                                           │
│                              ▼                                           │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │  MODULE B: INSIGHT GENERATION (Tạo insight & khuyến nghị)         │  │
│  │                                                                    │  │
│  │  Dựa trên Pattern Recognition, tạo ra các loại Insight:           │  │
│  │                                                                    │  │
│  │  ┌──────────────────────────────────────────────────────────────┐  │  │
│  │  │ Insight Type 1: TOPIC_FREQUENCY_ADJUSTMENT                  │  │  │
│  │  │                                                              │  │  │
│  │  │ Logic:                                                       │  │  │
│  │  │ IF topic.avg_conversion ≥ HIGH_THRESHOLD                    │  │  │
│  │  │   AND topic.sample_size ≥ MIN_SAMPLE (ví dụ: 5 bài)        │  │  │
│  │  │ THEN                                                        │  │  │
│  │  │   → suggestion = "INCREASE_FREQUENCY"                      │  │  │
│  │  │   → suggested_increase = +30% so với tần suất hiện tại     │  │  │
│  │  │                                                              │  │  │
│  │  │ Ví dụ cụ thể:                                               │  │  │
│  │  │ "Bài về 'XKLĐ ngành Điều dưỡng' có conversion_rate = 7.2%  │  │  │
│  │  │  (HIGH). Gợi ý: Tăng tần suất từ 2 bài/tuần → 3 bài/tuần" │  │  │
│  │  └──────────────────────────────────────────────────────────────┘  │  │
│  │                                                                    │  │
│  │  ┌──────────────────────────────────────────────────────────────┐  │  │
│  │  │ Insight Type 2: PERSONA_TONE_OPTIMIZATION                   │  │  │
│  │  │                                                              │  │  │
│  │  │ Logic:                                                       │  │  │
│  │  │ IF persona_A + tone_X has highest conversion                │  │  │
│  │  │   AND significantly_higher_than(persona_A + tone_Y)         │  │  │
│  │  │ THEN                                                        │  │  │
│  │  │   → suggestion = "PREFER_TONE"                              │  │  │
│  │  │   → recommended_tone = tone_X                               │  │  │
│  │  │                                                              │  │  │
│  │  │ Ví dụ: "Persona 'Sinh viên 20-25 tuổi' với tone 'Truyền    │  │  │
│  │  │  cảm hứng' có conversion cao hơn 40% so với tone 'Chuyên   │  │  │
│  │  │  gia'. Gợi ý ưu tiên tone 'Truyền cảm hứng'."             │  │  │
│  │  └──────────────────────────────────────────────────────────────┘  │  │
│  │                                                                    │  │
│  │  ┌──────────────────────────────────────────────────────────────┐  │  │
│  │  │ Insight Type 3: OPTIMAL_POSTING_SCHEDULE                    │  │  │
│  │  │                                                              │  │  │
│  │  │ Logic:                                                       │  │  │
│  │  │ Phân tích engagement_rate theo platform + time_slot          │  │  │
│  │  │ → Xác định khung giờ vàng cho từng nền tảng                │  │  │
│  │  │                                                              │  │  │
│  │  │ Ví dụ: "Facebook: Đăng lúc 19:00-21:00 có engagement       │  │  │
│  │  │  cao hơn 60% so với đăng buổi sáng."                       │  │  │
│  │  └──────────────────────────────────────────────────────────────┘  │  │
│  │                                                                    │  │
│  │  ┌──────────────────────────────────────────────────────────────┐  │  │
│  │  │ Insight Type 4: LOW_PERFORMER_ALERT                         │  │  │
│  │  │                                                              │  │  │
│  │  │ Logic:                                                       │  │  │
│  │  │ IF topic.avg_conversion ≤ LOW_THRESHOLD                     │  │  │
│  │  │   AND topic.sample_size ≥ MIN_SAMPLE                        │  │  │
│  │  │ THEN                                                        │  │  │
│  │  │   → suggestion = "REDUCE_OR_REVISE"                        │  │  │
│  │  │   → action = giảm tần suất hoặc thay đổi góc tiếp cận     │  │  │
│  │  │                                                              │  │  │
│  │  │ Ví dụ: "Bài về 'Visa du lịch Hàn Quốc' có conversion =    │  │  │
│  │  │  0.3% (LOW) sau 10 bài. Gợi ý: Giảm tần suất hoặc thay   │  │  │
│  │  │  đổi góc viết."                                             │  │  │
│  │  └──────────────────────────────────────────────────────────────┘  │  │
│  │                                                                    │  │
│  │  ┌──────────────────────────────────────────────────────────────┐  │  │
│  │  │ Insight Type 5: PLATFORM_CONTENT_FIT                        │  │  │
│  │  │                                                              │  │  │
│  │  │ Logic:                                                       │  │  │
│  │  │ So sánh hiệu quả cùng 1 chủ đề trên các nền tảng khác nhau│  │  │
│  │  │ → Gợi ý nền tảng phù hợp nhất cho từng loại nội dung      │  │  │
│  │  │                                                              │  │  │
│  │  │ Ví dụ: "Chủ đề 'Kinh nghiệm phỏng vấn XKLĐ' hiệu quả    │  │  │
│  │  │  trên TikTok (video ngắn) gấp 3 lần trên Website (bài     │  │  │
│  │  │  viết dài). Gợi ý ưu tiên TikTok cho chủ đề này."         │  │  │
│  │  └──────────────────────────────────────────────────────────────┘  │  │
│  │                                                                    │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                              │                                           │
│                              ▼                                           │
│                    ┌───────────────────┐                                  │
│                    │  Learning Insights │                                 │
│                    │  (Structured JSON) │                                 │
│                    └─────────┬─────────┘                                 │
│                              │                                           │
└──────────────────────────────┼───────────────────────────────────────────┘
                               │
                               ▼
```

### 2.4 Giai Đoạn 4: Cập Nhật Ngược Content Strategy (Strategy Update)

```
┌──────────────────────────────────────────────────────────────────────────┐
│               STRATEGY UPDATE PROCESSOR                                  │
│                                                                          │
│  Input: Learning Insights từ AI Feedback Loop Engine                     │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │  BƯỚC 1: Cập nhật Content Calendar (Lịch nội dung)               │  │
│  │                                                                    │  │
│  │  Dựa trên TOPIC_FREQUENCY_ADJUSTMENT:                             │  │
│  │  • HIGH_PERFORMER topics → Tăng slots trong lịch tuần             │  │
│  │  • LOW_PERFORMER topics  → Giảm slots hoặc đề xuất thay đổi      │  │
│  │                                                                    │  │
│  │  Ví dụ Output:                                                     │  │
│  │  ┌────────────────────────────────────────────────────┐           │  │
│  │  │ TUẦN TỚI - GỢI Ý LỊCH NỘI DUNG (AI-generated)   │           │  │
│  │  │                                                    │           │  │
│  │  │ T2: XKLĐ Điều dưỡng (Facebook, 19:00) ★ HIGH     │           │  │
│  │  │ T3: Du học Nhật - Học bổng (Website, 09:00)       │           │  │
│  │  │ T4: XKLĐ Điều dưỡng (TikTok, 20:00) ★ HIGH      │           │  │
│  │  │ T5: Kinh nghiệm phỏng vấn (TikTok, 19:00) ★ MED │           │  │
│  │  │ T6: XKLĐ Điều dưỡng (Facebook, 19:00) ★ HIGH     │           │  │
│  │  │ T7: Du học Hàn Quốc (Facebook, 10:00) ↓ GIẢM     │           │  │
│  │  │ CN: Testimonial XKLĐ (Facebook, 20:00)            │           │  │
│  │  └────────────────────────────────────────────────────┘           │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │  BƯỚC 2: Cập nhật Persona Preferences                            │  │
│  │                                                                    │  │
│  │  Dựa trên PERSONA_TONE_OPTIMIZATION:                              │  │
│  │  • Cập nhật trường "recommended_tone" trong Persona               │  │
│  │  • Lưu lịch sử thay đổi tone để Content Manager review           │  │
│  │                                                                    │  │
│  │  Ví dụ: Persona "Sinh viên 20-25"                                 │  │
│  │  → recommended_tone: "Truyền cảm hứng" (was: "Chuyên gia")      │  │
│  │  → confidence_score: 0.85 (dựa trên 15 bài mẫu)                  │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │  BƯỚC 3: Cập nhật AI Prompt Context                               │  │
│  │                                                                    │  │
│  │  Dựa trên tất cả Insights, bổ sung vào AI Generation Context:     │  │
│  │                                                                    │  │
│  │  {                                                                 │  │
│  │    "top_performing_topics": [                                      │  │
│  │      {"topic": "XKLĐ Điều dưỡng", "conv_rate": 7.2%},           │  │
│  │      {"topic": "Kinh nghiệm phỏng vấn", "conv_rate": 5.1%}     │  │
│  │    ],                                                              │  │
│  │    "best_cta_patterns": [                                          │  │
│  │      {"cta": "Đăng ký tư vấn miễn phí", "click_rate": 8.5%},    │  │
│  │    ],                                                              │  │
│  │    "optimal_content_length": {                                     │  │
│  │      "facebook": "300-500 từ",                                    │  │
│  │      "tiktok": "< 300 ký tự mô tả",                              │  │
│  │      "website": "800-1500 từ"                                     │  │
│  │    },                                                              │  │
│  │    "avoid_topics": [                                               │  │
│  │      {"topic": "Visa du lịch HQ", "reason": "Low conversion"}    │  │
│  │    ]                                                               │  │
│  │  }                                                                 │  │
│  │                                                                    │  │
│  │  → Context này được inject vào prompt khi Generate AI Content     │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │  BƯỚC 4: Thông báo & Phê duyệt (Notification & Approval)        │  │
│  │                                                                    │  │
│  │  > ✅ MẶC ĐỊNH: REVIEW MODE (đã xác nhận 29/05/2026)               │  │
│  │                                                                    │  │
│  │  Chế độ hoạt động:                                                │  │
│  │                                                                    │  │
│  │  • REVIEW MODE (MẶC ĐỊNH — Cần duyệt):                           │  │
│  │    Mọi thay đổi từ AI Feedback Loop đều được đưa vào            │  │
│  │    "Approval Queue" trên Dashboard để Content Manager phê duyệt:  │  │
│  │    - Điều chỉnh tần suất chủ đề                                  │  │
│  │    - Thay đổi Persona tone-of-voice                               │  │
│  │    - Thay đổi khung giờ đăng                                      │  │
│  │    - Loại bỏ/thêm chủ đề mới                                     │  │
│  │    - Cập nhật AI Prompt Context                                  │  │
│  │                                                                    │  │
│  │  • AUTO MODE (Tùy chọn — không mặc định):                        │  │
│  │    Content Manager có thể bật AUTO MODE cho các thay đổi nhỏ:    │  │
│  │    - Điều chỉnh tần suất ≤ 30%                                    │  │
│  │    - Thay đổi khung giờ đăng                                      │  │
│  │    (Cần bật thủ công trong Settings, không tự kích hoạt)         │  │
│  │                                                                    │  │
│  │  Quy trình REVIEW MODE:                                           │  │
│  │  1. Insight được tạo → status = "PENDING_REVIEW"                 │  │
│  │  2. Gửi notification đến Dashboard + Email                       │  │
│  │  3. Content Manager xem chi tiết Insight + dữ liệu gốc           │  │
│  │  4. Content Manager chọn "Approve" hoặc "Reject"                 │  │
│  │  5. Nếu Approve → Hệ thống áp dụng thay đổi vào Strategy        │  │
│  │  6. Nếu Reject → Lưu lý do từ chối, AI học từ feedback          │  │
│  │                                                                    │  │
│  │  → Gửi notification đến Dashboard + Email cho Content Manager     │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Sơ Đồ Luồng Dữ Liệu Tổng Hợp (End-to-End Data Flow Diagram)

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                        │
│   ① CONTENT STRATEGY                                                                  │
│   ┌─────────────────────┐                                                              │
│   │ • Persona            │                                                              │
│   │ • Domain Context     │──────────────┐                                               │
│   │ • AI Prompt Context  │              │                                               │
│   │ • Content Calendar   │◀─────────────┼──────────────────────────────────┐            │
│   └─────────────────────┘              │                                  │            │
│          ▲                              ▼                                  │            │
│          │                   ② CONTENT GENERATION                         │            │
│          │                   ┌─────────────────────┐                      │            │
│          │                   │ • AI tạo nội dung    │                      │            │
│          │                   │ • Content Draft      │                      │            │
│          │                   │ • Title + Body + CTA │                      │            │
│          │                   └──────────┬──────────┘                      │            │
│          │                              │                                  │            │
│          │                              ▼                                  │            │
│          │                   ③ PUBLISHING                                 │            │
│          │                   ┌─────────────────────┐                      │            │
│          │                   │ • Scheduled Post     │                      │            │
│          │                   │ • Platform: FB/TT/WEB│                      │            │
│          │                   │ • Time Slot          │                      │            │
│          │                   └──────────┬──────────┘                      │            │
│          │                              │                                  │            │
│          │                              ▼                                  │            │
│          │                   ④ LIVE ON PLATFORMS                           │            │
│          │                   ┌─────────────────────┐                      │            │
│          │                   │ Facebook │ TikTok    │                      │            │
│          │                   │ Website             │                      │            │
│          │                   └──────────┬──────────┘                      │            │
│          │                              │ (API/Webhook)                    │            │
│          │                              ▼                                  │            │
│          │                   ⑤ ANALYTICS & DATA COLLECTION                │            │
│          │                   ┌─────────────────────┐                      │            │
│          │                   │ Raw Metrics:         │                      │            │
│          │                   │ Views, Leads, Follow │                      │            │
│          │                   │ Likes, Shares, CTR   │                      │            │
│          │                   └──────────┬──────────┘                      │            │
│          │                              │                                  │            │
│          │                              ▼                                  │            │
│          │                   ⑥ PERFORMANCE SCORING                        │            │
│          │                   ┌─────────────────────┐                      │            │
│          │                   │ Conversion Rate      │                      │            │
│          │                   │ Engagement Rate      │                      │            │
│          │                   │ Performance Label    │                      │            │
│          │                   │ Content Features     │                      │            │
│          │                   └──────────┬──────────┘                      │            │
│          │                              │                                  │            │
│          │                              ▼                                  │            │
│          │                   ⑦ AI FEEDBACK LOOP ENGINE                    │            │
│          │                   ┌─────────────────────┐                      │            │
│          │                   │ Pattern Recognition  │                      │            │
│          │                   │ Insight Generation   │                      │            │
│          │                   │ Learning Signals     │                      │            │
│          │                   └──────────┬──────────┘                      │            │
│          │                              │                                  │            │
│          │                              ▼                                  │            │
│          │                   ⑧ STRATEGY UPDATE PROCESSOR                  │            │
│          │                   ┌─────────────────────┐                      │            │
│          │                   │ Update Calendar      │──────────────────────┘            │
│          │                   │ Update Persona       │                                   │
│          │                   │ Update AI Context    │                                   │
│          └───────────────────│ Notify Manager       │                                   │
│                              └─────────────────────┘                                   │
│                                                                                        │
│   ⑨ OPERATIONAL DASHBOARD                                                             │
│   ┌─────────────────────┐                                                              │
│   │ • Hiển thị Insights  │◀── Lấy dữ liệu từ ⑥ + ⑦                                  │
│   │ • Gợi ý AI          │                                                              │
│   │ • Approval Queue    │                                                              │
│   └─────────────────────┘                                                              │
│                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Cấu Trúc Dữ Liệu Chính (Key Data Structures)

### 4.1 Learning Insight Record

```json
{
  "insight_id": "INS-20260529-001",
  "insight_type": "TOPIC_FREQUENCY_ADJUSTMENT",
  "generated_at": "2026-05-29T18:00:00+07:00",
  "analysis_period": "2026-05-01 → 2026-05-28",
  "subject": {
    "domain_category": "XKLĐ",
    "content_topic": "Điều dưỡng Nhật Bản",
    "persona_id": "PER-003"
  },
  "metrics": {
    "total_posts_analyzed": 12,
    "avg_conversion_rate": 7.2,
    "avg_engagement_rate": 15.4,
    "best_platform": "Facebook",
    "best_time_slot": "19:00-21:00"
  },
  "suggestion": {
    "action": "INCREASE_FREQUENCY",
    "current_frequency": "2 bài/tuần",
    "recommended_frequency": "3 bài/tuần",
    "confidence_score": 0.88,
    "estimated_impact": "+35% leads/tuần"
  },
  "approval_required": true,
  "status": "PENDING_REVIEW"
}
```

### 4.2 AI Prompt Context (Enriched)

```json
{
  "context_version": "2026-05-29",
  "last_updated_from_analytics": "2026-05-29T06:00:00+07:00",
  "performance_context": {
    "top_topics": [
      {
        "topic": "XKLĐ ngành Điều dưỡng",
        "avg_conversion": 7.2,
        "recommended_frequency": "3/tuần",
        "best_platform": "Facebook",
        "best_cta": "Đăng ký tư vấn miễn phí ngay"
      }
    ],
    "underperforming_topics": [
      {
        "topic": "Visa du lịch Hàn Quốc",
        "avg_conversion": 0.3,
        "recommendation": "Thay đổi góc viết hoặc giảm tần suất"
      }
    ],
    "tone_recommendations": {
      "PER-001_SinhVien": "Truyền cảm hứng",
      "PER-002_PhuHuynh": "Chuyên gia, đáng tin cậy"
    },
    "optimal_schedules": {
      "facebook": {"best_slot": "19:00-21:00", "worst_slot": "06:00-08:00"},
      "tiktok": {"best_slot": "20:00-22:00", "worst_slot": "08:00-10:00"},
      "website": {"best_slot": "09:00-11:00", "worst_slot": "22:00-00:00"}
    }
  }
}
```

---

## 5. Quy Tắc Vận Hành (Business Rules cho Feedback Loop)

| # | Quy tắc | Mô tả |
|---|---------|--------|
| R1 | Ngưỡng đánh giá mặc định | HIGH ≥ 5% conversion, MID ≥ 2%, LOW < 2% |
| R2 | Kích thước mẫu tối thiểu | Cần ≥ 5 bài viết cùng chủ đề để tạo Insight có giá trị |
| R3 | Chu kỳ phân tích | AI Feedback Loop chạy 1 lần/tuần (Chủ nhật 00:00) |
| R4 | **Chế độ mặc định** | **REVIEW MODE** — Mọi Insight đều cần Content Manager phê duyệt trước khi áp dụng |
| R5 | Auto Mode (tùy chọn) | Content Manager có thể bật AUTO cho thay đổi nhỏ (≤ 30% tần suất, khung giờ) |
| R6 | Lưu lịch sử | Mọi Insight, quyết định Approve/Reject đều được lưu log để audit |
| R7 | Fallback | Nếu không đủ dữ liệu (< 5 bài), giữ nguyên chiến lược hiện tại |
| R8 | Retention | Dữ liệu Performance Records lưu trữ tối thiểu 12 tháng |
| R9 | Conflict Resolution | Nếu Insight mâu thuẫn, ưu tiên conversion_rate > engagement_rate |
| R10 | AI Engine | Sử dụng Google Gemini API (gemini-2.5-pro cho phân tích, gemini-2.5-flash cho tóm tắt) |
| R11 | Cold start | Khi chưa đủ dữ liệu, AI Prompt Context có thể rỗng. Module Generation phải dùng Default Context (Persona + Domain + tone mặc định) và KHÔNG được fail; nội dung đánh dấu `generated_without_feedback`. |
| R12 | Platform metric availability | Chỉ tính chỉ số mà API nền tảng thực sự cung cấp. TikTok không có reach/follower-per-post → bỏ qua follow_rate và reach-based metrics cho TikTok; chỉ số không khả dụng để null và loại khỏi tính trung bình (không coi là 0). |
| R13 | Divide-by-zero | Mọi tỷ lệ có mẫu số = 0 → gán = 0 và label `INSUFFICIENT_DATA`; loại bài khỏi Pattern Recognition cho đến khi mẫu số > 0. |
| R14 | Nguồn sự thật áp dụng thay đổi | Mọi thay đổi chiến lược (Persona/Calendar/AI Context) chỉ được áp dụng bởi **Strategy Update Processor** sau khi Insight ở trạng thái Approved. Insight không tự sửa dữ liệu trực tiếp. |

---

## 6. Trình Tự Hoạt Động (Sequence Diagram - Text)

```
Content Manager    Content Strategy    AI Generation    Publishing    Platforms    Analytics    Feedback Engine
      │                   │                 │               │             │            │              │
      │──Define Persona──▶│                 │               │             │            │              │
      │                   │──Persona+Context▶│              │             │            │              │
      │                   │                 │──Draft────────▶│            │             │              │
      │                   │                 │               │──Post──────▶│            │              │
      │                   │                 │               │             │            │              │
      │                   │                 │               │             │──Metrics──▶│              │
      │                   │                 │               │             │            │──Score───────▶│
      │                   │                 │               │             │            │              │
      │                   │                 │               │             │            │   Analyze    │
      │                   │                 │               │             │            │   Patterns   │
      │                   │                 │               │             │            │              │
      │                   │◀──Update Calendar+Persona+Context──────────────────────────│──Insights───│
      │                   │                 │               │             │            │              │
      │◀──Notification────│                 │               │             │            │              │
      │   (nếu cần duyệt)│                 │               │             │            │              │
      │──Approve/Reject──▶│                 │               │             │            │              │
      │                   │                 │               │             │            │              │
      │                   │──Updated Context▶│              │             │            │              │
      │                   │  (vòng lặp mới) │               │             │            │              │
```

---

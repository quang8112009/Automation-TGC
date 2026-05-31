# Danh Mục API Tích Hợp - Hệ Thống AutoTGC

> **Phiên bản:** 1.3  
> **Ngày tạo:** 29/05/2026  
> **Cập nhật:** 30/05/2026 — Siết bảo mật (bỏ IP/`root` khỏi tài liệu, dùng vault + user quyền tối thiểu); bổ sung endpoint Media, Platform Token, retry cho FAILED; chốt chu kỳ đồng bộ 6h  
> **Mục đích:** Liệt kê chi tiết các API cần tích hợp cho từng nền tảng, phân loại theo module hệ thống, phục vụ đội ngũ phát triển (Development Team).

---

## 1. Tổng Quan Nền Tảng Tích Hợp

Dựa trên tài liệu use case hiện tại, hệ thống AutoTGC cần tích hợp với **3 nền tảng chính** và các **dịch vụ hỗ trợ**:

| # | Nền tảng | Vai trò | Phase | Trạng thái |
|---|----------|---------|-------|------------|
| 1 | **Facebook** (Meta) | Đăng bài tự động, thu thập analytics | **Phase 1** | 🔴 Bắt buộc |
| 2 | **TikTok** | Đăng video/bài tự động, thu thập analytics | **Phase 1** | 🔴 Bắt buộc |
| 3 | **Website** (Custom CMS) | CMS quản lý bài viết, SEO, thu lead | **Phase 1** | 🔴 Bắt buộc |
| 4 | **Google Analytics 4** | Thu thập analytics website | **Phase 1** | 🔴 Bắt buộc |
| 5 | **Zalo OA** | Đăng bài, chatbot, thu lead (thị trường VN) | Phase 2+ | 🟢 Mở rộng sau |
| 6 | **YouTube** | Đăng video, thu thập analytics | Phase 2+ | 🟢 Mở rộng sau |
| 7 | **Instagram** | Đăng bài qua Meta API, thu thập analytics | Phase 2+ | 🟢 Mở rộng sau |

> ✅ **ĐÃ XÁC NHẬN (29/05/2026):** Phase 1 chỉ gồm Facebook + TikTok + Website + GA4. Zalo OA, YouTube, Instagram sẽ mở rộng sau — kiến trúc thiết kế sẵn khả năng mở rộng (extensible platform adapter pattern).

---

## 2. Chi Tiết API Theo Nền Tảng

---

### 2.1 Facebook (Meta) — Graph API

**Base URL:** `https://graph.facebook.com/v21.0/`  
**Tài liệu:** https://developers.facebook.com/docs/graph-api/  
**Xác thực:** OAuth 2.0 (Page Access Token, long-lived token)

#### A. APIs cho Module PUBLISHING (Đăng bài tự động)

| # | API Endpoint | Method | Mô tả | Permissions cần thiết |
|---|-------------|--------|--------|----------------------|
| 1 | `/{page-id}/feed` | POST | Đăng bài viết text lên Facebook Page | `pages_manage_posts`, `pages_read_engagement` |
| 2 | `/{page-id}/photos` | POST | Đăng bài kèm ảnh | `pages_manage_posts` |
| 3 | `/{page-id}/videos` | POST | Đăng video lên Page | `pages_manage_posts` |
| 4 | `/{post-id}` | DELETE | Xóa bài viết đã đăng | `pages_manage_posts` |
| 5 | `/{post-id}` | POST (update) | Chỉnh sửa bài viết đã đăng | `pages_manage_posts` |

**Lưu ý quan trọng:**
- Facebook **không hỗ trợ scheduled posting qua API trực tiếp** cho tất cả loại bài. Cần dùng trường `scheduled_publish_time` (UNIX timestamp) khi POST.
- Cần đăng ký Facebook App và xin **App Review** cho các permissions liên quan.

#### B. APIs cho Module ANALYTICS (Thu thập hiệu quả)

| # | API Endpoint | Method | Mô tả | Permissions |
|---|-------------|--------|--------|-------------|
| 1 | `/{post-id}/insights` | GET | Lấy metrics của bài viết (impressions, reach, engagement) | `pages_read_engagement`, `read_insights` |
| 2 | `/{page-id}/insights` | GET | Lấy page-level metrics (total followers, page views) | `pages_read_engagement`, `read_insights` |
| 3 | `/{post-id}` | GET | Lấy thông tin bài viết (likes, comments, shares count) | `pages_read_engagement` |
| 4 | `/{page-id}/feed` | GET | Lấy danh sách bài viết của page | `pages_read_engagement` |

**Metrics khả dụng qua Post Insights:**
- `post_impressions` — Số lượt hiển thị
- `post_impressions_unique` — Số người tiếp cận (reach)
- `post_engaged_users` — Số người tương tác
- `post_clicks` — Số lượt click
- `post_reactions_like_total` — Tổng reactions

#### C. APIs cho Module ANALYTICS — Lead Tracking

| # | API Endpoint | Method | Mô tả | Permissions |
|---|-------------|--------|--------|-------------|
| 1 | `/{page-id}/leadgen_forms` | GET | Lấy danh sách Lead Gen forms | `leads_retrieval`, `pages_manage_ads` |
| 2 | `/{form-id}/leads` | GET | Lấy leads từ form cụ thể | `leads_retrieval` |
| 3 | Leadgen Webhooks | SUBSCRIBE | Nhận real-time lead notifications | `leads_retrieval` |

---

### 2.2 TikTok — Content Posting API & Research API

**Base URL:** `https://open.tiktokapis.com/v2/`  
**Tài liệu:** https://developers.tiktok.com/doc/  
**Xác thực:** OAuth 2.0

#### A. APIs cho Module PUBLISHING

| # | API Endpoint | Method | Mô tả | Scopes cần thiết |
|---|-------------|--------|--------|-------------------|
| 1 | `/post/publish/inbox/video/init/` | POST | Khởi tạo upload video (Direct Post) | `video.publish` |
| 2 | `/post/publish/content/init/` | POST | Đăng nội dung (Photo mode, Carousel) | `video.publish` |
| 3 | `/post/publish/status/fetch/` | POST | Kiểm tra trạng thái đăng bài | `video.publish` |
| 4 | `/post/publish/creator_info/query/` | POST | Lấy thông tin creator (giới hạn đăng) | `video.publish` |

**Lưu ý quan trọng:**
- TikTok **bắt buộc** nội dung phải là video hoặc photo carousel.
- Mô tả video giới hạn **< 2200 ký tự** (bao gồm hashtags).
- Rate limit: Varies by creator type. Cần check `creator_info` trước khi đăng.
- Không hỗ trợ scheduled posting trực tiếp — hệ thống AutoTGC cần tự quản lý scheduling.

#### B. APIs cho Module ANALYTICS

| # | API Endpoint | Method | Mô tả | Scopes |
|---|-------------|--------|--------|--------|
| 1 | `/research/video/query/` | POST | Tìm kiếm video theo keyword, hashtag | `research.data.basic` |
| 2 | `/video/list/` | POST | Lấy danh sách video của user | `video.list` |
| 3 | `/video/query/` | POST | Lấy chi tiết video (view, like, comment, share) | `video.list` |

**Metrics khả dụng:**
- `view_count` — Lượt xem
- `like_count` — Lượt thích
- `comment_count` — Lượt bình luận
- `share_count` — Lượt chia sẻ
- `create_time` — Thời gian đăng

**⚠️ Hạn chế:**
- TikTok **không cung cấp follower growth per post** qua API.
- Lead tracking cần thông qua link bio/CTA → Website tracking (Google Analytics UTM).

---

### 2.3 Website (Owned Platform) — Custom CMS & Analytics

> ✅ **ĐÃ XÁC NHẬN:** Website sử dụng **Custom-built CMS** (không dùng WordPress). Server sẽ được cung cấp sau.

#### A. Custom CMS REST API (Cần xây dựng)

**Server:** Lưu trong vault/biến môi trường (`SERVER_HOST`) *(credentials lưu trong vault bảo mật — KHÔNG lưu trong tài liệu)*  
**Base URL:** `https://{domain}/api/v1/` *(domain trỏ DNS A record đến server — giá trị IP lưu trong cấu hình bí mật)*  
**Xác thực:** JWT Bearer Token (đồng bộ với hệ thống Authentication của AutoTGC)

Các endpoint CMS cần xây dựng để AutoTGC có thể đăng bài tự động lên website:

| # | API Endpoint | Method | Mô tả | Request Body |
|---|-------------|--------|--------|-------------|
| 1 | `/cms/posts` | POST | Tạo bài viết mới | `{title, body, category_id, seo_meta, featured_image, status, scheduled_at}` |
| 2 | `/cms/posts/{id}` | PUT | Cập nhật bài viết | `{title, body, seo_meta, status}` |
| 3 | `/cms/posts/{id}` | DELETE | Xóa bài viết | — |
| 4 | `/cms/posts` | GET | Lấy danh sách bài viết | Query: `?status=&category=&page=&limit=` |
| 5 | `/cms/posts/{id}` | GET | Lấy chi tiết bài viết | — |
| 6 | `/cms/media` | POST | Upload ảnh/video | `multipart/form-data` |
| 7 | `/cms/categories` | GET | Lấy danh mục bài viết | — |
| 8 | `/cms/posts/{id}/analytics` | GET | Lấy metrics bài viết từ CMS | — |

**Yêu cầu kỹ thuật cho Custom CMS API:**
- Hỗ trợ `scheduled_at` (ISO 8601) cho scheduled posting — hệ thống CMS tự đăng khi đến giờ
- Trả về `post_url` sau khi tạo bài để AutoTGC lưu mapping
- Hỗ trợ SEO fields: `meta_title`, `meta_description`, `slug`, `canonical_url`
- Response format: JSON, theo chuẩn REST (status codes: 200, 201, 400, 401, 404, 500)
- Pagination: `page` + `limit` + `total_count` trong response header
- CORS: Cho phép requests từ AutoTGC backend server

#### B. Google Analytics 4 (GA4) — Data API

**Base URL:** `https://analyticsdata.googleapis.com/v1beta/`  
**Tài liệu:** https://developers.google.com/analytics/devguides/reporting/data/v1  
**Xác thực:** Service Account (OAuth 2.0)

| # | API Endpoint | Method | Mô tả |
|---|-------------|--------|--------|
| 1 | `/properties/{property_id}:runReport` | POST | Chạy báo cáo tùy chỉnh |
| 2 | `/properties/{property_id}:runRealtimeReport` | POST | Báo cáo realtime |
| 3 | `/properties/{property_id}:batchRunReports` | POST | Chạy nhiều báo cáo cùng lúc |

**Metrics quan trọng cần thu thập:**
- `screenPageViews` — Lượt xem trang
- `sessions` — Phiên truy cập
- `conversions` — Số chuyển đổi (cần setup conversion events)
- `engagedSessions` — Phiên tương tác
- `bounceRate` — Tỷ lệ thoát
- `averageSessionDuration` — Thời gian trung bình

**Dimensions quan trọng:**
- `pagePath` — Đường dẫn bài viết
- `sessionSource` — Nguồn truy cập
- `sessionMedium` — Phương tiện
- `sessionCampaignName` — Tên chiến dịch (UTM)

#### C. Website Lead Tracking (Tự xây dựng)

> ✅ **ĐÃ XÁC NHẬN:** Lead Tracking **tự xây dựng** trong hệ thống AutoTGC (không dùng CRM bên ngoài).

**Phương pháp thu thập lead:**

| # | Phương pháp | Mô tả | Ưu tiên |
|---|-------------|--------|--------|
| 1 | Custom CMS Webhook | Form submit trên website → POST data đến AutoTGC Lead API | 🔴 Bắt buộc |
| 2 | Facebook Leadgen Webhook | Lead từ FB Lead Ads → real-time webhook | 🔴 Bắt buộc |
| 3 | UTM Parameters | Gắn UTM vào link từ social → tracking nguồn lead | 🔴 Bắt buộc |
| 4 | Facebook Pixel | Theo dõi conversion từ Facebook traffic | 🟡 Nên có |
| 5 | Google Analytics Events | Theo dõi form submissions qua GA4 events | 🟡 Nên có |
| 6 | TikTok CTA → Website | Redirect từ TikTok bio link → Website form → Lead API | 🔴 Bắt buộc |

---

### 2.4 Zalo OA (Official Account) — Phase 2+

> ⏳ **CHƯA TRIỂN KHAI PHASE 1.** Giữ lại tài liệu để mở rộng sau. Kiến trúc hệ thống thiết kế sẵn platform adapter để tích hợp nhanh khi cần.

**Base URL:** `https://openapi.zalo.me/v3.0/`  
**Tài liệu:** https://developers.zalo.me/docs  
**Xác thực:** OAuth 2.0 (OA Access Token)

| # | API Endpoint | Method | Mô tả |
|---|-------------|--------|--------|
| 1 | `/oa/article/create` | POST | Tạo bài viết trên Zalo OA |
| 2 | `/oa/article/update` | POST | Cập nhật bài viết |
| 3 | `/oa/article/getslice` | GET | Lấy danh sách bài viết |
| 4 | `/oa/getfollowers` | GET | Lấy danh sách follower |
| 5 | `/oa/conversation` | GET | Lấy tin nhắn (leads qua chat) |
| 6 | `/oa/message/cs` | POST | Gửi tin nhắn customer service |

---

## 3. APIs Nội Bộ AutoTGC (Internal APIs)

Đây là các API nội bộ mà hệ thống AutoTGC cần xây dựng, deploy trên server backend (host lưu trong cấu hình bí mật `SERVER_HOST`):

### 3.1 Core Module APIs

| # | Endpoint | Method | Mô tả | Module |
|---|----------|--------|--------|--------|
| 1 | `/api/analytics/collect` | POST | Thu thập metrics từ external APIs | Analytics |
| 2 | `/api/analytics/score` | POST | Tính điểm hiệu quả cho bài viết | Analytics |
| 3 | `/api/feedback/analyze` | POST | Chạy AI pattern recognition (Gemini) | Feedback Loop |
| 4 | `/api/feedback/insights` | GET | Lấy danh sách learning insights | Feedback Loop |
| 5 | `/api/feedback/insights/{id}/apply` | POST | Áp dụng insight vào strategy (sau khi duyệt) | Feedback Loop |
| 6 | `/api/feedback/insights/{id}/reject` | POST | Từ chối insight (lưu lý do) | Feedback Loop |
| 7 | `/api/strategy/calendar` | GET/PUT | Đọc/cập nhật content calendar | Content Strategy |
| 8 | `/api/strategy/persona/{id}/recommendations` | GET | Lấy gợi ý cho persona | Content Strategy |
| 9 | `/api/strategy/ai-context` | GET | Lấy enriched AI prompt context | Content Strategy |
| 10 | `/api/generation/generate` | POST | Tạo nội dung AI (với enriched context) | Content Generation |
| 11 | `/api/publishing/schedule` | POST | Lên lịch đăng bài (tạo Scheduled Post; kiểm tra media theo nền tảng) | Publishing |
| 12 | `/api/publishing/post` | POST | Thực hiện đăng bài lên platform (idempotent, có lock) | Publishing |
| 12b | `/api/publishing/scheduled/{id}/retry` | POST | Lên lịch lại bài ở trạng thái FAILED (Failed → Scheduled) | Publishing |
| 12c | `/api/media` | POST | Upload Media Asset (ảnh/video) gắn vào Content Draft | Publishing |
| 12d | `/api/platform-tokens` | GET | Kiểm tra trạng thái/hiệu lực token các nền tảng | Publishing |
| 12e | `/api/platform-tokens/{platform}/refresh` | POST | Refresh token nền tảng (chủ động trước khi hết hạn) | Publishing |
| 13 | `/api/dashboard/overview` | GET | Lấy dữ liệu dashboard tổng quan | Dashboard |
| 14 | `/api/dashboard/notifications` | GET | Lấy notifications cho Content Manager | Dashboard |

### 3.2 Lead Management APIs (Tự xây dựng)

> ✅ **ĐÃ XÁC NHẬN:** Hệ thống Lead Tracking tự xây dựng — không dùng CRM bên ngoài.

| # | Endpoint | Method | Mô tả | Request/Response |
|---|----------|--------|--------|------------------|
| 15 | `/api/leads` | POST | Tạo lead mới (từ webhook/form) | `{name, phone, email, source, utm_source, utm_medium, utm_campaign, content_post_id, platform, created_at}` |
| 16 | `/api/leads` | GET | Lấy danh sách leads (filter, pagination) | Query: `?source=&platform=&status=&from=&to=&page=&limit=` |
| 17 | `/api/leads/{id}` | GET | Chi tiết lead | Response: lead info + interaction history |
| 18 | `/api/leads/{id}` | PUT | Cập nhật trạng thái lead | `{status, note, assigned_to}` |
| 19 | `/api/leads/{id}` | DELETE | Xóa lead | — |
| 20 | `/api/leads/stats` | GET | Thống kê lead (theo nguồn, nền tảng, thời gian) | Query: `?group_by=source|platform|date&from=&to=` |
| 21 | `/api/leads/webhook/facebook` | POST | Webhook nhận lead từ Facebook Leadgen | Auto-parse FB lead format |
| 22 | `/api/leads/webhook/website` | POST | Webhook nhận lead từ Website forms | Auto-parse form submission |
| 23 | `/api/leads/export` | GET | Xuất danh sách leads (CSV/Excel) | Query: `?format=csv|xlsx&from=&to=` |

**Lead Data Model:**

```json
{
  "lead_id": "LEAD-20260529-001",
  "name": "Nguyễn Văn A",
  "phone": "0901234567",
  "email": "nguyenvana@email.com",
  "source": "facebook_leadgen | website_form | tiktok_bio | direct_message",
  "platform": "facebook | tiktok | website",
  "utm_source": "facebook",
  "utm_medium": "post",
  "utm_campaign": "xkld_dieu_duong_t5",
  "content_post_id": "POST-123",
  "domain_category": "XKLĐ",
  "content_topic": "Điều dưỡng Nhật Bản",
  "status": "NEW | CONTACTED | QUALIFIED | CONVERTED | LOST",
  "note": "",
  "assigned_to": "user_id",
  "created_at": "2026-05-29T18:00:00+07:00",
  "updated_at": "2026-05-29T18:30:00+07:00"
}
```

**Lead Status Flow:**
```
NEW → CONTACTED → QUALIFIED → CONVERTED
                              → LOST
```

**Tích hợp với Analytics Feedback Loop:**
- Mỗi lead được gắn với `content_post_id` → hệ thống tự động tính `conversion_rate` cho bài viết
- Lead count theo `domain_category` + `content_topic` → input cho AI Feedback Loop Engine
- Báo cáo lead theo UTM → xác định ROI từng nền tảng/chiến dịch

---

## 4. APIs Cho Dịch Vụ AI — Google Gemini (Đã xác nhận)

> ✅ **ĐÃ XÁC NHẬN:** Sử dụng **Google Gemini API** làm AI Service duy nhất.

**Base URL:** `https://generativelanguage.googleapis.com/v1beta/`  
**Tài liệu:** https://ai.google.dev/gemini-api/docs  
**Xác thực:** API Key hoặc OAuth 2.0 (Service Account)

| # | API Endpoint | Method | Mục đích trong AutoTGC | Model đề xuất |
|---|-------------|--------|----------------------|---------------|
| 1 | `/models/{model}:generateContent` | POST | Tạo nội dung marketing (Title, Body, CTA) | `gemini-2.5-flash` |
| 2 | `/models/{model}:generateContent` | POST | Phân tích pattern từ performance data (Feedback Loop) | `gemini-2.5-pro` |
| 3 | `/models/{model}:generateContent` | POST | Tóm tắt & tạo insight từ analytics data | `gemini-2.5-flash` |
| 4 | `/models/{model}:countTokens` | POST | Kiểm tra token count trước khi gọi generate | `gemini-2.5-flash` |

**Rate Limits (Free tier):**
- 15 requests/phút (RPM)
- 1,500 requests/ngày (RPD)
- Nên sử dụng **Paid tier** cho production: 360 RPM, không giới hạn RPD

**Prompt Structure cho AI Content Generation (với Feedback Context):**

```
[Vai trò chuyên gia] + 
[Ngữ cảnh lĩnh vực từ Domain Context] + 
[Persona đã chọn] + 
[Tone-of-voice (từ Analytics recommendation)] +
[Mục tiêu chuyển đổi] + 
[Performance Context: top topics, best CTAs, avoid topics] +
[Yêu cầu CTA bắt buộc (từ best CTA patterns)]
```

**Prompt Structure cho Feedback Loop Analysis:**

```
[Vai trò: Data Analyst chuyên về content marketing] +
[Input: JSON array of Performance Records trong 4 tuần gần nhất] +
[Yêu cầu: Phân tích theo 5 chiều (topic, persona, tone, platform, CTA)] +
[Output format: Structured JSON theo Learning Insight schema] +
[Ràng buộc: Chỉ tạo insight khi sample_size ≥ 5]
```

---

## 5. Ma Trận Tích Hợp API Theo Module — Phase 1

```
                    ┌──────────┬──────────┬──────────┬──────────┐
  PHASE 1           │ Facebook │  TikTok  │ Custom   │   GA4    │
                    │ Graph API│ Content  │ CMS API  │ Data API │
┌───────────────────┼──────────┼──────────┼──────────┼──────────┤
│ CONTENT STRATEGY  │    —     │    —     │    —     │    —     │
│ (Internal only)   │          │          │          │          │
├───────────────────┼──────────┼──────────┼──────────┼──────────┤
│ CONTENT GENERATION│    —     │    —     │    —     │    —     │
│ (Gemini API)      │          │          │          │          │
├───────────────────┼──────────┼──────────┼──────────┼──────────┤
│ PUBLISHING        │    ✅    │    ✅    │    ✅    │    —     │
│ (Đăng bài)        │  POST   │  POST   │  POST   │          │
├───────────────────┼──────────┼──────────┼──────────┼──────────┤
│ ANALYTICS         │    ✅    │    ✅    │    ✅    │    ✅    │
│ (Thu thập data)   │   GET   │   GET   │   GET   │   GET   │
├───────────────────┼──────────┼──────────┼──────────┼──────────┤
│ LEAD TRACKING     │    ✅    │    —*    │    ✅    │    —     │
│ (Thu lead)        │ Webhook  │ via Web  │ Webhook  │          │
├───────────────────┼──────────┼──────────┼──────────┼──────────┤
│ FEEDBACK LOOP     │    —     │    —     │    —     │    —     │
│ (Internal+Gemini) │          │          │          │          │
├───────────────────┼──────────┼──────────┼──────────┼──────────┤
│ DASHBOARD         │    —     │    —     │    —     │    —     │
│ (Internal only)   │          │          │          │          │
└───────────────────┴──────────┴──────────┴──────────┴──────────┘

✅ = Cần tích hợp    — = Không cần (sử dụng internal API)
*TikTok lead tracking thông qua redirect bio link → Website form → Lead API
```

---

## 6. Yêu Cầu Kỹ Thuật Cho Đội Phát Triển

### 6.1 Authentication & Token Management

| Nền tảng | Loại Token | Thời hạn | Cách refresh |
|----------|-----------|----------|-------------|
| Facebook | Page Access Token (Long-lived) | 60 ngày | Exchange token trước khi hết hạn |
| TikTok | OAuth Access Token | 24 giờ | Dùng Refresh Token (365 ngày) |
| GA4 | Service Account | Không hết hạn | JWT tự động |
| Custom CMS | JWT Bearer Token | Tùy cấu hình | Đồng bộ với AutoTGC Auth module |
| Google Gemini | API Key | Không hết hạn | Rotate định kỳ theo security policy |
| Zalo OA *(Phase 2+)* | OA Access Token | 1 giờ | Dùng Refresh Token |

### 6.2 Rate Limits

| Nền tảng | Rate Limit | Ghi chú |
|----------|-----------|---------|
| Facebook Graph API | 200 calls/hour/user | Tăng lên nếu app verified |
| TikTok Content API | Varies by creator | Check `creator_info` endpoint |
| GA4 Data API | 10,000 requests/day/project | Có thể xin tăng quota |
| Google Gemini (Paid) | 360 RPM | Không giới hạn RPD |

### 6.3 Webhook Integration

| # | Nền tảng | Webhook | Mục đích |
|---|----------|---------|----------|
| 1 | Facebook | Leadgen Webhooks | Nhận lead real-time → `/api/leads/webhook/facebook` |
| 2 | Facebook | Page Feed Webhooks | Nhận notification khi có comment/reaction mới |
| 3 | Website (Custom CMS) | Form Submission Webhook | Form submit → `/api/leads/webhook/website` |
| 4 | TikTok | Bio Link Redirect | TikTok bio → Website form → Lead API (indirect) |

### 6.4 Data Sync Schedule

| Module | Tần suất | Phương pháp |
|--------|----------|-------------|
| Analytics Collection | Mỗi 6 giờ | Scheduled Job (CRON) |
| Performance Scoring | Ngay sau mỗi lần collect | Event-driven |
| AI Feedback Loop | 1 lần/tuần (CN 00:00) | Scheduled Job (CRON) |
| Strategy Update | Ngay sau Feedback Loop | Event-driven |
| Token Refresh | Kiểm tra mỗi 12 giờ | Scheduled Job (CRON) |

---

## 7. Tóm Tắt Số Lượng API — Phase 1

| Loại | Số lượng | Ghi chú |
|------|----------|--------|
| **Facebook Graph API endpoints** | 9 | Đăng bài + Analytics + Lead webhook |
| **TikTok API endpoints** | 7 | Đăng video + Analytics |
| **Custom CMS API endpoints** (tự xây) | 8 | Deploy trên server backend (host trong cấu hình bí mật) |
| **Google Analytics 4 API endpoints** | 3 | Analytics website |
| **Google Gemini API endpoints** | 4 | AI Content + Feedback Analysis |
| **Internal AutoTGC Core APIs** | 14 | Core modules |
| **Internal Lead Management APIs** (tự xây) | 9 | Lead tracking + webhook + export |
| **Tổng Phase 1** | **~54 endpoints** | |

**Phase 2+ (mở rộng sau):**

| Loại | Số lượng | Ghi chú |
|------|----------|--------|
| Zalo OA API endpoints | 6 | Khi cần thị trường VN |
| Instagram (Meta Graph API) | ~3 | Reuse Facebook infrastructure |
| YouTube Data API v3 | ~5 | Video platform |

---

## 8. Server & Infrastructure

### 8.1 Thông tin Server

| Thông tin | Giá trị |
|-----------|---------|
| **IP Address** | Lưu trong vault/biến môi trường (`SERVER_HOST`) — KHÔNG ghi trực tiếp trong tài liệu/source/git |
| **Account ứng dụng** | Tạo **user riêng quyền tối thiểu** (ví dụ `autotgc`) để chạy ứng dụng — KHÔNG dùng `root` |
| **Account quản trị (root)** | Chỉ dùng cho thao tác hạ tầng thủ công; vô hiệu hóa SSH login trực tiếp bằng root, dùng SSH key + sudo |
| **Credentials** | ⚠️ Lưu trong **vault bảo mật** / secret manager (không lưu trong tài liệu) |
| **Vai trò** | Host Custom CMS + AutoTGC Backend APIs + Lead Management |
| **Domain** | *Cần cấu hình — trỏ DNS A record đến server (giá trị IP lưu trong cấu hình bí mật)* |

> ⚠️ **BẢO MẬT:** IP server, username và mật khẩu **KHÔNG ĐƯỢC** lưu trong tài liệu, source code, hoặc git repository. Sử dụng environment variables hoặc secret manager (ví dụ: `.env` file ngoài git, Google Secret Manager, HashiCorp Vault). Ứng dụng chạy bằng user quyền tối thiểu, không dùng `root`.

### 8.2 Khuyến nghị Setup Server

| Hạng mục | Khuyến nghị |
|----------|-------------|
| OS | Xác nhận OS hiện tại (Ubuntu/CentOS/Debian?) |
| Runtime | Node.js 20 LTS hoặc Python 3.11+ |
| Database | PostgreSQL 16 (quan hệ) + Redis (cache/queue) |
| Reverse Proxy | Nginx (SSL termination, load balancing) |
| SSL | Let's Encrypt (miễn phí) hoặc mua certificate |
| Process Manager | PM2 (Node.js) hoặc Gunicorn + Supervisor (Python) |
| CRON Jobs | systemd timer hoặc node-cron cho scheduled tasks |

---

## 9. Quyết Định Đã Xác Nhận ✅

| # | Câu hỏi | Quyết định | Ngày |
|---|---------|-----------|------|
| 1 | CMS Website | ✅ **Custom-built** (không dùng WordPress) | 29/05/2026 |
| 2 | AI Service | ✅ **Google Gemini API** (duy nhất) | 29/05/2026 |
| 3 | Chế độ Feedback Loop | ✅ **REVIEW MODE** mặc định | 29/05/2026 |
| 4 | Lead Tracking | ✅ **Tự xây dựng** (không dùng CRM bên ngoài) | 29/05/2026 |
| 5 | Server | ✅ Host backend lưu trong vault (`SERVER_HOST`); chạy app bằng user quyền tối thiểu, không dùng `root` | 29/05/2026 |
| 6 | Phase 1 Scope | ✅ Facebook + TikTok + Website + GA4 only | 29/05/2026 |
| 7 | Zalo OA | ✅ **Chưa cần Phase 1** — mở rộng sau | 29/05/2026 |
| 8 | Instagram | ✅ **Chưa cần Phase 1** — mở rộng sau | 29/05/2026 |
| 9 | YouTube | ✅ **Chưa cần Phase 1** — mở rộng sau | 29/05/2026 |

> 🟢 **Tất cả câu hỏi thiết kế đã được xác nhận. Sẵn sàng cho giai đoạn phát triển.**

---

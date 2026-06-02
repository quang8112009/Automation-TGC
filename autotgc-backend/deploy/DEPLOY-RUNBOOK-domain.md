# Runbook — Cấu hình tên miền + HTTPS cho AutoTGC

Mục tiêu: trỏ một tên miền thật vào server và phục vụ **SPA + API trên cùng một origin** qua HTTPS (Let's Encrypt). Frontend gọi API bằng đường dẫn tương đối (`VITE_API_BASE` rỗng), nên SPA và `/api` phải nằm cùng domain — không cần CORS ở production.

## 0. Điều kiện trước khi chạy

- Đã deploy backend (PM2 chạy `autotgc-backend` ở `127.0.0.1:3000`) và frontend (`/opt/autotgc-frontend/dist` đã có `index.html`).
- Có quyền `root` trên server. IP công khai của server: xem `deploy/deploy-frontend-only.ps1` (`ServerHost`).

## 1. Trỏ DNS

Tại nhà cung cấp tên miền, tạo bản ghi trỏ về IP server **trước khi** chạy script (Let's Encrypt xác thực qua cổng 80):

| Loại | Tên (host) | Giá trị |
|------|------------|---------|
| `A`  | `app` (hoặc `@` cho domain gốc) | `<IP_SERVER>` |
| `AAAA` (nếu có IPv6) | như trên | `<IPv6_SERVER>` |

Kiểm tra đã phân giải đúng:

```bash
dig +short app.example.com        # phải trả về IP server
```

> Chờ DNS lan truyền (thường vài phút) trước bước 3, nếu không certbot sẽ fail ở bước http-01.

## 2. Mở tường lửa (nếu ufw đang bật)

`provision.sh` cài `ufw` nhưng không tự bật. Nếu bạn đã bật ufw, mở 80/443:

```bash
ufw allow 80/tcp
ufw allow 443/tcp
ufw status
```

Cũng đảm bảo security group / firewall của nhà cung cấp VPS đã mở 80 và 443.

## 3. Chạy script cấu hình domain + cấp chứng chỉ

Trên server, từ thư mục mã nguồn đã đồng bộ (ví dụ `/opt/autotgc` hoặc `/opt/autotgc-src`):

```bash
DOMAIN=app.example.com EMAIL=ops@example.com bash deploy/setup-domain.sh
```

Tuỳ chọn: đổi thư mục dist của frontend (mặc định `/opt/autotgc-frontend/dist`):

```bash
DOMAIN=app.example.com EMAIL=ops@example.com FRONTEND_DIST=/opt/autotgc-frontend/dist \
  bash deploy/setup-domain.sh
```

Script thực hiện (idempotent — chạy lại an toàn):

1. Render `deploy/domain-vhost.conf` cho domain → `/etc/nginx/sites-available/autotgc-domain.conf`.
2. Tắt site catch-all `:80` (`server_name _`) để không tranh chấp với domain.
3. Cấp/gia hạn cert bằng `certbot --webroot`, rồi bật khối HTTPS và reload Nginx.
4. In smoke check (`HTTP_REDIRECT`, `HTTPS_SPA`, `HTTPS_HEALTH`).

Kỳ vọng: `HTTP_REDIRECT=301`, `HTTPS_SPA=200`, `HTTPS_HEALTH=200`.

## 4. Cập nhật cấu hình ứng dụng theo domain

Trong `/opt/autotgc/.env` (quyền 600, owner `autotgc`):

- `FRONTEND_ORIGIN=https://app.example.com`
  Hiện deploy đặt `FRONTEND_ORIGIN=*`. Vì production cùng-origin nên CORS gần như không cần, nhưng nên siết về domain thật cho an toàn. Đổi xong khởi động lại:

  ```bash
  sudo -u autotgc bash -lc "cd /opt/autotgc && pm2 restart autotgc-backend"
  ```

Frontend **không cần** đổi gì: `VITE_API_BASE` để rỗng (cùng origin). Chỉ đặt `VITE_API_BASE=https://api.example.com` nếu sau này bạn tách API sang domain riêng — khi đó phải bật CORS tương ứng.

## 5. Webhook bên ngoài (Facebook/Website/Zalo)

Sau khi có HTTPS, cập nhật URL webhook ở các nền tảng về domain mới, ví dụ:

- Facebook/Website: `https://app.example.com/api/...` (đúng đường dẫn webhook trong `intake`/`leads`).
- Giữ nguyên các HMAC secret trong `.env` (`WEBHOOK_SECRET_*`).

## 6. Tự động gia hạn cert

Certbot cài kèm systemd timer tự gia hạn. Kiểm tra:

```bash
certbot renew --dry-run
systemctl list-timers | grep certbot
```

## Khắc phục sự cố

- **certbot fail (challenge)**: DNS chưa trỏ đúng, hoặc 80 bị chặn. Kiểm tra `dig +short DOMAIN` và `curl -I http://DOMAIN/.well-known/acme-challenge/test`.
- **`nginx -t` báo thiếu cert**: bước bootstrap HTTP chưa chạy xong. Chạy lại `setup-domain.sh` (idempotent).
- **502 ở `/api`**: backend chưa chạy. `pm2 status` và `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/healthz`.
- **Trang trắng / 404 khi refresh route con**: thiếu SPA fallback — đảm bảo đang dùng `autotgc-domain.conf` (có `try_files ... /index.html`), không phải site cũ.

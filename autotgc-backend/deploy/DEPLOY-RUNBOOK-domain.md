# Runbook — Cấu hình tên miền + HTTPS cho AutoTGC

Mục tiêu: trỏ một tên miền thật vào server và phục vụ **SPA + API trên cùng một origin** qua HTTPS. Frontend gọi API bằng đường dẫn tương đối (`VITE_API_BASE` rỗng), nên SPA và `/api` phải nằm cùng domain — không cần CORS ở production.

## Thực tế hạ tầng server (36.50.26.118)

Server này chạy **aaPanel/BT Panel**, KHÔNG phải Ubuntu + certbot thuần. Cụ thể:

- nginx phục vụ traffic là của panel: `/www/server/nginx/sbin/nginx`.
- vhost nằm ở `/www/server/panel/vhost/nginx/*.conf` (không phải `/etc/nginx/sites-*`).
- App vhost sẵn có: `autotgc.conf` lắng nghe **:8088**, phục vụ SPA `/opt/autotgc-frontend/dist` + proxy `/api` → `127.0.0.1:3000`.
- Backend chạy dưới PM2 (`autotgc-api`) ở `127.0.0.1:3000`; `/healthz` trả 200.
- ufw đã mở 80 và 443.
- Chưa có certbot/acme.sh — script tự cài `acme.sh`.

Vì vậy domain được cấu hình bằng `deploy/setup-domain-panel.sh` (ghi vhost vào cây của panel), KHÔNG dùng certbot trên `/etc/nginx`.

## Bước 1 — Tạo bản ghi DNS (BẮT BUỘC, làm trước)

Tại nhà cung cấp DNS của `thiennn.icu`, tạo:

| Loại | Tên (host) | Giá trị |
|------|------------|---------|
| `A`  | `tgc-auto` | `36.50.26.118` |

Kiểm tra đã phân giải đúng (chờ vài phút tới vài chục phút để lan truyền):

```bash
nslookup tgc-auto.thiennn.icu 8.8.8.8
```

Phải trả về `36.50.26.118`. Let's Encrypt xác thực qua HTTP cổng 80 trên chính tên miền này — **không tạo được cert nếu DNS chưa trỏ đúng.**

## Bước 2 — Cài vhost domain (HTTP) — ĐÃ CHẠY

Đã thực hiện: ghi `/www/server/panel/vhost/nginx/tgc-auto.conf` (server_name `tgc-auto.thiennn.icu`, :80), reload nginx, không đụng vhost :8088. Kiểm chứng bằng Host header trên server: `HEALTH=200`, `SPA=200`, webroot ACME trả đúng nội dung.

Chạy lại khi cần (idempotent), từ máy Windows trong thư mục `docs/`:

```powershell
powershell -ExecutionPolicy Bypass -File "autotgc-backend\deploy\_ssh-run.ps1" `
  -ServerHost 36.50.26.118 -Password '<ROOT_PW>' `
  -ScriptFile "autotgc-backend\deploy\setup-domain-panel.sh" `
  -EnvPrefix "DOMAIN=tgc-auto.thiennn.icu ACTION=http"
```

## Bước 3 — Cấp chứng chỉ + bật HTTPS (chạy SAU khi DNS đã sống)

```powershell
powershell -ExecutionPolicy Bypass -File "autotgc-backend\deploy\_ssh-run.ps1" `
  -ServerHost 36.50.26.118 -Password '<ROOT_PW>' `
  -ScriptFile "autotgc-backend\deploy\setup-domain-panel.sh" `
  -EnvPrefix "DOMAIN=tgc-auto.thiennn.icu EMAIL=admin@tgc.com ACTION=cert"
```

Script sẽ: cài `acme.sh` (nếu thiếu) → cấp cert ECC qua webroot `/var/www/html` → cài cert vào `/www/server/panel/vhost/cert/tgc-auto.thiennn.icu/` → ghi lại vhost có khối :443 + redirect 80→443 → reload nginx. `acme.sh` tự cài cron auto-renew. Nếu DNS chưa phân giải, script tự dừng (exit 2).

## Bước 4 — Kiểm tra trạng thái bất kỳ lúc nào

```powershell
powershell -ExecutionPolicy Bypass -File "autotgc-backend\deploy\_ssh-run.ps1" `
  -ServerHost 36.50.26.118 -Password '<ROOT_PW>' `
  -ScriptFile "autotgc-backend\deploy\setup-domain-panel.sh" `
  -EnvPrefix "DOMAIN=tgc-auto.thiennn.icu ACTION=status"
```

## Bước 5 — Siết CORS về domain thật (khuyến nghị, sau khi HTTPS chạy)

`/opt/autotgc/.env` hiện đặt `FRONTEND_ORIGIN=*`. Vì cùng-origin nên CORS gần như không cần, nhưng nên siết lại:

```bash
sed -i 's#^FRONTEND_ORIGIN=.*#FRONTEND_ORIGIN=https://tgc-auto.thiennn.icu#' /opt/autotgc/.env
sudo -u autotgc bash -lc "cd /opt/autotgc && pm2 restart autotgc-api"
```

Frontend KHÔNG cần build lại: `VITE_API_BASE` để rỗng (cùng origin).

## Khắc phục sự cố

- **acme issue fail (challenge)**: DNS chưa trỏ đúng, hoặc 80 bị chặn ở firewall nhà cung cấp VPS. Kiểm tra `nslookup ... 8.8.8.8` và `curl -I http://tgc-auto.thiennn.icu/.well-known/acme-challenge/test`.
- **502 ở `/api`**: backend chưa chạy. `pm2 status` và `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/healthz`.
- **Trang trắng / 404 khi refresh route con**: vhost thiếu SPA fallback — đảm bảo `tgc-auto.conf` còn `try_files ... /index.html`.
- **pm2 `autotgc-api` errored**: có một process pm2 `autotgc-api` ở trạng thái errored (restart nhiều lần) nhưng cổng 3000 vẫn 200 — nên kiểm tra `pm2 logs autotgc-api` để dọn process lỗi trùng lặp.

## Ghi chú vận hành

- `deploy/_ssh-run.ps1` là helper chạy lệnh/script từ xa qua Posh-SSH; mật khẩu truyền qua tham số, không lưu ra đĩa. Truyền `-ScriptFile` để upload + chạy một `.sh`, hoặc `-Command` để chạy lệnh inline.
- ĐỔI MẬT KHẨU root sau khi hoàn tất, vì nó đã từng được nhập trong phiên làm việc.

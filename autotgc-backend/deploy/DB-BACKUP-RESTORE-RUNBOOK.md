# Runbook: PostgreSQL Backup & Restore (AutoTGC)

> Khắc phục gap P0 #2: hiện **chưa có backup DB tự động** (chỉ có pg_dump ad-hoc lúc deploy).
> Script: `deploy/backup-db.sh`. Mọi lệnh chạy trên host prod.

## 1. Cài backup tự động (cron, daily)

```bash
# Đảm bảo script có trên host (đi kèm deploy vào /opt/autotgc/deploy/) và log dir tồn tại
mkdir -p /var/log/autotgc /var/backups/autotgc
chmod +x /opt/autotgc/deploy/backup-db.sh

# Thêm vào crontab root: chạy 02:30 hằng ngày
( crontab -l 2>/dev/null; echo '30 2 * * * /opt/autotgc/deploy/backup-db.sh >> /var/log/autotgc/backup.log 2>&1' ) | crontab -

# (khuyến nghị) off-site: mount remote/object-storage rồi set env trong dòng cron
# 30 2 * * * BACKUP_OFFSITE_DIR=/mnt/backup-remote /opt/autotgc/deploy/backup-db.sh >> /var/log/autotgc/backup.log 2>&1
```

Tham số (env, tùy chọn): `BACKUP_DIR` (mặc định `/var/backups/autotgc`), `BACKUP_RETENTION_DAYS` (14), `BACKUP_OFFSITE_DIR` (rỗng = chỉ lưu local).

## 2. Chạy thử + xác minh

```bash
/opt/autotgc/deploy/backup-db.sh
ls -lh /var/backups/autotgc/ | tail -3        # thấy file autotgc-YYYYMMDD-HHMMSS.sql.gz mới
gzip -t /var/backups/autotgc/autotgc-*.sql.gz # kiểm tra file gzip không hỏng
```

## 3. DIỄN TẬP RESTORE (BẮT BUỘC — backup chưa test = chưa có backup)

> Luôn restore vào DB **tạm** trước, KHÔNG ghi đè DB production khi diễn tập.

```bash
# Tạo DB tạm để test restore (chạy với quyền postgres trên cổng 5434)
PGD=$(ls /usr/lib/postgresql/*/bin/psql | sort -V | tail -1)
sudo -u postgres "$PGD" -p 5434 -c "CREATE DATABASE autotgc_restore_test;"

# Restore bản backup mới nhất vào DB tạm
LATEST=$(ls -1t /var/backups/autotgc/*.sql.gz | head -1)
gunzip -c "$LATEST" | sudo -u postgres "$PGD" -p 5434 -d autotgc_restore_test

# Xác minh: đếm bảng + vài bảng chính
sudo -u postgres "$PGD" -p 5434 -d autotgc_restore_test -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';"
sudo -u postgres "$PGD" -p 5434 -d autotgc_restore_test -tAc \
  "SELECT count(*) FROM \"UserAccount\";"

# Dọn DB tạm sau khi xác minh
sudo -u postgres "$PGD" -p 5434 -c "DROP DATABASE autotgc_restore_test;"
```

## 4. Restore THẬT khi sự cố (mất dữ liệu)

> RỦI RO CAO. Dừng app trước, backup hiện trạng trước khi ghi đè.

```bash
# 1) Dừng app để không có ghi mới
sudo -u autotgc bash -lc "pm2 stop autotgc-api autotgc-worker"

# 2) Backup hiện trạng (phòng khi cần quay lại)
/opt/autotgc/deploy/backup-db.sh

# 3) Restore: cách an toàn nhất là tạo DB mới rồi đổi tên, thay vì DROP DB đang dùng
#    (điều chỉnh tên DB theo DATABASE_URL thực tế).
#    Tham khảo cú pháp ở mục 3; với restore thật, restore vào DB đích sau khi đã
#    chắc chắn và có người xác nhận.

# 4) Khởi động lại + kiểm tra
sudo -u autotgc bash -lc "pm2 start autotgc-api autotgc-worker"
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/readyz   # mong đợi 200
```

## 5. Lưu ý

- **Retention:** mặc định giữ 14 ngày local; off-site nên giữ lâu hơn.
- **Off-site là bắt buộc cho production thật:** backup nằm cùng VM với DB → mất VM là mất cả hai. Set `BACKUP_OFFSITE_DIR` trỏ tới remote/object-storage đã mount.
- **Giám sát:** thêm alert nếu `/var/log/autotgc/backup.log` không có dòng `BACKUP_OK` trong 24h, hoặc file backup mới nhất quá cũ.
- **Bảo mật:** file dump chứa dữ liệu PII → đặt quyền chặt (`chmod 600`, thư mục `700`, owner root), mã hoá khi để off-site.

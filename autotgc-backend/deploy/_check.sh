#!/usr/bin/env bash
echo "== nginx sites-enabled =="
ls -la /etc/nginx/sites-enabled/ 2>&1
echo "== /opt/autotgc/deploy =="
ls /opt/autotgc/deploy/ 2>&1 | head -40
echo "== frontend dist =="
ls /opt/autotgc-frontend/dist 2>&1 | head
echo "== pm2 =="
pm2 list 2>&1 | tail -8
echo "== health (backend :3000) =="
curl -s -o /dev/null -w "local3000=%{http_code}\n" http://127.0.0.1:3000/healthz
echo "== via nginx :80 =="
curl -s -o /dev/null -w "nginx80=%{http_code}\n" http://127.0.0.1/healthz
echo "== certbot present? =="
which certbot 2>&1 || echo "certbot: NOT INSTALLED"
echo "== public IP of this server =="
curl -s ifconfig.me 2>&1; echo
echo "== ufw =="
ufw status 2>&1 | head -6

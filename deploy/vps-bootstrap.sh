#!/usr/bin/env bash
# Run on the VPS as root, after:
#   1. DNS A portal.fidumcompany.com -> <VPS IP> has propagated
#   2. /opt/guesty-portal-lookup has been populated (e.g. via deploy/rsync-up.sh)
#   3. /opt/guesty-portal-lookup/.env.local exists with GUESTY_OPEN_API_* vars
#
# Idempotent — safe to re-run.

set -euo pipefail

DOMAIN="${DOMAIN:-portal.fidumcompany.com}"
APP_DIR="${APP_DIR:-/opt/guesty-portal-lookup}"
APP_PORT="${APP_PORT:-3014}"
SVC_NAME="${SVC_NAME:-guesty-portal-lookup}"
ACME_EMAIL="${ACME_EMAIL:-forrest@nlma.io}"

echo "==> Sanity check"
[[ -d "$APP_DIR" ]] || { echo "Missing $APP_DIR — populate it first"; exit 1; }
[[ -f "$APP_DIR/.env.local" ]] || { echo "Missing $APP_DIR/.env.local — populate GUESTY_OPEN_API_*"; exit 1; }

echo "==> Install deps + build"
cd "$APP_DIR"
npm ci
npm run build

echo "==> systemd unit"
cat > "/etc/systemd/system/${SVC_NAME}.service" <<EOF
[Unit]
Description=Guesty Portal Lookup
After=network.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/.env.local
Environment=PORT=${APP_PORT}
Environment=NODE_ENV=production
ExecStart=/usr/bin/node ./node_modules/next/dist/bin/next start -p ${APP_PORT}
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SVC_NAME"
systemctl restart "$SVC_NAME"
sleep 2
systemctl --no-pager status "$SVC_NAME" | head -10
curl -sf -o /dev/null -m 10 "http://127.0.0.1:${APP_PORT}/" && echo "  app responding on :$APP_PORT"

echo "==> nginx vhost"
cat > "/etc/nginx/sites-available/${DOMAIN}" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    location /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
    }

    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
EOF
ln -sf "/etc/nginx/sites-available/${DOMAIN}" "/etc/nginx/sites-enabled/${DOMAIN}"
mkdir -p /var/www/letsencrypt
nginx -t
systemctl reload nginx

echo "==> Let's Encrypt (HTTP-01)"
if certbot certificates 2>/dev/null | grep -q "Domains: ${DOMAIN}"; then
  echo "  cert already exists — skipping issuance"
else
  certbot --nginx --redirect --non-interactive --agree-tos -m "${ACME_EMAIL}" -d "$DOMAIN"
fi

echo "==> Done."
echo "    URL:      https://${DOMAIN}"
echo "    Service:  systemctl status ${SVC_NAME}"

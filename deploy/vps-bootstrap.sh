#!/usr/bin/env bash
# Run on the VPS as root, after:
#   1. DNS A <DOMAIN> -> <VPS IP> has propagated
#   2. /opt/guesty-portal-lookup has been populated (e.g. via deploy/rsync-up.sh)
#   3. /opt/guesty-portal-lookup/.env.local exists with GUESTY_OPEN_API_* vars
#
# Idempotent — safe to re-run.
#
# Optional env vars:
#   DOMAIN                  Primary domain (default: portal.fidumcompany.com)
#   EXTRA_DOMAINS           Comma-separated SAN entries (e.g. "stay.fidumcompany.com")
#   APP_DIR, APP_PORT,
#   SVC_NAME, ACME_EMAIL    Standard overrides
#   HOSTINGER_API_TOKEN     If set, enables DNS-01 fallback when HTTP-01 fails.
#                           Get one at hpanel.hostinger.com → Account → API.
#                           Required if your VPS provider intermittently drops
#                           port-80 connections from Let's Encrypt validators
#                           (Hostinger SDN does this — observed 2026-05-08 on
#                           portal.fidumcompany.com expand to add stay alias).
#   DNS_APEX                Apex domain for DNS-01 (default: derived from DOMAIN)

set -euo pipefail

DOMAIN="${DOMAIN:-portal.fidumcompany.com}"
EXTRA_DOMAINS="${EXTRA_DOMAINS:-}"
APP_DIR="${APP_DIR:-/opt/guesty-portal-lookup}"
APP_PORT="${APP_PORT:-3014}"
SVC_NAME="${SVC_NAME:-guesty-portal-lookup}"
ACME_EMAIL="${ACME_EMAIL:-forrest@nlma.io}"
HOSTINGER_API_TOKEN="${HOSTINGER_API_TOKEN:-}"

# Build certbot -d arg list
ALL_DOMAINS=("$DOMAIN")
if [[ -n "$EXTRA_DOMAINS" ]]; then
  IFS=',' read -ra EXTRAS <<< "$EXTRA_DOMAINS"
  for d in "${EXTRAS[@]}"; do
    ALL_DOMAINS+=("$(echo "$d" | xargs)")
  done
fi
CERTBOT_D_ARGS=()
for d in "${ALL_DOMAINS[@]}"; do
  CERTBOT_D_ARGS+=(-d "$d")
done

# Derive apex from primary domain (e.g. portal.fidumcompany.com → fidumcompany.com)
DNS_APEX="${DNS_APEX:-$(echo "$DOMAIN" | awk -F. '{print $(NF-1)"."$NF}')}"

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
SERVER_NAMES="${ALL_DOMAINS[*]}"
cat > "/etc/nginx/sites-available/${DOMAIN}" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${SERVER_NAMES};

    # ACME HTTP-01 challenge — must come BEFORE the redirect, otherwise
    # Let's Encrypt follows the 301 to HTTPS where the cert may not yet
    # cover the new SAN, and the handshake fails as a connection timeout.
    location /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
        default_type "text/plain";
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${SERVER_NAMES};

    # ssl_certificate lines added by certbot after first issuance.
    # On a fresh install these don't exist yet, so we serve plain HTTP
    # for the first run and let certbot rewrite this block.

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
# On a fresh install the 443 block has no cert directives and nginx -t fails.
# Strip the 443 block on first run; certbot will reinstate it.
if [[ ! -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" ]]; then
  echo "  no existing cert — staging port-80-only vhost for first cert issuance"
  cat > "/etc/nginx/sites-available/${DOMAIN}" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${SERVER_NAMES};

    location /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
        default_type "text/plain";
    }

    location / {
        return 444;
    }
}
EOF
fi
ln -sf "/etc/nginx/sites-available/${DOMAIN}" "/etc/nginx/sites-enabled/${DOMAIN}"
mkdir -p /var/www/letsencrypt
nginx -t
systemctl reload nginx

# ---------------------------------------------------------------------------
# DNS-01 helper functions (only used when HTTP-01 fails)
# ---------------------------------------------------------------------------
HOSTINGER_API_BASE="https://developers.hostinger.com/api/dns/v1/zones"

# Plant a TXT record via Hostinger DNS API. Args: <subdomain-relative-name> <value>
plant_txt() {
  local name="$1" value="$2"
  curl -sf -X PUT "${HOSTINGER_API_BASE}/${DNS_APEX}" \
    -H "Authorization: Bearer ${HOSTINGER_API_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"overwrite\":false,\"zone\":[{\"name\":\"${name}\",\"type\":\"TXT\",\"ttl\":60,\"records\":[{\"content\":\"${value}\"}]}]}" \
    > /dev/null
}

# Wait until @1.1.1.1 and @8.8.8.8 both resolve the TXT to the expected value.
wait_for_txt() {
  local fqdn="$1" expected="$2"
  local i v1 v2
  for i in $(seq 1 60); do
    v1=$(dig +short @1.1.1.1 "${fqdn}" TXT 2>/dev/null | tr -d '"' | head -1)
    v2=$(dig +short @8.8.8.8 "${fqdn}" TXT 2>/dev/null | tr -d '"' | head -1)
    if [[ "$v1" == "$expected" && "$v2" == "$expected" ]]; then
      return 0
    fi
    sleep 2
  done
  return 1
}

# Manual auth hook — writes the challenge to a known location and waits for
# the orchestrator (this script) to plant + verify TXT, then to release.
write_dns_auth_hook() {
  cat > /tmp/cb-auth.sh <<'EOF'
#!/bin/bash
echo "${CERTBOT_DOMAIN} ${CERTBOT_VALIDATION}" > /tmp/cb-challenge.txt
for i in $(seq 1 300); do
  [[ -f /tmp/cb-go.txt ]] && exit 0
  sleep 1
done
exit 1
EOF
  cat > /tmp/cb-cleanup.sh <<'EOF'
#!/bin/bash
touch /tmp/cb-cleaned.txt
EOF
  chmod +x /tmp/cb-auth.sh /tmp/cb-cleanup.sh
}

issue_via_dns01() {
  if [[ -z "$HOSTINGER_API_TOKEN" ]]; then
    echo "  ERROR: HTTP-01 failed and HOSTINGER_API_TOKEN is not set; cannot fall back to DNS-01."
    echo "  Set HOSTINGER_API_TOKEN (from hpanel.hostinger.com → Account → API) and re-run."
    return 1
  fi
  echo "==> Falling back to DNS-01 via Hostinger DNS API"
  write_dns_auth_hook
  rm -f /tmp/cb-challenge.txt /tmp/cb-go.txt /tmp/cb-cleaned.txt /tmp/cb-result.txt /tmp/cb-finished.txt

  nohup bash -c "certbot certonly --manual --preferred-challenges dns \
    --manual-auth-hook /tmp/cb-auth.sh \
    --manual-cleanup-hook /tmp/cb-cleanup.sh \
    --expand --cert-name ${DOMAIN} ${CERTBOT_D_ARGS[*]} \
    --non-interactive --agree-tos -m ${ACME_EMAIL} \
    > /tmp/cb-result.txt 2>&1; touch /tmp/cb-finished.txt" >/dev/null 2>&1 &
  disown || true

  # Each domain in the SAN gets its own challenge. Loop: wait for challenge,
  # plant, verify, release, repeat until certbot finishes.
  while true; do
    # Wait for next challenge or completion
    for i in $(seq 1 120); do
      [[ -f /tmp/cb-finished.txt ]] && break 2
      [[ -f /tmp/cb-challenge.txt ]] && break
      sleep 1
    done
    [[ -f /tmp/cb-finished.txt ]] && break

    local challenge_line
    challenge_line=$(cat /tmp/cb-challenge.txt)
    local cb_domain cb_value
    cb_domain=$(echo "$challenge_line" | awk '{print $1}')
    cb_value=$(echo "$challenge_line" | awk '{print $2}')

    # Hostinger API expects the name relative to the apex.
    # Strip the apex suffix to get the relative name.
    local relative_name="_acme-challenge.${cb_domain%."$DNS_APEX"}"
    # Edge case: if cb_domain == apex, the relative name is just "_acme-challenge"
    if [[ "$cb_domain" == "$DNS_APEX" ]]; then
      relative_name="_acme-challenge"
    fi

    echo "  planting TXT ${relative_name}.${DNS_APEX} = ${cb_value}"
    plant_txt "$relative_name" "$cb_value"

    if ! wait_for_txt "_acme-challenge.${cb_domain}" "$cb_value"; then
      echo "  ERROR: TXT propagation timeout after 120s"
      rm -f /tmp/cb-go.txt
      cat /tmp/cb-result.txt
      return 1
    fi

    echo "  TXT propagated; releasing certbot"
    rm -f /tmp/cb-challenge.txt
    touch /tmp/cb-go.txt

    # Wait for the auth hook to consume the go signal before re-arming
    sleep 3
    rm -f /tmp/cb-go.txt
  done

  if grep -q "Successfully received certificate" /tmp/cb-result.txt 2>/dev/null; then
    echo "  DNS-01 success"
    return 0
  fi
  echo "  ERROR: certbot DNS-01 failed:"
  cat /tmp/cb-result.txt
  return 1
}

# ---------------------------------------------------------------------------
# Cert issuance: try HTTP-01 (--webroot) first, fall back to DNS-01.
# ---------------------------------------------------------------------------
echo "==> Let's Encrypt"
if certbot certificates 2>/dev/null | grep -q "Domains: ${DOMAIN}"; then
  echo "  cert already exists — skipping issuance"
else
  echo "  trying HTTP-01 (webroot)"
  if certbot certonly --webroot -w /var/www/letsencrypt \
       --non-interactive --agree-tos -m "${ACME_EMAIL}" \
       --cert-name "${DOMAIN}" "${CERTBOT_D_ARGS[@]}" 2>&1 | tee /tmp/cb-http01.log; then
    if grep -q "Successfully received certificate" /tmp/cb-http01.log; then
      echo "  HTTP-01 success"
    else
      echo "  HTTP-01 reported no error but cert wasn't issued; falling back"
      issue_via_dns01
    fi
  else
    echo "  HTTP-01 failed (likely SDN port-80 block); falling back to DNS-01"
    issue_via_dns01
  fi

  # Now that the cert exists, write the full nginx vhost with TLS directives
  # and reload. (The first-run port-80-only stub is replaced.)
  cat > "/etc/nginx/sites-available/${DOMAIN}" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${SERVER_NAMES};

    location /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
        default_type "text/plain";
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${SERVER_NAMES};

    ssl_certificate /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

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
  nginx -t
  systemctl reload nginx
fi

echo "==> Done."
echo "    URL:      https://${DOMAIN}"
for d in "${ALL_DOMAINS[@]:1}"; do
  echo "    Alias:    https://${d}"
done
echo "    Service:  systemctl status ${SVC_NAME}"
if [[ -z "$HOSTINGER_API_TOKEN" ]]; then
  cat <<EOF

Note: HOSTINGER_API_TOKEN is not set, so cert renewal via HTTP-01 only.
If you ever need to add a SAN and Hostinger blocks port 80 to LE validators,
set HOSTINGER_API_TOKEN and re-run this script — DNS-01 fallback will kick in.
EOF
fi

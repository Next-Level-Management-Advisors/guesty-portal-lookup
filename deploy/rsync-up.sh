#!/usr/bin/env bash
# Run on your dev box. Pushes the project to /opt/guesty-portal-lookup on the VPS.
# Excludes node_modules, .next, .git, and local secrets.

set -euo pipefail

VPS="${DEPLOY_VPS:-root@178.16.141.166}"
DEST="${DEPLOY_DEST:-/opt/guesty-portal-lookup}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

echo "==> Ensuring ${DEST} exists on ${VPS}"
ssh "$VPS" "mkdir -p $DEST"

if command -v rsync >/dev/null 2>&1; then
  echo "==> rsync from $ROOT/ -> ${VPS}:${DEST}/"
  rsync -avz --delete \
    --exclude '.next' \
    --exclude 'node_modules' \
    --exclude '.git' \
    --exclude '.turbo' \
    --exclude '.env.local' \
    "$ROOT/" "${VPS}:${DEST}/"
else
  echo "==> rsync not found — falling back to tar over ssh"
  cd "$ROOT"
  tar --exclude='.next' --exclude='node_modules' --exclude='.git' --exclude='.turbo' --exclude='.env.local' \
    -czf - . | ssh "$VPS" "tar -xzf - -C $DEST"
fi

echo "==> Reminder: scp $ROOT/.env.local ${VPS}:${DEST}/.env.local"
echo "==> Then ssh in and run: bash ${DEST}/deploy/vps-bootstrap.sh"

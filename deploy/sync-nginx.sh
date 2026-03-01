#!/usr/bin/env bash
# Sync nginx config from repo template to sites-available.
# Designed to run as the idlerpg user during deploys.
# Requires: sudo nginx -t, sudo systemctl reload nginx (via sudoers)
set -euo pipefail

INSTALL_DIR="/opt/idle-party-rpg"
NGINX_CONF="ipr-site.conf"
TEMPLATE="$INSTALL_DIR/deploy/ipr-site.conf.template"
TARGET="/etc/nginx/sites-available/$NGINX_CONF"

if [[ ! -f "$TEMPLATE" ]]; then
  echo "[sync-nginx] Template not found: $TEMPLATE"
  exit 1
fi

# Extract domain from existing config (avoids needing .env parsing)
if [[ -f "$TARGET" ]]; then
  CURRENT_DOMAIN=$(grep 'server_name' "$TARGET" | awk '{print $2}' | tr -d ';')
else
  echo "[sync-nginx] No existing nginx config at $TARGET — skipping (run setup-prod.sh first)"
  exit 0
fi

# Generate new config from template
NEW_CONF=$(sed "s/{{DOMAIN}}/$CURRENT_DOMAIN/g" "$TEMPLATE")

# Compare with current config
if [[ -f "$TARGET" ]] && echo "$NEW_CONF" | diff -q - "$TARGET" >/dev/null 2>&1; then
  echo "[sync-nginx] nginx config unchanged"
  exit 0
fi

# Write new config and reload
echo "$NEW_CONF" | sudo tee "$TARGET" >/dev/null
echo "[sync-nginx] Updated $TARGET"

sudo nginx -t
sudo systemctl reload nginx
echo "[sync-nginx] nginx reloaded"

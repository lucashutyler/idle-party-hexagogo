#!/usr/bin/env bash
# Sync nginx config from repo template to sites-available.
# Designed to run as the service user during deploys.
# Requires sudoers entries for: cp, nginx -t, systemctl reload nginx
#
# Multi-instance: everything is derived from where this script lives, so a second
# install at /opt/idle-party-rpg-<instance> syncs its own nginx site file and
# never touches the first instance's. The naming rule matches setup-prod.sh:
#   /opt/idle-party-rpg            -> ipr-site.conf
#   /opt/idle-party-rpg-game2      -> ipr-site-game2.conf
set -euo pipefail

INSTALL_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
case "${INSTALL_DIR##*/}" in
  idle-party-rpg)   SUFFIX="" ;;
  idle-party-rpg-*) SUFFIX="-${INSTALL_DIR##*/idle-party-rpg-}" ;;
  *) echo "[sync-nginx] Unexpected install dir '$INSTALL_DIR' — expected .../idle-party-rpg[-<instance>]"; exit 1 ;;
esac
NGINX_CONF="ipr-site${SUFFIX}.conf"
TEMPLATE="$INSTALL_DIR/deploy/ipr-site.conf.template"
TARGET="/etc/nginx/sites-available/$NGINX_CONF"
ENV_FILE="$INSTALL_DIR/.env"

if [[ ! -f "$TEMPLATE" ]]; then
  echo "[sync-nginx] Template not found: $TEMPLATE"
  exit 1
fi

if [[ ! -f "$TARGET" ]]; then
  echo "[sync-nginx] No existing nginx config at $TARGET — skipping (run setup-prod.sh first)"
  exit 0
fi

if [[ ! -r "$ENV_FILE" ]]; then
  echo "[sync-nginx] Cannot read $ENV_FILE — skipping"
  exit 0
fi

# Domain and port both come from this instance's .env, so the rendered config
# can never point at another instance's port.
DOMAIN=$(grep '^APP_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- | sed -e 's|^https://||' -e 's|^http://||' -e 's|/.*$||')
PORT=$(grep '^PORT=' "$ENV_FILE" | head -1 | cut -d= -f2)
PORT="${PORT:-3001}"

if [[ -z "$DOMAIN" ]]; then
  # Fall back to whatever the live config already serves.
  DOMAIN=$(grep 'server_name' "$TARGET" | head -1 | awk '{print $2}' | tr -d ';')
fi
[[ -z "$DOMAIN" ]] && { echo "[sync-nginx] Could not determine domain — skipping"; exit 0; }

# If certbot has taken over this site file it holds a TLS server block that the
# repo template doesn't know about. Re-rendering would drop HTTPS, so bail out and
# leave it to the operator (re-run setup-prod.sh to pull in template changes).
if grep -q 'managed by Certbot' "$TARGET" 2>/dev/null; then
  echo "[sync-nginx] $NGINX_CONF is certbot-managed — leaving it untouched"
  exit 0
fi

# Generate new config from template into a temp file
TMPFILE=$(mktemp)
sed -e "s/{{DOMAIN}}/$DOMAIN/g" -e "s/{{PORT}}/$PORT/g" "$TEMPLATE" > "$TMPFILE"

# Compare with current config
if diff -q "$TMPFILE" "$TARGET" >/dev/null 2>&1; then
  echo "[sync-nginx] nginx config unchanged ($NGINX_CONF)"
  rm "$TMPFILE"
  exit 0
fi

# Copy new config and reload
sudo cp "$TMPFILE" "$TARGET"
rm "$TMPFILE"
echo "[sync-nginx] Updated $TARGET ($DOMAIN -> localhost:$PORT)"

sudo nginx -t
sudo systemctl reload nginx
echo "[sync-nginx] nginx reloaded"

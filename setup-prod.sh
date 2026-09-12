#!/usr/bin/env bash
set -euo pipefail

REPO_URL="git@github.com:lucashutyler/idle-party-hexagogo.git"
SERVICE_USER="idlerpg"
INSTALL_ROOT="${INSTALL_ROOT:-/opt}"

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[OK]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!!]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

usage() {
  cat <<USAGE
Usage: sudo ./setup-prod.sh [--instance NAME] [--certbot | --no-certbot]

  --instance NAME   Install a named instance alongside the primary one.
                    Omit for the primary instance.
  --certbot         Issue a Let's Encrypt certificate for the domain at the end.
  --no-certbot      Skip the HTTPS prompt entirely (for proxied TLS, e.g. Cloudflare).
                    Without either flag the script asks.

Each instance gets its own install directory, .env, data/, systemd unit and
nginx site, so several can run on one server behind different domains:

  (primary)          /opt/idle-party-rpg         idle-party-rpg.service         ipr-site.conf
  --instance game2   /opt/idle-party-rpg-game2   idle-party-rpg-game2.service   ipr-site-game2.conf
USAGE
  exit 0
}

# --- Parse args ---
INSTANCE="${INSTANCE:-}"
USE_CERTBOT=""   # "" = ask, "yes" / "no" = decided by flag
while [[ $# -gt 0 ]]; do
  case "$1" in
    --instance) INSTANCE="${2:-}"; shift 2 ;;
    --instance=*) INSTANCE="${1#*=}"; shift ;;
    --certbot) USE_CERTBOT="yes"; shift ;;
    --no-certbot) USE_CERTBOT="no"; shift ;;
    -h|--help) usage ;;
    *) error "Unknown argument: $1 (try --help)" ;;
  esac
done

# --- Must run as root ---
if [[ $EUID -ne 0 ]]; then
  error "This script must be run as root (use sudo)"
fi

echo ""
echo "=== Idle Party RPG — Production Setup ==="
echo ""

# --- Resolve instance identity ---
if [[ -z "$INSTANCE" ]]; then
  echo "Leave blank for the primary instance, or name a second instance (e.g. game2)."
  read -rp "Instance name []: " INSTANCE
fi

if [[ -n "$INSTANCE" ]]; then
  [[ "$INSTANCE" =~ ^[a-z0-9][a-z0-9-]*$ ]] || \
    error "Instance name must be lowercase letters, digits and dashes (got: $INSTANCE)"
fi

SUFFIX=""
[[ -n "$INSTANCE" ]] && SUFFIX="-$INSTANCE"

# These three names must stay in step with the derivation in deploy/sync-nginx.sh.
INSTALL_DIR="$INSTALL_ROOT/idle-party-rpg$SUFFIX"
SERVICE_NAME="idle-party-rpg$SUFFIX"
NGINX_CONF="ipr-site$SUFFIX.conf"
SUDOERS_FILE="/etc/sudoers.d/$SERVICE_USER-${INSTANCE:-default}"
INSTANCE_LABEL="${INSTANCE:-primary}"

info "Instance:     $INSTANCE_LABEL"
info "Install dir:  $INSTALL_DIR"
info "Service:      $SERVICE_NAME.service"
info "nginx site:   $NGINX_CONF"
echo ""

# --- Validate prerequisites ---
echo "Checking prerequisites..."

command -v node >/dev/null 2>&1 || error "node is not installed. Install Node.js 22 LTS via NodeSource (see README)."
NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [[ "$NODE_VERSION" -lt 22 ]]; then
  error "Node.js 22+ is required (found v$(node -v | sed 's/v//')). Upgrade Node.js first."
fi
info "node $(node -v)"

command -v npm >/dev/null 2>&1 || error "npm is not installed."
info "npm $(npm -v)"

command -v nginx >/dev/null 2>&1 || error "nginx is not installed. Install it first: apt install nginx"
info "nginx $(nginx -v 2>&1 | sed 's/.*\///')"

command -v git >/dev/null 2>&1 || error "git is not installed."
info "git $(git --version | awk '{print $3}')"

echo ""

# --- Ports already claimed by other instances ---
# Reads every sibling install's .env so a new instance can't silently collide.
# Newline-separated "<port> <install dir>" lines (plain string, not an assoc array,
# so this still runs under bash 3.x).
USED_PORTS=""
for env_file in "$INSTALL_ROOT"/idle-party-rpg*/.env; do
  [[ -f "$env_file" ]] || continue
  [[ "$env_file" == "$INSTALL_DIR/.env" ]] && continue
  other_port=$(grep '^PORT=' "$env_file" | head -1 | cut -d= -f2 || true)
  [[ -n "$other_port" ]] && USED_PORTS="$USED_PORTS$other_port ${env_file%/.env}
"
done

port_owner() { echo "$USED_PORTS" | awk -v p="$1" '$1 == p { print $2; exit }'; }

SUGGESTED_PORT=3001
while [[ -n "$(port_owner "$SUGGESTED_PORT")" ]]; do
  SUGGESTED_PORT=$((SUGGESTED_PORT + 1))
done

# --- Prompt for configuration ---
SKIP_ENV=false
if [[ -f "$INSTALL_DIR/.env" ]]; then
  warn "Existing .env found at $INSTALL_DIR/.env"
  read -rp "Overwrite it? (y/N): " OVERWRITE_ENV
  if [[ "$OVERWRITE_ENV" != "y" && "$OVERWRITE_ENV" != "Y" ]]; then
    SKIP_ENV=true
    info "Keeping existing .env"
    # Still need DOMAIN and PORT for the nginx config — take them from the existing .env
    DOMAIN=$(grep '^APP_URL=' "$INSTALL_DIR/.env" | head -1 | cut -d= -f2- | sed -e 's|^https://||' -e 's|^http://||' -e 's|/.*$||')
    [[ -z "$DOMAIN" ]] && read -rp "Domain name (e.g. play.hexagogo.com): " DOMAIN
    [[ -z "$DOMAIN" ]] && error "Domain is required."
    PORT=$(grep '^PORT=' "$INSTALL_DIR/.env" | head -1 | cut -d= -f2)
    PORT="${PORT:-3001}"
    info "Using domain: $DOMAIN (port $PORT)"
  fi
fi

if [[ "$SKIP_ENV" == "false" ]]; then
  echo "=== Configuration ==="
  echo ""

  read -rp "Domain name (e.g. play.hexagogo.com): " DOMAIN
  [[ -z "$DOMAIN" ]] && error "Domain is required."

  DEFAULT_SECRET=$(openssl rand -hex 32)
  read -rp "Session secret [generated: ${DEFAULT_SECRET:0:16}...]: " SESSION_SECRET
  SESSION_SECRET="${SESSION_SECRET:-$DEFAULT_SECRET}"

  DEFAULT_APP_URL="https://$DOMAIN"
  read -rp "App URL [$DEFAULT_APP_URL]: " APP_URL
  APP_URL="${APP_URL:-$DEFAULT_APP_URL}"

  if [[ -n "$USED_PORTS" ]]; then
    echo ""
    echo "Ports already in use by other instances:"
    echo "$USED_PORTS" | while read -r used owner; do
      [[ -n "$used" ]] && echo "  $used  ($owner)"
    done || true
  fi
  read -rp "Server port [$SUGGESTED_PORT]: " PORT
  PORT="${PORT:-$SUGGESTED_PORT}"

  echo ""
  echo "AWS SES configuration (required for email authentication):"
  read -rp "AWS_ACCESS_KEY_ID: " AWS_ACCESS_KEY_ID
  [[ -z "$AWS_ACCESS_KEY_ID" ]] && error "AWS_ACCESS_KEY_ID is required for production email auth."
  read -rp "AWS_SECRET_ACCESS_KEY: " AWS_SECRET_ACCESS_KEY
  [[ -z "$AWS_SECRET_ACCESS_KEY" ]] && error "AWS_SECRET_ACCESS_KEY is required for production email auth."
  read -rp "SES_FROM_EMAIL (e.g. noreply@hexagogo.com): " SES_FROM_EMAIL
  [[ -z "$SES_FROM_EMAIL" ]] && error "SES_FROM_EMAIL is required for production email auth."
  read -rp "AWS_REGION [us-east-1]: " AWS_REGION
  AWS_REGION="${AWS_REGION:-us-east-1}"

  echo ""
fi

# --- Port collision guard ---
PORT_OWNER=$(port_owner "$PORT")
if [[ -n "$PORT_OWNER" ]]; then
  error "Port $PORT is already used by $PORT_OWNER. Pick a different port."
fi

# --- Create service user ---
if ! id "$SERVICE_USER" &>/dev/null; then
  useradd --system --create-home --home-dir /home/$SERVICE_USER --shell /bin/bash "$SERVICE_USER"
  info "Created user: $SERVICE_USER (with home dir for SSH)"
else
  info "User $SERVICE_USER already exists"
  # Ensure shell is bash (may have been nologin from a previous setup)
  usermod --shell /bin/bash "$SERVICE_USER" 2>/dev/null || true
fi

# --- Set up sudoers for service restart + nginx sync ---
# One file per instance, so setting up a second instance can't revoke the first
# instance's ability to restart and reload itself during a deploy.
# A pre-multi-instance install left a single /etc/sudoers.d/idlerpg granting rights
# over the primary service. Its contents already match the primary's names, so rename
# it into the new scheme rather than deleting it — dropping it while installing a
# *second* instance would silently break the primary's deploys.
LEGACY_SUDOERS="/etc/sudoers.d/$SERVICE_USER"
if [[ -f "$LEGACY_SUDOERS" ]]; then
  if [[ -z "$INSTANCE" || -f "/etc/sudoers.d/$SERVICE_USER-default" ]]; then
    rm "$LEGACY_SUDOERS"
    warn "Removed superseded legacy sudoers file $LEGACY_SUDOERS"
  else
    mv "$LEGACY_SUDOERS" "/etc/sudoers.d/$SERVICE_USER-default"
    warn "Migrated $LEGACY_SUDOERS -> /etc/sudoers.d/$SERVICE_USER-default (primary instance)"
  fi
fi
cat > "$SUDOERS_FILE" <<SUDOERS
$SERVICE_USER ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart $SERVICE_NAME
$SERVICE_USER ALL=(ALL) NOPASSWD: /usr/bin/systemctl reload nginx
$SERVICE_USER ALL=(ALL) NOPASSWD: /usr/sbin/nginx -t
$SERVICE_USER ALL=(ALL) NOPASSWD: /bin/cp /tmp/* /etc/nginx/sites-available/$NGINX_CONF
SUDOERS
chmod 440 "$SUDOERS_FILE"
info "Sudoers: $SERVICE_USER can restart $SERVICE_NAME, sync $NGINX_CONF, reload nginx"

# --- Clone or update repo ---
if [[ -d "$INSTALL_DIR/.git" ]]; then
  info "Repository already exists at $INSTALL_DIR, pulling latest..."
  git -C "$INSTALL_DIR" pull
else
  info "Cloning repository to $INSTALL_DIR..."
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

# --- Write .env ---
if [[ "$SKIP_ENV" == "false" ]]; then
  cat > "$INSTALL_DIR/.env" <<EOF
PORT=$PORT
SESSION_SECRET=$SESSION_SECRET
APP_URL=$APP_URL
AWS_ACCESS_KEY_ID=$AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY=$AWS_SECRET_ACCESS_KEY
AWS_REGION=$AWS_REGION
SES_FROM_EMAIL=$SES_FROM_EMAIL
EOF
  chmod 600 "$INSTALL_DIR/.env"
  info "Wrote $INSTALL_DIR/.env"
fi

# --- Install dependencies and build ---
echo "Installing dependencies and building..."
cd "$INSTALL_DIR"
npm install
npm run build
info "Build complete"

# --- Set ownership ---
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"
info "Set ownership to $SERVICE_USER"

# --- Install systemd service ---
SCRIPT_DIR="$INSTALL_DIR/deploy"
sed -e "s|{{INSTALL_DIR}}|$INSTALL_DIR|g" \
    -e "s|{{SERVICE_USER}}|$SERVICE_USER|g" \
    -e "s|{{SERVICE_NAME}}|$SERVICE_NAME|g" \
    -e "s|{{INSTANCE_LABEL}}|$INSTANCE_LABEL|g" \
    "$SCRIPT_DIR/idle-party-rpg.service.template" > "/etc/systemd/system/$SERVICE_NAME.service"
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"
info "systemd service $SERVICE_NAME installed and started"

# --- Install nginx config ---
sed -e "s/{{DOMAIN}}/$DOMAIN/g" -e "s/{{PORT}}/$PORT/g" \
    "$SCRIPT_DIR/ipr-site.conf.template" > "/etc/nginx/sites-available/$NGINX_CONF"

if [[ -L "/etc/nginx/sites-enabled/$NGINX_CONF" ]]; then
  rm "/etc/nginx/sites-enabled/$NGINX_CONF"
fi
ln -s "/etc/nginx/sites-available/$NGINX_CONF" "/etc/nginx/sites-enabled/$NGINX_CONF"

# Remove default site if it exists
if [[ -L "/etc/nginx/sites-enabled/default" ]]; then
  rm "/etc/nginx/sites-enabled/default"
  warn "Removed default nginx site"
fi

nginx -t || error "nginx config test failed"
systemctl reload nginx
info "nginx configured for $DOMAIN -> localhost:$PORT"

# --- Optional HTTPS via certbot ---
# Skip this if TLS terminates upstream (Cloudflare proxy, another load balancer);
# nginx then just serves plain HTTP on :80 behind the proxy.
if [[ -z "$USE_CERTBOT" ]]; then
  echo ""
  echo "HTTPS: certbot issues a Let's Encrypt certificate directly on this server."
  echo "Skip it if TLS already terminates upstream (e.g. the Cloudflare proxy)."
  read -rp "Set up HTTPS with certbot for $DOMAIN? (y/N): " CERTBOT_ANSWER
  if [[ "$CERTBOT_ANSWER" == "y" || "$CERTBOT_ANSWER" == "Y" ]]; then
    USE_CERTBOT="yes"
  else
    USE_CERTBOT="no"
  fi
fi

if [[ "$USE_CERTBOT" == "yes" ]]; then
  if ! command -v certbot >/dev/null 2>&1; then
    warn "certbot is not installed — installing it now..."
    apt-get update
    apt-get install -y certbot python3-certbot-nginx || \
      error "Failed to install certbot. Install it manually, then run: certbot --nginx -d $DOMAIN"
  fi
  # certbot rewrites the site file in place to add the TLS server block. sync-nginx.sh
  # detects a certbot-managed config and leaves it alone, so deploys won't clobber it.
  certbot --nginx -d "$DOMAIN" || error "certbot failed for $DOMAIN. Fix DNS, then run: certbot --nginx -d $DOMAIN"
  info "HTTPS enabled for $DOMAIN"
  warn "$NGINX_CONF is now certbot-managed — deploys will stop auto-syncing it."
  warn "If the repo's nginx template changes, re-run this script to pick it up."
else
  info "Skipped certbot — nginx serves plain HTTP on :80 (expects TLS upstream)"
fi

# --- Done ---
echo ""
echo "=== Setup Complete ($INSTANCE_LABEL) ==="
echo ""
echo "  Game server:  systemctl status $SERVICE_NAME"
echo "  Server logs:  journalctl -u $SERVICE_NAME -f"
echo "  nginx config: /etc/nginx/sites-available/$NGINX_CONF"
echo "  App env:      $INSTALL_DIR/.env"
echo "  Game data:    $INSTALL_DIR/data/"
echo ""
echo "=== Next Steps ==="
echo ""
if [[ "$USE_CERTBOT" == "yes" ]]; then
  echo "  1. HTTPS is live via certbot. Confirm renewal is armed:"
  echo "     systemctl status certbot.timer"
else
  echo "  1. Point $DOMAIN at this server and terminate TLS upstream."
  echo "     With Cloudflare:"
  echo "     - A record for $DOMAIN -> $(hostname -I | awk '{print $1}'), proxy enabled (orange cloud)"
  echo "     - SSL/TLS mode: Full (nginx serves plain HTTP on :80 behind the proxy)"
  echo "     - Enable WebSockets under Network (the game runs over a WS connection)"
fi
echo ""
echo "  2. Set up SSH key for the $SERVICE_USER user (skip if already done):"
echo "     sudo mkdir -p /home/$SERVICE_USER/.ssh"
echo "     sudo ssh-keygen -t ed25519 -f /home/$SERVICE_USER/.ssh/id_deploy -N ''"
echo "     sudo cat /home/$SERVICE_USER/.ssh/id_deploy.pub | sudo tee -a /home/$SERVICE_USER/.ssh/authorized_keys"
echo "     sudo chown -R $SERVICE_USER:$SERVICE_USER /home/$SERVICE_USER/.ssh"
echo "     sudo chmod 700 /home/$SERVICE_USER/.ssh && sudo chmod 600 /home/$SERVICE_USER/.ssh/authorized_keys"
echo ""
echo "  3. Add GitHub Actions secrets for auto-deploy (shared by all instances):"
echo "     SSH_HOST  = $(hostname -I | awk '{print $1}')"
echo "     SSH_USER  = $SERVICE_USER"
echo "     SSH_KEY   = (contents of /home/$SERVICE_USER/.ssh/id_deploy)"
echo ""
echo "     Deploy fans out over every /opt/idle-party-rpg* install it finds,"
echo "     so this instance is picked up automatically on the next push to main."
echo ""
echo "  4. Test: curl -H 'Host: $DOMAIN' http://localhost"
echo ""

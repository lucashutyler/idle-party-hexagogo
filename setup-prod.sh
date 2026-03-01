#!/usr/bin/env bash
set -euo pipefail

REPO_URL="git@github.com:lucashutyler/idle-party-hexagogo.git"
INSTALL_DIR="/opt/idle-party-rpg"
SERVICE_NAME="idle-party-rpg"
NGINX_CONF="ipr-site.conf"
SERVICE_USER="idlerpg"

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[OK]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!!]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# --- Must run as root ---
if [[ $EUID -ne 0 ]]; then
  error "This script must be run as root (use sudo)"
fi

echo ""
echo "=== Idle Party RPG — Production Setup ==="
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

# --- Prompt for configuration ---
SKIP_ENV=false
if [[ -f "$INSTALL_DIR/.env" ]]; then
  warn "Existing .env found at $INSTALL_DIR/.env"
  read -rp "Overwrite it? (y/N): " OVERWRITE_ENV
  if [[ "$OVERWRITE_ENV" != "y" && "$OVERWRITE_ENV" != "Y" ]]; then
    SKIP_ENV=true
    info "Keeping existing .env"
    # Still need DOMAIN for nginx config — extract from existing APP_URL
    DOMAIN=$(grep '^APP_URL=' "$INSTALL_DIR/.env" | sed 's|APP_URL=https\?://||')
    [[ -z "$DOMAIN" ]] && read -rp "Domain name (e.g. play.hexagogo.com): " DOMAIN
    [[ -z "$DOMAIN" ]] && error "Domain is required."
    info "Using domain: $DOMAIN"
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

  read -rp "Server port [3001]: " PORT
  PORT="${PORT:-3001}"

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
SUDOERS_FILE="/etc/sudoers.d/$SERVICE_USER"
cat > "$SUDOERS_FILE" <<SUDOERS
$SERVICE_USER ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart $SERVICE_NAME
$SERVICE_USER ALL=(ALL) NOPASSWD: /usr/bin/systemctl reload nginx
$SERVICE_USER ALL=(ALL) NOPASSWD: /usr/sbin/nginx -t
$SERVICE_USER ALL=(ALL) NOPASSWD: /bin/cp /tmp/* /etc/nginx/sites-available/$NGINX_CONF
SUDOERS
chmod 440 "$SUDOERS_FILE"
info "Sudoers: $SERVICE_USER can restart $SERVICE_NAME, sync nginx config, reload nginx"

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
cp "$INSTALL_DIR/deploy/idle-party-rpg.service" "/etc/systemd/system/$SERVICE_NAME.service"
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl start "$SERVICE_NAME"
info "systemd service installed and started"

# --- Install nginx config ---
SCRIPT_DIR="$INSTALL_DIR/deploy"
sed "s/{{DOMAIN}}/$DOMAIN/g" "$SCRIPT_DIR/ipr-site.conf.template" > "/etc/nginx/sites-available/$NGINX_CONF"

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
info "nginx configured for $DOMAIN"

# --- Done ---
echo ""
echo "=== Setup Complete ==="
echo ""
echo "  Game server:  systemctl status $SERVICE_NAME"
echo "  Server logs:  journalctl -u $SERVICE_NAME -f"
echo "  nginx config: /etc/nginx/sites-available/$NGINX_CONF"
echo "  App env:      $INSTALL_DIR/.env"
echo ""
echo "=== Next Steps ==="
echo ""
echo "  1. Set up HTTPS:"
echo "     sudo apt install certbot python3-certbot-nginx"
echo "     sudo certbot --nginx -d $DOMAIN"
echo ""
echo "  2. Set up SSH key for the $SERVICE_USER user:"
echo "     sudo mkdir -p /home/$SERVICE_USER/.ssh"
echo "     sudo ssh-keygen -t ed25519 -f /home/$SERVICE_USER/.ssh/id_deploy -N ''"
echo "     sudo cat /home/$SERVICE_USER/.ssh/id_deploy.pub | sudo tee /home/$SERVICE_USER/.ssh/authorized_keys"
echo "     sudo chown -R $SERVICE_USER:$SERVICE_USER /home/$SERVICE_USER/.ssh"
echo "     sudo chmod 700 /home/$SERVICE_USER/.ssh && sudo chmod 600 /home/$SERVICE_USER/.ssh/authorized_keys"
echo ""
echo "  3. Add GitHub Actions secrets for auto-deploy:"
echo "     SSH_HOST  = $(hostname -I | awk '{print $1}')"
echo "     SSH_USER  = $SERVICE_USER"
echo "     SSH_KEY   = (contents of /home/$SERVICE_USER/.ssh/id_deploy)"
echo ""
echo "  4. Test: curl http://$DOMAIN"
echo ""

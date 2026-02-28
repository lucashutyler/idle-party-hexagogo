#!/usr/bin/env bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

info()  { echo -e "${GREEN}[OK]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

echo ""
echo "=== Idle Party RPG — Dev Setup ==="
echo ""

# --- Validate prerequisites ---
echo "Checking prerequisites..."

command -v node >/dev/null 2>&1 || error "node is not installed. Install Node.js 20+ first."
NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [[ "$NODE_VERSION" -lt 20 ]]; then
  error "Node.js 20+ is required (found v$(node -v | sed 's/v//')). Upgrade Node.js first."
fi
info "node $(node -v)"

command -v npm >/dev/null 2>&1 || error "npm is not installed."
info "npm $(npm -v)"

command -v git >/dev/null 2>&1 || error "git is not installed."
info "git $(git --version | awk '{print $3}')"

echo ""

# --- Install dependencies ---
echo "Installing dependencies..."
npm install
info "Dependencies installed"

# --- Build ---
echo "Building shared types and packages..."
npm run build
info "Build complete"

echo ""
echo "=== Ready! ==="
echo ""
echo "  Start development:  npm run dev"
echo "  Run tests:          npm run test"
echo "  Type check:         npm run typecheck"
echo ""
echo "  Dev server starts at http://localhost:3000"
echo "  Email verification is instant in dev mode — enter any email."
echo ""

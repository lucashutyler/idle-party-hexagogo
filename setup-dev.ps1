$ErrorActionPreference = "Stop"

function Info($msg) { Write-Host "[OK] $msg" -ForegroundColor Green }
function Err($msg) { Write-Host "[ERROR] $msg" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "=== Idle Party RPG - Dev Setup ==="
Write-Host ""

# --- Validate prerequisites ---
Write-Host "Checking prerequisites..."

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Err "node is not installed. Install Node.js 20+ first." }
$nodeVersion = (node -v) -replace 'v', '' -split '\.' | Select-Object -First 1
if ([int]$nodeVersion -lt 20) { Err "Node.js 20+ is required (found v$(node -v)). Upgrade Node.js first." }
Info "node $(node -v)"

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Err "npm is not installed." }
Info "npm $(npm -v)"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Err "git is not installed." }
Info "git $(git --version)"

Write-Host ""

# --- Install dependencies ---
Write-Host "Installing dependencies..."
npm install
if ($LASTEXITCODE -ne 0) { Err "npm install failed" }
Info "Dependencies installed"

# --- Build ---
Write-Host "Building shared types and packages..."
npm run build
if ($LASTEXITCODE -ne 0) { Err "npm run build failed" }
Info "Build complete"

Write-Host ""
Write-Host "=== Ready! ==="
Write-Host ""
Write-Host "  Start development:  npm run dev"
Write-Host "  Run tests:          npm run test"
Write-Host "  Type check:         npm run typecheck"
Write-Host ""
Write-Host "  Dev server starts at http://localhost:3000"
Write-Host "  Email verification is instant in dev mode - enter any email."
Write-Host ""

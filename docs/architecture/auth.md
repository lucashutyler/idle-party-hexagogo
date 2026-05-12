# Authentication & sessions

## Email-based magic link auth

Auth is handled over REST (`/auth/*`), not WebSocket. Sessions use `express-session` with httpOnly cookies (30-day expiry), persisted to disk via `JsonSessionStore` (survives server restarts/deploys). Account data (email, username, verified status) is stored in `data/accounts.json` via `AccountStore`. Magic link tokens are in-memory with 15-minute expiry (`TokenStore`). Username is changeable later.

**Dev flow**: Enter email → token returned directly → auto-verified → session created on same browser → game.

**Prod flow (approve/poll)**: Enter email → magic link emailed → requesting browser polls `GET /auth/login-status?loginId=...` every 2s. User clicks magic link on any device → `POST /auth/approve` marks login approved (no session on approving device, shows "Sign in approved!"). Requesting browser's next poll detects approval → session created on that response → game. `ApproveScreen` handles the magic link landing; `LoginScreen` manages the polling/waiting UI.

## WebSocket auth via session cookie

WebSocket upgrade requests are authenticated by parsing the session cookie server-side. If no valid session/username, the upgrade is rejected with 401. No login messages are sent over WS — identity comes from the cookie. Deactivated accounts are also rejected at WS upgrade.

## Duplicate detection & device fingerprinting

A persistent `_dt` cookie (UUID, 10-year expiry, httpOnly) is set on every request via middleware. It survives logout (only the session cookie is cleared). On every session creation (verify/login-status), a `SessionRecord` is captured: `{ deviceToken, ip, userAgent, timestamp }`. The last 10 records per account are stored in `accounts.json` via `AccountStore.addSessionRecord()`. The admin dashboard can view session history per account and detect shared device tokens across accounts via `GET /api/admin/duplicate-tokens`.

## Account deactivation

Admins can suspend accounts via `POST /api/admin/players/:username/deactivate`. Deactivation sets `account.deactivated = true`, kicks the player (closes all WS connections with code 4001), and blocks future logins. Deactivation is checked at: `POST /auth/login`, `GET /auth/verify`, `GET /auth/login-status`, `GET /auth/session`, and WS upgrade. Suspended users see a `SuspensionScreen` with a textarea to submit a reactivation appeal (`POST /auth/appeal`, no session required). Appeals are stored as `account.reactivationRequest`. Admins see appeal indicators and can reactivate via `POST /api/admin/players/:username/reactivate`.

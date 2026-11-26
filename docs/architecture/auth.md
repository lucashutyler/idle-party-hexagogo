# Authentication & sessions

## Email sign-in (code or link)

Auth is handled over REST (`/auth/*`), not WebSocket. Sessions use `express-session` with httpOnly cookies (30-day expiry), persisted to disk via `JsonSessionStore` (survives server restarts/deploys). Account data (email, username, verified status) is stored in `data/accounts.json` via `AccountStore`. Pending sign-ins (link token, `loginId`, code) are in-memory with a 15-minute expiry (`TokenStore`), so a restart ends them. A username can't change once chosen: `POST /auth/username` refuses a different name on an account that has one, and re-sending the current name succeeds. `AccountStore.setUsername` refuses reserved names (`server/src/auth/reservedUsernames.ts`), and names that look like game staff (`looksLikeStaffName`): the name is split into words at `_`, `-`, digits and every lower-to-upper case change, lower-cased, and refused when a word, two neighbouring words run together, or the whole name without separators and digits is one of `STAFF_WORDS` (admin, administrator, moderator, mod, gm, gamemaster, staff, system, official, support, server). So `Admin_Bob` and `GameMaster` are refused and `Badminton`, `Modern`, `Systemic` and `Gemma` are not. Both refusals answer 409 "That name is reserved". An account that already holds a staff-like name keeps it and can send it again. An account that already holds a store file's name can't connect until it is renamed by hand with the server stopped, and `AccountStore.load` logs each one at startup. `AccountStore.save` runs one write at a time.

**Dev flow**: Enter email → token returned directly → `GET /auth/verify` → session created on same browser → game. `/auth/verify` answers 404 in production.

**Prod flow (code or same-browser link)**:

1. `POST /auth/login { email }` checks the sign-in email limits (below), creates the account if needed, then `TokenStore.createLogin(email, deviceToken)` makes a pending login holding the email, a 6-digit `code` (`crypto.randomInt`, zero-padded), the asking browser's `_dt` device token (`requesterDevice`), the link `token` and a `codeAttempts` counter. Asking again from the same browser while that login is open (not approved, not expired) reuses it with a fresh 15-minute expiry, so a resend carries the same code and link. The response is `{ mode: 'prod', loginId, sent: true }`; the code only travels in the email.
2. The email (`sendMagicLinkEmail(email, token, code)`) shows the code large, puts it in the subject so phone notifications show it, and has a "Sign in on this browser" button to `/approve?token=...`.
3. The asking browser polls `GET /auth/login-status?loginId=...` every 2s and shows a code field. Either of two things signs it in:
   - **The code.** `POST /auth/login-code { loginId, code }` strips spaces, needs exactly 6 digits, and calls `TokenStore.submitCode`, which compares with `crypto.timingSafeEqual`. A match consumes the login, marks the account verified, checks deactivation and starts the session on that response (`{ status: 'approved', email, username }`). A miss answers `{ status: 'pending', error }`. The fifth miss deletes the login and its link token, and that answer, like any later one, is `{ status: 'expired' }`.
   - **The link, in the same browser.** `ApproveScreen` posts `POST /auth/approve { token }` on load. `TokenStore.approveFromLink(token, deviceToken)` approves the login only when the device token matches `requesterDevice`; the route then marks the account verified and answers `{ success: true }`, and the asking tab's next poll gets the session. From any other browser it approves nothing, answers `{ needsCode: true }` (the page asks for the code on the screen that asked), and the link stays usable until it expires. An unknown or expired token is a 401.

`startSession(req, res, email, account)` in `authRoutes.ts` (regenerate, save, `addSessionRecord`, respond) is shared by `/auth/login-status` and `/auth/login-code`.

**Sign-in limits.** `SlidingWindowLimiter` (`server/src/RateLimiter.ts`, `tryTake(key)`, `allows(key)`, `prune()`) counts takes per key in a rolling window; refused takes don't count. In production `POST /auth/login` needs room under three limits before `AccountStore.createAccount` runs: 3 per 10 minutes per email + `req.ip`, 8 per hour per email, and 100 per 10 minutes per `req.ip`. A sign-in email counts against all three or, when any one is full, none. A refusal is logged and answers `200 { error: 'Too many sign-in emails. ...' }`, which `LoginScreen` shows. `POST /auth/login-code` has its own limit of 100 tries per 10 minutes per `req.ip`. The limiters are pruned on `TokenStore`'s 5-minute cleanup tick (`TokenStore.pruneWithCleanup`). `req.ip` is the address the nearest proxy saw (`trust proxy` is 1 and the nginx template appends `$remote_addr` to `X-Forwarded-For`), so behind a further proxy or CDN it is that edge's address, which many players can share; the per-IP limits are set high for that reason.

**Login screen.** `LoginScreen` is a real form with a labelled email field and an "Email me a sign-in code" button; errors are `role=alert`. After sending it shows "Check your email" with the address, a labelled code field (`inputmode=numeric`, `autocomplete=one-time-code`), a Sign in button, a resend button and "Use a different email". The form's submit goes to the code while the code field is up. `EmailSignIn` (`client/src/network/EmailSignIn.ts`) holds the current `loginId`, runs the poll and posts the code with it, and treats a code result like a poll result: approved enters the game (`App.enterAfterSignIn`), expired returns to the form, suspended opens the suspension screen, and a refused code shows in the alert line (`showCodeError`). Answers for a `loginId` it has left are dropped. While a code is being checked, a poll answering `expired` is ignored: a right code ends the login on the server before the code's own answer (which waits on the account and session writes) arrives. Resend posts `/auth/login` again for the same address and restarts the poll; "Use a different email" stops polling and returns to the form. An expired sign-in returns to the form with a message.

## WebSocket auth via session cookie

WebSocket upgrade requests are authenticated by parsing the session cookie server-side. If no valid session/username, the upgrade is rejected with 401. No login messages are sent over WS — identity comes from the cookie. Deactivated accounts are also rejected at WS upgrade.

## Duplicate detection & device fingerprinting

A persistent `_dt` cookie (UUID, 10-year expiry, httpOnly) is set on every request via middleware. It survives logout (only the session cookie is cleared). On every session creation (verify, login-status, login-code), a `SessionRecord` is captured: `{ deviceToken, ip, userAgent, timestamp }`. The last 10 records per account are stored in `accounts.json` via `AccountStore.addSessionRecord()`. The admin dashboard can view session history per account and detect shared device tokens across accounts via `GET /api/admin/duplicate-tokens`.

## Invite-only beta gate

Setting `INVITE_ONLY=true` restricts `POST /auth/login` to an allow list: anyone with an admin role (see below) is always allowed, plus any email added to the admin-managed invite list. The check runs before `AccountStore.createAccount()`, so a rejected email never gets an account record created. Rejection returns `200 { error: '...' }` (no `inviteOnly` flag — mirrors the existing generic-error path in `LoginScreen`/`App.handleEmailLogin`, no dedicated screen needed since the rejection only ever happens pre-session). When `INVITE_ONLY` is unset or `false` (the default), login is unrestricted as before.

The invite list itself is persisted via `InviteListStore` (`server/src/auth/InviteListStore.ts`, `data/invite-list.json`) and managed from the admin dashboard's **Invite List** tab (only shown in the sidebar when `INVITE_ONLY=true` — see `docs/architecture/admin-dashboard.md`) via `GET/POST /api/admin/invite-list` and `DELETE /api/admin/invite-list/:email`. The gate calls `grantedAdminRole()`, so promoting someone in the dashboard also lets them sign in. It deliberately uses the *granted* role rather than the effective one, so a suspended admin falls through to the deactivated branch below and gets the appeal flow instead of a generic "invite-only" rejection.

## Admin roles

Two levels, defined in `server/src/auth/AdminRoles.ts`:

| Role | Can do |
|------|--------|
| `admin` | Every admin action — the whole World Manager, `/api/admin/*`, and the MCP content tools |
| `superadmin` | All of the above, **plus** granting and clearing other accounts' roles |

Where a role comes from:

- **`ADMIN_EMAILS`** (comma-separated env var) — every listed email is automatically a **super admin**, whether or not an account record exists yet. This is the bootstrap set: it can't be edited from the dashboard, so there is always a way back in. Parsed per request by the shared `parseEmailListEnv()` helper (`server/src/auth/EmailListParser.ts`), so editing the env var takes effect without a code change.
- **Granted in the dashboard** — a super admin sets any other account to Admin or Super Admin from the Accounts tab's detail modal (`PUT /api/admin/accounts/:email/role`). The grant is persisted as `Account.role` in `data/accounts.json`.

Two resolvers, and the distinction matters:

- `resolveAdminRole(email, accountStore)` — the role you may **act with right now**. Used by every *authorization* gate (`createAdminAuth`, and through it the MCP endpoint). A suspended account resolves to `null`, so deactivating an admin immediately strips their privileges (an `ADMIN_EMAILS` super admin is exempt).
- `grantedAdminRole(email, accountStore)` — the role **on record**, ignoring suspension. Used where suspension is handled separately or shouldn't apply: rendering the dashboard's role editor (so a suspended admin still displays as an admin, and reactivating restores it) and the invite-only login gate above.

Guards on `PUT /api/admin/accounts/:email/role`: super admin only, browser session only (never an API token), and it rejects both `ADMIN_EMAILS` accounts (`400` — change the env var instead) and changing your own role (`400`, so you can't accidentally lock yourself out).

## API tokens

Bearer credentials an admin generates for themselves, used by the MCP content-authoring server (`docs/architecture/mcp.md`) and by `/api/admin/*` for scripting. They replaced the old `MCP_TOKENS` env var entirely.

`ApiTokenStore` (`server/src/auth/ApiTokenStore.ts`, `data/api-tokens.json`) holds one record per token: `{ id, email, label, tokenHash, prefix, createdAt, expiresAt, lastUsedAt }`.

- The secret is `ipr_` + 32 random bytes as hex. It is **returned exactly once**, in the creation response, and stored only as a sha256 hash — `prefix` keeps the first 8 characters in the clear purely so a row is identifiable in the UI.
- **Scoped to the owner.** `GET`/`POST /api/admin/api-tokens` and `DELETE /api/admin/api-tokens/:id` always operate on the caller's own tokens; revoke is filtered by owner email, so another admin's token id resolves as `404` rather than deleting anything.
- **Session-only management.** All three routes sit behind `requireSession`, so a leaked token can't mint itself a longer-lived replacement or promote its owner.
- **Tokens carry no permissions.** Authorization is re-derived from the owner's role on every single request, so a token belonging to someone who was demoted or suspended is inert — there is deliberately no cleanup pass on role removal, and nothing to forget to run.
- Optional expiry (`YYYY-MM-DD` from the dashboard's date picker means "through the end of that day"; a full ISO timestamp also works). An unparseable `expiresAt` counts as expired, so a corrupt record fails closed.
- `lastUsedAt` is stamped in memory on each authenticated request and flushed to disk on a 60-second timer rather than writing the file per request. `startFlush()`/`stopFlush()` are wired in `server/src/index.ts` next to `TokenStore`; `stopFlush()` is awaited on shutdown and persists whatever the last tick missed.

## Unified admin auth

`createAdminAuth({ accountStore, apiTokenStore })` (`server/src/admin/adminMiddleware.ts`) resolves either credential into one `AdminPrincipal` — `{ email, role, via: 'session' | 'token', label, tokenId? }` — attached to `req.adminPrincipal`. A bearer token, when present, always wins over a session cookie. It exports four things:

- `requireAdmin` — applied router-wide to `/api/admin/*` and to the `/api-docs/admin` Swagger UI. 401 unauthenticated / invalid or expired token, 403 authenticated-but-not-an-admin.
- `requireSuperAdmin` — the extra check on role granting.
- `requireSession` — rejects API-token callers on token and role management.
- `resolvePrincipal` — the raw resolver, reused by the MCP endpoint so it can apply its own bearer-token-only rule first.

## Account deactivation

Admins can suspend accounts via `POST /api/admin/players/:username/deactivate`. Deactivation sets `account.deactivated = true`, kicks the player (closes all WS connections with code 4001), and blocks future logins. Deactivation is checked at: `POST /auth/login`, `GET /auth/verify`, `GET /auth/login-status`, `POST /auth/login-code`, `GET /auth/session`, and WS upgrade. Suspended users see a `SuspensionScreen` with a textarea to submit a reactivation appeal (`POST /auth/appeal`, no session required). Appeals are stored as `account.reactivationRequest`. Admins see appeal indicators and can reactivate via `POST /api/admin/players/:username/reactivate`.

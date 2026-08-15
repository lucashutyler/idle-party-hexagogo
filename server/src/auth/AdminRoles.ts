import type { AccountStore } from './AccountStore.js';
import { parseEmailListEnv } from './EmailListParser.js';

/**
 * Admin privilege levels. `admin` may perform admin actions; `superadmin` may additionally
 * grant/revoke roles. Anyone without a role has no admin access at all.
 */
export type AdminRole = 'admin' | 'superadmin';

export const ADMIN_ROLES: readonly AdminRole[] = ['admin', 'superadmin'];

export function isAdminRole(value: unknown): value is AdminRole {
  return value === 'admin' || value === 'superadmin';
}

/**
 * Emails listed in ADMIN_EMAILS are automatically super admins. This is the bootstrap set —
 * it can't be edited from the dashboard, so there is always a way back in.
 */
export function isEnvSuperAdmin(email: string | undefined | null): boolean {
  if (!email) return false;
  return parseEmailListEnv(process.env.ADMIN_EMAILS).has(email.trim().toLowerCase());
}

/**
 * The role stored against an account, ignoring whether it's currently usable. This is what the
 * dashboard edits — use `resolveAdminRole` for authorization decisions.
 */
export function grantedAdminRole(email: string | undefined | null, accountStore: AccountStore): AdminRole | null {
  if (!email) return null;
  if (isEnvSuperAdmin(email)) return 'superadmin';
  return accountStore.findByEmail(email)?.role ?? null;
}

/**
 * The role an email may actually act with right now: ADMIN_EMAILS wins outright, otherwise the
 * granted role — but a suspended account loses its privileges until reactivated. Returns null
 * for everyone else. Every gate (session, API token, MCP) resolves through here, so demoting or
 * suspending someone takes effect on their very next request without touching their tokens.
 */
export function resolveAdminRole(email: string | undefined | null, accountStore: AccountStore): AdminRole | null {
  if (!email) return null;
  if (isEnvSuperAdmin(email)) return 'superadmin';
  const account = accountStore.findByEmail(email);
  if (!account || account.deactivated) return null;
  return account.role ?? null;
}

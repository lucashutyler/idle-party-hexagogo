const API_BASE = '/auth';

export interface SessionInfo {
  authenticated: boolean;
  email?: string;
  username?: string | null;
}

export interface LoginResult {
  mode: 'dev' | 'prod';
  token?: string;
  sent?: boolean;
  error?: string;
}

export interface UsernameResult {
  success?: boolean;
  username?: string;
  oldUsername?: string | null;
  error?: string;
}

async function jsonFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: 'include',
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
  return res.json() as Promise<T>;
}

export async function getSession(): Promise<SessionInfo> {
  return jsonFetch<SessionInfo>(`${API_BASE}/session`);
}

export async function loginWithEmail(email: string): Promise<LoginResult> {
  return jsonFetch<LoginResult>(`${API_BASE}/login`, {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

export interface VerifyResult {
  success?: boolean;
  email?: string;
  username?: string | null;
  error?: string;
}

export async function verifyToken(token: string): Promise<VerifyResult> {
  return jsonFetch<VerifyResult>(`${API_BASE}/verify?token=${encodeURIComponent(token)}`, {
    method: 'GET',
  });
}

export async function setUsername(username: string): Promise<UsernameResult> {
  return jsonFetch<UsernameResult>(`${API_BASE}/username`, {
    method: 'POST',
    body: JSON.stringify({ username }),
  });
}

export async function logout(): Promise<void> {
  await jsonFetch(`${API_BASE}/logout`, { method: 'POST' });
}

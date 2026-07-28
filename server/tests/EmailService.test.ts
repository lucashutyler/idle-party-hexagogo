import { describe, it, expect, afterEach, vi } from 'vitest';

// `isProd` inside EmailService.ts is captured once at module load, so each case needs a fresh
// module instance (vi.resetModules) after stubbing NODE_ENV, not just a re-assigned env var.
describe('isEmailConfigured', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is always true in dev — email delivery falls back to console logging', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.resetModules();
    const { isEmailConfigured } = await import('../src/auth/EmailService.js');
    expect(isEmailConfigured()).toBe(true);
  });

  it('is false in production when SES env vars are missing', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SES_FROM_EMAIL', '');
    vi.stubEnv('AWS_ACCESS_KEY_ID', '');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', '');
    vi.resetModules();
    const { isEmailConfigured } = await import('../src/auth/EmailService.js');
    expect(isEmailConfigured()).toBe(false);
  });

  it('is true in production once all three SES env vars are set', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SES_FROM_EMAIL', 'noreply@example.com');
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'key');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'secret');
    vi.resetModules();
    const { isEmailConfigured } = await import('../src/auth/EmailService.js');
    expect(isEmailConfigured()).toBe(true);
  });
});

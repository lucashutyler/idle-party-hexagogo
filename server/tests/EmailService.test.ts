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

describe('buildNotificationEmail', () => {
  const APP_URL = 'https://game.example.test';

  it('escapes markup and quotes in the HTML part', async () => {
    const { buildNotificationEmail } = await import('../src/auth/EmailService.js');
    const email = buildNotificationEmail(
      'Message from "eve"',
      'Hi <a href="https://bad.example.test">click</a> it\'s & more',
      APP_URL,
    );

    expect(email.html).not.toContain('<a href="https://bad.example.test">');
    expect(email.html).toContain('&lt;a href=&quot;https://bad.example.test&quot;&gt;click&lt;/a&gt;');
    expect(email.html).toContain('it&#39;s &amp; more');
    expect(email.html).toContain('<h2>Message from &quot;eve&quot;</h2>');
    expect(email.html).toContain(`href="${APP_URL}"`);
  });

  it('leaves the subject and text part plain', async () => {
    const { buildNotificationEmail } = await import('../src/auth/EmailService.js');
    const body = 'Hi <a href="x">click</a> it\'s & more';
    const email = buildNotificationEmail('Message from "eve"', body, APP_URL);

    expect(email.subject).toBe('Idle Party RPG — Message from "eve"');
    expect(email.text).toBe(`Message from "eve"\n\n${body}\n\n${APP_URL}`);
  });
});

describe('buildMagicLinkEmail', () => {
  it('shows the code in the subject and body and links to the approve page', async () => {
    const { buildMagicLinkEmail } = await import('../src/auth/EmailService.js');
    const email = buildMagicLinkEmail('abc123', '042917', 'https://game.example.test');

    expect(email.subject).toContain('042917');
    expect(email.html).toContain('042917');
    expect(email.html).toContain('href="https://game.example.test/approve?token=abc123"');
    expect(email.html).toContain('Sign in on this browser');
    expect(email.html).toContain('Nobody can sign in with this email unless they also have the code');
    expect(email.text).toContain('042917');
    expect(email.text).toContain('https://game.example.test/approve?token=abc123');
  });
});

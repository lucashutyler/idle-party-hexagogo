import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

const isProd = process.env.NODE_ENV === 'production';

let sesClient: SESClient | null = null;

function getSesClient(): SESClient {
  if (!sesClient) {
    sesClient = new SESClient({
      region: process.env.AWS_REGION ?? 'us-east-1',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      },
    });
  }
  return sesClient;
}

/** Whether email can actually be delivered right now. Dev mode always "sends" (console log), so this only bites in production. */
export function isEmailConfigured(): boolean {
  if (!isProd) return true;
  return Boolean(process.env.SES_FROM_EMAIL && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
}

/** Shared SES send — dev mode logs instead of sending. */
async function sendSesEmail(to: string, subject: string, html: string, text: string, devLogLabel: string): Promise<void> {
  if (!isProd) {
    console.log(`[EmailService] DEV MODE — ${devLogLabel} for ${to}:`);
    console.log(`  ${text}`);
    return;
  }

  const fromEmail = process.env.SES_FROM_EMAIL;
  if (!fromEmail) {
    throw new Error('SES_FROM_EMAIL not configured');
  }

  const client = getSesClient();
  await client.send(new SendEmailCommand({
    Source: fromEmail,
    Destination: { ToAddresses: [to] },
    Message: {
      Subject: { Data: subject },
      Body: {
        Html: { Data: html },
        Text: { Data: text },
      },
    },
  }));
}

export interface BuiltEmail {
  subject: string;
  html: string;
  text: string;
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  '\'': '&#39;',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
}

function appUrl(): string {
  return process.env.APP_URL ?? 'http://localhost:3000';
}

export function buildMagicLinkEmail(token: string, code: string, baseUrl: string): BuiltEmail {
  const approveUrl = `${baseUrl}/approve?token=${encodeURIComponent(token)}`;
  const safeCode = escapeHtml(code);

  return {
    subject: `${code} is your Idle Party RPG sign-in code`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2>Sign in to Idle Party RPG</h2>
        <p>Type this code on the screen where you asked to sign in:</p>
        <p style="margin: 16px 0; font-family: monospace; font-size: 36px; font-weight: bold; letter-spacing: 8px;">${safeCode}</p>
        <p>Reading this on the browser where you asked? Use the button instead. Both expire in 15 minutes.</p>
        <a href="${escapeHtml(approveUrl)}" style="display: inline-block; padding: 12px 24px; background: #d4a017; color: #1a0a2e; text-decoration: none; border-radius: 4px; font-weight: bold;">
          Sign in on this browser
        </a>
        <p style="margin-top: 24px; font-size: 12px; color: #888;">
          Nobody can sign in with this email unless they also have the code, so never share it.
          If you didn't ask to sign in, you can safely ignore this email.
        </p>
      </div>
    `,
    text: [
      'Sign in to Idle Party RPG',
      '',
      `Your sign-in code: ${code}`,
      '',
      'Type it on the screen where you asked to sign in. Reading this on the browser where you asked? Open this link instead:',
      approveUrl,
      '',
      'Both expire in 15 minutes. Nobody can sign in with this email unless they also have the code, so never share it. If you didn\'t ask to sign in, you can safely ignore this email.',
    ].join('\n'),
  };
}

export async function sendMagicLinkEmail(email: string, token: string, code: string): Promise<void> {
  const { subject, html, text } = buildMagicLinkEmail(token, code, appUrl());
  await sendSesEmail(email, subject, html, text, 'magic link');
  console.log(`[EmailService] Magic link sent to ${email}`);
}

/** Title and body are escaped in the HTML part only; the subject and text part stay plain. */
export function buildNotificationEmail(title: string, body: string, baseUrl: string): BuiltEmail {
  return {
    subject: `Idle Party RPG — ${title}`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(body)}</p>
        <a href="${escapeHtml(baseUrl)}" style="display: inline-block; margin-top: 16px; padding: 12px 24px; background: #d4a017; color: #1a0a2e; text-decoration: none; border-radius: 4px; font-weight: bold;">
          Open Idle Party RPG
        </a>
        <p style="margin-top: 24px; font-size: 12px; color: #888;">
          You're receiving this because you enabled email notifications for this event. Manage this in Settings → Notifications.
        </p>
      </div>
    `,
    text: `${title}\n\n${body}\n\n${baseUrl}`,
  };
}

/** Generic notification email — used by the notification framework's email channel driver. */
export async function sendNotificationEmail(email: string, title: string, body: string): Promise<void> {
  const { subject, html, text } = buildNotificationEmail(title, body, appUrl());
  await sendSesEmail(email, subject, html, text, 'notification email');
}

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

export async function sendMagicLinkEmail(email: string, token: string): Promise<void> {
  const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
  const approveUrl = `${appUrl}/approve?token=${token}`;

  await sendSesEmail(
    email,
    'Idle Party RPG — Sign In',
    `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2>Sign in to Idle Party RPG</h2>
        <p>Click the button below to sign in. This link expires in 15 minutes.</p>
        <a href="${approveUrl}" style="display: inline-block; padding: 12px 24px; background: #d4a017; color: #1a0a2e; text-decoration: none; border-radius: 4px; font-weight: bold;">
          Sign In
        </a>
        <p style="margin-top: 24px; font-size: 12px; color: #888;">
          If you didn't request this, you can safely ignore this email.
        </p>
      </div>
    `,
    `Sign in to Idle Party RPG:\n\n${approveUrl}\n\nThis link expires in 15 minutes. If you didn't request this, you can safely ignore this email.`,
    'magic link',
  );

  console.log(`[EmailService] Magic link sent to ${email}`);
}

/** Generic notification email — used by the notification framework's email channel driver. */
export async function sendNotificationEmail(email: string, title: string, body: string): Promise<void> {
  const appUrl = process.env.APP_URL ?? 'http://localhost:3000';

  await sendSesEmail(
    email,
    `Idle Party RPG — ${title}`,
    `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2>${title}</h2>
        <p>${body}</p>
        <a href="${appUrl}" style="display: inline-block; margin-top: 16px; padding: 12px 24px; background: #d4a017; color: #1a0a2e; text-decoration: none; border-radius: 4px; font-weight: bold;">
          Open Idle Party RPG
        </a>
        <p style="margin-top: 24px; font-size: 12px; color: #888;">
          You're receiving this because you enabled email notifications for this event. Manage this in Settings → Notifications.
        </p>
      </div>
    `,
    `${title}\n\n${body}\n\n${appUrl}`,
    'notification email',
  );
}

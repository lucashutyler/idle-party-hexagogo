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

export async function sendMagicLinkEmail(email: string, token: string): Promise<void> {
  const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
  const verifyUrl = `${appUrl}/verify?token=${token}`;

  if (!isProd) {
    console.log(`[EmailService] DEV MODE — magic link for ${email}:`);
    console.log(`  ${verifyUrl}`);
    return;
  }

  const fromEmail = process.env.SES_FROM_EMAIL;
  if (!fromEmail) {
    throw new Error('SES_FROM_EMAIL not configured');
  }

  const client = getSesClient();
  await client.send(new SendEmailCommand({
    Source: fromEmail,
    Destination: { ToAddresses: [email] },
    Message: {
      Subject: { Data: 'Idle Party RPG — Sign In' },
      Body: {
        Html: {
          Data: `
            <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
              <h2>Sign in to Idle Party RPG</h2>
              <p>Click the button below to sign in. This link expires in 15 minutes.</p>
              <a href="${verifyUrl}" style="display: inline-block; padding: 12px 24px; background: #d4a017; color: #1a0a2e; text-decoration: none; border-radius: 4px; font-weight: bold;">
                Sign In
              </a>
              <p style="margin-top: 24px; font-size: 12px; color: #888;">
                If you didn't request this, you can safely ignore this email.
              </p>
            </div>
          `,
        },
        Text: {
          Data: `Sign in to Idle Party RPG:\n\n${verifyUrl}\n\nThis link expires in 15 minutes. If you didn't request this, you can safely ignore this email.`,
        },
      },
    },
  }));

  console.log(`[EmailService] Magic link sent to ${email}`);
}

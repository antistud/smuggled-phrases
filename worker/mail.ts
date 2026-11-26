/** Sends the sign-in email. Uses the Resend HTTP API when a key is configured. */
export interface MailEnv {
  /** Secret: API key for the email provider. */
  RESEND_API_KEY?: string;
  /** e.g. "Smuggled Phrases <login@yourdomain.com>" (the domain must be verified with the provider). */
  MAIL_FROM?: string;
  /** "true" only for local development: sign-in links are returned to the app instead of emailed. */
  DEV_MAGIC_LINKS?: string;
}

export type MailResult = { sent: true } | { sent: false; dev: { link: string; code: string } } | { sent: false; error: 'email-not-configured' | 'email-failed' };

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export async function sendLoginEmail(env: MailEnv, to: string, link: string, code: string): Promise<MailResult> {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) {
    if (env.DEV_MAGIC_LINKS === 'true') return { sent: false, dev: { link, code } };
    return { sent: false, error: 'email-not-configured' };
  }
  const text = [
    'Psst. Here is your way into Smuggled Phrases.',
    '',
    `Tap to sign in: ${link}`,
    '',
    `Or type this code into the app: ${code}`,
    '',
    'Both expire in 15 minutes and work once. If you did not ask for this, ignore it.',
  ].join('\n');
  const html = `<div style="font-family:Georgia,serif;max-width:440px;margin:0 auto;padding:24px;background:#e4d5b1;color:#1d1a16">
  <h1 style="font-size:22px;letter-spacing:2px;text-transform:uppercase;margin:0 0 12px">Smuggled Phrases</h1>
  <p>Psst. Here is your way in.</p>
  <p><a href="${escapeHtml(link)}" style="display:inline-block;padding:14px 22px;background:#c2331f;color:#fff;text-decoration:none;font-weight:bold;letter-spacing:1px">SIGN IN</a></p>
  <p>Or type this code into the app:</p>
  <p style="font-size:32px;letter-spacing:8px;font-family:monospace;margin:8px 0"><strong>${code}</strong></p>
  <p style="font-size:13px;color:#5a4a2a">Both expire in 15 minutes and work once. If you did not ask for this, ignore it.</p>
</div>`;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject: `${code} is your Smuggled Phrases sign-in code`, text, html }),
    });
    return res.ok ? { sent: true } : { sent: false, error: 'email-failed' };
  } catch {
    return { sent: false, error: 'email-failed' };
  }
}

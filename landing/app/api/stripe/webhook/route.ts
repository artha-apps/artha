/**
 * POST /api/stripe/webhook
 *
 * Stripe sends signed events to this endpoint. On a successful payment
 * (checkout.session.completed) we:
 *   1. Verify the Stripe signature.
 *   2. Resolve the customer's email from the session.
 *   3. Generate a signed Artha Pro license key.
 *   4. Email the key to the customer via Resend.
 *
 * Required env vars:
 *   STRIPE_SECRET_KEY         — Stripe secret key
 *   STRIPE_WEBHOOK_SECRET     — Signing secret from the Stripe webhook dashboard
 *   ARTHA_LICENSE_PRIVATE_KEY — Ed25519 private key PEM (single line with \n escapes, or multiline)
 *   RESEND_API_KEY            — Resend API key
 *   RESEND_FROM_EMAIL         — Verified Resend sender (e.g. noreply@artha.space)
 *
 * Set up the webhook in Stripe Dashboard:
 *   Developers → Webhooks → Add endpoint
 *   URL: https://artha.space/api/stripe/webhook   (or the preview URL while testing)
 *   Events: checkout.session.completed
 */

import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { Resend } from 'resend';
import { generateLicenseKey } from '../../../../lib/license-gen';

// Stripe needs the raw request body to verify the signature — Node runtime only.
export const runtime = 'nodejs';

/** Resolve the best email address from a completed checkout session. */
function resolveEmail(session: Stripe.Checkout.Session): string | null {
  if (session.customer_details?.email) return session.customer_details.email;
  if (session.metadata?.customer_email) return session.metadata.customer_email;
  if (session.customer_email) return session.customer_email;
  return null;
}

/** HTML email body sent to the customer. */
function licenseEmailHtml(key: string, email: string): string {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /></head>
<body style="font-family:system-ui,sans-serif;background:#fafaf7;color:#0a1628;padding:40px 20px;margin:0">
  <div style="max-width:560px;margin:0 auto">
    <h1 style="font-size:26px;font-weight:600;color:#0035ed;margin:0 0 8px">
      Welcome to Artha Pro
    </h1>
    <p style="color:#5b6577;margin:0 0 32px">
      Thanks for your purchase. Your license key is below — paste it into
      <strong style="color:#0a1628">Artha → Settings → License</strong>.
    </p>

    <div style="background:#fff;border:1px solid #e8e4da;border-radius:8px;padding:20px 24px;margin-bottom:32px">
      <p style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#0035ed;margin:0 0 8px">
        Your license key
      </p>
      <code style="font-family:ui-monospace,Menlo,monospace;font-size:13px;word-break:break-all;color:#0a1628;line-height:1.6">
        ${key}
      </code>
    </div>

    <p style="color:#5b6577;font-size:14px;margin:0 0 8px">
      This key activates <strong style="color:#0a1628">Artha Pro</strong> for
      <strong style="color:#0a1628">${email}</strong>. Keep it somewhere safe — we can
      re-send it if you lose it; just email
      <a href="mailto:support@artha.space" style="color:#0035ed">support@artha.space</a>.
    </p>
    <p style="color:#5b6577;font-size:14px;margin:0 0 32px">
      Your key is perpetual — it never expires and isn't tied to a subscription.
    </p>

    <hr style="border:none;border-top:1px solid #e8e4da;margin:0 0 24px" />
    <p style="color:#8a93a3;font-size:12px;margin:0">
      Artha · <a href="https://artha.space" style="color:#8a93a3">artha.space</a>
    </p>
  </div>
</body>
</html>
  `.trim();
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secretKey || !webhookSecret) {
    console.error('[stripe/webhook] missing STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET');
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 503 });
  }

  const stripe = new Stripe(secretKey);
  const rawBody = await req.text();
  const sig = req.headers.get('stripe-signature') ?? '';

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Webhook signature verification failed';
    console.error('[stripe/webhook] signature error:', msg);
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  // Acknowledge events we don't handle — Stripe retries otherwise.
  if (event.type !== 'checkout.session.completed') {
    return NextResponse.json({ received: true });
  }

  const session = event.data.object as Stripe.Checkout.Session;
  if (session.payment_status !== 'paid') {
    return NextResponse.json({ received: true });
  }

  const email = resolveEmail(session);
  if (!email) {
    console.error('[stripe/webhook] no email on session', session.id);
    return NextResponse.json({ error: 'No customer email found' }, { status: 422 });
  }

  let licenseKey: string;
  try {
    licenseKey = generateLicenseKey(email, 'pro', 1);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Key generation failed';
    console.error('[stripe/webhook] key generation error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  const resendApiKey = process.env.RESEND_API_KEY;
  if (resendApiKey) {
    try {
      const resend = new Resend(resendApiKey);
      const fromEmail = process.env.RESEND_FROM_EMAIL ?? 'noreply@artha.space';
      const { error } = await resend.emails.send({
        from: `Artha <${fromEmail}>`,
        to: [email],
        subject: 'Your Artha Pro license key',
        html: licenseEmailHtml(licenseKey, email),
      });
      // Don't 500 on email failure — Stripe would retry and re-issue keys.
      // Log and continue; manual recovery via support email.
      if (error) console.error('[stripe/webhook] Resend error:', error);
    } catch (err) {
      console.error('[stripe/webhook] email send threw:', err);
    }
  } else {
    // No email provider configured — log the key so it can be recovered/sent manually.
    console.warn('[stripe/webhook] RESEND_API_KEY not set; key for', email, ':', licenseKey);
  }

  console.info('[stripe/webhook] Pro key issued for', email, 'session', session.id);
  return NextResponse.json({ received: true });
}

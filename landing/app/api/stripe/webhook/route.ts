/**
 * POST /api/stripe/webhook
 *
 * Zero-database license fulfilment — Stripe is the customer store. Handled
 * events (register all three in the Stripe dashboard):
 *
 *   invoice.paid                    — THE minting event for every subscription
 *                                     plan (first purchase, annual/6-month
 *                                     renewals, AND mid-cycle seat changes via
 *                                     proration invoices). Branches on the
 *                                     PRICE id found in the invoice lines —
 *                                     never on event type or metadata.
 *   checkout.session.completed      — legacy one-time (payment-mode) purchases
 *                                     only: mints the grandfathered perpetual
 *                                     Personal key. Subscription-mode sessions
 *                                     are acked here and minted by their first
 *                                     invoice.paid.
 *   customer.subscription.deleted   — courtesy "won't renew" email. No key
 *                                     action: the key lapses at its exp
 *                                     (period end + 7-day grace) on its own.
 *
 * Idempotency: deliberately none. Re-processing an event re-mints an
 * equivalent key (same tier/seats/expiry — both keys verify until exp), so a
 * Stripe retry costs at most a duplicate email. This preserves the zero-DB
 * property; add event-id dedupe (e.g. Vercel KV) only if duplicate emails
 * ever become a support burden.
 *
 * Required env vars:
 *   STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET
 *   STRIPE_PRICE_ID_PERSONAL_ANNUAL / STRIPE_PRICE_ID_PERSONAL_6MO
 *   STRIPE_PRICE_ID_TEAM / STRIPE_PRICE_ID_BUSINESS
 *   ARTHA_LICENSE_PRIVATE_KEY — Ed25519 private key PEM
 *   RESEND_API_KEY / RESEND_FROM_EMAIL — key delivery
 */

import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { Resend } from 'resend';
import { generateLicenseKey, type Tier } from '../../../../lib/license-gen';

// Stripe needs the raw request body to verify the signature — Node runtime only.
export const runtime = 'nodejs';

/** Oldest app release that accepts 'team' wire-tier keys. Surfaced in the
 *  team/business email so buyers on older builds know to update first. */
const MIN_APP_VERSION_FOR_TEAM = '0.2.0';

const GRACE_SECONDS = 7 * 86_400; // renewal grace before the key lapses

interface PlanSpec {
  tier: Tier;
  label: string;
  /** Seats come from the invoice line quantity when true; else always 1. */
  perSeat: boolean;
}

/** Subscription price id → what to mint. Computed per-request because env
 *  vars are the routing table. */
function planByPrice(): Map<string, PlanSpec> {
  const m = new Map<string, PlanSpec>();
  const add = (envVar: string, spec: PlanSpec) => {
    const id = process.env[envVar];
    if (id) m.set(id, spec);
  };
  add('STRIPE_PRICE_ID_PERSONAL_ANNUAL', { tier: 'pro', label: 'Personal (annual)', perSeat: false });
  add('STRIPE_PRICE_ID_PERSONAL_6MO', { tier: 'pro', label: 'Personal (6-month)', perSeat: false });
  add('STRIPE_PRICE_ID_TEAM', { tier: 'team', label: 'Team', perSeat: true });
  add('STRIPE_PRICE_ID_BUSINESS', { tier: 'enterprise', label: 'Business', perSeat: true });
  return m;
}

/** Resolve the best email address from a completed checkout session. */
function resolveSessionEmail(session: Stripe.Checkout.Session): string | null {
  if (session.customer_details?.email) return session.customer_details.email;
  if (session.metadata?.customer_email) return session.metadata.customer_email;
  if (session.customer_email) return session.customer_email;
  return null;
}

/** Best-effort email delivery. Never throws and never 500s the webhook —
 *  Stripe would retry and re-issue keys; manual recovery goes via support. */
async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  const resendApiKey = process.env.RESEND_API_KEY;
  if (!resendApiKey) {
    console.warn('[stripe/webhook] RESEND_API_KEY not set; email for', to, 'suppressed — subject:', subject);
    return;
  }
  try {
    const resend = new Resend(resendApiKey);
    const fromEmail = process.env.RESEND_FROM_EMAIL ?? 'noreply@artha.space';
    const { error } = await resend.emails.send({ from: `Artha <${fromEmail}>`, to: [to], subject, html });
    if (error) console.error('[stripe/webhook] Resend error:', error);
  } catch (err) {
    console.error('[stripe/webhook] email send threw:', err);
  }
}

/** Shared email chrome. */
function emailShell(title: string, inner: string): string {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /></head>
<body style="font-family:system-ui,sans-serif;background:#fafaf7;color:#0a1628;padding:40px 20px;margin:0">
  <div style="max-width:560px;margin:0 auto">
    <h1 style="font-size:26px;font-weight:600;color:#0035ed;margin:0 0 8px">${title}</h1>
    ${inner}
    <hr style="border:none;border-top:1px solid #e8e4da;margin:32px 0 24px" />
    <p style="color:#8a93a3;font-size:12px;margin:0">
      Artha · <a href="https://artha.space" style="color:#8a93a3">artha.space</a>
    </p>
  </div>
</body>
</html>
  `.trim();
}

function keyBlock(key: string): string {
  return `
    <div style="background:#fff;border:1px solid #e8e4da;border-radius:8px;padding:20px 24px;margin:24px 0">
      <p style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#0035ed;margin:0 0 8px">Your license key</p>
      <code style="font-family:ui-monospace,Menlo,monospace;font-size:13px;word-break:break-all;color:#0a1628;line-height:1.6">${key}</code>
    </div>`;
}

function personalEmailHtml(key: string, email: string, renewsAt: Date): string {
  return emailShell('Welcome to Artha Personal', `
    <p style="color:#5b6577;margin:0 0 8px">
      Thanks for subscribing. Paste the key below into
      <strong style="color:#0a1628">Artha → Settings → License</strong>.
    </p>
    ${keyBlock(key)}
    <p style="color:#5b6577;font-size:14px;margin:0 0 8px">
      This key activates <strong style="color:#0a1628">Artha Personal</strong> for
      <strong style="color:#0a1628">${email}</strong> — unlimited documents, scheduler,
      context packs, starter templates, and priority support.
    </p>
    <p style="color:#5b6577;font-size:14px;margin:0">
      Your plan renews on <strong style="color:#0a1628">${renewsAt.toISOString().slice(0, 10)}</strong>;
      we'll email a fresh key on each renewal. Lost a key? Email
      <a href="mailto:support@artha.space" style="color:#0035ed">support@artha.space</a>.
    </p>`);
}

function teamEmailHtml(key: string, label: string, seats: number, renewsAt: Date): string {
  return emailShell(`Your Artha ${label} license`, `
    <p style="color:#5b6577;margin:0 0 8px">
      Thanks for your purchase — <strong style="color:#0a1628">${seats} seats</strong>.
      Paste the key below into <strong style="color:#0a1628">Settings → License on the
      HUB machine</strong> (the computer that runs the team server), then provision
      teammates in Settings → Team.
    </p>
    ${keyBlock(key)}
    <p style="color:#5b6577;font-size:14px;margin:0 0 8px">
      Requires Artha <strong style="color:#0a1628">v${MIN_APP_VERSION_FOR_TEAM}+</strong>.
      Setup guide: <a href="https://github.com/artha-apps/artha/blob/main/docs/deploy/org-hub.md" style="color:#0035ed">org-hub runbook</a>.
    </p>
    <p style="color:#5b6577;font-size:14px;margin:0">
      Renews on <strong style="color:#0a1628">${renewsAt.toISOString().slice(0, 10)}</strong>
      (the key includes a 7-day grace window); a fresh key is emailed on each renewal
      and whenever you change seat count. Support:
      <a href="mailto:support@artha.space" style="color:#0035ed">support@artha.space</a>.
    </p>`);
}

function legacyPerpetualEmailHtml(key: string, email: string): string {
  return emailShell('Welcome to Artha', `
    <p style="color:#5b6577;margin:0 0 8px">
      Thanks for your purchase. Paste the key below into
      <strong style="color:#0a1628">Artha → Settings → License</strong>.
    </p>
    ${keyBlock(key)}
    <p style="color:#5b6577;font-size:14px;margin:0 0 8px">
      This key activates <strong style="color:#0a1628">Artha Personal</strong> for
      <strong style="color:#0a1628">${email}</strong>, perpetually — it never expires
      and isn't tied to a subscription.
    </p>
    <p style="color:#5b6577;font-size:14px;margin:0">
      Lost a key? Email <a href="mailto:support@artha.space" style="color:#0035ed">support@artha.space</a>.
    </p>`);
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

  // ── invoice.paid — mint/renew every subscription plan ────────────────────
  if (event.type === 'invoice.paid') {
    const invoice = event.data.object as Stripe.Invoice;
    const plans = planByPrice();

    // Branch on the PRICE id: legacy payment-mode checkouts had
    // invoice_creation enabled, so they ALSO emit invoice.paid — those lines
    // carry the old one-time price id, match nothing here, and fall through
    // to the ack below (their minting happened in checkout.session.completed).
    const line = invoice.lines.data.find(l => l.price?.id && plans.has(l.price.id));
    if (!line?.price) return NextResponse.json({ received: true });

    const spec = plans.get(line.price.id)!;
    const seats = spec.perSeat ? Math.max(1, line.quantity ?? 1) : 1;
    const periodEnd = line.period.end; // unix seconds — the subscription period this invoice paid for
    const exp = periodEnd + GRACE_SECONDS;

    const email = invoice.customer_email
      ?? (typeof invoice.customer === 'string'
        ? await stripe.customers.retrieve(invoice.customer).then(c => ('deleted' in c && c.deleted ? null : (c as Stripe.Customer).email)).catch(() => null)
        : null);
    if (!email) {
      console.error('[stripe/webhook] no email resolvable for invoice', invoice.id);
      return NextResponse.json({ error: 'No customer email found' }, { status: 422 });
    }

    let key: string;
    try {
      key = generateLicenseKey(email, spec.tier, seats, exp);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Key generation failed';
      console.error('[stripe/webhook] key generation error:', msg);
      return NextResponse.json({ error: msg }, { status: 500 });
    }

    const renewsAt = new Date(periodEnd * 1000);
    if (spec.perSeat) {
      await sendEmail(email, `Your Artha ${spec.label} license (${seats} seats)`, teamEmailHtml(key, spec.label, seats, renewsAt));
    } else {
      await sendEmail(email, 'Your Artha Personal license key', personalEmailHtml(key, email, renewsAt));
    }
    console.info(`[stripe/webhook] ${spec.label} key issued for`, email, `seats=${seats} exp=${exp}`, 'invoice', invoice.id);
    return NextResponse.json({ received: true });
  }

  // ── checkout.session.completed — legacy one-time purchases only ──────────
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    // Subscription-mode sessions are minted by their first invoice.paid.
    if (session.mode !== 'payment' || session.payment_status !== 'paid') {
      return NextResponse.json({ received: true });
    }
    const email = resolveSessionEmail(session);
    if (!email) {
      console.error('[stripe/webhook] no email on session', session.id);
      return NextResponse.json({ error: 'No customer email found' }, { status: 422 });
    }
    let key: string;
    try {
      key = generateLicenseKey(email, 'pro', 1); // perpetual — grandfathered Personal
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Key generation failed';
      console.error('[stripe/webhook] key generation error:', msg);
      return NextResponse.json({ error: msg }, { status: 500 });
    }
    await sendEmail(email, 'Your Artha license key', legacyPerpetualEmailHtml(key, email));
    console.info('[stripe/webhook] legacy perpetual Personal key issued for', email, 'session', session.id);
    return NextResponse.json({ received: true });
  }

  // ── customer.subscription.deleted — courtesy notice only ─────────────────
  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object as Stripe.Subscription;
    const email = typeof sub.customer === 'string'
      ? await stripe.customers.retrieve(sub.customer).then(c => ('deleted' in c && c.deleted ? null : (c as Stripe.Customer).email)).catch(() => null)
      : null;
    if (email) {
      const until = new Date((sub.current_period_end + GRACE_SECONDS) * 1000).toISOString().slice(0, 10);
      await sendEmail(email, 'Your Artha subscription has been cancelled', emailShell('Sorry to see you go', `
        <p style="color:#5b6577;margin:0 0 8px">
          Your Artha subscription won't renew. Your current license key stays
          active until <strong style="color:#0a1628">${until}</strong>, and everything
          in your local workspace remains yours — Artha keeps working on the Free plan
          afterwards. Changed your mind? You can re-subscribe any time at
          <a href="https://artha.space/#pricing" style="color:#0035ed">artha.space</a>.
        </p>`));
    }
    return NextResponse.json({ received: true });
  }

  // Acknowledge everything else — Stripe retries otherwise.
  return NextResponse.json({ received: true });
}

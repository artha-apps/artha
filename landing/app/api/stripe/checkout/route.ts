/**
 * POST /api/stripe/checkout
 *
 * Creates a Stripe Checkout session for one of the four self-serve plans and
 * returns the session URL. The client redirects the user to that URL.
 *
 * Plans (all subscriptions — the license key is re-minted and emailed by the
 * webhook on every invoice.paid, carrying exp = period end + 7-day grace):
 *   personal-annual — $59/yr, 1 seat  (primary B2C product)
 *   personal-6mo    — $34/6mo, 1 seat (subscription-hesitant option)
 *   team            — $168/seat/yr, min 5 seats (LAN hub, shared memory/packs)
 *   business        — $348/seat/yr, min 5 seats (adds audit export, RBAC, org hub)
 *
 * Required env vars:
 *   STRIPE_SECRET_KEY                 — Stripe secret key
 *   STRIPE_PRICE_ID_PERSONAL_ANNUAL   — recurring yearly Price, qty 1
 *   STRIPE_PRICE_ID_PERSONAL_6MO     — recurring 6-month Price, qty 1
 *   STRIPE_PRICE_ID_TEAM             — recurring yearly per-unit Price (licensed qty)
 *   STRIPE_PRICE_ID_BUSINESS         — recurring yearly per-unit Price (licensed qty)
 *   NEXT_PUBLIC_URL                  — public URL of this deployment
 */

import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';

export const runtime = 'nodejs';

export type PlanId = 'personal-annual' | 'personal-6mo' | 'team' | 'business';

/** Per-plan checkout shape. Seat plans clamp the requested quantity. */
const PLANS: Record<PlanId, { envVar: string; perSeat: boolean; minSeats: number; maxSeats: number }> = {
  'personal-annual': { envVar: 'STRIPE_PRICE_ID_PERSONAL_ANNUAL', perSeat: false, minSeats: 1, maxSeats: 1 },
  'personal-6mo':    { envVar: 'STRIPE_PRICE_ID_PERSONAL_6MO',    perSeat: false, minSeats: 1, maxSeats: 1 },
  team:              { envVar: 'STRIPE_PRICE_ID_TEAM',            perSeat: true,  minSeats: 5, maxSeats: 500 },
  business:          { envVar: 'STRIPE_PRICE_ID_BUSINESS',        perSeat: true,  minSeats: 5, maxSeats: 500 },
};

export async function POST(req: NextRequest) {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    console.error('[stripe/checkout] missing STRIPE_SECRET_KEY');
    return NextResponse.json(
      { error: 'Checkout is not configured yet. Please try again later.' },
      { status: 503 },
    );
  }

  // Pin to the SDK's bundled API version (omitting apiVersion uses the SDK default).
  const stripe = new Stripe(secretKey);

  try {
    const body = await req.json().catch(() => ({}));
    const planId: PlanId = typeof body.plan === 'string' && body.plan in PLANS
      ? (body.plan as PlanId)
      : 'personal-annual';
    const plan = PLANS[planId];

    const priceId = process.env[plan.envVar];
    if (!priceId) {
      console.error(`[stripe/checkout] missing ${plan.envVar}`);
      return NextResponse.json(
        { error: 'This plan is not available for online purchase yet. Email support@artha.space.' },
        { status: 503 },
      );
    }

    const quantity = plan.perSeat
      ? Math.min(plan.maxSeats, Math.max(plan.minSeats, Math.floor(Number(body.seats) || plan.minSeats)))
      : 1;

    const email: string | undefined =
      typeof body.email === 'string' && body.email.includes('@') ? body.email : undefined;

    const baseUrl =
      process.env.NEXT_PUBLIC_URL ??
      req.nextUrl.origin ??
      'https://artha.space';

    const session = await stripe.checkout.sessions.create({
      // All plans are subscriptions; the offline key simply carries an expiry
      // and the webhook re-mints it on every renewal invoice. NOTE: do NOT add
      // invoice_creation here — Stripe rejects it in subscription mode
      // (subscriptions invoice natively).
      mode: 'subscription',
      line_items: [{ price: priceId, quantity }],
      // Pre-fill email if the user typed it on the landing page.
      customer_email: email,
      // Collect billing address for tax / invoicing purposes.
      billing_address_collection: 'auto',
      allow_promotion_codes: true,
      // Plan id rides the metadata for observability; the webhook branches on
      // the PRICE id (authoritative), never on this.
      metadata: { customer_email: email ?? '', plan: planId },
      success_url: `${baseUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/#pricing`,
    });

    return NextResponse.json({ url: session.url });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[stripe/checkout] error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

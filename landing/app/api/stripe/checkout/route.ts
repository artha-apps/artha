/**
 * POST /api/stripe/checkout
 *
 * Creates a Stripe Checkout session for a one-time Artha Pro purchase and
 * returns the session URL. The client redirects the user to that URL.
 *
 * Required env vars:
 *   STRIPE_SECRET_KEY  — Stripe secret key (sk_test_... in test mode, sk_live_... in prod)
 *   STRIPE_PRICE_ID    — Stripe Price ID for the Artha Pro product
 *   NEXT_PUBLIC_URL    — Public URL of this deployment (e.g. https://artha.space)
 */

import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  const priceId = process.env.STRIPE_PRICE_ID;

  if (!secretKey || !priceId) {
    console.error('[stripe/checkout] missing STRIPE_SECRET_KEY or STRIPE_PRICE_ID');
    return NextResponse.json(
      { error: 'Checkout is not configured yet. Please try again later.' },
      { status: 503 },
    );
  }

  // Pin to the SDK's bundled API version (omitting apiVersion uses the SDK default).
  const stripe = new Stripe(secretKey);

  try {
    const body = await req.json().catch(() => ({}));
    const email: string | undefined =
      typeof body.email === 'string' && body.email.includes('@') ? body.email : undefined;

    const baseUrl =
      process.env.NEXT_PUBLIC_URL ??
      req.nextUrl.origin ??
      'https://artha.space';

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      // Pre-fill email if the user typed it on the landing page.
      customer_email: email,
      // Collect billing address for tax / invoicing purposes.
      billing_address_collection: 'auto',
      // Pass the email through so the webhook can read it without a DB.
      metadata: { customer_email: email ?? '' },
      success_url: `${baseUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/`,
      // Automatically generate a Stripe invoice PDF (nice for B2B buyers).
      invoice_creation: { enabled: true },
    });

    return NextResponse.json({ url: session.url });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[stripe/checkout] error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

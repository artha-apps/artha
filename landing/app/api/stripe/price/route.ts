/**
 * GET /api/stripe/price
 *
 * Returns the formatted Artha Pro price from the configured Stripe Price, so the
 * pricing card always shows the authoritative amount (test or live). Falls back
 * to { configured: false } when Stripe isn't set up yet.
 */

import { NextResponse } from 'next/server';
import Stripe from 'stripe';

export const runtime = 'nodejs';

export async function GET() {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  const priceId = process.env.STRIPE_PRICE_ID;
  if (!secretKey || !priceId) {
    return NextResponse.json({ configured: false }, { status: 200 });
  }

  try {
    const stripe = new Stripe(secretKey);
    const price = await stripe.prices.retrieve(priceId);

    const amount = price.unit_amount; // in the currency's smallest unit (cents)
    const currency = (price.currency ?? 'usd').toUpperCase();
    const recurring = price.recurring; // null for one-time

    let display = 'See price at checkout';
    if (typeof amount === 'number') {
      const formatted = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency,
        // Drop cents for whole-dollar prices (e.g. $49 not $49.00).
        minimumFractionDigits: amount % 100 === 0 ? 0 : 2,
      }).format(amount / 100);
      display = recurring ? `${formatted}/${recurring.interval}` : formatted;
    }

    return NextResponse.json(
      {
        configured: true,
        display,
        oneTime: !recurring,
        testMode: secretKey.startsWith('sk_test_'),
      },
      { headers: { 'cache-control': 'public, max-age=0, s-maxage=300' } },
    );
  } catch (err) {
    console.error('[stripe/price] error:', err instanceof Error ? err.message : err);
    return NextResponse.json({ configured: false }, { status: 200 });
  }
}

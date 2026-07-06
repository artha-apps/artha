/**
 * GET /api/stripe/price
 *
 * Returns the formatted prices for every self-serve SKU from the configured
 * Stripe Prices, so the pricing cards always show authoritative amounts (test
 * or live). Each SKU degrades to null independently — a missing Team price
 * never hides the Personal card. Shape:
 *
 *   {
 *     configured: boolean,           // any SKU available
 *     testMode: boolean,
 *     personalAnnual: { display, unitAmount, interval } | null,
 *     personal6mo:    { display, unitAmount, interval } | null,
 *     team:           { display, unitAmount, interval, perSeat: true } | null,
 *     business:       { display, unitAmount, interval, perSeat: true } | null,
 *   }
 */

import { NextResponse } from 'next/server';
import Stripe from 'stripe';

export const runtime = 'nodejs';

interface SkuPrice {
  display: string;
  /** Smallest currency unit (cents) — the seat stepper computes live totals. */
  unitAmount: number | null;
  interval: string | null;
  perSeat: boolean;
}

async function fetchSku(stripe: Stripe, envVar: string, perSeat: boolean): Promise<SkuPrice | null> {
  const priceId = process.env[envVar];
  if (!priceId) return null;
  try {
    const price = await stripe.prices.retrieve(priceId);
    const amount = price.unit_amount;
    const currency = (price.currency ?? 'usd').toUpperCase();
    const recurring = price.recurring;

    let display = 'See price at checkout';
    if (typeof amount === 'number') {
      const formatted = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency,
        // Drop cents for whole-dollar prices (e.g. $59 not $59.00).
        minimumFractionDigits: amount % 100 === 0 ? 0 : 2,
      }).format(amount / 100);
      display = recurring
        ? `${formatted}/${recurring.interval_count && recurring.interval_count > 1 ? `${recurring.interval_count} ${recurring.interval}s` : recurring.interval}`
        : formatted;
    }
    return { display, unitAmount: amount, interval: recurring?.interval ?? null, perSeat };
  } catch (err) {
    console.error(`[stripe/price] ${envVar}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

export async function GET() {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    return NextResponse.json({ configured: false }, { status: 200 });
  }

  try {
    const stripe = new Stripe(secretKey);
    const [personalAnnual, personal6mo, team, business] = await Promise.all([
      fetchSku(stripe, 'STRIPE_PRICE_ID_PERSONAL_ANNUAL', false),
      fetchSku(stripe, 'STRIPE_PRICE_ID_PERSONAL_6MO', false),
      fetchSku(stripe, 'STRIPE_PRICE_ID_TEAM', true),
      fetchSku(stripe, 'STRIPE_PRICE_ID_BUSINESS', true),
    ]);

    return NextResponse.json(
      {
        configured: !!(personalAnnual || personal6mo || team || business),
        testMode: secretKey.startsWith('sk_test_'),
        personalAnnual,
        personal6mo,
        team,
        business,
      },
      { headers: { 'cache-control': 'public, max-age=0, s-maxage=300' } },
    );
  } catch (err) {
    console.error('[stripe/price] error:', err instanceof Error ? err.message : err);
    return NextResponse.json({ configured: false }, { status: 200 });
  }
}

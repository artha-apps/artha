import type { Metadata } from 'next';
import Link from 'next/link';
import Stripe from 'stripe';

/**
 * /success — post-checkout thank-you page.
 *
 * Stripe redirects here with `?session_id=cs_…`. When the secret key is
 * configured we look the session up server-side so the page can name the plan,
 * seat count, and the inbox the key was sent to. Every lookup failure degrades
 * to generic copy — the webhook, not this page, is what actually mints and
 * emails the key, so nothing here is load-bearing.
 */
export const metadata: Metadata = {
  title: 'Thank you — Artha',
  robots: { index: false, follow: false },
};

// Reads a query param + calls Stripe per request; never prerender.
export const dynamic = 'force-dynamic';

interface OrderSummary {
  /** Human plan name — "Personal (annual)", "Team", … */
  planLabel: string;
  /** Team/Business keys are applied on the hub machine, not each laptop. */
  hubPlan: boolean;
  seats: number;
  email: string | null;
}

/** Price id → plan label, mirroring the webhook's routing table. */
function planLabels(): Map<string, { label: string; hubPlan: boolean }> {
  const m = new Map<string, { label: string; hubPlan: boolean }>();
  const add = (envVar: string, label: string, hubPlan: boolean) => {
    const id = process.env[envVar];
    if (id) m.set(id, { label, hubPlan });
  };
  add('STRIPE_PRICE_ID_PERSONAL_ANNUAL', 'Personal (annual)', false);
  add('STRIPE_PRICE_ID_PERSONAL_6MO', 'Personal (6-month)', false);
  add('STRIPE_PRICE_ID_TEAM', 'Team', true);
  add('STRIPE_PRICE_ID_BUSINESS', 'Business', true);
  return m;
}

async function loadSummary(sessionId: string | undefined): Promise<OrderSummary | null> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || !sessionId || !/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return null;
  try {
    const stripe = new Stripe(key, { timeout: 6_000 });
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['line_items'],
    });
    const item = session.line_items?.data?.[0];
    const priceId = item?.price?.id;
    const spec = priceId ? planLabels().get(priceId) : undefined;
    return {
      planLabel: spec?.label ?? 'Artha',
      hubPlan: spec?.hubPlan ?? false,
      seats: spec?.hubPlan ? Math.max(1, item?.quantity ?? 1) : 1,
      email: session.customer_details?.email ?? session.metadata?.customer_email ?? null,
    };
  } catch (err) {
    console.error('[success] session lookup failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

export default async function SuccessPage({
  searchParams,
}: {
  searchParams: Promise<{ session_id?: string }>;
}) {
  const { session_id } = await searchParams;
  const order = await loadSummary(session_id);

  const planName = order && order.planLabel !== 'Artha' ? `Artha ${order.planLabel}` : 'Artha';
  const where = order?.hubPlan
    ? 'on your hub machine: Artha → Settings → License'
    : 'Artha → Settings → License';

  return (
    <main className="success-wrap">
      <div className="container success-inner">
        <div className="success-badge" aria-hidden="true">✓</div>
        <h1>You&rsquo;re all set.</h1>
        <p className="success-lede">
          Thanks for subscribing to <strong>{planName}</strong>
          {order && order.seats > 1 ? <> ({order.seats} seats)</> : null}. We&rsquo;ve
          emailed your license key{order?.email ? <> to <strong>{order.email}</strong></> : null} —
          paste it into <strong>{where}</strong> to unlock your plan.
        </p>
        <ol className="success-steps">
          <li>
            <span className="num">01</span>
            <span>Check your inbox for an email from Artha with your license key.</span>
          </li>
          <li>
            <span className="num">02</span>
            <span>
              {order?.hubPlan
                ? 'On the hub machine, open Artha → Settings → License and paste the key. Teammates connect to the hub over your office network.'
                : 'Open Artha → Settings → License and paste the key. It works on every machine you use.'}
            </span>
          </li>
          <li>
            <span className="num">03</span>
            <span>
              No email after a few minutes? Check spam, or write to{' '}
              <a href="mailto:support@artha.space">support@artha.space</a>.
              Renewals re-issue a fresh key to the same inbox automatically.
            </span>
          </li>
        </ol>
        <Link className="btn-primary" href="/">
          Back to artha.space
        </Link>
      </div>
    </main>
  );
}

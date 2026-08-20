import type { Metadata } from 'next';
import { SubscribeClient } from './SubscribeClient';

/**
 * /subscribe — dedicated checkout page.
 *
 * The landing page's pricing section is a summary; this page is the
 * destination for anything that wants to send a person straight to a plan:
 * the in-app License screen, renewal emails, and direct links. It accepts
 * `?plan=personal-annual|personal-6mo|team|business` and `?seats=N` so a link
 * can pre-select the exact SKU. Checkout itself is unchanged — it still goes
 * through POST /api/stripe/checkout and the license key is emailed by the
 * Stripe webhook.
 */
export const metadata: Metadata = {
  title: 'Subscribe — Artha',
  description:
    'Choose an Artha plan. Pay with Stripe, receive a signed offline license key by email. No account, no phone-home — everything runs on your machine.',
  alternates: { canonical: 'https://artha.space/subscribe' },
  openGraph: {
    title: 'Subscribe to Artha',
    description:
      'Personal, Team, or Business — local-first AI, honestly priced. Offline license keys, zero telemetry.',
    url: 'https://artha.space/subscribe',
  },
};

export default function SubscribePage() {
  return <SubscribeClient />;
}

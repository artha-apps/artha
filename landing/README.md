# Artha Landing Page

Marketing site at the eventual domain (e.g. `artha.app` or `artha.vercel.app`).

## Stack
- Next.js 14 (App Router)
- TypeScript
- No CSS framework — single `globals.css` is enough for a one-page site

## Local development

```bash
cd landing
npm install
npm run dev   # http://localhost:3000
```

## Deploy to Vercel

```bash
# One-time
npm i -g vercel
cd landing
vercel link        # link to a new or existing Vercel project
vercel --prod      # deploy
```

Or wire the GitHub repo to Vercel via the dashboard and set **Root Directory** to `landing`. Subsequent pushes to `main` auto-deploy.

## How downloads work

`app/page.tsx` calls the GitHub Releases API for `artha-apps/artha` at page load to fetch the latest release's assets and renders OS-specific download buttons. **No rebuild is needed when a new release is cut** — the landing page picks up the new version automatically.

If the GitHub API call fails (rate limiting, network), the page falls back to a "See all downloads" link to `https://github.com/artha-apps/artha/releases/latest`.

## Production checklist

- [ ] Link to Vercel project: `vercel link`
- [ ] Set custom domain (optional, Phase 2)
- [ ] Verify `RELEASES_API` URL points to the correct GitHub repo
- [ ] Add favicon + apple-touch-icon to `public/`
- [ ] Add `og:image` for social sharing (Phase 2)

## Commerce env vars (Vercel → Settings → Environment Variables)

Pricing is four subscription SKUs (see `docs/gtm/pricing_page_copy.md`); the
webhook mints offline license keys on every `invoice.paid`.

| Var | What |
|---|---|
| `STRIPE_SECRET_KEY` | Stripe secret key (`sk_live_…` / `sk_test_…`) |
| `STRIPE_WEBHOOK_SECRET` | Signing secret of the `/api/stripe/webhook` endpoint |
| `STRIPE_PRICE_ID_PERSONAL_ANNUAL` | Recurring **yearly** Price, $59, qty 1 |
| `STRIPE_PRICE_ID_PERSONAL_6MO` | Recurring **every 6 months** Price, $34, qty 1 |
| `STRIPE_PRICE_ID_TEAM` | Recurring yearly **per-unit (licensed qty)** Price, $168/seat |
| `STRIPE_PRICE_ID_BUSINESS` | Recurring yearly per-unit Price, $348/seat |
| `ARTHA_LICENSE_PRIVATE_KEY` | Ed25519 private key PEM (license signing) |
| `RESEND_API_KEY` / `RESEND_FROM_EMAIL` | License-key email delivery |
| `NEXT_PUBLIC_URL` | Public URL of this deployment |

Stripe dashboard: webhook endpoint `https://artha.space/api/stripe/webhook`
must subscribe to `checkout.session.completed`, `invoice.paid`, and
`customer.subscription.deleted`. The legacy one-time `STRIPE_PRICE_ID` var can
stay set — in-flight old checkouts still mint the grandfathered perpetual key.

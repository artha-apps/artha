'use client';

import { useEffect, useMemo, useState } from 'react';
import { Mark } from '../components/Mark';

/* ------------------------------------------------------------------ */
/* Types + plan catalog                                                */
/* ------------------------------------------------------------------ */

/** Must match PlanId in app/api/stripe/checkout/route.ts. */
type PlanId = 'personal-annual' | 'personal-6mo' | 'team' | 'business';

/** The three selectable cards. Personal's billing interval is a sub-choice. */
type Tier = 'personal' | 'team' | 'business';
type Interval = 'annual' | '6mo';

/** Per-SKU price from /api/stripe/price. unitAmount is cents. */
type SkuPrice = {
  display: string;
  unitAmount: number | null;
  interval: string | null;
  perSeat: boolean;
} | null;

type PriceInfo = {
  configured: boolean;
  testMode?: boolean;
  personalAnnual?: SkuPrice;
  personal6mo?: SkuPrice;
  team?: SkuPrice;
  business?: SkuPrice;
} | null;

const MIN_SEATS = 5;
const MAX_SEATS = 500;

/** Copy mirrors docs/gtm/pricing_page_copy.md — only code-enforced features. */
const TIERS: ReadonlyArray<{
  id: Tier;
  name: string;
  tagline: string;
  features: readonly string[];
  perSeat: boolean;
}> = [
  {
    id: 'personal',
    name: 'Personal',
    tagline: 'The full solo experience — a fresh offline key on every renewal.',
    perSeat: false,
    features: [
      'Everything in Free, uncapped',
      'Unlimited document generation',
      'Scheduled tasks & unlimited context packs',
      'Starter skill templates (legal · finance · ops)',
      'Priority email support',
    ],
  },
  {
    id: 'team',
    name: 'Team',
    tagline: 'One hub machine, your whole team working with shared context.',
    perSeat: true,
    features: [
      'Everything in Personal',
      'LAN team hub — data stays in your office',
      'Shared memories & shared context packs',
      'Seat-capped roster + per-member API keys',
    ],
  },
  {
    id: 'business',
    name: 'Business',
    tagline: 'For regulated teams that must prove what their AI did.',
    perSeat: true,
    features: [
      'Everything in Team',
      'Audit-log export — every tool call, attributable',
      'Org hub deployment + role controls',
      'Security-questionnaire support',
    ],
  },
];

/** Comparison rows — only flags the app actually enforces. */
const COMPARE: ReadonlyArray<readonly [string, string, string, string, string]> = [
  ['Runs 100% locally', '✓', '✓', '✓', '✓'],
  ['Documents / month', '5', 'Unlimited', 'Unlimited', 'Unlimited'],
  ['Scheduled tasks', '—', '✓', '✓', '✓'],
  ['Context packs', '1', 'Unlimited', 'Unlimited', 'Unlimited'],
  ['Starter skill templates', '—', '✓', '✓', '✓'],
  ['LAN team hub', '—', '—', '✓', '✓'],
  ['Shared memories & packs', '—', '—', '✓', '✓'],
  ['Seats', '1', '1', '5+', '5+'],
  ['Audit-log export', '—', '—', '—', '✓'],
  ['RBAC / org hub', '—', '—', '—', '✓'],
  ['Support', 'Community', 'Priority', 'Priority', 'Priority + questionnaire'],
];

const FAQ: ReadonlyArray<readonly [string, string]> = [
  [
    'What happens after I pay?',
    'Stripe confirms the payment and we email a signed license key within a minute or two. Paste it into Artha → Settings → License. No account to create, nothing to activate online.',
  ],
  [
    'Do the apps phone home to check my license?',
    'Never. Keys are Ed25519-signed tokens verified entirely on-device — that is why they work air-gapped. Subscriptions work by putting an expiry inside the key and emailing you a fresh one on each renewal.',
  ],
  [
    'What happens if my subscription lapses?',
    'Your key includes a 7-day grace window past the renewal date. After that, Personal falls back to the Free plan and a Team/Business hub stops serving teammates — but all your local data stays exactly where it is, yours. Re-subscribe any time and paste the new key.',
  ],
  [
    'Can I move my key between machines?',
    'Yes — it is a signed token, not a machine lock. One person, your machines. Team and Business keys go on the hub machine.',
  ],
  [
    'How do Team and Business seats work?',
    'You pick a seat count at checkout (minimum 5). The key is applied on the hub machine and caps the roster at that number. Change seats later and the key is re-issued on the proration invoice.',
  ],
  [
    'I bought the early one-time license — what happens to me?',
    'You are grandfathered: your perpetual key maps to Personal, forever — everything solo, no subscription, as promised when you bought it.',
  ],
  [
    'Refunds?',
    '14 days, no questions — email support@artha.space.',
  ],
];

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function formatUsd(cents: number): string {
  const dollars = cents / 100;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: dollars % 1 === 0 ? 0 : 2,
  }).format(dollars);
}

function clampSeats(n: number): number {
  if (!Number.isFinite(n)) return MIN_SEATS;
  return Math.min(MAX_SEATS, Math.max(MIN_SEATS, Math.floor(n)));
}

/** Parse `?plan=` — tolerant of the bare `personal` alias. */
function parsePlanParam(raw: string | null): { tier: Tier; interval: Interval } | null {
  switch (raw) {
    case 'personal':
    case 'personal-annual':
      return { tier: 'personal', interval: 'annual' };
    case 'personal-6mo':
      return { tier: 'personal', interval: '6mo' };
    case 'team':
      return { tier: 'team', interval: 'annual' };
    case 'business':
      return { tier: 'business', interval: 'annual' };
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export function SubscribeClient() {
  const [price, setPrice] = useState<PriceInfo>(null);
  const [priceFailed, setPriceFailed] = useState(false);

  const [tier, setTier] = useState<Tier>('personal');
  const [interval, setInterval] = useState<Interval>('annual');
  const [seats, setSeats] = useState<number>(MIN_SEATS);
  const [email, setEmail] = useState('');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Deep-link support: /subscribe?plan=team&seats=12&email=... — read once on
  // mount (window-only) so the page stays a plain client component without a
  // Suspense boundary for useSearchParams.
  useEffect(() => {
    const qs = new URLSearchParams(window.location.search);
    const parsed = parsePlanParam(qs.get('plan'));
    if (parsed) {
      setTier(parsed.tier);
      setInterval(parsed.interval);
    }
    const s = qs.get('seats');
    if (s) setSeats(clampSeats(Number(s)));
    const e = qs.get('email');
    if (e && e.includes('@')) setEmail(e);

    fetch('/api/stripe/price')
      .then((r) => (r.ok ? r.json() : null))
      .then((p) => {
        if (p) setPrice(p);
        else setPriceFailed(true);
      })
      .catch(() => setPriceFailed(true));
  }, []);

  const planId: PlanId =
    tier === 'personal' ? (interval === 'annual' ? 'personal-annual' : 'personal-6mo') : tier;

  /** The Stripe SKU backing the current selection (null while loading / unconfigured). */
  const sku: SkuPrice = useMemo(() => {
    if (!price) return null;
    if (planId === 'personal-annual') return price.personalAnnual ?? null;
    if (planId === 'personal-6mo') return price.personal6mo ?? null;
    if (planId === 'team') return price.team ?? null;
    return price.business ?? null;
  }, [price, planId]);

  const perSeat = tier !== 'personal';
  const total = sku?.unitAmount != null ? formatUsd(sku.unitAmount * (perSeat ? seats : 1)) : null;
  const period = planId === 'personal-6mo' ? '6 months' : 'year';
  const available = !!sku;
  const skuKnownMissing = !!price && !sku; // price API answered, this SKU isn't configured

  /** Per-tier headline price for the cards (unaffected by current selection). */
  function tierPrice(t: Tier): SkuPrice {
    if (!price) return null;
    if (t === 'personal') return (interval === 'annual' ? price.personalAnnual : price.personal6mo) ?? null;
    if (t === 'team') return price.team ?? null;
    return price.business ?? null;
  }

  async function handleCheckout() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/stripe/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plan: planId,
          seats: perSeat ? seats : undefined,
          email: email.includes('@') ? email.trim() : undefined,
          from: 'subscribe',
        }),
      });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        setError(data.error ?? 'Something went wrong — please try again.');
        setLoading(false);
      }
    } catch {
      setError('Network error — please try again.');
      setLoading(false);
    }
  }

  return (
    <>
      <header className="nav">
        <div className="container nav-inner">
          <a href="/" className="brand" aria-label="Artha — AI Coworker OS">
            <Mark size={40} />
            <span className="wordmark">
              <span className="wordmark-name">ARTHA</span>
              <span className="wordmark-rule" aria-hidden="true" />
              <span className="wordmark-tagline">AI Coworker OS</span>
            </span>
          </a>
          <nav>
            <ul className="nav-links">
              <li>
                <a href="/#features">Features</a>
              </li>
              <li>
                <a href="/#pricing">Pricing</a>
              </li>
              <li className="hide-sm">
                <a href="/#getting-started">Get started</a>
              </li>
              <li>
                <a className="nav-cta" href="/">
                  Download
                </a>
              </li>
            </ul>
          </nav>
        </div>
      </header>

      <main className="subscribe">
        <section className="subscribe-hero">
          <div className="container">
            <div className="eyebrow">Subscribe</div>
            <h1>Choose your plan.</h1>
            <p className="lede">
              Pay with Stripe, get a signed offline license key by email, paste it into
              Artha. No account, no phone-home — everything runs on your machine.
            </p>
            <ul className="subscribe-trust" aria-label="What every plan includes">
              <li>Local SQLite storage</li>
              <li>Works fully offline</li>
              <li>No account required</li>
              <li>Zero telemetry</li>
              <li>Offline license keys (Ed25519)</li>
            </ul>
            {price?.testMode && (
              <p className="subscribe-testmode" role="status">
                Stripe is in test mode — no real charges will be made.
              </p>
            )}
          </div>
        </section>

        <section className="subscribe-body">
          <div className="container subscribe-grid">
            {/* ---------------- Plan picker ---------------- */}
            <div className="subscribe-plans" role="radiogroup" aria-label="Plan">
              {TIERS.map((t) => {
                const selected = tier === t.id;
                const p = tierPrice(t.id);
                return (
                  <div
                    key={t.id}
                    role="radio"
                    aria-checked={selected}
                    tabIndex={0}
                    className={`plan-option${selected ? ' selected' : ''}`}
                    onClick={() => setTier(t.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setTier(t.id);
                      }
                    }}
                  >
                    <div className="plan-option-head">
                      <span className="plan-radio" aria-hidden="true" />
                      <div className="plan-option-title">
                        <div className="price-tier">{t.name}</div>
                        <p className="plan-tagline">{t.tagline}</p>
                      </div>
                      <div className="plan-option-price">
                        {p ? (
                          <>
                            <strong>{p.display}</strong>
                            {t.perSeat && <span className="price-suffix">per seat</span>}
                          </>
                        ) : (
                          <span className="price-loading">{priceFailed || price ? 'Coming soon' : '—'}</span>
                        )}
                      </div>
                    </div>

                    {selected && (
                      <div className="plan-option-body">
                        {t.id === 'personal' && price?.personalAnnual && price?.personal6mo && (
                          <div className="price-interval-toggle" role="tablist" aria-label="Billing interval">
                            <button
                              type="button"
                              role="tab"
                              aria-selected={interval === 'annual'}
                              className={interval === 'annual' ? 'active' : ''}
                              onClick={(e) => { e.stopPropagation(); setInterval('annual'); }}
                            >
                              Annual
                            </button>
                            <button
                              type="button"
                              role="tab"
                              aria-selected={interval === '6mo'}
                              className={interval === '6mo' ? 'active' : ''}
                              onClick={(e) => { e.stopPropagation(); setInterval('6mo'); }}
                            >
                              6 months
                            </button>
                          </div>
                        )}

                        {t.perSeat && (
                          <div className="seat-stepper" aria-label={`${t.name} seats`}>
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); setSeats((s) => clampSeats(s - 1)); }}
                              disabled={seats <= MIN_SEATS}
                              aria-label="Fewer seats"
                            >
                              −
                            </button>
                            <span className="seat-count">{seats} seats</span>
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); setSeats((s) => clampSeats(s + 1)); }}
                              disabled={seats >= MAX_SEATS}
                              aria-label="More seats"
                            >
                              +
                            </button>
                            <span>Min {MIN_SEATS} · applied on the hub machine</span>
                          </div>
                        )}

                        <ul className="price-features">
                          {t.features.map((f) => (
                            <li key={f}>{f}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                );
              })}

              <p className="subscribe-free-note">
                Just want to try it? <a href="/">Download Artha free</a> — no card, 5 documents a
                month. Need air-gapped / on-prem Enterprise?{' '}
                <a href="mailto:support@artha.space?subject=Artha%20Enterprise">Talk to us</a>.
              </p>
            </div>

            {/* ---------------- Order summary ---------------- */}
            <aside className="subscribe-summary" aria-label="Order summary">
              <div className="price-tier">Your plan</div>
              <div className="summary-line">
                <span>Artha {TIERS.find((t) => t.id === tier)?.name}</span>
                <span>{sku?.display ?? <span className="price-loading">—</span>}</span>
              </div>
              {perSeat && (
                <div className="summary-line">
                  <span>Seats</span>
                  <span>× {seats}</span>
                </div>
              )}
              <div className="summary-line total">
                <span>Billed every {period}</span>
                <span>{total ?? <span className="price-loading">—</span>}</span>
              </div>

              <label className="summary-email">
                <span>Email for your license key <em>(optional — Stripe will also ask)</em></span>
                <input
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  placeholder="you@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>

              <button
                type="button"
                className="price-cta primary"
                onClick={handleCheckout}
                disabled={loading || !available}
              >
                {loading
                  ? 'Redirecting to Stripe…'
                  : available
                    ? `Continue to checkout`
                    : skuKnownMissing
                      ? 'Not available online yet'
                      : 'Loading price…'}
              </button>

              {skuKnownMissing && (
                <p className="summary-note">
                  This plan isn’t set up for online purchase yet — email{' '}
                  <a href="mailto:support@artha.space">support@artha.space</a> and we’ll sort it out.
                </p>
              )}
              {error && <p className="price-error">{error}</p>}

              <ul className="summary-assurances">
                <li>Secure checkout by Stripe</li>
                <li>License key emailed within minutes</li>
                <li>Cancel anytime · 14-day refund</li>
                <li>Renewals re-issue a fresh key automatically</li>
              </ul>
            </aside>
          </div>
        </section>

        {/* ---------------- Comparison ---------------- */}
        <section className="subscribe-compare">
          <div className="container">
            <div className="section-header">
              <h2>What each plan unlocks.</h2>
              <p>Only features the app actually enforces — nothing aspirational.</p>
            </div>
            <div className="compare-scroll">
              <table className="compare-table">
                <thead>
                  <tr>
                    <th scope="col"><span className="sr-only">Feature</span></th>
                    <th scope="col">Free</th>
                    <th scope="col" className="is-current">Personal</th>
                    <th scope="col">Team</th>
                    <th scope="col">Business</th>
                  </tr>
                </thead>
                <tbody>
                  {COMPARE.map(([label, ...cells]) => (
                    <tr key={label}>
                      <th scope="row">{label}</th>
                      {cells.map((c, i) => (
                        <td key={i} className={c === '—' ? 'is-dash' : ''}>{c}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* ---------------- FAQ ---------------- */}
        <section className="subscribe-faq">
          <div className="container">
            <div className="section-header">
              <h2>Questions, answered.</h2>
            </div>
            <div className="faq-list">
              {FAQ.map(([q, a]) => (
                <details key={q} className="faq-item">
                  <summary>{q}</summary>
                  <p>{a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer className="footer">
        <div className="container">
          <div className="footer-inner">
            <div className="footer-brand">
              <div className="brand">
                <Mark size={36} />
                <span className="wordmark">
                  <span className="wordmark-name">ARTHA</span>
                  <span className="wordmark-rule" aria-hidden="true" />
                  <span className="wordmark-tagline">AI Coworker OS</span>
                </span>
              </div>
              <p>
                अर्थ — Sanskrit for work done, purpose, meaning, intent.
                A local-first AI workspace built on the principle that your
                data is yours.
              </p>
            </div>
            <div>
              <div className="footer-col-title">Product</div>
              <ul className="footer-links">
                <li><a href="/">Download</a></li>
                <li><a href="/#features">Features</a></li>
                <li><a href="/subscribe">Subscribe</a></li>
                <li><a href="/#getting-started">Get started</a></li>
              </ul>
            </div>
            <div>
              <div className="footer-col-title">Project</div>
              <ul className="footer-links">
                <li><a href="/privacy">Privacy</a></li>
                <li><a href="/license">License</a></li>
              </ul>
            </div>
          </div>
          <div className="footer-bottom">
            <div>© 2026 Shree Labs Inc.</div>
            <div>Built locally.</div>
          </div>
          <div className="footer-credit">Presented by Shree Labs Inc.</div>
        </div>
      </footer>
    </>
  );
}

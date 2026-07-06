'use client';

import Image from 'next/image';
import { useEffect, useState } from 'react';

/**
 * Public pricing visibility. The four-tier model (Free capped / Personal
 * annual / Team per-seat / Business per-seat) is live — see
 * docs/gtm/pricing_page_copy.md for the canonical copy and
 * /api/stripe/price for the authoritative amounts.
 */
const SHOW_PRICING = true;

type Platform = 'mac-arm64' | 'mac-intel' | 'windows' | 'linux' | 'unknown';

function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'unknown';
  const ua = navigator.userAgent;
  const platform =
    (navigator as any).userAgentData?.platform ?? navigator.platform;

  if (/Mac/i.test(platform)) {
    // UA doesn't disclose Apple Silicon vs Intel reliably; default to arm64
    // (newer machines), offer Intel as a secondary download.
    return 'mac-arm64';
  }
  if (/Win/i.test(platform)) return 'windows';
  if (/Linux/i.test(platform) && !/Android/i.test(ua)) return 'linux';
  return 'unknown';
}

type AssetMeta = { name: string; size: number };
type ReleaseInfo = {
  tag_name: string;
  published_at?: string;
  assets: Partial<Record<Exclude<Platform, 'unknown'>, AssetMeta>>;
} | null;

function bytesToMB(n: number) {
  return `${Math.round(n / 1024 / 1024)} MB`;
}

/** Format the release timestamp as e.g. "Jun 4, 2026, 2:30 PM UTC".
 *  The timestamp is always rendered in UTC and explicitly labelled so the
 *  reader never mistakes it for their local time. `timeZoneName` cannot be
 *  combined with `dateStyle`/`timeStyle` (that throws), so the date and time
 *  parts are spelled out as individual components. */
function formatReleaseDate(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  }).format(d);
}

/** Brand mark — Devanagari अ inside a sacred-geometry mandala.
 *  Source artwork is gold on near-black, so the mark reads as a dark
 *  medallion on the cream page background. */
function Mark({ size = 32 }: { size?: number }) {
  return (
    <Image
      src="/logo-mark.png"
      alt=""
      width={size}
      height={size}
      className="brand-mark"
      priority
    />
  );
}


const FEATURES: ReadonlyArray<readonly [string, string, string]> = [
  [
    '01 / DOCUMENTS',
    'Native artifacts',
    'Generate Word, Excel, PowerPoint, and PDF files from natural language. Every artifact stays on your machine.',
  ],
  [
    '02 / TOOLS',
    'MCP-native',
    'Any Model Context Protocol server becomes a skill your agent can use. Bring your own integrations.',
  ],
  [
    '03 / RETRIEVAL',
    'Local RAG',
    'Index folders with Ollama embeddings. Search, cite, and chat with your files — no cloud.',
  ],
  [
    '04 / MODELS',
    'Ollama-first',
    'Auto-detect installed models, pull new ones, and switch between Llama, Mistral, Qwen, and more.',
  ],
  [
    '05 / PRIVACY',
    'Zero telemetry',
    'No accounts. No tracking. No background phone-home. The binary is auditable.',
  ],
  [
    '06 / SAFETY',
    'Sandboxed tools',
    'Optional Docker sandbox for untrusted tools. Run agents without giving them your shell.',
  ],
];

const PLATFORM_LABEL: Record<Exclude<Platform, 'unknown'>, string> = {
  'mac-arm64': 'Download for macOS (Apple Silicon)',
  'mac-intel': 'Download for macOS (Intel)',
  windows: 'Download for Windows',
  linux: 'Download for Linux (.deb)',
};

const SECONDARY_LABEL: Record<Exclude<Platform, 'unknown'>, string> = {
  'mac-arm64': 'macOS arm64',
  'mac-intel': 'macOS Intel',
  windows: 'Windows',
  linux: 'Linux .deb',
};

const PLATFORM_ORDER: Exclude<Platform, 'unknown'>[] = [
  'mac-arm64',
  'mac-intel',
  'windows',
  'linux',
];

function downloadHref(p: Platform): string {
  if (p === 'unknown') return '/api/download/mac-arm64';
  return `/api/download/${p}`;
}

/** Per-SKU price from /api/stripe/price. unitAmount is cents (seat totals). */
type SkuPrice = { display: string; unitAmount: number | null; interval: string | null; perSeat: boolean } | null;
type PriceInfo = {
  configured: boolean;
  testMode?: boolean;
  personalAnnual?: SkuPrice;
  personal6mo?: SkuPrice;
  team?: SkuPrice;
  business?: SkuPrice;
} | null;

type PlanId = 'personal-annual' | 'personal-6mo' | 'team' | 'business';

/** Live seat total for a per-seat SKU ("$840/year for 5 seats"). */
function seatTotal(sku: SkuPrice, seats: number): string | null {
  if (!sku?.unitAmount) return null;
  const total = (sku.unitAmount * seats) / 100;
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: total % 1 === 0 ? 0 : 2,
  }).format(total);
}

export default function Page() {
  const [platform, setPlatform] = useState<Platform>('unknown');
  const [release, setRelease] = useState<ReleaseInfo>(null);
  const [error, setError] = useState<string | null>(null);

  const [price, setPrice] = useState<PriceInfo>(null);
  const [checkoutLoading, setCheckoutLoading] = useState<PlanId | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  // Personal card interval + per-seat steppers (min 5 per the plan).
  const [personalInterval, setPersonalInterval] = useState<'annual' | '6mo'>('annual');
  const [teamSeats, setTeamSeats] = useState(5);
  const [bizSeats, setBizSeats] = useState(5);

  useEffect(() => {
    setPlatform(detectPlatform());
    fetch('/api/release')
      .then((r) => {
        if (!r.ok) throw new Error(`Release API returned ${r.status}`);
        return r.json();
      })
      .then(setRelease)
      .catch((e) => setError(String(e)));

    // Authoritative Pro price straight from Stripe (test or live).
    fetch('/api/stripe/price')
      .then((r) => (r.ok ? r.json() : null))
      .then(setPrice)
      .catch(() => setPrice({ configured: false }));
  }, []);

  async function handleCheckout(plan: PlanId, seats?: number) {
    setCheckoutLoading(plan);
    setCheckoutError(null);
    try {
      const res = await fetch('/api/stripe/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan, seats }),
      });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        setCheckoutError(data.error ?? 'Something went wrong — please try again.');
        setCheckoutLoading(null);
      }
    } catch {
      setCheckoutError('Network error — please try again.');
      setCheckoutLoading(null);
    }
  }

  const primaryPlatform: Exclude<Platform, 'unknown'> =
    platform === 'unknown' ? 'mac-arm64' : platform;
  const primaryAsset = release?.assets?.[primaryPlatform] ?? null;
  const primaryLabel =
    platform === 'unknown'
      ? 'Download Artha'
      : PLATFORM_LABEL[primaryPlatform];

  const otherLinks = PLATFORM_ORDER.flatMap((p) => {
    if (p === primaryPlatform) return [];
    const meta = release?.assets?.[p];
    if (!meta) return [];
    return [{ platform: p, label: SECONDARY_LABEL[p] }];
  });

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
                <a href="#features">Features</a>
              </li>
              {SHOW_PRICING && (
                <li>
                  <a href="#pricing">Pricing</a>
                </li>
              )}
              <li className="hide-sm">
                <a href="#getting-started">Get started</a>
              </li>
              <li>
                <a className="nav-cta" href={downloadHref(primaryPlatform)}>
                  Download
                </a>
              </li>
            </ul>
          </nav>
        </div>
      </header>

      <main>
        <section className="hero">
          <div className="container">
            <div className="eyebrow">
              Local-first · Privacy by design
              {release?.tag_name ? ` · ${release.tag_name.toUpperCase()}` : ''}
            </div>
            <h1>
              Serious work. <span className="accent">Fully local.</span>
            </h1>
            <p className="lede">
              Artha is a local-first AI workspace that generates documents,
              indexes your files, and runs agents — all on your hardware.
              No cloud calls. No accounts. No telemetry.
            </p>
            <div className="cta-row">
              <a
                className="btn-primary"
                href={downloadHref(primaryPlatform)}
              >
                <span>{primaryLabel}</span>
                {primaryAsset && (
                  <span style={{ opacity: 0.75, fontWeight: 400 }}>
                    · {bytesToMB(primaryAsset.size)}
                  </span>
                )}
              </a>
            </div>
            <div className="release-meta">
              {release ? (
                <>
                  Latest release <strong>{release.tag_name}</strong>
                  {release.published_at &&
                    formatReleaseDate(release.published_at) && (
                      <> · {formatReleaseDate(release.published_at)}</>
                    )}
                  {otherLinks.length > 0 && (
                    <>
                      {' · Also for '}
                      {otherLinks.map((l, i) => (
                        <span key={l.platform}>
                          <a href={downloadHref(l.platform)}>{l.label}</a>
                          {i < otherLinks.length - 1 ? ' · ' : ''}
                        </span>
                      ))}
                    </>
                  )}
                </>
              ) : error ? (
                <>Release info temporarily unavailable.</>
              ) : (
                'Loading latest release…'
              )}
            </div>
          </div>
        </section>

        <section className="stats" aria-label="Project facts">
          <div className="container">
            <div className="stats-grid">
              <div>
                <div className="stat-label">On-device execution</div>
                <div className="stat-value">100%</div>
              </div>
              <div>
                <div className="stat-label">Telemetry events</div>
                <div className="stat-value">0</div>
              </div>
              <div>
                <div className="stat-label">Platforms</div>
                <div className="stat-value">3</div>
              </div>
              <div>
                <div className="stat-label">Document formats</div>
                <div className="stat-value">4</div>
              </div>
            </div>
          </div>
        </section>

        <section className="features" id="features">
          <div className="container">
            <div className="section-header">
              <h2>An AI workspace that earns trust.</h2>
              <p>
                Every capability built around a single rule: your files,
                prompts, embeddings, and model outputs never leave the machine
                they were generated on.
              </p>
            </div>
            <div className="feature-grid">
              {FEATURES.map(([label, title, body]) => (
                <div className="feature" key={label}>
                  <div className="feature-label">{label}</div>
                  <h3>{title}</h3>
                  <p>{body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {SHOW_PRICING && (
        <section className="pricing" id="pricing">
          <div className="container">
            <div className="section-header">
              <h2>Local-first, honestly priced.</h2>
              <p>
                Everything runs on your machine on every plan — your files never leave it.
                License keys verify offline; no account, no phone-home, ever.
              </p>
            </div>
            <div className="price-grid quad">

              {/* Free — the capped on-ramp */}
              <div className="price-card">
                <div className="price-tier">Free</div>
                <div className="price-amount">$0<span className="price-suffix">forever</span></div>
                <p className="price-desc">
                  Try the local AI coworker for real — no account, no card.
                </p>
                <ul className="price-features">
                  <li>Chat, tools, local RAG &amp; memory</li>
                  <li>BYOK cloud models (your key)</li>
                  <li>5 generated documents / month</li>
                  <li>1 saved context pack</li>
                  <li>Community support</li>
                </ul>
                <a className="price-cta secondary" href={downloadHref(primaryPlatform)}>
                  Download free
                </a>
              </div>

              {/* Personal — the primary B2C product */}
              <div className="price-card highlight">
                <div className="price-tier">Personal</div>
                <div className="price-amount">
                  {personalInterval === 'annual'
                    ? (price?.personalAnnual?.display ?? <span className="price-loading">—</span>)
                    : (price?.personal6mo?.display ?? <span className="price-loading">—</span>)}
                </div>
                {price?.personal6mo && price?.personalAnnual && (
                  <div className="price-interval-toggle" role="tablist" aria-label="Billing interval">
                    <button
                      className={personalInterval === 'annual' ? 'active' : ''}
                      onClick={() => setPersonalInterval('annual')}
                    >Annual</button>
                    <button
                      className={personalInterval === '6mo' ? 'active' : ''}
                      onClick={() => setPersonalInterval('6mo')}
                    >6 months</button>
                  </div>
                )}
                <p className="price-desc">
                  The full solo experience — a fresh offline key on every renewal.
                </p>
                <ul className="price-features">
                  <li>Everything in Free, uncapped</li>
                  <li>Unlimited document generation</li>
                  <li>Scheduled tasks &amp; unlimited packs</li>
                  <li>Starter skill templates (legal · finance · ops)</li>
                  <li>Priority email support</li>
                </ul>
                <button
                  className="price-cta primary"
                  onClick={() => handleCheckout(personalInterval === 'annual' ? 'personal-annual' : 'personal-6mo')}
                  disabled={checkoutLoading !== null || !(personalInterval === 'annual' ? price?.personalAnnual : price?.personal6mo)}
                >
                  {checkoutLoading?.startsWith('personal')
                    ? 'Redirecting…'
                    : (personalInterval === 'annual' ? price?.personalAnnual : price?.personal6mo)
                      ? 'Get Personal'
                      : 'Coming soon'}
                </button>
              </div>

              {/* Team — the collaboration tier */}
              <div className="price-card">
                <div className="price-tier">Team</div>
                <div className="price-amount">
                  {price?.team?.display ?? <span className="price-loading">—</span>}
                  {price?.team && <span className="price-suffix">per seat</span>}
                </div>
                <div className="seat-stepper" aria-label="Team seats">
                  <button onClick={() => setTeamSeats(s => Math.max(5, s - 1))} disabled={teamSeats <= 5} aria-label="Fewer seats">−</button>
                  <span className="seat-count">{teamSeats} seats</span>
                  <button onClick={() => setTeamSeats(s => Math.min(500, s + 1))} aria-label="More seats">+</button>
                  {seatTotal(price?.team ?? null, teamSeats) && (
                    <span>= {seatTotal(price?.team ?? null, teamSeats)}/yr</span>
                  )}
                </div>
                <p className="price-desc">
                  One hub machine, your whole team working with shared context. Min 5 seats.
                </p>
                <ul className="price-features">
                  <li>Everything in Personal</li>
                  <li>LAN team hub — data stays in your office</li>
                  <li>Shared memories &amp; shared context packs</li>
                  <li>Seat-capped roster + API keys</li>
                </ul>
                <button
                  className="price-cta primary"
                  onClick={() => handleCheckout('team', teamSeats)}
                  disabled={checkoutLoading !== null || !price?.team}
                >
                  {checkoutLoading === 'team' ? 'Redirecting…' : price?.team ? 'Get Team' : 'Coming soon'}
                </button>
              </div>

              {/* Business — compliance tier; air-gapped Enterprise via sales */}
              <div className="price-card">
                <div className="price-tier">Business</div>
                <div className="price-amount">
                  {price?.business?.display ?? <span className="price-loading">—</span>}
                  {price?.business && <span className="price-suffix">per seat</span>}
                </div>
                <div className="seat-stepper" aria-label="Business seats">
                  <button onClick={() => setBizSeats(s => Math.max(5, s - 1))} disabled={bizSeats <= 5} aria-label="Fewer seats">−</button>
                  <span className="seat-count">{bizSeats} seats</span>
                  <button onClick={() => setBizSeats(s => Math.min(500, s + 1))} aria-label="More seats">+</button>
                  {seatTotal(price?.business ?? null, bizSeats) && (
                    <span>= {seatTotal(price?.business ?? null, bizSeats)}/yr</span>
                  )}
                </div>
                <p className="price-desc">
                  For regulated teams that must prove what their AI did. Min 5 seats.
                </p>
                <ul className="price-features">
                  <li>Everything in Team</li>
                  <li>Audit-log export — every tool call, attributable</li>
                  <li>Org hub deployment + role controls</li>
                  <li>Security-questionnaire support</li>
                </ul>
                <button
                  className="price-cta primary"
                  onClick={() => handleCheckout('business', bizSeats)}
                  disabled={checkoutLoading !== null || !price?.business}
                >
                  {checkoutLoading === 'business' ? 'Redirecting…' : price?.business ? 'Get Business' : 'Coming soon'}
                </button>
                <p className="price-desc" style={{ marginTop: 12, marginBottom: 0 }}>
                  Air-gapped / on-prem Enterprise from $7,500/yr —{' '}
                  <a href="mailto:support@artha.space?subject=Artha%20Enterprise">talk to us</a>.
                </p>
              </div>
            </div>
            {checkoutError && <p className="price-error">{checkoutError}</p>}
          </div>
        </section>
        )}

        <section className="getting-started" id="getting-started">
          <div className="container">
            <div className="section-header">
              <h2>Before your first launch.</h2>
              <p>Three things worth knowing.</p>
            </div>
            <ol className="notes-list">
              <li>
                <div className="num">01</div>
                <div className="body">
                  <p>
                    Requires <a href="https://ollama.ai">Ollama</a> running
                    locally.
                  </p>
                  <p>
                    We recommend{' '}
                    <code>llama3.2:3b-instruct-q4_K_M</code> to start — fits in
                    8 GB of RAM and is fast on most laptops.
                  </p>
                </div>
              </li>
              <li>
                <div className="num">02</div>
                <div className="body">
                  <p>
                    macOS builds are <strong>signed &amp; notarized by Apple</strong>.
                  </p>
                  <p>
                    They install like any Mac app — no warnings. The Windows
                    installer is unsigned during the beta, so SmartScreen asks
                    once: click &ldquo;More info&rdquo; →
                    &ldquo;Run anyway&rdquo;. A signed Windows build ships when
                    we leave beta.
                  </p>
                </div>
              </li>
              <li>
                <div className="num">03</div>
                <div className="body">
                  <p>The app runs entirely on your machine.</p>
                  <p>
                    No telemetry, no account, no cloud — your data stays local.
                  </p>
                </div>
              </li>
            </ol>
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
                <li>
                  <a href={downloadHref(primaryPlatform)}>Download</a>
                </li>
                <li>
                  <a href="#features">Features</a>
                </li>
                <li>
                  <a href="#getting-started">Get started</a>
                </li>
              </ul>
            </div>
            <div>
              <div className="footer-col-title">Project</div>
              <ul className="footer-links">
                <li>
                  <a href="/privacy">Privacy</a>
                </li>
              </ul>
            </div>
          </div>
          <div className="footer-bottom">
            <div>© 2026 Shree Labs Inc.</div>
            <div>Built locally.</div>
          </div>
          <div className="footer-credit">
            Presented by Shree Labs Inc.
          </div>
        </div>
      </footer>
    </>
  );
}

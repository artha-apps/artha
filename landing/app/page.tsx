'use client';

import Image from 'next/image';
import { useEffect, useState } from 'react';

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
  assets: Partial<Record<Exclude<Platform, 'unknown'>, AssetMeta>>;
} | null;

function bytesToMB(n: number) {
  return `${Math.round(n / 1024 / 1024)} MB`;
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

type PriceInfo = { configured: boolean; display?: string; oneTime?: boolean } | null;

export default function Page() {
  const [platform, setPlatform] = useState<Platform>('unknown');
  const [release, setRelease] = useState<ReleaseInfo>(null);
  const [error, setError] = useState<string | null>(null);

  const [price, setPrice] = useState<PriceInfo>(null);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

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

  async function handleProCheckout() {
    setCheckoutLoading(true);
    setCheckoutError(null);
    try {
      const res = await fetch('/api/stripe/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        setCheckoutError(data.error ?? 'Something went wrong — please try again.');
        setCheckoutLoading(false);
      }
    } catch {
      setCheckoutError('Network error — please try again.');
      setCheckoutLoading(false);
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
              <li>
                <a href="#pricing">Pricing</a>
              </li>
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
            <div className="eyebrow">Local-first · Privacy by design · v0.1.1</div>
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

        <section className="pricing" id="pricing">
          <div className="container">
            <div className="section-header">
              <h2>One purchase. Yours forever.</h2>
              <p>
                Artha is a one-time purchase — no subscription, no accounts.
                Buy a license, run it locally on your machine, and own it forever.
              </p>
            </div>
            <div className="price-grid single">
              <div className="price-card highlight">
                <div className="price-tier">Artha License</div>
                <div className="price-amount">
                  {price?.configured && price.display ? (
                    <>{price.display}</>
                  ) : price === null ? (
                    <span className="price-loading">—</span>
                  ) : (
                    <span className="price-loading">Soon</span>
                  )}
                  {price?.oneTime && <span className="price-suffix">one-time</span>}
                </div>
                <p className="price-desc">
                  A perpetual license to run Artha locally. Pay once, use forever —
                  your key is delivered by email instantly.
                </p>
                <ul className="price-features">
                  <li>Run Artha locally on your machine</li>
                  <li>Perpetual license key — never expires</li>
                  <li>Local AI, document generation &amp; RAG</li>
                  <li>Fully offline · zero telemetry</li>
                  <li>Priority email support</li>
                </ul>
                <button
                  className="price-cta primary"
                  onClick={handleProCheckout}
                  disabled={checkoutLoading || !price?.configured}
                >
                  {checkoutLoading
                    ? 'Redirecting to checkout…'
                    : price?.configured
                      ? 'Buy a license'
                      : 'Coming soon'}
                </button>
                {checkoutError && <p className="price-error">{checkoutError}</p>}
              </div>
            </div>
          </div>
        </section>

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
                    Installers are currently <strong>unsigned</strong>.
                  </p>
                  <p>
                    On macOS, right-click the app and choose Open. On Windows,
                    click &ldquo;More info&rdquo; → &ldquo;Run anyway&rdquo;.
                    Signed builds are on the roadmap.
                  </p>
                </div>
              </li>
              <li>
                <div className="num">03</div>
                <div className="body">
                  <p>The binary is open source and auditable.</p>
                  <p>
                    Run it as a black box, or build from source — your call.
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
            <div>© 2026 Artha</div>
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

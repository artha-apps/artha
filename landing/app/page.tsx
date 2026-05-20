'use client';

import { useEffect, useState } from 'react';

const REPO = 'Noopurtrivedi/artha';
const RELEASES_LATEST = `https://github.com/${REPO}/releases/latest`;
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;

type Platform = 'mac-arm64' | 'mac-intel' | 'windows' | 'linux' | 'unknown';

function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'unknown';
  const ua = navigator.userAgent;
  const platform = (navigator as any).userAgentData?.platform ?? navigator.platform;

  if (/Mac/i.test(platform)) {
    // Best-effort Apple Silicon detection — UA doesn't disclose arch reliably,
    // so we offer both and default to arm64 (newer machines).
    return 'mac-arm64';
  }
  if (/Win/i.test(platform)) return 'windows';
  if (/Linux/i.test(platform) && !/Android/i.test(ua)) return 'linux';
  return 'unknown';
}

type Asset = { name: string; browser_download_url: string; size: number };
type ReleaseInfo = { tag_name: string; assets: Asset[] } | null;

function findAsset(release: ReleaseInfo, predicate: (name: string) => boolean) {
  if (!release) return null;
  return release.assets.find((a) => predicate(a.name)) ?? null;
}

function bytesToMB(n: number) {
  return `${Math.round(n / 1024 / 1024)} MB`;
}

export default function Page() {
  const [platform, setPlatform] = useState<Platform>('unknown');
  const [release, setRelease] = useState<ReleaseInfo>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPlatform(detectPlatform());
    fetch(RELEASES_API)
      .then((r) => {
        if (!r.ok) throw new Error(`GitHub API returned ${r.status}`);
        return r.json();
      })
      .then(setRelease)
      .catch((e) => setError(String(e)));
  }, []);

  const macArm = findAsset(release, (n) => /arm64.*\.dmg$/i.test(n));
  const macX64 = findAsset(release, (n) => /\.dmg$/i.test(n) && !/arm64/i.test(n));
  const winExe = findAsset(release, (n) => /\.exe$/i.test(n));
  const linuxDeb = findAsset(release, (n) => /\.deb$/i.test(n));

  const primary =
    platform === 'mac-arm64'
      ? macArm ?? macX64
      : platform === 'mac-intel'
        ? macX64 ?? macArm
        : platform === 'windows'
          ? winExe
          : platform === 'linux'
            ? linuxDeb
            : null;

  const primaryLabel =
    platform === 'mac-arm64'
      ? 'Download for macOS (Apple Silicon)'
      : platform === 'mac-intel'
        ? 'Download for macOS (Intel)'
        : platform === 'windows'
          ? 'Download for Windows'
          : platform === 'linux'
            ? 'Download for Linux (.deb)'
            : 'See all downloads';

  return (
    <main style={{ maxWidth: 880, margin: '0 auto', padding: '80px 24px' }}>
      <header style={{ marginBottom: 64 }}>
        <div style={{ fontSize: 14, color: 'var(--muted)', marginBottom: 12 }}>
          🪔 Artha
        </div>
        <h1
          style={{
            fontSize: 56,
            fontWeight: 700,
            letterSpacing: '-0.02em',
            lineHeight: 1.05,
            marginBottom: 20,
          }}
        >
          Your work, done. <span style={{ color: 'var(--accent)' }}>Locally.</span>
        </h1>
        <p style={{ fontSize: 20, color: 'var(--muted)', maxWidth: 640 }}>
          Open-source local-first AI agent for document workflows, MCP tools, and
          agentic automation. No data leaves your machine. Ever.
        </p>
      </header>

      <section style={{ marginBottom: 64 }}>
        {primary ? (
          <a
            href={primary.browser_download_url}
            style={{
              display: 'inline-block',
              background: 'var(--accent)',
              color: '#000',
              padding: '16px 28px',
              borderRadius: 10,
              fontWeight: 600,
              fontSize: 16,
              marginRight: 12,
            }}
          >
            {primaryLabel} ({bytesToMB(primary.size)})
          </a>
        ) : (
          <a
            href={RELEASES_LATEST}
            style={{
              display: 'inline-block',
              background: 'var(--accent)',
              color: '#000',
              padding: '16px 28px',
              borderRadius: 10,
              fontWeight: 600,
              fontSize: 16,
              marginRight: 12,
            }}
          >
            {primaryLabel}
          </a>
        )}

        <a
          href={`https://github.com/${REPO}`}
          style={{
            display: 'inline-block',
            border: '1px solid var(--border)',
            padding: '16px 28px',
            borderRadius: 10,
            fontWeight: 500,
            fontSize: 16,
          }}
        >
          View on GitHub →
        </a>

        <div style={{ marginTop: 24, fontSize: 14, color: 'var(--muted)' }}>
          {release ? (
            <>
              Latest release: <strong>{release.tag_name}</strong> · Also available
              for{' '}
              {[
                macArm && (
                  <a
                    key="ma"
                    href={macArm.browser_download_url}
                    style={{ color: 'var(--accent)' }}
                  >
                    macOS arm64
                  </a>
                ),
                macX64 && (
                  <a
                    key="mx"
                    href={macX64.browser_download_url}
                    style={{ color: 'var(--accent)' }}
                  >
                    macOS Intel
                  </a>
                ),
                winExe && (
                  <a
                    key="w"
                    href={winExe.browser_download_url}
                    style={{ color: 'var(--accent)' }}
                  >
                    Windows
                  </a>
                ),
                linuxDeb && (
                  <a
                    key="l"
                    href={linuxDeb.browser_download_url}
                    style={{ color: 'var(--accent)' }}
                  >
                    Linux (.deb)
                  </a>
                ),
              ]
                .filter(Boolean)
                .reduce<React.ReactNode[]>((acc, el, i, arr) => {
                  acc.push(el);
                  if (i < arr.length - 1) acc.push(' · ');
                  return acc;
                }, [])}
            </>
          ) : error ? (
            <>
              Couldn’t fetch release info.{' '}
              <a href={RELEASES_LATEST} style={{ color: 'var(--accent)' }}>
                See all downloads →
              </a>
            </>
          ) : (
            'Loading latest release…'
          )}
        </div>
      </section>

      <section
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
          gap: 16,
          marginBottom: 64,
        }}
      >
        {[
          ['📄 Documents', 'Generate DOCX, PPTX, XLSX, PDF from natural language.'],
          ['🔌 MCP-native', 'Any MCP server becomes a skill your agent can use.'],
          ['🧠 Local RAG', 'Index your files with Ollama embeddings. Zero cloud.'],
          ['🦙 Ollama first', 'Auto-detect, pull, and switch local models.'],
          ['🔒 Zero telemetry', 'No tracking. No accounts. No data exfiltration.'],
          ['🐳 Sandboxed tools', 'Optional Docker sandbox for tool execution.'],
        ].map(([title, body]) => (
          <div
            key={title}
            style={{
              background: 'var(--bg-elev)',
              border: '1px solid var(--border)',
              borderRadius: 12,
              padding: 20,
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 6 }}>{title}</div>
            <div style={{ fontSize: 14, color: 'var(--muted)' }}>{body}</div>
          </div>
        ))}
      </section>

      <section style={{ marginBottom: 48 }}>
        <h2 style={{ fontSize: 20, marginBottom: 12 }}>First-run notes</h2>
        <ul
          style={{
            color: 'var(--muted)',
            paddingLeft: 20,
            fontSize: 15,
            lineHeight: 1.9,
          }}
        >
          <li>
            Requires <a href="https://ollama.ai" style={{ color: 'var(--accent)' }}>Ollama</a> running locally. We recommend{' '}
            <code>llama3.2:3b-instruct-q4_K_M</code> to start.
          </li>
          <li>
            Installers are currently <strong>unsigned</strong>. On macOS, right-click
            the app → Open. On Windows, click "More info" → "Run anyway".
          </li>
          <li>
            Source is <a href={`https://github.com/${REPO}`} style={{ color: 'var(--accent)' }}>MIT-licensed</a>.
            Audit the build, run from source, or trust the binary — your call.
          </li>
        </ul>
      </section>

      <footer
        style={{
          borderTop: '1px solid var(--border)',
          paddingTop: 24,
          fontSize: 13,
          color: 'var(--muted)',
        }}
      >
        Artha (अर्थ) — Sanskrit for purpose, meaning, livelihood. Built with care.
        MIT licensed.
      </footer>
    </main>
  );
}

import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Privacy — Artha',
  description:
    'Artha is local-first. It collects nothing, sends nothing, and never phones home.',
};

export default function PrivacyPage() {
  return (
    <main className="container" style={{ maxWidth: 720, padding: '96px 24px' }}>
      <a
        href="/"
        style={{
          fontSize: 13,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: 'var(--fg-muted)',
        }}
      >
        ← Back
      </a>
      <h1
        style={{
          fontSize: 48,
          fontWeight: 600,
          letterSpacing: '-0.025em',
          lineHeight: 1.1,
          margin: '24px 0 32px',
        }}
      >
        Privacy
      </h1>

      <div
        style={{
          fontSize: 17,
          lineHeight: 1.7,
          color: 'var(--fg)',
          display: 'flex',
          flexDirection: 'column',
          gap: 20,
        }}
      >
        <p>
          Artha is local-first. It runs on your machine and only on your
          machine.
        </p>
        <p>
          <strong>The desktop app.</strong> No accounts. No telemetry. No
          analytics. No background phone-home. It does not contact any Artha
          server, because there isn&apos;t one. The only network calls it makes
          are the ones you explicitly trigger (model downloads via Ollama, MCP
          servers you configure, web searches via tools you enable). Your
          files, prompts, embeddings, and model outputs never leave your
          machine.
        </p>
        <p>
          <strong>This website.</strong> artha.space serves static pages. It
          uses no analytics, no third-party scripts, and no cookies. The
          download flow proxies installer files from the project&apos;s build
          artifacts and does not log who downloaded what.
        </p>
        <p style={{ color: 'var(--fg-muted)', fontSize: 15 }}>
          Last updated: 2026-05-27.
        </p>
      </div>
    </main>
  );
}

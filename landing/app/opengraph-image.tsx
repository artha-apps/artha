import { ImageResponse } from 'next/og';

export const runtime = 'edge';
export const alt = 'Artha — Local-first AI for serious work';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OG() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background: '#FAFAF7',
          padding: 80,
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
          <svg
            viewBox="0 0 64 64"
            width={64}
            height={64}
            xmlns="http://www.w3.org/2000/svg"
            fill="#0A1628"
          >
            <path
              fillRule="evenodd"
              d="M6 6 H58 V58 H6 Z M14 14 H50 V50 H14 Z"
            />
            <rect x="19" y="22" width="10" height="20" />
          </svg>
          <div
            style={{
              fontSize: 36,
              fontWeight: 600,
              letterSpacing: '-0.02em',
              color: '#0A1628',
            }}
          >
            Artha
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
          <div
            style={{
              fontSize: 84,
              fontWeight: 600,
              lineHeight: 1.05,
              letterSpacing: '-0.028em',
              color: '#0A1628',
              maxWidth: 900,
            }}
          >
            Serious work.{' '}
            <span style={{ color: '#0035ED' }}>Fully local.</span>
          </div>
          <div
            style={{
              fontSize: 28,
              lineHeight: 1.4,
              color: '#5B6577',
              maxWidth: 800,
            }}
          >
            An open-source AI workspace. Your data never leaves your machine.
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            paddingTop: 24,
            borderTop: '1px solid #E8E4DA',
            fontSize: 20,
            color: '#5B6577',
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            fontWeight: 500,
          }}
        >
          <div>artha.space</div>
          <div>Open source · MIT · Zero telemetry</div>
        </div>
      </div>
    ),
    size,
  );
}

import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'License — Artha',
  description: 'Artha is released under the MIT License.',
};

const MIT = `MIT License

Copyright (c) 2026 Noopur Trivedi

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

export default function LicensePage() {
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
        License
      </h1>
      <pre
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 14,
          lineHeight: 1.7,
          color: 'var(--fg)',
          background: 'var(--code-bg)',
          padding: 32,
          borderRadius: 6,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
{MIT}
      </pre>
    </main>
  );
}

import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'License — Artha',
  description: 'Artha is proprietary software. Copyright © 2026 Shree Labs Inc.',
};

const LICENSE_TEXT = `Artha — Proprietary Software License
Copyright (c) 2026 Shree Labs Inc. All rights reserved.

Artha is proprietary software owned by Shree Labs Inc. It is made available
only under the terms of its LICENSE file. Except where the Company has signed a
separate written agreement with you, no right is granted to use, copy, modify,
distribute, sublicense, sell, or create derivative works of this software or
its source code. All rights not expressly granted in writing are reserved.

Artha is built with third-party open-source components, each licensed under its
own terms; those licenses are acknowledged in the THIRD-PARTY-NOTICES file
distributed with the software.

The "Artha" name, the अ mark, and the Artha logo are trademarks of Shree Labs
Inc. and are not licensed.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

For licensing inquiries, contact support@artha.space.`;

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
{LICENSE_TEXT}
      </pre>
    </main>
  );
}

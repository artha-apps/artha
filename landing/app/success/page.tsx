import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Thank you — Artha Pro',
  robots: { index: false, follow: false },
};

export default function SuccessPage() {
  return (
    <main className="success-wrap">
      <div className="container success-inner">
        <div className="success-badge" aria-hidden="true">✓</div>
        <h1>You&rsquo;re all set.</h1>
        <p className="success-lede">
          Thanks for upgrading to <strong>Artha Pro</strong>. We&rsquo;ve emailed your
          license key — paste it into <strong>Artha → Settings → License</strong> to
          unlock Pro.
        </p>
        <ol className="success-steps">
          <li>
            <span className="num">01</span>
            <span>Check your inbox for an email from Artha with your license key.</span>
          </li>
          <li>
            <span className="num">02</span>
            <span>Open Artha → Settings → License and paste the key.</span>
          </li>
          <li>
            <span className="num">03</span>
            <span>
              No email after a few minutes? Check spam, or write to{' '}
              <a href="mailto:support@artha.space">support@artha.space</a>.
            </span>
          </li>
        </ol>
        <Link className="btn-primary" href="/">
          Back to artha.space
        </Link>
      </div>
    </main>
  );
}

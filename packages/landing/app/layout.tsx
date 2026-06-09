/**
 * Root layout for the Artha marketing site.
 *
 * Sets global metadata (OG tags, Twitter card) used by Next.js for every page,
 * injects the Inter font via Google Fonts, and applies the dark base styles
 * (bg-gray-950 / text-gray-100) that every child page inherits.
 */
import type { Metadata } from 'next';
import './globals.css';

// Static metadata is defined here (not in page.tsx) so it applies site-wide
// and is included in the HTML <head> during static export.
export const metadata: Metadata = {
  title: 'Artha — Local-first AI productivity agent',
  description:
    'Artha runs entirely on your machine. Document workflows, MCP tools, zero cloud.',
  openGraph: {
    title: 'Artha — Local-first AI productivity agent',
    description: 'Run AI agents on your own hardware. Privacy-first, MCP-native, zero cloud.',
    type: 'website',
    url: 'https://artha.app',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'Artha' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Artha — Local-first AI productivity agent',
    description: 'Run AI agents on your own hardware. Privacy-first, MCP-native, zero cloud.',
    images: ['/og.png'],
  },
};

/** Wraps every page with the HTML shell, fonts, and global dark-mode body styles. */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Preconnect hints cut font-load latency; crossOrigin is required for gstatic. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      {/* antialiased smooths font rendering on macOS/retina screens */}
      <body className="bg-gray-950 text-gray-100 font-sans antialiased">{children}</body>
    </html>
  );
}

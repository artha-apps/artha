import type { Metadata, Viewport } from 'next';
import { Inter, Marcellus } from 'next/font/google';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
  weight: ['400', '500', '600', '700'],
});

// Marcellus — refined geometric Roman caps, used only for the brand wordmark.
// Thin, wide proportions match the lockup's display type without needing the
// actual custom typeface.
const marcellus = Marcellus({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-marcellus',
  weight: ['400'],
});

export const metadata: Metadata = {
  metadataBase: new URL('https://artha.space'),
  title: 'Artha — Local-first AI for serious work',
  description:
    'A local-first AI workspace for documents, spreadsheets, and agentic workflows. Zero telemetry. Your data never leaves your machine.',
  openGraph: {
    title: 'Artha — Local-first AI for serious work',
    description:
      'A local-first AI workspace. DOCX, PPTX, XLSX, PDF — generated on your machine. Zero telemetry.',
    url: 'https://artha.space',
    siteName: 'Artha',
    type: 'website',
    images: [
      {
        url: '/og-image.png',
        width: 1200,
        height: 630,
        alt: 'Artha',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Artha — Local-first AI for serious work',
    description:
      'A local-first AI workspace. Zero telemetry. Your data never leaves your machine.',
    images: ['/og-image.png'],
  },
  icons: {
    icon: [
      { url: '/favicon-16.png', sizes: '16x16', type: 'image/png' },
      { url: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/favicon-256.png', sizes: '256x256', type: 'image/png' },
    ],
    apple: '/apple-touch-icon.png',
    shortcut: '/favicon-32.png',
  },
};

export const viewport: Viewport = {
  themeColor: '#fafaf7',
  colorScheme: 'light',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${inter.variable} ${marcellus.variable}`}>
      <body>{children}</body>
    </html>
  );
}

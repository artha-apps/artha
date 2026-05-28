import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
  weight: ['400', '500', '600', '700'],
});

export const metadata: Metadata = {
  metadataBase: new URL('https://artha.space'),
  title: 'Artha — Local-first AI for serious work',
  description:
    'A local-first AI workspace for documents, spreadsheets, and agentic workflows. Open source. Zero telemetry. Your data never leaves your machine.',
  openGraph: {
    title: 'Artha — Local-first AI for serious work',
    description:
      'Open source local-first AI workspace. DOCX, PPTX, XLSX, PDF — generated on your machine. Zero telemetry.',
    url: 'https://artha.space',
    siteName: 'Artha',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Artha — Local-first AI for serious work',
    description:
      'Open source local-first AI workspace. Zero telemetry. Your data never leaves your machine.',
  },
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
    ],
    shortcut: '/favicon.svg',
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
    <html lang="en" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}

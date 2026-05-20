import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Artha — Your work, done. Locally.',
  description:
    'Open-source local-first AI agent for document workflows, MCP tools, and agentic automation. No data leaves your machine.',
  openGraph: {
    title: 'Artha — Your work, done. Locally.',
    description:
      'Open-source local-first AI agent. DOCX, PPTX, XLSX, PDF — generated on your machine.',
    type: 'website',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

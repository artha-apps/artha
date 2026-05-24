'use client';

const GITHUB_OWNER = 'Noopurtrivedi';
const GITHUB_REPO = 'artha';

export default function NavBar({ releaseUrl }: { releaseUrl: string }) {
  return (
    <nav className="fixed top-0 left-0 right-0 z-50 border-b border-gray-800/80 bg-gray-950/80 backdrop-blur-sm">
      <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between">
        {/* Logo */}
        <a href="/" className="flex items-center gap-2 font-bold text-white text-lg">
          <span className="w-7 h-7 rounded-lg bg-artha-600 flex items-center justify-center text-white text-sm">
            A
          </span>
          Artha
        </a>

        {/* Links */}
        <div className="hidden sm:flex items-center gap-6 text-sm text-gray-400">
          <a href="#how" className="hover:text-white transition-colors">How it works</a>
          <a href="#features" className="hover:text-white transition-colors">Features</a>
          <a
            href={`https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-white transition-colors"
          >
            GitHub
          </a>
        </div>

        {/* CTA */}
        <a
          href={releaseUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="px-4 py-1.5 rounded-lg bg-artha-600 hover:bg-artha-500 text-white text-sm font-medium transition-colors"
        >
          Download
        </a>
      </div>
    </nav>
  );
}

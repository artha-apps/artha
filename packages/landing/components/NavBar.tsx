/**
 * Sticky top navigation bar for the Artha landing page.
 *
 * The bar is fixed so it stays visible while the user scrolls. Links use
 * in-page fragment anchors (#how, #features) for the two main sections,
 * plus an external GitHub link. The "Download" CTA button receives the
 * resolved release URL from the parent so it always points at the latest tag.
 */
'use client';

// Duplicated from page.tsx because NavBar is a standalone component that may
// be used independently; import from a shared constants module if this grows.
const GITHUB_OWNER = 'Noopurtrivedi';
const GITHUB_REPO = 'artha';

/** Props accepted by NavBar. */
interface NavBarProps {
  /** Fully resolved GitHub release page URL (e.g. /releases/tag/v1.2.0). */
  releaseUrl: string;
}

/** @see NavBarProps */
export default function NavBar({ releaseUrl }: NavBarProps) {
  return (
    {/* backdrop-blur-sm + semi-transparent bg creates the frosted-glass effect over page content */}
    <nav className="fixed top-0 left-0 right-0 z-50 border-b border-gray-800/80 bg-gray-950/80 backdrop-blur-sm">
      <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between">
        {/* Logo */}
        <a href="/" className="flex items-center gap-2 font-bold text-white text-lg">
          <span className="w-7 h-7 rounded-lg bg-artha-600 flex items-center justify-center text-white text-sm">
            A
          </span>
          Artha
        </a>

        {/* Links — hidden on mobile (< sm) to avoid cramping the narrow bar */}
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

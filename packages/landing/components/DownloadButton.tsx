/**
 * Smart download button for the Artha landing page.
 *
 * On mount it:
 *   1. Detects the visitor's OS via navigator.platform / userAgent.
 *   2. Fetches the latest GitHub release's asset list via the GitHub REST API.
 *   3. Resolves the direct download URL for the visitor's platform (.dmg / .exe / .deb).
 *
 * While the API call is in-flight the button falls back to the generic
 * /releases/latest URL provided by the parent (releaseUrl prop), so there is
 * never a broken link. Once assets are loaded, alternate-platform links are
 * shown below the primary button so every visitor can get any build.
 */
'use client';

import { useEffect, useState } from 'react';

/** Supported OS variants; 'unknown' when detection is inconclusive. */
type OS = 'mac' | 'windows' | 'linux' | 'unknown';

/** Visual size variant — 'xl' is used in the bottom CTA, 'lg' in the Hero. */
type Size = 'lg' | 'xl';

const GITHUB_OWNER = 'Noopurtrivedi';
const GITHUB_REPO = 'artha';

/** Minimal shape of a GitHub release asset returned by the REST API. */
interface Asset {
  name: string;
  browser_download_url: string;
}

/**
 * Sniffs the user's operating system from browser globals.
 * Returns 'unknown' when running outside a browser (e.g. during SSR/static export).
 */
function detectOS(): OS {
  // navigator is undefined in Node.js during Next.js static generation.
  if (typeof navigator === 'undefined') return 'unknown';
  const p = navigator.platform.toLowerCase();
  const ua = navigator.userAgent.toLowerCase();
  // platform is more reliable; userAgent is checked as a fallback for edge cases.
  if (p.startsWith('mac') || ua.includes('mac os')) return 'mac';
  if (p.startsWith('win') || ua.includes('windows')) return 'windows';
  if (p.startsWith('linux') || ua.includes('linux')) return 'linux';
  return 'unknown';
}

/**
 * Returns the human-readable button label and sub-text for a given OS.
 * The sub-text clarifies the installer format (DMG / EXE / DEB) so users
 * know what they're downloading before they click.
 */
function labelForOS(os: OS) {
  switch (os) {
    case 'mac':     return { label: 'Download for macOS', sub: 'Apple Silicon + Intel · .dmg' };
    case 'windows': return { label: 'Download for Windows', sub: '64-bit · .exe installer' };
    case 'linux':   return { label: 'Download for Linux', sub: '64-bit · .deb package' };
    default:        return { label: 'Download Artha', sub: 'macOS · Windows · Linux' };
  }
}

/**
 * Resolves the direct CDN download URL for the given OS from the release asset list.
 * Matches by file extension (.dmg / .exe / .deb) — the first matching asset wins.
 * Falls back to the generic /releases/latest page if no matching asset is found.
 */
function assetUrlForOS(os: OS, assets: Asset[]): string {
  // Map each OS to its canonical installer extension.
  const ext = os === 'mac' ? '.dmg' : os === 'windows' ? '.exe' : os === 'linux' ? '.deb' : '';
  // 'unknown' OS has no extension; send the user to the releases page instead.
  if (!ext) return `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
  const match = assets.find((a) => a.name.toLowerCase().endsWith(ext));
  // Prefer the direct asset URL; fall back to releases page if the asset is missing.
  return match?.browser_download_url ?? `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
}

/** Props for the DownloadButton component. */
interface DownloadButtonProps {
  /**
   * GitHub release page URL provided by the parent — used as the href while
   * the asset list is still loading or if the API call fails entirely.
   */
  releaseUrl: string;
  /**
   * Visual size of the primary button.
   * 'xl' → used in the bottom Download CTA section (larger padding).
   * 'lg' → used in the Hero section (default).
   */
  size?: Size;
}

/** @see DownloadButtonProps */
export default function DownloadButton({
  releaseUrl,
  size = 'lg',
}: DownloadButtonProps) {
  // OS starts as 'unknown' to match the SSR render; set on mount via detectOS().
  const [os, setOS] = useState<OS>('unknown');
  const [assets, setAssets] = useState<Asset[]>([]);
  // loading=true until the GitHub API call settles, preventing href flicker.
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // OS detection runs client-side only (navigator is unavailable during SSR).
    setOS(detectOS());
    // Fetch the asset list for the latest release to resolve per-platform URLs.
    fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`)
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data.assets)) setAssets(data.assets);
      })
      // Network failure is silently ignored; the fallback releaseUrl is still valid.
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // While loading (or if assets are empty), fall back to the generic releases page.
  const href = loading || assets.length === 0 ? releaseUrl : assetUrlForOS(os, assets);
  const { label, sub } = labelForOS(os);

  // Padding/font-size differ between the Hero button (lg) and the CTA button (xl).
  const sizeClasses =
    size === 'xl'
      ? 'px-8 py-4 text-lg rounded-2xl'
      : 'px-6 py-3.5 text-base rounded-xl';

  return (
    <div className="flex flex-col items-center gap-1">
      {/* Primary download link — styled as a button, opens the release in a new tab */}
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={`inline-flex items-center gap-3 bg-artha-600 hover:bg-artha-500 active:bg-artha-700 text-white font-semibold transition-all duration-150 glow ${sizeClasses}`}
      >
        {/* Download arrow icon (SVG inline to avoid an extra icon dependency) */}
        <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
        </svg>
        {label}
      </a>
      <span className="text-xs text-gray-500">{sub} · Free & open source</span>
      {/* Other platforms — only shown when OS is identified, so users can grab a
          build for a different machine without hunting through the releases page. */}
      {os !== 'unknown' && (
        <div className="flex gap-4 mt-1 text-xs text-gray-600">
          {(['mac', 'windows', 'linux'] as OS[])
            // Exclude the already-highlighted primary OS.
            .filter((o) => o !== os)
            .map((o) => (
              <a
                key={o}
                href={assets.length ? assetUrlForOS(o, assets) : releaseUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-gray-400 transition-colors capitalize"
              >
                {o === 'mac' ? 'macOS' : o === 'windows' ? 'Windows' : 'Linux'}
              </a>
            ))}
        </div>
      )}
    </div>
  );
}

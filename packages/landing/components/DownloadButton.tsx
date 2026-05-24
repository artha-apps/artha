'use client';

import { useEffect, useState } from 'react';

type OS = 'mac' | 'windows' | 'linux' | 'unknown';
type Size = 'lg' | 'xl';

const GITHUB_OWNER = 'Noopurtrivedi';
const GITHUB_REPO = 'artha';

interface Asset {
  name: string;
  browser_download_url: string;
}

function detectOS(): OS {
  if (typeof navigator === 'undefined') return 'unknown';
  const p = navigator.platform.toLowerCase();
  const ua = navigator.userAgent.toLowerCase();
  if (p.startsWith('mac') || ua.includes('mac os')) return 'mac';
  if (p.startsWith('win') || ua.includes('windows')) return 'windows';
  if (p.startsWith('linux') || ua.includes('linux')) return 'linux';
  return 'unknown';
}

function labelForOS(os: OS) {
  switch (os) {
    case 'mac':     return { label: 'Download for macOS', sub: 'Apple Silicon + Intel · .dmg' };
    case 'windows': return { label: 'Download for Windows', sub: '64-bit · .exe installer' };
    case 'linux':   return { label: 'Download for Linux', sub: '64-bit · .deb package' };
    default:        return { label: 'Download Artha', sub: 'macOS · Windows · Linux' };
  }
}

function assetUrlForOS(os: OS, assets: Asset[]): string {
  const ext = os === 'mac' ? '.dmg' : os === 'windows' ? '.exe' : os === 'linux' ? '.deb' : '';
  if (!ext) return `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
  const match = assets.find((a) => a.name.toLowerCase().endsWith(ext));
  return match?.browser_download_url ?? `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
}

export default function DownloadButton({
  releaseUrl,
  size = 'lg',
}: {
  releaseUrl: string;
  size?: Size;
}) {
  const [os, setOS] = useState<OS>('unknown');
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setOS(detectOS());
    fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`)
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data.assets)) setAssets(data.assets);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const href = loading || assets.length === 0 ? releaseUrl : assetUrlForOS(os, assets);
  const { label, sub } = labelForOS(os);

  const sizeClasses =
    size === 'xl'
      ? 'px-8 py-4 text-lg rounded-2xl'
      : 'px-6 py-3.5 text-base rounded-xl';

  return (
    <div className="flex flex-col items-center gap-1">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={`inline-flex items-center gap-3 bg-artha-600 hover:bg-artha-500 active:bg-artha-700 text-white font-semibold transition-all duration-150 glow ${sizeClasses}`}
      >
        <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
        </svg>
        {label}
      </a>
      <span className="text-xs text-gray-500">{sub} · Free & open source</span>
      {/* Other platforms */}
      {os !== 'unknown' && (
        <div className="flex gap-4 mt-1 text-xs text-gray-600">
          {(['mac', 'windows', 'linux'] as OS[])
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

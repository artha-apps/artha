/**
 * /api/download/:platform — resolves the latest release asset for the
 * requested platform and issues a 302 redirect to GitHub's CDN URL.
 *
 * Streaming the binary through Vercel edge would hit the 30-second timeout
 * for large DMG/EXE files. A redirect is instant and lets GitHub's CDN serve
 * the file directly — no size or timeout constraints.
 *
 * Requires GITHUB_TOKEN env var (fine-grained PAT, Contents:read) to avoid
 * GitHub API rate limits (60 req/hr unauthenticated vs 5,000 authenticated).
 */
import type { NextRequest } from 'next/server';

export const runtime = 'edge';

const REPO = 'artha-apps/artha';
const ALLOWED: ReadonlySet<string> = new Set([
  'mac-arm64',
  'mac-intel',
  'windows',
  'linux',
]);

type GHAsset = { name: string; browser_download_url: string };
type GHRelease = { assets: GHAsset[] };

function pickAsset(assets: GHAsset[], platform: string): GHAsset | null {
  if (platform === 'mac-arm64') {
    return (
      assets.find((a) => /arm64.*\.dmg$/i.test(a.name)) ??
      assets.find((a) => /\.dmg$/i.test(a.name)) ??
      null
    );
  }
  if (platform === 'mac-intel') {
    return (
      assets.find((a) => /\.dmg$/i.test(a.name) && !/arm64/i.test(a.name)) ??
      assets.find((a) => /\.dmg$/i.test(a.name)) ??
      null
    );
  }
  if (platform === 'windows') {
    return assets.find((a) => /\.exe$/i.test(a.name)) ?? null;
  }
  if (platform === 'linux') {
    return assets.find((a) => /\.deb$/i.test(a.name)) ?? null;
  }
  return null;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { platform: string } },
) {
  if (!ALLOWED.has(params.platform)) {
    return new Response('Unknown platform', { status: 404 });
  }

  const token = process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = {
    'User-Agent': 'artha-space',
    Accept: 'application/vnd.github+json',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const releaseRes = await fetch(
    `https://api.github.com/repos/${REPO}/releases/latest`,
    { headers, next: { revalidate: 300 } },
  );
  if (!releaseRes.ok) {
    return new Response('Release lookup failed', { status: 502 });
  }

  const release = (await releaseRes.json()) as GHRelease;
  const asset = pickAsset(release.assets ?? [], params.platform);
  if (!asset) {
    return new Response('No installer for that platform yet', { status: 404 });
  }

  // Redirect to GitHub's CDN — fast, no proxy timeout, no size limit.
  return Response.redirect(asset.browser_download_url, 302);
}

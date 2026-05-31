/**
 * /api/download/:platform — resolves the matching installer for the latest
 * release and 302-redirects to GitHub's browser_download_url.
 *
 * Why redirect instead of proxy-streaming: streaming a ~140 MB binary through an
 * Edge Function is unreliable (the browser could end up saving the file under
 * GitHub's storage GUID with no extension when the stream/header path hiccups).
 * GitHub's download URL carries the correct filename via response-content-
 * disposition, so a redirect is robust. The repo is public, so there's no
 * benefit to hiding the github.com URL.
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

type GHAsset = { id: number; name: string; url: string; browser_download_url: string };
type GHRelease = { assets: GHAsset[] };

function pickAsset(
  assets: GHAsset[],
  platform: string,
): GHAsset | null {
  if (platform === 'mac-arm64') {
    return (
      assets.find((a) => /arm64.*\.dmg$/i.test(a.name)) ??
      assets.find((a) => /\.dmg$/i.test(a.name)) ??
      null
    );
  }
  if (platform === 'mac-intel') {
    return (
      assets.find(
        (a) => /\.dmg$/i.test(a.name) && !/arm64/i.test(a.name),
      ) ??
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
  { params }: { params: Promise<{ platform: string }> },
) {
  const { platform } = await params;
  if (!ALLOWED.has(platform)) {
    return new Response('Unknown platform', { status: 404 });
  }

  const token = process.env.GITHUB_TOKEN;

  // Repo is public — if the token is missing/expired (401/403), retry
  // unauthenticated so a bad token can't wedge downloads on a stale release.
  const url = `https://api.github.com/repos/${REPO}/releases/latest`;
  const hdrs = (auth: boolean) => ({
    'User-Agent': 'artha-space',
    Accept: 'application/vnd.github+json',
    ...(auth && token ? { Authorization: `Bearer ${token}` } : {}),
  });
  // no-store: skip Next's durable Data Cache (it wedged stale); the redirect's
  // own short CDN cache is enough.
  let releaseRes = await fetch(url, { headers: hdrs(true), cache: 'no-store' });
  if ((releaseRes.status === 401 || releaseRes.status === 403) && token) {
    releaseRes = await fetch(url, { headers: hdrs(false), cache: 'no-store' });
  }
  if (!releaseRes.ok) {
    return new Response('Release lookup failed', { status: 502 });
  }
  const release = (await releaseRes.json()) as GHRelease;
  const asset = pickAsset(release.assets ?? [], platform);
  if (!asset?.browser_download_url) {
    return new Response('No installer for that platform yet', {
      status: 404,
    });
  }

  // Redirect to GitHub's download URL — it serves the binary from its CDN with
  // the correct filename. 302 (not 308) so the browser re-resolves on each
  // download as new releases ship; don't let the redirect itself be cached long.
  return new Response(null, {
    status: 302,
    headers: {
      location: asset.browser_download_url,
      'cache-control': 'public, max-age=0, s-maxage=60',
    },
  });
}

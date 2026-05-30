/**
 * /api/download/:platform — proxies the matching installer through artha.space
 * so the browser never sees a github.com URL. Edge runtime, streamed.
 *
 * Repo (artha-apps/artha) is public, so GITHUB_TOKEN is optional. Assets are
 * still fetched via the API endpoint with Accept: application/octet-stream so
 * the browser never sees a github.com URL; the token, when present, only raises
 * the rate limit.
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

type GHAsset = { id: number; name: string; url: string };
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

  const releaseRes = await fetch(
    `https://api.github.com/repos/${REPO}/releases/latest`,
    {
      headers: {
        'User-Agent': 'artha-space',
        Accept: 'application/vnd.github+json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      next: { revalidate: 300 },
    },
  );
  if (!releaseRes.ok) {
    return new Response('Release lookup failed', { status: 502 });
  }
  const release = (await releaseRes.json()) as GHRelease;
  const asset = pickAsset(release.assets ?? [], platform);
  if (!asset) {
    return new Response('No installer for that platform yet', {
      status: 404,
    });
  }

  // Fetch the asset binary via the API endpoint with octet-stream accept.
  // GitHub returns a 302 to its CDN with a short-lived signed URL;
  // redirect:follow handles it. Auth is optional for a public repo.
  const fileRes = await fetch(asset.url, {
    headers: {
      'User-Agent': 'artha-space',
      Accept: 'application/octet-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    redirect: 'follow',
  });
  if (!fileRes.ok || !fileRes.body) {
    return new Response('Download proxy failed', { status: 502 });
  }

  const safeName = asset.name.replace(/[^a-zA-Z0-9._-]/g, '_');

  return new Response(fileRes.body, {
    status: 200,
    headers: {
      'content-type':
        fileRes.headers.get('content-type') ?? 'application/octet-stream',
      'content-disposition': `attachment; filename="${safeName}"`,
      ...(fileRes.headers.get('content-length')
        ? { 'content-length': fileRes.headers.get('content-length') as string }
        : {}),
      'cache-control': 'public, max-age=0, s-maxage=300',
    },
  });
}

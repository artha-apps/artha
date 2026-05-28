/**
 * /api/download/:platform — proxies the matching installer through artha.space
 * so the browser never sees a github.com URL. Edge runtime, streamed.
 *
 * Repo is private — uses GITHUB_TOKEN to fetch the release metadata and to
 * download the asset via the API endpoint with Accept: application/octet-stream
 * (the canonical path for private-repo asset downloads).
 */
import type { NextRequest } from 'next/server';

export const runtime = 'edge';

const REPO = 'Noopurtrivedi/artha';
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
  { params }: { params: { platform: string } },
) {
  if (!ALLOWED.has(params.platform)) {
    return new Response('Unknown platform', { status: 404 });
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return new Response('Download proxy not configured', { status: 503 });
  }

  const releaseRes = await fetch(
    `https://api.github.com/repos/${REPO}/releases/latest`,
    {
      headers: {
        'User-Agent': 'artha-space',
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
      },
      next: { revalidate: 300 },
    },
  );
  if (!releaseRes.ok) {
    return new Response('Release lookup failed', { status: 502 });
  }
  const release = (await releaseRes.json()) as GHRelease;
  const asset = pickAsset(release.assets ?? [], params.platform);
  if (!asset) {
    return new Response('No installer for that platform yet', {
      status: 404,
    });
  }

  // Fetch the asset binary via the API endpoint with octet-stream accept —
  // this is the documented private-repo asset download path. GitHub returns a
  // 302 to its CDN with a short-lived signed URL; redirect:follow handles it.
  const fileRes = await fetch(asset.url, {
    headers: {
      'User-Agent': 'artha-space',
      Accept: 'application/octet-stream',
      Authorization: `Bearer ${token}`,
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

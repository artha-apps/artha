/**
 * /api/release — sanitized latest-release info, no GitHub URLs ever returned to
 * the browser. The page calls this instead of api.github.com.
 *
 * Repo (artha-apps/artha) is public, so GITHUB_TOKEN is optional — when set it
 * raises the GitHub API rate limit, but the route works without it.
 */
import type { NextRequest } from 'next/server';

export const runtime = 'edge';

const REPO = 'artha-apps/artha';

type GHAsset = { name: string; size: number };
type GHRelease = { tag_name: string; published_at: string; assets: GHAsset[] };

type Platform = 'mac-arm64' | 'mac-intel' | 'windows' | 'linux';

function platformOf(filename: string): Platform | null {
  if (/arm64.*\.dmg$/i.test(filename)) return 'mac-arm64';
  if (/\.dmg$/i.test(filename)) return 'mac-intel';
  if (/\.exe$/i.test(filename)) return 'windows';
  if (/\.deb$/i.test(filename)) return 'linux';
  return null;
}

/** Fetch the latest release. Tries the token (higher rate limit) first, but the
 *  repo is public — so if the token is missing/expired (401/403), retry
 *  unauthenticated rather than getting stuck serving a stale cached release. */
async function fetchLatest(token?: string): Promise<Response> {
  const url = `https://api.github.com/repos/${REPO}/releases/latest`;
  const headers = (auth: boolean) => ({
    'User-Agent': 'artha-space',
    Accept: 'application/vnd.github+json',
    ...(auth && token ? { Authorization: `Bearer ${token}` } : {}),
  });
  // Short revalidate so a freshly-published release shows up within ~1 min.
  // no-store: never use Next's durable Data Cache (it wedged on a stale release
  // and wouldn't revalidate). The CDN response cache below absorbs bursts.
  let res = await fetch(url, { headers: headers(true), cache: 'no-store' });
  if ((res.status === 401 || res.status === 403) && token) {
    res = await fetch(url, { headers: headers(false), cache: 'no-store' });
  }
  return res;
}

export async function GET(_req: NextRequest) {
  const token = process.env.GITHUB_TOKEN;

  const ghRes = await fetchLatest(token);

  if (!ghRes.ok) {
    return Response.json(
      { error: 'release_unavailable', status: ghRes.status },
      { status: 502 },
    );
  }

  const release = (await ghRes.json()) as GHRelease;

  const assetsByPlatform: Partial<
    Record<Platform, { name: string; size: number }>
  > = {};
  for (const a of release.assets ?? []) {
    const p = platformOf(a.name);
    if (p && !assetsByPlatform[p]) {
      assetsByPlatform[p] = { name: a.name, size: a.size };
    }
  }

  return Response.json(
    {
      tag_name: release.tag_name,
      published_at: release.published_at,
      assets: assetsByPlatform,
    },
    {
      headers: {
        'cache-control': 'public, max-age=0, s-maxage=60',
      },
    },
  );
}

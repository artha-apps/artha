/**
 * /api/release — sanitized latest-release info, no GitHub URLs ever returned to
 * the browser. The page calls this instead of api.github.com.
 *
 * Repo is private: requires GITHUB_TOKEN env var (fine-scoped PAT with
 * Contents:read on Noopurtrivedi/artha).
 */
import type { NextRequest } from 'next/server';

export const runtime = 'edge';

const REPO = 'Noopurtrivedi/artha';

type GHAsset = { name: string; size: number };
type GHRelease = { tag_name: string; assets: GHAsset[] };

type Platform = 'mac-arm64' | 'mac-intel' | 'windows' | 'linux';

function platformOf(filename: string): Platform | null {
  if (/arm64.*\.dmg$/i.test(filename)) return 'mac-arm64';
  if (/\.dmg$/i.test(filename)) return 'mac-intel';
  if (/\.exe$/i.test(filename)) return 'windows';
  if (/\.deb$/i.test(filename)) return 'linux';
  return null;
}

export async function GET(_req: NextRequest) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return Response.json(
      { error: 'release_token_missing' },
      { status: 503 },
    );
  }

  const ghRes = await fetch(
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
    { tag_name: release.tag_name, assets: assetsByPlatform },
    {
      headers: {
        'cache-control': 'public, max-age=0, s-maxage=300',
      },
    },
  );
}

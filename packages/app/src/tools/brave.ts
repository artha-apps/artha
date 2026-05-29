/**
 * Brave Search API client.
 *
 * Free tier: 2,000 queries / month. Returns high-quality, real-time web
 * results without any intermediary instance to maintain. Requires an API key
 * from https://brave.com/search/api/
 *
 * Docs: https://api.search.brave.com/app/documentation/web-search/get-started
 */

import { SearchResult, SearchOptions } from './searxng';

/** Shape of a single result item inside the `web.results` array. All fields are
 *  optional because the API silently omits them when unavailable. */
interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
  /** ISO-8601-like age string, e.g. "2024-03-14T10:00:00". */
  page_age?: string;
}

/** Top-level Brave Search API response envelope. Only the `web` bucket is used;
 *  the API also returns `news`, `videos`, etc. which Artha currently ignores. */
interface BraveSearchResponse {
  web?: {
    results?: BraveWebResult[];
  };
}

const BRAVE_API_BASE = 'https://api.search.brave.com/res/v1/web/search';

/**
 * Query the Brave Search API. Throws on network errors or invalid API keys
 * so the caller can fall through to the next backend.
 */
export async function braveSearch(
  apiKey: string,
  query: string,
  opts: SearchOptions = {}
): Promise<SearchResult[]> {
  const params = new URLSearchParams({
    q: query,
    count: String(Math.min(opts.count ?? 8, 20)),
  });

  if (opts.freshness) {
    // Brave's freshness codes differ from SearXNG's time_range strings.
    // Map our shared SearchOptions values to Brave's compact abbreviations.
    const map: Record<NonNullable<SearchOptions['freshness']>, string> = {
      day: 'pd',
      week: 'pw',
      month: 'pm',
      year: 'py',
    };
    params.set('freshness', map[opts.freshness]);
  }

  const res = await fetch(`${BRAVE_API_BASE}?${params.toString()}`, {
    headers: {
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': apiKey,
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`Brave Search API returned HTTP ${res.status}`);
  }

  const json = await res.json() as BraveSearchResponse;
  const items = json.web?.results ?? [];
  return items
    .filter(r => r.url)
    .map(r => ({
      title: r.title ?? '',
      url: r.url!,
      snippet: (r.description ?? '').slice(0, 300),
      published_at: r.page_age,
    }));
}

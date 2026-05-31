/**
 * SearXNG client — privacy-respecting metasearch.
 * The default instance is configurable in Settings; users running their own
 * SearXNG locally get fully zero-cloud search. Public instances are a
 * convenience starting point.
 */

/** Normalised result shape returned by every search backend (Brave, SearXNG,
 *  DuckDuckGo). Downstream consumers (web.ts, docs.ts) only deal with this. */
export interface SearchResult {
  title: string;
  url: string;
  /** Short excerpt shown to the model (300-char cap applied by each backend). */
  snippet: string;
  /** ISO publication date, present only when the backend provides it. */
  published_at?: string;
}

/** Options shared across all three search backends. */
export interface SearchOptions {
  /** Number of results to return. Each backend may apply its own cap. */
  count?: number;
  freshness?: 'day' | 'week' | 'month' | 'year';
  language?: string;
}

/** Raw result object from the SearXNG JSON endpoint. All fields are optional
 *  because SearXNG aggregates heterogeneous engines that may omit any field. */
interface SearXNGJsonResult {
  url?: string;
  title?: string;
  /** SearXNG's term for the result snippet/excerpt. */
  content?: string;
  publishedDate?: string;
}

/** Top-level SearXNG /search?format=json response envelope. */
interface SearXNGResponse {
  results?: SearXNGJsonResult[];
}

// SearXNG's time_range parameter values happen to mirror our freshness strings,
// but we map explicitly so any future divergence only requires a change here.
const FRESHNESS_TO_TIMERANGE: Record<NonNullable<SearchOptions['freshness']>, string> = {
  day: 'day',
  week: 'week',
  month: 'month',
  year: 'year',
};

/**
 * Query a SearXNG instance. Tries each instance URL in order until one
 * responds successfully. Throws if every instance fails.
 */
export async function search(
  instances: string[],
  query: string,
  opts: SearchOptions = {}
): Promise<SearchResult[]> {
  if (instances.length === 0) {
    throw new Error('No SearXNG instances configured. Set one in Settings → Web.');
  }

  const params = new URLSearchParams({
    q: query,
    format: 'json',
    language: opts.language ?? 'en',
  });
  if (opts.freshness) params.set('time_range', FRESHNESS_TO_TIMERANGE[opts.freshness]);

  const errors: string[] = [];

  for (const raw of instances) {
    const base = raw.replace(/\/+$/, '');
    const url = `${base}/search?${params.toString()}`;
    try {
      const res = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Artha/0.1 (+local-agent; respects robots.txt)',
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        errors.push(`${base}: HTTP ${res.status}`);
        continue;
      }
      const json = await res.json() as SearXNGResponse;
      const items = (json.results ?? []).slice(0, opts.count ?? 10);
      return items.map(r => ({
        title: r.title ?? '',
        url: r.url ?? '',
        snippet: (r.content ?? '').slice(0, 300),
        published_at: r.publishedDate,
      })).filter(r => r.url);
    } catch (err) {
      errors.push(`${base}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(`All SearXNG instances failed: ${errors.join('; ')}`);
}

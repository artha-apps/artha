/**
 * DuckDuckGo HTML scraper — zero-config web search fallback.
 *
 * Uses the public HTML endpoint (not the JSON API, which only returns Instant
 * Answers and not full web results). Parses result anchors from the HTML
 * with a lightweight regex approach — no headless browser required.
 *
 * Rate limits: informal; this is intended as a last-resort fallback when
 * neither Brave nor any SearXNG instance is available.
 */

import { SearchResult, SearchOptions } from './searxng';

/**
 * Scrape DuckDuckGo HTML results for `query`. Returns up to `opts.count`
 * results. Throws on network failure so the caller can surface the error.
 */
export async function duckduckgoSearch(
  query: string,
  opts: SearchOptions = {}
): Promise<SearchResult[]> {
  const count = opts.count ?? 8;

  // DDG's HTML endpoint accepts POST with URL-encoded body
  const body = new URLSearchParams({
    q: query,
    kl: 'wt-wt',   // region: worldwide
    kp: '-2',       // safe search: moderate
    kaf: '1',       // no ads
  });

  const res = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (compatible; Artha/0.1; local-agent)',
      'Accept': 'text/html',
    },
    body: body.toString(),
    redirect: 'follow',
    signal: AbortSignal.timeout(12_000),
  });

  if (!res.ok) {
    throw new Error(`DuckDuckGo returned HTTP ${res.status}`);
  }

  const html = await res.text();
  const results: SearchResult[] = [];

  // Parse links and snippets separately then zip them by index.
  // Result anchors are in <a class="result__a" href="...">title</a>
  // Snippets are in <a class="result__snippet">...</a>
  const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html)) !== null) {
    snippets.push(sm[1].replace(/<[^>]+>/g, '').trim());
  }

  let idx = 0;
  let lm: RegExpExecArray | null;
  while ((lm = linkRe.exec(html)) !== null && results.length < count) {
    const rawUrl = lm[1];
    const title = lm[2].replace(/<[^>]+>/g, '').trim();

    // DDG redirect URLs start with //duckduckgo.com/l/?uddg= — decode them
    let url = rawUrl;
    if (url.startsWith('//duckduckgo.com/l/')) {
      try {
        const u = new URL('https:' + url);
        url = decodeURIComponent(u.searchParams.get('uddg') ?? url);
      } catch { /* leave as-is */ }
    }

    // Skip DDG-internal links
    if (!url.startsWith('http')) { idx++; continue; }

    results.push({
      title,
      url,
      snippet: (snippets[idx] ?? '').slice(0, 300),
    });
    idx++;
  }

  if (results.length === 0) {
    throw new Error('DuckDuckGo returned no parseable results');
  }

  return results;
}

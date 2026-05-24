/**
 * Built-in Web Tools — gives Artha first-class ability to read URLs and
 * search the web without any user-installed MCP servers.
 *
 * Design principles:
 *   - Local-first: SearXNG by default, no API keys required
 *   - Polite: respects robots.txt unless explicitly bypassed for a host
 *   - Cheap: SQLite-backed cache with configurable TTL
 *   - Honest UA: identifies itself as a local agent
 *   - Citable: every result carries source URL + title for chat citations
 */
import OpenAI from 'openai';
import robotsParser from 'robots-parser';
import { getDb } from '../db/schema';
import { extractReadable } from './readability';
import { search as searxngSearch, SearchResult } from './searxng';
import { braveSearch } from './brave';
import { duckduckgoSearch } from './duckduckgo';

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_INSTANCES = ['https://searx.be', 'https://search.brave4u.com'];
const DEFAULT_CACHE_TTL_SECONDS = 3600;            // 1 hour
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;         // 5MB
const USER_AGENT = 'Artha/0.1 (+local-agent; respects robots.txt)';
const ALLOWED_CONTENT_TYPES = [
  'text/html',
  'application/xhtml+xml',
  'text/plain',
  'application/json',
  'application/xml',
  'text/xml',
  'text/markdown',
];

export interface WebConfig {
  searxng_instances: string[];
  cache_ttl_seconds: number;
  respect_robots: boolean;
  robots_override_hosts: string[]; // hosts allowed to bypass robots
  timeout_ms: number;
  max_bytes: number;
  /** Optional Brave Search API key. When set, Brave is tried before SearXNG.
   *  Free tier: 2,000 queries/month. Get a key at https://brave.com/search/api/ */
  brave_api_key?: string;
}

export const DEFAULT_WEB_CONFIG: WebConfig = {
  searxng_instances: DEFAULT_INSTANCES,
  cache_ttl_seconds: DEFAULT_CACHE_TTL_SECONDS,
  respect_robots: true,
  robots_override_hosts: [],
  timeout_ms: DEFAULT_TIMEOUT_MS,
  max_bytes: DEFAULT_MAX_BYTES,
  brave_api_key: '',
};

// Loaded lazily so the tool module doesn't require the DB at import time.
function loadConfig(): WebConfig {
  try {
    const db = getDb();
    const row = db
      .prepare(`SELECT settings_json FROM users WHERE user_id='default'`)
      .get() as { settings_json: string } | undefined;
    const settings = JSON.parse(row?.settings_json ?? '{}') as { web?: Partial<WebConfig> };
    return { ...DEFAULT_WEB_CONFIG, ...(settings.web ?? {}) };
  } catch {
    return DEFAULT_WEB_CONFIG;
  }
}

// ── Citation tracker ─────────────────────────────────────────────────────────
// The orchestrator pulls citations off each invocation so chat messages can
// render them under the assistant bubble. Keyed by a token the orchestrator
// passes in; cleared after the workflow finishes.

export interface Citation {
  url: string;
  title: string;
  fetched_at: number;
}

const pendingCitations = new Map<string, Citation[]>();

export function startCitationCollection(token: string): void {
  pendingCitations.set(token, []);
}

export function drainCitations(token: string): Citation[] {
  const list = pendingCitations.get(token) ?? [];
  pendingCitations.delete(token);
  // De-dupe by URL, keep first occurrence (search order matters)
  const seen = new Set<string>();
  return list.filter(c => {
    if (seen.has(c.url)) return false;
    seen.add(c.url);
    return true;
  });
}

let activeToken: string | null = null;

export function setActiveCitationToken(token: string | null): void {
  activeToken = token;
}

function record(citation: Citation): void {
  if (!activeToken) return;
  const list = pendingCitations.get(activeToken);
  if (list) list.push(citation);
}

/** Public hook so other tool modules (e.g. browser.ts) can attribute citations
 *  to the active workflow without re-implementing the collector. No-op if no
 *  workflow is currently collecting. */
export function recordCitation(citation: Citation): void {
  record(citation);
}

// ── Tool schemas (OpenAI function format) ────────────────────────────────────

export const WEB_TOOL_SCHEMAS: OpenAI.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description:
        'Fetch a single URL and return its cleaned, readable content as markdown. ' +
        'Use this when the user gives you a URL, or after web_search to read a result. ' +
        'Caches responses for an hour by default — repeated reads of the same URL are free.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'Absolute http(s) URL to fetch.',
          },
          mode: {
            type: 'string',
            enum: ['readable', 'raw'],
            description:
              '"readable" (default) strips nav/ads and returns markdown. ' +
              '"raw" returns the original HTML/text — only use when you specifically need page structure.',
          },
          max_chars: {
            type: 'number',
            description: 'Truncate returned content to this many characters. Default 20000.',
          },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the web via SearXNG. Returns a list of results with title, URL, and snippet. ' +
        'Use this when the user asks a question that needs current information. ' +
        'Follow up with web_fetch on the most promising results to read the full page.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query.',
          },
          count: {
            type: 'number',
            description: 'Number of results to return. Default 8.',
          },
          freshness: {
            type: 'string',
            enum: ['day', 'week', 'month', 'year'],
            description: 'Restrict results to a recent time window.',
          },
        },
        required: ['query'],
      },
    },
  },
];

// ── Robots.txt enforcement ───────────────────────────────────────────────────

const robotsCache = new Map<string, { allowed: (path: string) => boolean; fetched_at: number }>();
const ROBOTS_CACHE_TTL = 24 * 60 * 60; // 24h

async function isAllowedByRobots(targetUrl: URL): Promise<boolean> {
  const origin = targetUrl.origin;
  const now = Math.floor(Date.now() / 1000);
  const cached = robotsCache.get(origin);
  if (cached && now - cached.fetched_at < ROBOTS_CACHE_TTL) {
    return cached.allowed(targetUrl.toString());
  }

  let allowedFn: (path: string) => boolean;
  try {
    const robotsUrl = `${origin}/robots.txt`;
    const res = await fetch(robotsUrl, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) {
      const body = await res.text();
      const parser = robotsParser(robotsUrl, body);
      allowedFn = (u: string) => parser.isAllowed(u, USER_AGENT) ?? true;
    } else {
      // No robots.txt or unreachable — treat as fully allowed (standard practice)
      allowedFn = () => true;
    }
  } catch {
    allowedFn = () => true;
  }
  robotsCache.set(origin, { allowed: allowedFn, fetched_at: now });
  return allowedFn(targetUrl.toString());
}

// ── web_fetch implementation ─────────────────────────────────────────────────

interface FetchResult {
  url: string;
  title: string;
  content: string;
  content_type: string;
  fetched_at: number;
  from_cache: boolean;
  truncated: boolean;
}

async function webFetchImpl(args: { url: string; mode?: string; max_chars?: number }): Promise<string> {
  const config = loadConfig();
  const url = String(args.url ?? '').trim();
  const mode = (args.mode === 'raw' ? 'raw' : 'readable') as 'readable' | 'raw';
  const maxChars = typeof args.max_chars === 'number' && args.max_chars > 0 ? args.max_chars : 20_000;

  if (!url) throw new Error('web_fetch: url is required');

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`web_fetch: invalid URL "${url}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`web_fetch: only http(s) URLs are supported (got ${parsed.protocol})`);
  }

  // Cache check
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const cached = db
    .prepare(`SELECT * FROM web_cache WHERE url=?`)
    .get(url) as
    | { url: string; title: string; content: string; content_type: string; fetched_at: number }
    | undefined;

  if (cached && now - cached.fetched_at < config.cache_ttl_seconds) {
    const content = cached.content.slice(0, maxChars);
    record({ url, title: cached.title, fetched_at: cached.fetched_at });
    const result: FetchResult = {
      url,
      title: cached.title,
      content,
      content_type: cached.content_type,
      fetched_at: cached.fetched_at,
      from_cache: true,
      truncated: content.length < cached.content.length,
    };
    return JSON.stringify(result);
  }

  // Robots.txt
  if (config.respect_robots && !config.robots_override_hosts.includes(parsed.host)) {
    const allowed = await isAllowedByRobots(parsed);
    if (!allowed) {
      throw new Error(
        `web_fetch: blocked by robots.txt for ${parsed.host}. ` +
        `Add the host to robots_override_hosts in Settings → Web to bypass.`
      );
    }
  }

  // Network fetch
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(config.timeout_ms),
  });

  if (!res.ok) {
    throw new Error(`web_fetch: ${url} returned HTTP ${res.status}`);
  }

  const contentType = (res.headers.get('content-type') ?? 'text/html').toLowerCase();
  const baseType = contentType.split(';')[0].trim();
  if (!ALLOWED_CONTENT_TYPES.some(t => baseType === t || baseType.startsWith(t))) {
    throw new Error(`web_fetch: refusing content-type "${baseType}" — not in allowlist`);
  }

  // Cap body size
  const contentLength = Number(res.headers.get('content-length') ?? '0');
  if (contentLength > config.max_bytes) {
    throw new Error(`web_fetch: response too large (${contentLength} bytes > ${config.max_bytes})`);
  }

  const raw = await res.text();
  if (raw.length > config.max_bytes) {
    throw new Error(`web_fetch: response too large (${raw.length} bytes > ${config.max_bytes})`);
  }

  // Extract
  let title = '';
  let content = raw;
  if (mode === 'readable' && (baseType === 'text/html' || baseType === 'application/xhtml+xml')) {
    const article = extractReadable(raw, url);
    if (article) {
      title = article.title;
      content = article.content;
    } else {
      // Readability failed — fall back to a title pull + raw text
      const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      if (titleMatch) title = titleMatch[1].trim();
      content = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
  } else {
    const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleMatch) title = titleMatch[1].trim();
  }

  // Persist to cache
  try {
    db.prepare(
      `INSERT INTO web_cache (url, title, content, content_type, etag, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET
         title=excluded.title,
         content=excluded.content,
         content_type=excluded.content_type,
         etag=excluded.etag,
         fetched_at=excluded.fetched_at`
    ).run(url, title, content, baseType, res.headers.get('etag'), now);
  } catch (err) {
    console.warn('[web_fetch] cache write failed:', err);
  }

  record({ url, title, fetched_at: now });

  const truncated = content.length > maxChars;
  const result: FetchResult = {
    url,
    title,
    content: truncated ? content.slice(0, maxChars) : content,
    content_type: baseType,
    fetched_at: now,
    from_cache: false,
    truncated,
  };
  return JSON.stringify(result);
}

// ── web_search implementation ────────────────────────────────────────────────

async function webSearchImpl(args: { query: string; count?: number; freshness?: string }): Promise<string> {
  const config = loadConfig();
  const query = String(args.query ?? '').trim();
  if (!query) throw new Error('web_search: query is required');

  const count = typeof args.count === 'number' && args.count > 0 ? Math.min(args.count, 20) : 8;
  const freshness = ['day', 'week', 'month', 'year'].includes(String(args.freshness))
    ? (args.freshness as 'day' | 'week' | 'month' | 'year')
    : undefined;

  // ── Search backend priority chain ────────────────────────────────────────
  // 1. Brave Search API  — if api key configured (highest quality, real-time)
  // 2. SearXNG instances — privacy-preserving metasearch (configured or defaults)
  // 3. DuckDuckGo HTML   — zero-config fallback (last resort)
  let results: SearchResult[] = [];
  let provider = 'searxng';
  const errors: string[] = [];

  // 1 — Brave Search
  if (config.brave_api_key?.trim()) {
    try {
      results = await braveSearch(config.brave_api_key.trim(), query, { count, freshness });
      provider = 'brave';
    } catch (err) {
      errors.push(`Brave: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 2 — SearXNG (if Brave not used or failed)
  if (results.length === 0 && config.searxng_instances.length > 0) {
    try {
      results = await searxngSearch(config.searxng_instances, query, { count, freshness });
      provider = 'searxng';
    } catch (err) {
      errors.push(`SearXNG: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 3 — DuckDuckGo HTML fallback
  if (results.length === 0) {
    try {
      results = await duckduckgoSearch(query, { count, freshness });
      provider = 'duckduckgo';
    } catch (err) {
      errors.push(`DuckDuckGo: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (results.length === 0) {
    throw new Error(`All search backends failed: ${errors.join('; ')}`);
  }

  // Record each result as a (lightweight) citation so the chat can show them
  // even before the agent calls web_fetch on a specific link.
  const now = Math.floor(Date.now() / 1000);
  for (const r of results) {
    record({ url: r.url, title: r.title, fetched_at: now });
  }

  return JSON.stringify({ query, provider, count: results.length, results });
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

export async function invokeWebTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'web_fetch':
      return webFetchImpl(args as { url: string; mode?: string; max_chars?: number });
    case 'web_search':
      return webSearchImpl(args as { query: string; count?: number; freshness?: string });
    default:
      throw new Error(`Unknown web tool: ${name}`);
  }
}

export function isWebTool(name: string): boolean {
  return name === 'web_fetch' || name === 'web_search';
}

// ── Cache admin ──────────────────────────────────────────────────────────────

export function clearWebCache(): number {
  const db = getDb();
  const before = db.prepare(`SELECT COUNT(*) as n FROM web_cache`).get() as { n: number };
  db.prepare(`DELETE FROM web_cache`).run();
  return before.n;
}

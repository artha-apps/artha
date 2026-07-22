/**
 * Provider probes — model discovery + connection testing with normalized
 * errors (Phase A commit 6; ErrorNormalizer v0 per the provider SDK ports).
 *
 * Electron-free and SDK-free on purpose: plain fetch with explicit timeouts,
 * so probes are fast (no SDK retry loops — a probe should answer "is this
 * config right?" immediately, not after five backoffs) and unit-testable
 * against the mock provider fixture. Never logs or embeds API keys.
 */

export type ProbeErrorKind =
  | 'auth' | 'rate_limit' | 'not_found' | 'bad_request'
  | 'unavailable' | 'network' | 'timeout' | 'malformed' | 'unknown';

export interface ProbeError {
  kind: ProbeErrorKind;
  status?: number;
  /** Human-readable, key-free, shown verbatim in the UI. */
  message: string;
  /** Whether retrying later without config changes could succeed. */
  retryable: boolean;
}

export type DiscoveryResult =
  | { ok: true; models: string[] }
  | { ok: false; error: ProbeError };

export type ConnectionTestResult =
  | { ok: true; latencyMs: number; model: string }
  | { ok: false; error: ProbeError };

/** Map an HTTP status + provider body to a normalized, user-safe error. */
function normalizeHttpError(status: number, bodyText: string): ProbeError {
  // Providers use the OpenAI {error:{message}} shape or bare text — take
  // whichever exists, clipped, with no key material (we never echo requests).
  let providerMsg = '';
  try {
    const j = JSON.parse(bodyText) as { error?: { message?: string } | string };
    providerMsg = typeof j.error === 'string' ? j.error : j.error?.message ?? '';
  } catch { providerMsg = bodyText; }
  providerMsg = (providerMsg || '').slice(0, 300);

  if (status === 401 || status === 403) {
    return { kind: 'auth', status, retryable: false, message: providerMsg || 'The provider rejected this API key.' };
  }
  if (status === 429) {
    return { kind: 'rate_limit', status, retryable: true, message: providerMsg || 'Rate limit reached — try again shortly.' };
  }
  if (status === 404) {
    return { kind: 'not_found', status, retryable: false, message: providerMsg || 'Endpoint or model not found — check the base URL and model name.' };
  }
  if (status >= 400 && status < 500) {
    return { kind: 'bad_request', status, retryable: false, message: providerMsg || `The provider rejected the request (${status}).` };
  }
  return { kind: 'unavailable', status, retryable: true, message: providerMsg || `The provider is unavailable (${status}).` };
}

function normalizeThrow(err: unknown): ProbeError {
  if (err instanceof Error && err.name === 'AbortError') {
    return { kind: 'timeout', retryable: true, message: 'The provider did not respond in time.' };
  }
  return { kind: 'network', retryable: true, message: 'Could not reach the provider — check the base URL and your connection.' };
}

async function timedFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: c.signal });
  } finally {
    clearTimeout(t);
  }
}

const authHeaders = (apiKey?: string): Record<string, string> =>
  apiKey && apiKey.trim() ? { authorization: `Bearer ${apiKey.trim()}` } : {};

/** GET {base}/models — de-duplicated, sorted model ids. An empty list is a
 *  SUCCESS (the UI falls back to manual model entry, not an error state). */
export async function discoverModels(baseUrl: string, apiKey?: string, timeoutMs = 10_000): Promise<DiscoveryResult> {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`;
  let res: Response;
  try {
    res = await timedFetch(url, { headers: authHeaders(apiKey) }, timeoutMs);
  } catch (err) {
    return { ok: false, error: normalizeThrow(err) };
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) return { ok: false, error: normalizeHttpError(res.status, text) };
  try {
    const json = JSON.parse(text) as { data?: { id?: string }[] };
    const ids = (json.data ?? []).map(m => m?.id).filter((id): id is string => !!id);
    return { ok: true, models: [...new Set(ids)].sort() };
  } catch {
    return { ok: false, error: { kind: 'malformed', retryable: false, message: 'The endpoint responded, but not with an OpenAI-compatible model list.' } };
  }
}

/** One cheap non-streaming completion — proves base URL + key + model all
 *  work together, and measures round-trip latency. */
export async function testConnection(
  baseUrl: string, apiKey: string | undefined, model: string, timeoutMs = 20_000,
): Promise<ConnectionTestResult> {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const started = Date.now();
  let res: Response;
  try {
    res = await timedFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(apiKey) },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
        max_tokens: 8,
        temperature: 0,
        stream: false,
      }),
    }, timeoutMs);
  } catch (err) {
    return { ok: false, error: normalizeThrow(err) };
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) return { ok: false, error: normalizeHttpError(res.status, text) };
  try {
    const json = JSON.parse(text) as { choices?: { message?: { content?: string | null } }[] };
    if (!Array.isArray(json.choices)) throw new Error('no choices');
    return { ok: true, latencyMs: Date.now() - started, model };
  } catch {
    return { ok: false, error: { kind: 'malformed', retryable: false, message: 'The endpoint responded, but not with an OpenAI-compatible completion.' } };
  }
}

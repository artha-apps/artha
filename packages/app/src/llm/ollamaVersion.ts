/**
 * Ollama version helpers — the small, pure piece of the runtime story.
 *
 * Ollama gates new model architectures on the SERVER version (a pull fails
 * with HTTP 412 "requires a newer version of Ollama"), so Artha must be able
 * to (a) read the running server's version, (b) compare it with a catalog
 * entry's `minOllamaVersion` BEFORE attempting a pull, and (c) recognise the
 * 412 text when a hand-typed tag hits it anyway. Everything here is
 * side-effect-free except `getServerVersion` (one GET /api/version).
 */

export type Semver = [number, number, number];

/** Parse 'v0.33.2', '0.33.2', '0.33.2-rc1' → [0,33,2]; null when unparseable. */
export function parseVersion(s: string | null | undefined): Semver | null {
  if (typeof s !== 'string') return null;
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(s.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

/** -1 when a < b, 0 when equal, 1 when a > b. Unparseable input sorts lowest. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return -1;
    if (pa[i] > pb[i]) return 1;
  }
  return 0;
}

/** True when `installed` satisfies `min` (>=). An unknown installed version
 *  is treated as satisfying — we never block a pull on a guess; the server's
 *  own 412 is the authoritative refusal and is mapped to an honest message. */
export function versionSatisfies(installed: string | null | undefined, min: string | undefined): boolean {
  if (!min || !installed) return true;
  if (!parseVersion(installed) || !parseVersion(min)) return true;
  return compareVersions(installed, min) >= 0;
}

/** Does an Ollama pull error mean "your server is too old"? Matches the 412
 *  wording Ollama uses for architecture-gated models. */
export function isOutdatedPullError(message: string | undefined | null): boolean {
  if (!message) return false;
  return /requires a newer version of ollama/i.test(message) || /\b412\b.*newer version/i.test(message);
}

/** Read the running server's version (GET /api/version). Null when the server
 *  is down or answers something unexpected. */
export async function getServerVersion(
  host = 'http://localhost:11434',
  timeoutMs = 1500,
  fetchFn: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeoutMs);
    const res = await fetchFn(`${host}/api/version`, { signal: c.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const json = (await res.json()) as { version?: unknown };
    return typeof json.version === 'string' && parseVersion(json.version) ? json.version : null;
  } catch {
    return null;
  }
}

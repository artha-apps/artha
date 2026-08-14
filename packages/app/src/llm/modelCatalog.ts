/**
 * Model catalog — the curated "Browse & Install" list, remote-refreshed.
 *
 * The catalog is DATA, not code (same philosophy as providerPresets.ts): each
 * entry describes one pullable Ollama model with the pre-install facts the
 * raw Ollama library doesn't provide — RAM floor, download size, speed class,
 * and an honest one-liner. Post-install quality is NOT decided here; the
 * local benchmark (router/benchmark.ts → model_profiles) measures that on the
 * user's machine for any model, catalog or not.
 *
 * Freshness: the list is fetched from artha.space (a static, git-reviewed
 * JSON — no identifiers sent, plain GET) so newly released models reach users
 * without an app release. BUNDLED_CATALOG is the offline/air-gapped/fetch-
 * failure fallback and ships in the binary; the panel never renders empty.
 */

export interface CatalogEntry {
  /** Ollama pull tag, e.g. 'qwen2.5:7b'. */
  tag: string;
  label: string;
  /** Family name for the colored badge (Llama, Qwen, Muse…). */
  family: string;
  /** Human-readable download size, e.g. '~4.7 GB'. */
  size: string;
  /** Minimum system RAM in GB — the Browse tab warns below this. */
  ramRequired: number;
  /** Speed class shown on the card: 'Very fast' | 'Fast' | 'Medium' | 'Slow'. */
  speed: string;
  description: string;
  /** Optional highlight chip, e.g. 'Best for agents'. */
  badge: string | null;
  /** Oldest Ollama version known to run this model (new architectures need a
   *  recent engine). Display hint only — pulls are never blocked on it. */
  minOllamaVersion?: string;
}

export interface ModelCatalog {
  entries: CatalogEntry[];
  /** Where this list came from — 'bundled' means the remote fetch failed or
   *  hasn't happened; the UI treats both identically. */
  source: 'remote' | 'bundled';
}

/** Shipped-in-binary fallback. Mirrored by landing/public/model-catalog.json —
 *  update BOTH when curating (the remote copy is what installed apps see). */
export const BUNDLED_CATALOG: CatalogEntry[] = [
  {
    tag: 'llama3.2:3b',
    label: 'Llama 3.2 3B',
    family: 'Llama',
    size: '~2 GB',
    ramRequired: 4,
    speed: 'Fast',
    description: "Meta's lightweight model. Great for quick tasks on any Mac.",
    badge: 'Recommended for most',
  },
  {
    tag: 'llama3.2:1b',
    label: 'Llama 3.2 1B',
    family: 'Llama',
    size: '~0.8 GB',
    ramRequired: 2,
    speed: 'Very fast',
    description: 'Ultra-lightweight. Instant responses, ideal for low-RAM machines.',
    badge: null,
  },
  {
    tag: 'qwen2.5:7b',
    label: 'Qwen 2.5 7B',
    family: 'Qwen',
    size: '~4.7 GB',
    ramRequired: 8,
    speed: 'Medium',
    description: 'Best tool-calling accuracy. The default Artha model for agentic tasks.',
    badge: 'Best for agents',
  },
  {
    tag: 'muse-glimmer:30b',
    label: 'Muse Glimmer 30B',
    family: 'Muse',
    size: '~19 GB',
    ramRequired: 32,
    speed: 'Medium',
    description:
      "Meta's open agentic model (Aug 2026) — built for local multi-step tool use, coding, and vision. Strongest local agent if your machine can hold it.",
    badge: 'New',
    minOllamaVersion: '0.11.0',
  },
  {
    tag: 'qwen2.5:14b',
    label: 'Qwen 2.5 14B',
    family: 'Qwen',
    size: '~9 GB',
    ramRequired: 16,
    speed: 'Medium',
    description: 'Stronger reasoning and tool use. Needs 16 GB+ RAM.',
    badge: null,
  },
  {
    tag: 'qwen2.5:72b',
    label: 'Qwen 2.5 72B',
    family: 'Qwen',
    size: '~47 GB',
    ramRequired: 64,
    speed: 'Slow',
    description:
      'Flagship Qwen — top-tier tool-calling and reasoning. Best agentic accuracy. Needs a 64 GB+ machine.',
    badge: 'Most capable',
  },
  {
    tag: 'llama3.3:70b',
    label: 'Llama 3.3 70B',
    family: 'Llama',
    size: '~43 GB',
    ramRequired: 48,
    speed: 'Slow',
    description: "Meta's latest 70B — excellent reasoning and solid tool use. Needs 48 GB+ RAM.",
    badge: null,
  },
  {
    tag: 'mistral:7b',
    label: 'Mistral 7B',
    family: 'Mistral',
    size: '~4.1 GB',
    ramRequired: 8,
    speed: 'Medium',
    description: 'Strong general-purpose European model. Great instruction following.',
    badge: null,
  },
  {
    tag: 'gemma3:4b',
    label: 'Gemma 3 4B',
    family: 'Gemma',
    size: '~3.3 GB',
    ramRequired: 6,
    speed: 'Fast',
    description: "Google's efficient model. Good balance of speed and capability.",
    badge: null,
  },
  {
    tag: 'phi4:14b',
    label: 'Phi 4 14B',
    family: 'Phi',
    size: '~8.9 GB',
    ramRequired: 16,
    speed: 'Medium',
    description: "Microsoft's reasoning-focused model. Excellent at structured tasks.",
    badge: null,
  },
  {
    tag: 'deepseek-r1:7b',
    label: 'DeepSeek R1 7B',
    family: 'DeepSeek',
    size: '~4.7 GB',
    ramRequired: 8,
    speed: 'Medium',
    description: 'Chain-of-thought reasoning model. Shows its thinking process.',
    badge: null,
  },
  {
    tag: 'codellama:7b',
    label: 'CodeLlama 7B',
    family: 'CodeLlama',
    size: '~3.8 GB',
    ramRequired: 8,
    speed: 'Medium',
    description: 'Specialized for coding tasks. Use for programming workflows.',
    badge: null,
  },
  {
    tag: 'nomic-embed-text',
    label: 'Nomic Embed Text',
    family: 'Nomic',
    size: '~0.3 GB',
    ramRequired: 2,
    speed: 'Very fast',
    description: 'Embedding model for RAG and semantic search. Not a chat model.',
    badge: 'For RAG',
  },
];

/** Static file on the landing site (Vercel CDN). Anonymous GET, no params. */
const CATALOG_URL = 'https://artha.space/model-catalog.json';
/** How long a successful remote fetch is reused before refetching. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const FETCH_TIMEOUT_MS = 5_000;
/** Hard cap on remote entries — a corrupted/hostile file can't flood the UI. */
const MAX_ENTRIES = 50;

/** Valid Ollama tag: name[/name][:tag], safe charset only. The tag is passed
 *  verbatim to Ollama's HTTP API (JSON body, never a shell), so this guards
 *  UI sanity more than injection — but stay strict anyway. */
const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)?(:[A-Za-z0-9._-]+)?$/;

/** True when a remote entry is shaped, sized, and charset-safe enough to render. */
function isValidEntry(e: unknown): e is CatalogEntry {
  if (typeof e !== 'object' || e === null) return false;
  const o = e as Record<string, unknown>;
  const str = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max;
  return (
    str(o.tag, 80) && TAG_RE.test(o.tag as string) &&
    str(o.label, 60) &&
    str(o.family, 24) &&
    str(o.size, 16) &&
    typeof o.ramRequired === 'number' && Number.isFinite(o.ramRequired) &&
    (o.ramRequired as number) >= 1 && (o.ramRequired as number) <= 1024 &&
    str(o.speed, 20) &&
    str(o.description, 240) &&
    (o.badge === null || str(o.badge, 40)) &&
    (o.minOllamaVersion === undefined || str(o.minOllamaVersion, 16))
  );
}

/** Strip unknown keys so the renderer only ever sees the declared shape. */
function toEntry(e: CatalogEntry): CatalogEntry {
  const { tag, label, family, size, ramRequired, speed, description, badge, minOllamaVersion } = e;
  return { tag, label, family, size, ramRequired, speed, description, badge, ...(minOllamaVersion ? { minOllamaVersion } : {}) };
}

let cached: { catalog: ModelCatalog; at: number } | null = null;

/** Test hook — clears the module-level remote cache. */
export function resetCatalogCache(): void {
  cached = null;
}

/**
 * The catalog to show: remote when reachable and well-formed, bundled
 * otherwise. Never throws; a bundled result is not cached, so the next call
 * retries the remote fetch.
 */
export async function getModelCatalog(
  fetchFn: typeof fetch = fetch,
): Promise<ModelCatalog> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.catalog;

  try {
    const res = await fetchFn(CATALOG_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`catalog fetch ${res.status}`);
    const json = (await res.json()) as { schemaVersion?: number; models?: unknown[] };
    if (json.schemaVersion !== 1 || !Array.isArray(json.models)) {
      throw new Error('catalog schema mismatch');
    }
    const entries = json.models.filter(isValidEntry).map(toEntry).slice(0, MAX_ENTRIES);
    if (entries.length === 0) throw new Error('catalog empty after validation');
    const catalog: ModelCatalog = { entries, source: 'remote' };
    cached = { catalog, at: Date.now() };
    return catalog;
  } catch {
    // Offline, blocked, slow, or malformed — the bundled list is always valid.
    return { entries: BUNDLED_CATALOG, source: 'bundled' };
  }
}

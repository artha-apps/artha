/**
 * Context-window sizing for Ollama requests.
 *
 * `num_ctx` is a hard ceiling: when a prompt exceeds it, Ollama silently keeps
 * the TAIL and drops the head — the system prompt and the user's request go
 * first, and the model answers "you haven't specified a task" (observed
 * 2026-09-05: a routed 14B with an 8192 ceiling got an 8,734-token prompt,
 * Ollama logged "truncating input prompt limit=4098 prompt=8734"). A static
 * per-model number can never be right, because prompt size is a property of
 * the request (tool schemas alone are ~5k tokens with 44 tools). So size the
 * window from the request, in stable buckets — Ollama re-allocates the KV cache
 * when num_ctx changes, so we never want a different value on every call.
 */

export const NUM_CTX_BUCKETS = [8192, 16384, 32768, 65536, 131072] as const;

/** ~3.2 chars per token is a conservative (over-counting) estimate for English
 *  prose + JSON tool schemas on Qwen/Llama tokenizers. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.2);
}

/** Choose the smallest bucket that holds the estimated prompt plus the reply
 *  budget with 25% headroom, never below the configured/legacy floor. Ollama
 *  clamps anything above the model's trained context itself (with a warning),
 *  so exceeding it is harmless; undershooting is what truncates. */
export function pickNumCtx(
  configured: number | undefined,
  estimatedPromptTokens: number,
  replyBudget: number,
): number {
  const floor = Math.max(configured ?? 8192, 8192);
  const needed = Math.ceil(estimatedPromptTokens * 1.25 + Math.max(replyBudget, 0));
  const bucket = NUM_CTX_BUCKETS.find(b => b >= needed) ?? NUM_CTX_BUCKETS[NUM_CTX_BUCKETS.length - 1];
  return Math.max(floor, bucket);
}

// ── Per-model prompt-size calibration ─────────────────────────────────────
//
// `estimateTokens` counts characters, which matches Qwen/Llama templates. Some
// chat templates render the same request far larger: muse-glimmer's "glimmer"
// renderer turned an 8.8k-token conversation into ~35k (Ollama log 2026-11-12,
// "truncating input prompt limit=16387 prompt=35089"), so a model escalated
// to mid-run lost the head of its prompt — the system prompt and the user's
// request — and answered "I don't have a current task". Ollama reports the
// real size back (prompt_eval_count), so learn each model's ratio from it.

/** model → real prompt tokens per estimated token (≥ 1; only ever grows —
 *  over-sizing the window is cheap, under-sizing truncates). */
const learnedScale = new Map<string, number>();

/** A prompt this close to the window filled it: Ollama truncated it. */
export const TRUNCATION_MARGIN = 16;

/** The estimate scaled by what this model's template has been seen to cost. */
export function scaledEstimate(model: string, estimate: number): number {
  return Math.ceil(estimate * (learnedScale.get(model) ?? 1));
}

/**
 * Record what Ollama actually evaluated for a request. Returns true when the
 * prompt filled the window (Ollama dropped its head), so the caller must not
 * trust the reply. On truncation the real size is unknown (only that it
 * exceeded num_ctx), so the scale at least doubles past what would have fit.
 * Note: prompt_eval_count excludes tokens served from Ollama's prompt cache,
 * so a cached request can only under-report — which never lowers the scale.
 */
export function notePromptSize(model: string, estimate: number, promptEvalCount: number, numCtx: number): boolean {
  if (!(estimate > 0) || !(promptEvalCount > 0)) return false;
  const current = learnedScale.get(model) ?? 1;
  if (promptEvalCount >= numCtx - TRUNCATION_MARGIN) {
    learnedScale.set(model, Math.max(current, (numCtx / estimate) * 2));
    return true;
  }
  learnedScale.set(model, Math.max(current, promptEvalCount / estimate));
  return false;
}

/** Test hook: forget every learned scale. */
export function resetPromptScales(): void {
  learnedScale.clear();
}

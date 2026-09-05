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

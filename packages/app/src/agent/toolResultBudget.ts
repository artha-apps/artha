/**
 * Tool-result budget for the ReAct prompt.
 *
 * Every tool result is appended to the conversation and re-read by the model
 * on EVERY later turn. On a local model that is not free: a 72B model on an
 * M-series Mac evaluates ~55 prompt tokens/s, so a 30k-token tool result costs
 * ~9 minutes before the next token — and overflows a 32k context outright.
 * The model never needs the whole thing; it needs enough to decide the next
 * call. This clamps what the MODEL sees. Audit/UI paths keep the full text.
 */

/** ~3.5k tokens. Big enough for any sane listing/search/read excerpt. */
export const MAX_TOOL_RESULT_CHARS = 12_000;

/** Return `text` unchanged when within budget; otherwise the head of it plus an
 *  explicit, model-readable marker saying how much was cut and how to refine. */
export function clampToolResult(text: string, max: number = MAX_TOOL_RESULT_CHARS): string {
  if (text.length <= max) return text;
  const cut = text.length - max;
  return (
    `${text.slice(0, max)}\n` +
    `…[truncated ${cut.toLocaleString()} more characters — result too large for the model. ` +
    `Narrow the request (a pattern, a sub-folder, a smaller range) instead of re-running the same call.]`
  );
}

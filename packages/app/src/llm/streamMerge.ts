/**
 * Pure helpers for assembling a streamed chat completion. OpenAI streams tool
 * calls as incremental deltas keyed by index (id + name arrive once, arguments
 * arrive char-by-char); this reassembles them. Kept pure so it's unit-testable
 * without a live model.
 */
import OpenAI from 'openai';

/** Accumulated state for a single in-progress tool call across stream chunks.
 *  `arguments` is a partial JSON string that grows until the stream ends. */
export interface PartialToolCall {
  id: string;
  name: string;
  arguments: string;
  /** Provider-specific side-channel on the tool call (e.g. Gemini's
   *  `extra_content.google.thought_signature`). Gemini 3.x REJECTS the whole
   *  follow-up request (400) if the echoed assistant tool_call is missing its
   *  thought_signature, so this must survive stream reassembly and be sent
   *  back verbatim. Arrives once, on the first chunk for an index. */
  extra_content?: unknown;
}

/** Streaming tool-call delta shape (subset of the OpenAI chunk type we use).
 *  `index` is optional in reality: OpenAI keys deltas by index, but Gemini's
 *  OpenAI-compat stream emits each call as ONE complete delta with an `id` and
 *  NO index. */
export interface ToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
  extra_content?: unknown;
}

/** Fold a chunk's tool-call deltas into the running accumulator (immutably).
 *
 *  Slot resolution, in order: explicit `index` (OpenAI semantics) → matching
 *  `id` (Gemini emits complete, id-keyed calls with no index — folding those
 *  into slot 0 fused parallel calls into one corrupt call, "namename" +
 *  concatenated JSON args) → a NEW slot when the delta carries an unseen id →
 *  else the last slot (bare argument fragments). */
export function applyToolCallDeltas(acc: PartialToolCall[], deltas: ToolCallDelta[]): PartialToolCall[] {
  const next = acc.slice();
  for (const d of deltas) {
    let i: number;
    if (typeof d.index === 'number') {
      i = d.index;
    } else if (d.id) {
      const byId = next.findIndex(p => p && p.id === d.id);
      i = byId >= 0 ? byId : next.length;
    } else {
      i = Math.max(next.length - 1, 0);
    }
    // First chunk for a slot carries id + name (+ any provider side-channel
    // like extra_content); subsequent chunks carry only argument fragments,
    // so we preserve whatever arrived earlier.
    const cur = next[i] ?? { id: '', name: '', arguments: '' };
    next[i] = {
      id: d.id ?? cur.id,
      name: cur.name + (d.function?.name ?? ''),
      arguments: cur.arguments + (d.function?.arguments ?? ''),
      extra_content: d.extra_content ?? cur.extra_content,
    };
  }
  return next;
}

/** Convert assembled partials into OpenAI tool-call objects, dropping any that
 *  never received a function name (defensive against malformed streams).
 *  Provider side-channels (`extra_content`) are carried through so the ReAct
 *  loop's echo of the assistant turn stays byte-faithful to what the provider
 *  sent — Gemini validates that. */
export function toToolCalls(partials: PartialToolCall[]): OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] {
  return partials
    .filter(p => p && p.name)
    .map(p => ({
      id: p.id || `call_${Math.random().toString(36).slice(2, 10)}`,
      type: 'function' as const,
      function: { name: p.name, arguments: p.arguments || '{}' },
      ...(p.extra_content !== undefined ? { extra_content: p.extra_content } : {}),
    })) as OpenAI.Chat.Completions.ChatCompletionMessageToolCall[];
}

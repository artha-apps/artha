/**
 * Pure helpers for assembling a streamed chat completion. OpenAI streams tool
 * calls as incremental deltas keyed by index (id + name arrive once, arguments
 * arrive char-by-char); this reassembles them. Kept pure so it's unit-testable
 * without a live model.
 */
import OpenAI from 'openai';

export interface PartialToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** Streaming tool-call delta shape (subset of the OpenAI chunk type we use). */
export interface ToolCallDelta {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

/** Fold a chunk's tool-call deltas into the running accumulator (immutably). */
export function applyToolCallDeltas(acc: PartialToolCall[], deltas: ToolCallDelta[]): PartialToolCall[] {
  const next = acc.slice();
  for (const d of deltas) {
    const i = d.index ?? 0;
    const cur = next[i] ?? { id: '', name: '', arguments: '' };
    next[i] = {
      id: d.id ?? cur.id,
      name: cur.name + (d.function?.name ?? ''),
      arguments: cur.arguments + (d.function?.arguments ?? ''),
    };
  }
  return next;
}

/** Convert assembled partials into OpenAI tool-call objects, dropping any that
 *  never received a function name (defensive against malformed streams). */
export function toToolCalls(partials: PartialToolCall[]): OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] {
  return partials
    .filter(p => p && p.name)
    .map(p => ({
      id: p.id || `call_${Math.random().toString(36).slice(2, 10)}`,
      type: 'function' as const,
      function: { name: p.name, arguments: p.arguments || '{}' },
    }));
}

/**
 * `ask_user` — structured clarifying questions the agent can ask MID-RUN.
 *
 * The model calls it with 1–4 multiple-choice questions. The renderer shows an
 * inline card (Chat and Delegate); the user's answers resolve the SAME tool
 * call — the loop simply awaits it, so there is no new turn.
 *
 * Safety rules:
 *   - Unattended runs (scheduled / LAN) fail closed: the call returns
 *     `unanswered (unattended run)` immediately and the model must proceed
 *     safely or stop. It never guesses an answer on the user's behalf.
 *   - No timeout while attended, but Cancel (or Stop) resolves as `declined`.
 */
import OpenAI from 'openai';
import type { InteractionHub } from './interactions';

/** One selectable option. */
export interface AskOption { label: string; description?: string }

/** One question as the model asked it (after normalisation). */
export interface AskQuestion {
  id: string;
  question: string;
  options: AskOption[];
  allow_custom: boolean;
  multi: boolean;
}

/** The user's answer to one question: chosen option labels + optional free text. */
export interface AskAnswer { selected: string[]; custom?: string }

/** Answers keyed by question id, as the renderer submits them. */
export type AskAnswers = Record<string, AskAnswer>;

export const ASK_USER_TOOL_NAME = 'ask_user';
export const MAX_ASK_QUESTIONS = 4;
/** Exact marker returned for unattended runs (asserted by tests + the model prompt). */
export const UNATTENDED_RESULT = 'unanswered (unattended run)';

/** OpenAI function schema offered to the model. */
export const ASK_USER_TOOL_SCHEMA: OpenAI.ChatCompletionTool = {
  type: 'function',
  function: {
    name: ASK_USER_TOOL_NAME,
    description:
      'Ask the user 1-4 short multiple-choice questions when a decision genuinely needs them ' +
      '(ambiguous target, irreversible choice, missing preference you cannot look up). ' +
      'The run pauses until they answer; the result contains their choices. ' +
      `If it returns "declined" or "${UNATTENDED_RESULT}", do NOT guess — continue only with ` +
      'steps that are safe without the answer, or stop and say what you needed.',
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_ASK_QUESTIONS,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Short stable id, e.g. "format".' },
              question: { type: 'string' },
              options: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string' },
                    description: { type: 'string' },
                  },
                  required: ['label'],
                },
              },
              allow_custom: { type: 'boolean', description: 'Let the user type their own answer.' },
              multi: { type: 'boolean', description: 'Allow selecting more than one option.' },
            },
            required: ['question', 'options'],
          },
        },
      },
      required: ['questions'],
    },
  },
};

/** Validate + normalise model-supplied arguments. Small models send sloppy
 *  JSON, so missing ids/flags are defaulted; structurally unusable input is an
 *  error the model can correct. */
export function parseAskUserArgs(args: Record<string, unknown>):
  { ok: true; questions: AskQuestion[] } | { ok: false; error: string } {
  const raw = args?.questions;
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: 'ask_user needs a non-empty "questions" array.' };
  }
  if (raw.length > MAX_ASK_QUESTIONS) {
    return { ok: false, error: `ask_user accepts at most ${MAX_ASK_QUESTIONS} questions; got ${raw.length}.` };
  }
  const seen = new Set<string>();
  const questions: AskQuestion[] = [];
  for (let i = 0; i < raw.length; i++) {
    const q = raw[i] as Record<string, unknown> | null;
    const text = typeof q?.question === 'string' ? q.question.trim() : '';
    if (!text) return { ok: false, error: `Question ${i + 1} has no "question" text.` };
    const options: AskOption[] = Array.isArray(q?.options)
      ? (q!.options as unknown[]).flatMap((o): AskOption[] => {
          if (typeof o === 'string' && o.trim()) return [{ label: o.trim() }];
          const obj = o as Record<string, unknown> | null;
          const label = typeof obj?.label === 'string' ? obj.label.trim() : '';
          if (!label) return [];
          const description = typeof obj?.description === 'string' && obj.description.trim() ? obj.description.trim() : undefined;
          return [{ label, ...(description ? { description } : {}) }];
        })
      : [];
    const allowCustom = q?.allow_custom === true;
    if (options.length === 0 && !allowCustom) {
      return { ok: false, error: `Question ${i + 1} needs at least one option (or allow_custom: true).` };
    }
    let id = typeof q?.id === 'string' && q.id.trim() ? q.id.trim() : `q${i + 1}`;
    if (seen.has(id)) id = `${id}_${i + 1}`;
    seen.add(id);
    questions.push({ id, question: text, options, allow_custom: allowCustom, multi: q?.multi === true });
  }
  return { ok: true, questions };
}

/** Clamp a submitted answer to what the question allows: only offered labels,
 *  at most one when !multi, free text only when allow_custom. Anything else is
 *  dropped rather than trusted. */
export function sanitizeAnswers(questions: AskQuestion[], answers: unknown): AskAnswers {
  const input = (answers && typeof answers === 'object') ? answers as Record<string, unknown> : {};
  const out: AskAnswers = {};
  for (const q of questions) {
    const a = input[q.id] as Record<string, unknown> | undefined;
    const labels = new Set(q.options.map(o => o.label));
    let selected = Array.isArray(a?.selected)
      ? (a!.selected as unknown[]).filter((s): s is string => typeof s === 'string' && labels.has(s))
      : [];
    selected = [...new Set(selected)];
    if (!q.multi) selected = selected.slice(0, 1);
    const custom = q.allow_custom && typeof a?.custom === 'string' && a.custom.trim()
      ? a.custom.trim().slice(0, 2000) : undefined;
    out[q.id] = { selected, ...(custom ? { custom } : {}) };
  }
  return out;
}

/** The tool result the model reads for an answered card. */
export function formatAnsweredResult(questions: AskQuestion[], answers: AskAnswers): string {
  return JSON.stringify({
    status: 'answered',
    answers: questions.map(q => ({
      id: q.id,
      question: q.question,
      selected: answers[q.id]?.selected ?? [],
      ...(answers[q.id]?.custom ? { custom: answers[q.id].custom } : {}),
      unanswered: !(answers[q.id]?.selected.length || answers[q.id]?.custom),
    })),
  });
}

/** Result when the user dismissed the card (Cancel or Stop). */
export const DECLINED_RESULT =
  'declined — the user dismissed the question without answering. Do not guess their answer: ' +
  'continue only with steps that are safe without it, or stop and say what you needed.';

/** Full unattended result: the exact marker plus guidance for the model. */
export const UNATTENDED_RESULT_TEXT =
  `${UNATTENDED_RESULT} — no person is available to answer. Do not assume an answer: ` +
  'proceed only with steps that are safe without it, or stop and report what you needed.';

/** Run one ask_user call end to end. Resolves with the tool-result string for
 *  THIS call — the awaiting ReAct loop simply continues with it. */
export async function runAskUser(
  args: Record<string, unknown>,
  ctx: { unattended: boolean; runId: string; workflowId: string; sessionId: string; hub: InteractionHub },
): Promise<string> {
  const parsed = parseAskUserArgs(args);
  if (!parsed.ok) return `Error: ${parsed.error}`;
  // Fail closed: nobody is watching, so nobody can answer. Never block a
  // scheduled/LAN run on a card, and never fabricate an answer.
  if (ctx.unattended) return UNATTENDED_RESULT_TEXT;

  const { outcome } = ctx.hub.open({
    runId: ctx.runId,
    workflowId: ctx.workflowId,
    kind: 'ask',
    payload: { sessionId: ctx.sessionId, questions: parsed.questions },
  });
  const res = await outcome;
  if (res.status === 'answered') {
    return formatAnsweredResult(parsed.questions, sanitizeAnswers(parsed.questions, res.answer));
  }
  return res.status === 'expired'
    ? 'expired — the question can no longer be answered. Do not guess; proceed safely or stop.'
    : DECLINED_RESULT;
}

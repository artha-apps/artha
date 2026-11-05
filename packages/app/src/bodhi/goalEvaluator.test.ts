/** Pure evaluator rules: parsing is fail-closed and criteria are decisive. */
import { describe, it, expect, vi } from 'vitest';
import {
  parseJudgeOutput, evaluateGoal, decideStopGate, buildJudgeMessages, JUDGE_SYSTEM_PROMPT,
  type EvaluatorInput,
} from './goalEvaluator';

const refs = new Set(['E1', 'E2']);

const input = (over: Partial<EvaluatorInput> = {}): EvaluatorInput => ({
  objective: 'Organise downloads',
  condition: 'every PDF in ~/Downloads is in ~/Downloads/pdfs',
  runFacts: { toolCallsTotal: 2, toolCallsFailed: 0, mutationsTotal: 1, mutationsFailed: 0 },
  criteria: [],
  evidence: [{ id: 'E1', kind: 'tool_result', status: 'succeeded', summary: 'fs_move_batch moved 4 files' }],
  ...over,
});

describe('parseJudgeOutput — unparseable is never met', () => {
  it.each([
    ['', 'empty'],
    ['Yes, the goal is met.', 'prose'],
    ['{"verdict": "met", ', 'truncated JSON'],
    ['["met"]', 'array'],
    ['{"verdict":"probably"}', 'unknown verdict word'],
    ['{"verdict":"met","evidence_refs":[]}', 'met without evidence'],
    ['{"verdict":"met","evidence_refs":["E9"]}', 'met citing evidence it was not shown'],
  ])('%s (%s) → unknown', (text) => {
    expect(parseJudgeOutput(text, refs).verdict).toBe('unknown');
  });

  it('accepts a fenced met that cites real evidence', () => {
    const v = parseJudgeOutput('```json\n{"verdict":"met","gaps":[],"evidence_refs":["E1","E1"]}\n```', refs);
    expect(v).toMatchObject({ verdict: 'met', evidence_refs: ['E1'] });
  });

  it('unmet keeps its gaps, and gets a generic one if it gave none', () => {
    expect(parseJudgeOutput('{"verdict":"unmet","gaps":["2 PDFs left"]}', refs).gaps).toEqual(['2 PDFs left']);
    expect(parseJudgeOutput('{"verdict":"unmet"}', refs).gaps.length).toBe(1);
  });
});

describe('evaluateGoal', () => {
  it('a failed deterministic criterion is decisive — the judge is not consulted', async () => {
    const judge = vi.fn(async () => '{"verdict":"met","evidence_refs":["E1"]}');
    const v = await evaluateGoal(input({ criteria: [{ description: 'pdfs exists at its destination', outcome: 'failed', required: true }] }), judge);
    expect(v).toMatchObject({ verdict: 'unmet', source: 'criteria' });
    expect(v.gaps[0]).toContain('pdfs exists');
    expect(judge).not.toHaveBeenCalled();
  });

  it('no judge, a throwing judge, or garbage all yield unknown', async () => {
    expect((await evaluateGoal(input(), null)).verdict).toBe('unknown');
    expect((await evaluateGoal(input(), async () => { throw new Error('offline'); })).verdict).toBe('unknown');
    expect((await evaluateGoal(input(), async () => 'sure!')).verdict).toBe('unknown');
  });

  it('met is downgraded to unknown while a required check is indeterminate', async () => {
    const v = await evaluateGoal(
      input({ criteria: [{ description: 'pdfs exists', outcome: 'indeterminate', required: true }] }),
      async () => '{"verdict":"met","evidence_refs":["E1"]}',
    );
    expect(v.verdict).toBe('unknown');
  });

  it('the final answer is citable as ANSWER only when one was given', async () => {
    const judge = async () => '{"verdict":"met","evidence_refs":["ANSWER"]}';
    expect((await evaluateGoal(input(), judge)).verdict).toBe('unknown');
    expect((await evaluateGoal(input({ finalAnswer: 'Here is the summary…' }), judge)).verdict).toBe('met');
  });

  it('uses its own judge prompt and no tools', () => {
    const msgs = buildJudgeMessages(input({ finalAnswer: 'I moved everything!' }));
    expect(msgs[0]).toEqual({ role: 'system', content: JUDGE_SYSTEM_PROMPT });
    expect(msgs[1].content).toContain('E1 [tool_result, succeeded]');
    expect(msgs[1].content).toContain('never of actions taken');
  });
});

describe('decideStopGate', () => {
  it('met completes; unmet continues for 2 rounds; then (or unknown) needs review', () => {
    expect(decideStopGate('met', 0)).toBe('complete');
    expect(decideStopGate('unmet', 0)).toBe('continue');
    expect(decideStopGate('unmet', 1)).toBe('continue');
    expect(decideStopGate('unmet', 2)).toBe('needs_review');
    expect(decideStopGate('unknown', 0)).toBe('needs_review');
  });
});

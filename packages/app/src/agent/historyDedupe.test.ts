import { describe, it, expect } from 'vitest';
import { dropEchoedGoal } from './historyDedupe';
import type OpenAI from 'openai';

const u = (c: string): OpenAI.ChatCompletionMessageParam => ({ role: 'user', content: c });
const a = (c: string): OpenAI.ChatCompletionMessageParam => ({ role: 'assistant', content: c });

describe('dropEchoedGoal', () => {
  const goal = "move the excel sheet 'Trinity customer DB' to my project folder";
  it('drops the trailing user turn when it is the current request (the double-send bug)', () => {
    const h = [u('what can I do to create a blog website'), u(goal)];
    expect(dropEchoedGoal(h, goal)).toEqual([u('what can I do to create a blog website')]);
  });
  it('matches a "/slug goal" invocation against the slug-stripped goal', () => {
    expect(dropEchoedGoal([u('/organize tidy ~/Desktop')], 'tidy ~/Desktop')).toEqual([]);
  });
  it('matches an enriched goal (goal + clarification Q&A appended)', () => {
    const enriched = `${goal}\n\nAdditional context from user:\nQ: which?\nA: the US one`;
    expect(dropEchoedGoal([a('hi'), u(goal)], enriched)).toEqual([a('hi')]);
  });
  it('leaves history alone when the last turn is not the current request', () => {
    const h = [u('earlier ask'), a('done')];
    expect(dropEchoedGoal(h, goal)).toBe(h);
    const h2 = [u('a different question')];
    expect(dropEchoedGoal(h2, goal)).toBe(h2);
  });
  it('is a no-op for empty history or missing goal', () => {
    expect(dropEchoedGoal([], goal)).toEqual([]);
    const h = [u(goal)];
    expect(dropEchoedGoal(h, undefined)).toBe(h);
  });
});

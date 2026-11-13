/**
 * Per-model prompt-size calibration (live QA finding, 2026-11-12).
 *
 * muse-glimmer's chat template rendered an 8.8k-token (by estimate)
 * conversation as ~35k tokens; with the 16k window Artha picked, Ollama cut
 * off the head of the prompt and the escalated model answered "I don't have a
 * current task". These pin that the window grows to what the model really
 * costs, and that an overflow is reported as truncated (never trusted).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { pickNumCtx, scaledEstimate, notePromptSize, resetPromptScales, TRUNCATION_MARGIN } from './numCtx';

beforeEach(() => resetPromptScales());

describe('learned prompt scale', () => {
  it('reproduces the live case: the estimate alone picks a window that truncates', () => {
    const estimate = 8811;                          // what Artha estimated
    const numCtx = pickNumCtx(4096, scaledEstimate('muse-glimmer:30b', estimate), 2048);
    expect(numCtx).toBe(16384);                     // too small for the real ~35k
    // Ollama evaluates only what fits: the window filled → truncated.
    expect(notePromptSize('muse-glimmer:30b', estimate, numCtx - 1, numCtx)).toBe(true);
  });

  it('after a truncation the retry gets a larger window, enough for the real prompt', () => {
    const estimate = 8811;
    notePromptSize('muse-glimmer:30b', estimate, 16384 - 1, 16384);
    const retry = pickNumCtx(4096, scaledEstimate('muse-glimmer:30b', estimate), 2048);
    expect(retry).toBeGreaterThanOrEqual(35089 + 2048);
  });

  it('learns from a request that fit, so later calls are sized right the first time', () => {
    expect(notePromptSize('muse-glimmer:30b', 1000, 3980, 8192)).toBe(false); // ~4x template
    expect(scaledEstimate('muse-glimmer:30b', 8811)).toBeGreaterThanOrEqual(35000);
    expect(pickNumCtx(4096, scaledEstimate('muse-glimmer:30b', 8811), 2048)).toBe(65536);
  });

  it('is per model, never shrinks, and ignores missing numbers', () => {
    notePromptSize('a', 1000, 3000, 8192);
    notePromptSize('a', 1000, 1000, 8192);          // a cached/cheaper request can't lower it
    expect(scaledEstimate('a', 1000)).toBe(3000);
    expect(scaledEstimate('b', 1000)).toBe(1000);   // other models unaffected
    expect(notePromptSize('a', 0, 5000, 8192)).toBe(false);
    expect(notePromptSize('a', 1000, 0, 8192)).toBe(false);
    expect(notePromptSize('c', 1000, 8192 - TRUNCATION_MARGIN - 1, 8192)).toBe(false);
  });
});

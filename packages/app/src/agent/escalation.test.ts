import { describe, it, expect } from 'vitest';
import { nextEscalation, escalationLadder } from './escalation';

describe('escalationLadder', () => {
  const candidates = ['qwen2.5:72b', 'qwen2.5:14b-instruct-q4_K_M', 'qwen2.5:7b', 'mistral:7b', 'llama3.2:3b', 'nomic-embed-text:latest', 'qwen3.5:latest', 'qwen2.5:32b'];
  it('lists larger eligible models ascending, then the oversized user pick last', () => {
    expect(escalationLadder({ current: 'qwen2.5:7b', candidates, capB: 32, knownBadToolCalls: new Set(['mistral:7b']), userLocalPick: 'qwen2.5:72b' }))
      .toEqual(['qwen2.5:14b-instruct-q4_K_M', 'qwen2.5:32b', 'qwen2.5:72b']);
  });
  it('never includes smaller, unsized, embedding or known-bad models', () => {
    const l = escalationLadder({ current: 'qwen2.5:14b-instruct-q4_K_M', candidates, capB: 32, knownBadToolCalls: new Set(['mistral:7b', 'qwen2.5:32b']), userLocalPick: null });
    expect(l).toEqual([]);
  });
  it('never builds a ladder from a cloud or unsized current model', () => {
    expect(escalationLadder({ current: 'gpt-4o', candidates, capB: 32, knownBadToolCalls: new Set(), userLocalPick: null })).toEqual([]);
    expect(escalationLadder({ current: 'qwen3.5:latest', candidates, capB: 32, knownBadToolCalls: new Set(), userLocalPick: null })).toEqual([]);
    expect(escalationLadder({ current: null, candidates, capB: 32, knownBadToolCalls: new Set(), userLocalPick: null })).toEqual([]);
  });
  it('is empty when the current model is already the top rung', () => {
    expect(escalationLadder({ current: 'qwen2.5:72b', candidates, capB: 32, knownBadToolCalls: new Set(), userLocalPick: 'qwen2.5:72b' })).toEqual([]);
  });
  it('does not add the user pick when it is within the cap (it is already a rung) or known bad', () => {
    expect(escalationLadder({ current: 'llama3.2:3b', candidates: ['llama3.2:3b', 'qwen2.5:7b'], capB: 8, knownBadToolCalls: new Set(), userLocalPick: 'qwen2.5:7b' })).toEqual(['qwen2.5:7b']);
    expect(escalationLadder({ current: 'llama3.2:3b', candidates: ['llama3.2:3b'], capB: 8, knownBadToolCalls: new Set(['big:70b']), userLocalPick: 'big:70b' })).toEqual([]);
  });
});

describe('nextEscalation', () => {
  it('restores withheld tools first after a discarded turn', () => {
    expect(nextEscalation({ discarded: true, toolsPruned: true, toolsRestored: false, modelEscalated: false, ladder: ['x:14b'] })).toEqual({ kind: 'restore-tools' });
  });
  it('steps up one model when tools were not the problem', () => {
    expect(nextEscalation({ discarded: false, toolsPruned: true, toolsRestored: false, modelEscalated: false, ladder: ['x:14b', 'x:32b'] })).toEqual({ kind: 'switch-model', model: 'x:14b' });
    expect(nextEscalation({ discarded: true, toolsPruned: true, toolsRestored: true, modelEscalated: false, ladder: ['x:14b'] })).toEqual({ kind: 'switch-model', model: 'x:14b' });
  });
  it('gives up after each remedy has been used once', () => {
    expect(nextEscalation({ discarded: true, toolsPruned: true, toolsRestored: true, modelEscalated: true, ladder: ['x:14b'] })).toBeNull();
    expect(nextEscalation({ discarded: false, toolsPruned: false, toolsRestored: false, modelEscalated: false, ladder: [] })).toBeNull();
  });
});

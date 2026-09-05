import { describe, it, expect } from 'vitest';
import { routeAgentModel, agentParamCapB, modelParamsB, type AgentRouteInput } from './agentRouter';

const base = (o: Partial<AgentRouteInput> = {}): AgentRouteInput => ({
  ramGb: 128,
  userPick: { name: 'qwen2.5:72b', isLocal: true },
  pin: null,
  candidates: ['qwen2.5:72b', 'qwen2.5:14b-instruct-q4_K_M', 'mistral:7b', 'llama3.3:70b', 'nomic-embed-text:latest', 'qwen3.5:latest'],
  knownBadToolCalls: new Set(['mistral:7b']),
  ...o,
});

describe('agentParamCapB / modelParamsB', () => {
  it('scales the agent budget with RAM and parses sizes from tags', () => {
    expect(agentParamCapB(8)).toBe(4);
    expect(agentParamCapB(16)).toBe(8);
    expect(agentParamCapB(32)).toBe(15);
    expect(agentParamCapB(128)).toBe(32);
    expect(modelParamsB('qwen2.5:14b-instruct-q4_K_M')).toBe(14);
    expect(modelParamsB('llama3.2:3b')).toBe(3);
    expect(modelParamsB('qwen3.5:latest')).toBe(Infinity);
  });
});

describe('routeAgentModel', () => {
  it("routes the founder's case: 72B pick on 128 GB → the 14B tier default, automatically", () => {
    const r = routeAgentModel(base());
    expect(r.source).toBe('auto');
    expect(r.model).toBe('qwen2.5:14b-instruct-q4_K_M');
    expect(r.userPick).toBe('qwen2.5:72b');
    expect(r.reason).toMatch(/too large/);
  });
  it('honours an eligible local pick untouched', () => {
    const r = routeAgentModel(base({ userPick: { name: 'qwen2.5:14b-instruct-q4_K_M', isLocal: true } }));
    expect(r.source).toBe('user');
    expect(r.model).toBe('qwen2.5:14b-instruct-q4_K_M');
  });
  it('never replaces a cloud model the user chose (no silent data egress either way)', () => {
    const r = routeAgentModel(base({ userPick: { name: 'models/gemini-3.1-flash-lite', isLocal: false } }));
    expect(r.source).toBe('user');
    expect(r.model).toBe('models/gemini-3.1-flash-lite');
  });
  it('a pin always wins', () => {
    const r = routeAgentModel(base({ pin: 'qwen2.5:72b' }));
    expect(r.source).toBe('pin');
    expect(r.model).toBe('qwen2.5:72b');
  });
  it('never auto-selects a model that failed the tool-call benchmark, an embedder, or an unsized tag', () => {
    const r = routeAgentModel(base({ ramGb: 16, candidates: ['mistral:7b', 'nomic-embed-text:latest', 'qwen3.5:latest', 'llama3.2:3b'] }));
    expect(r.source).toBe('auto');
    expect(r.model).toBe('llama3.2:3b');
  });
  it('a pick that failed tool calls is routed away from even when it is small', () => {
    const r = routeAgentModel(base({ ramGb: 16, userPick: { name: 'mistral:7b', isLocal: true }, candidates: ['mistral:7b', 'qwen2.5:7b'] }));
    expect(r.source).toBe('auto');
    expect(r.model).toBe('qwen2.5:7b');
    expect(r.reason).toMatch(/tool-calling check/);
  });
  it('falls back to the user pick, honestly, when nothing eligible is installed', () => {
    const r = routeAgentModel(base({ candidates: ['qwen2.5:72b', 'llama3.3:70b'] }));
    expect(r.source).toBe('user-fallback');
    expect(r.model).toBe('qwen2.5:72b');
    expect(r.reason).toMatch(/no smaller tool-capable model/);
  });
  it('without a tier default present, picks the largest eligible local model', () => {
    const r = routeAgentModel(base({ candidates: ['qwen2.5:72b', 'llama3.1:8b', 'qwen2.5:7b'] }));
    expect(r.source).toBe('auto');
    expect(r.model).toBe('llama3.1:8b');
  });
  it('reports none when nothing is configured', () => {
    expect(routeAgentModel(base({ userPick: null })).source).toBe('none');
  });
});

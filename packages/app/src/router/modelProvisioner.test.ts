import { describe, it, expect } from 'vitest';
import { vi } from 'vitest';
import { planProvision, tierDefaultTag, estimatedDownloadGb, resetStaleToolEvidence, TOOL_PROBE_VERSION, type ProvisionInput } from './modelProvisioner';

vi.mock('../db/schema', () => ({ getDb: () => { throw new Error('not used in pure tests'); } }));
vi.mock('./benchmark', () => ({ benchmarkModel: async () => [] }));

const GB = 1024 ** 3;
const base = (o: Partial<ProvisionInput> = {}): ProvisionInput => ({
  ramGb: 128,
  installed: ['qwen2.5:72b'],
  autoManage: undefined,
  route: { source: 'user-fallback', model: 'qwen2.5:72b' },
  freeBytes: 500 * GB,
  lastFailureAt: null,
  now: 1_000_000_000_000,
  ...o,
});

describe('planProvision', () => {
  it('installs the tier default when routing fell back to an oversized pick', () => {
    const d = planProvision(base());
    expect(d.action).toBe('install');
    expect(d.tag).toBe('qwen2.5:14b-instruct-q4_K_M');
  });
  it('picks the tier by RAM', () => {
    expect(tierDefaultTag(16)).toBe('qwen2.5:7b-instruct-q4_K_M');
    expect(tierDefaultTag(8)).toBe('llama3.2:3b-instruct-q4_K_M');
    expect(planProvision(base({ ramGb: 16 })).tag).toBe('qwen2.5:7b-instruct-q4_K_M');
  });
  it('does nothing when the user turned automatic management off', () => {
    expect(planProvision(base({ autoManage: false })).action).toBe('none');
  });
  it('does nothing when any quant of the tier default is already installed', () => {
    expect(planProvision(base({ installed: ['qwen2.5:72b', 'qwen2.5:14b'] })).action).toBe('none');
    expect(planProvision(base({ installed: ['qwen2.5:14b-instruct-q8_0'] })).action).toBe('none');
  });
  it('never downloads for cloud users, pinned users, or no model at all', () => {
    expect(planProvision(base({ route: { source: 'user', model: 'gpt-4o' } })).action).toBe('none');
    expect(planProvision(base({ route: { source: 'pin', model: 'qwen2.5:72b' } })).action).toBe('none');
    expect(planProvision(base({ route: { source: 'none', model: null } })).action).toBe('none');
  });
  it('leaves a fitting user pick alone', () => {
    expect(planProvision(base({ route: { source: 'user', model: 'qwen2.5:7b' }, installed: ['qwen2.5:7b'] })).action).toBe('none');
  });
  it('upgrades a weak auto stand-in but not a near-equivalent one', () => {
    expect(planProvision(base({ route: { source: 'auto', model: 'llama3.2:3b' }, installed: ['qwen2.5:72b', 'llama3.2:3b'] })).action).toBe('install');
    expect(planProvision(base({ route: { source: 'auto', model: 'mistral-nemo:12b' }, installed: ['qwen2.5:72b', 'mistral-nemo:12b'] })).action).toBe('none');
  });
  it('refuses on low disk and backs off after a recent failure', () => {
    expect(planProvision(base({ freeBytes: 5 * GB })).reason).toMatch(/free disk/);
    const now = 1_000_000_000_000;
    expect(planProvision(base({ lastFailureAt: now - 60_000, now })).reason).toMatch(/retrying tomorrow/);
    expect(planProvision(base({ lastFailureAt: now - 25 * 3600_000, now })).action).toBe('install');
  });
  it('estimates q4 download size from the tag', () => {
    expect(estimatedDownloadGb('qwen2.5:14b-instruct-q4_K_M')).toBeCloseTo(8.9);
    expect(estimatedDownloadGb('mystery:latest')).toBe(10);
  });
});

describe('resetStaleToolEvidence', () => {
  const fakeDb = () => {
    const ran: string[] = [];
    const db = {
      ran,
      prepare: (sql: string) => ({
        run: (...args: unknown[]) => { ran.push(sql + ' ' + JSON.stringify(args)); },
        get: () => ({ settings_json: JSON.stringify({}) }),
      }),
    };
    return db;
  };
  it('drops old tool_args rows once and stamps the probe version', () => {
    const db = fakeDb();
    expect(resetStaleToolEvidence(db, {})).toBe(true);
    expect(db.ran.some(r => r.includes("DELETE FROM model_profiles WHERE task_type='tool_args'"))).toBe(true);
    expect(db.ran.some(r => r.includes('UPDATE users SET settings_json') && r.includes('toolProbeVersion') && r.includes(String(TOOL_PROBE_VERSION)))).toBe(true);
  });
  it('is a no-op once the current probe version is recorded', () => {
    const db = fakeDb();
    expect(resetStaleToolEvidence(db, { toolProbeVersion: TOOL_PROBE_VERSION })).toBe(false);
    expect(db.ran).toEqual([]);
  });
});

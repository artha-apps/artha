import { describe, it, expect } from 'vitest';
import { inspect, type DoctorDeps, MIN_FREE_DISK_BYTES, PENDING_INTERACTION_MAX_AGE_SEC, STUCK_TASK_AGE_SEC } from './inspect';

const NOW = 1_800_000_000;

function healthy(over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    ollama: async () => ({ reachable: true, version: '0.12.3', minVersion: '0.12.0' }),
    activeModel: async () => ({ name: 'qwen3:8b', local: true }),
    isModelInstalled: async () => true,
    quarantinedMcpServers: async () => [],
    stalePendingInteractions: async () => 0,
    stuckRunningTasks: async () => 0,
    freeDiskBytes: async () => 50 * 1024 ** 3,
    now: () => NOW,
    ...over,
  };
}

const byId = async (deps: DoctorDeps) =>
  Object.fromEntries((await inspect(deps)).checks.map(c => [c.id, c]));

describe('doctor inspect', () => {
  it('reports all six checks ok on a healthy machine', async () => {
    const { checks } = await inspect(healthy());
    expect(checks.map(c => c.id)).toEqual(['ollama', 'active-model', 'mcp-quarantine', 'stale-interactions', 'stuck-tasks', 'disk']);
    expect(checks.every(c => c.status === 'ok')).toBe(true);
    expect(checks.every(c => c.fix === undefined)).toBe(true);
  });

  it('errors when Ollama is unreachable and does not probe the model', async () => {
    let probed = false;
    const c = await byId(healthy({
      ollama: async () => ({ reachable: false, version: null, minVersion: '0.12.0' }),
      isModelInstalled: async () => { probed = true; return true; },
    }));
    expect(c.ollama.status).toBe('error');
    expect(c.ollama.fix).toBeTruthy();
    expect(c['active-model'].status).toBe('warn');
    expect(probed).toBe(false);
  });

  it('warns when Ollama is below the minimum version', async () => {
    const c = await byId(healthy({ ollama: async () => ({ reachable: true, version: '0.11.9', minVersion: '0.12.0' }) }));
    expect(c.ollama.status).toBe('warn');
    expect(c.ollama.detail).toContain('0.12.0');
  });

  it('accepts a version exactly at the minimum', async () => {
    const c = await byId(healthy({ ollama: async () => ({ reachable: true, version: '0.12.0', minVersion: '0.12.0' }) }));
    expect(c.ollama.status).toBe('ok');
  });

  it('errors when the active local model is not installed', async () => {
    const c = await byId(healthy({ isModelInstalled: async () => false }));
    expect(c['active-model'].status).toBe('error');
    expect(c['active-model'].detail).toContain('qwen3:8b');
  });

  it('errors when no model is selected; ok for cloud models without probing', async () => {
    expect((await byId(healthy({ activeModel: async () => null })))['active-model'].status).toBe('error');
    let probed = false;
    const c = await byId(healthy({
      activeModel: async () => ({ name: 'cloud-model', local: false }),
      isModelInstalled: async () => { probed = true; return false; },
    }));
    expect(c['active-model'].status).toBe('ok');
    expect(probed).toBe(false);
  });

  it('warns and names quarantined MCP servers', async () => {
    const c = await byId(healthy({ quarantinedMcpServers: async () => ['files', 'calendar'] }));
    expect(c['mcp-quarantine'].status).toBe('warn');
    expect(c['mcp-quarantine'].detail).toContain('files, calendar');
  });

  it('passes the 24 h cutoff for pending interactions and warns on any', async () => {
    let cutoff = 0;
    const c = await byId(healthy({ stalePendingInteractions: async (t) => { cutoff = t; return 2; } }));
    expect(cutoff).toBe(NOW - PENDING_INTERACTION_MAX_AGE_SEC);
    expect(PENDING_INTERACTION_MAX_AGE_SEC).toBe(86_400);
    expect(c['stale-interactions'].status).toBe('warn');
    expect(c['stale-interactions'].detail).toMatch(/^2 questions/);
  });

  it('warns on task executions stuck in running', async () => {
    let cutoff = 0;
    const c = await byId(healthy({ stuckRunningTasks: async (t) => { cutoff = t; return 1; } }));
    expect(cutoff).toBe(NOW - STUCK_TASK_AGE_SEC);
    expect(c['stuck-tasks'].status).toBe('warn');
  });

  it('errors under 2 GB free, ok at exactly 2 GB, warns when unknown', async () => {
    expect((await byId(healthy({ freeDiskBytes: async () => MIN_FREE_DISK_BYTES - 1 }))).disk.status).toBe('error');
    expect((await byId(healthy({ freeDiskBytes: async () => MIN_FREE_DISK_BYTES }))).disk.status).toBe('ok');
    expect((await byId(healthy({ freeDiskBytes: async () => null }))).disk.status).toBe('warn');
  });

  it('turns a throwing probe into a warn instead of failing the report', async () => {
    const c = await byId(healthy({ stuckRunningTasks: async () => { throw new Error('db locked'); } }));
    expect(c['stuck-tasks'].status).toBe('warn');
    expect(c['stuck-tasks'].detail).toContain('db locked');
    expect(c.disk.status).toBe('ok');
  });
});

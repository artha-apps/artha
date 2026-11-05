/**
 * Doctor — read-only health report.
 *
 * `inspect(deps)` is pure: every fact about the machine comes from an
 * injected probe, so it is fully testable with fakes. It never fixes
 * anything; each failing check carries a human `fix` hint instead.
 * The real probes are wired in `probes.ts` and exposed over IPC as
 * `doctor:inspect`.
 */

import { compareVersions } from '../llm/ollamaVersion';

export type CheckStatus = 'ok' | 'warn' | 'error';

export interface DoctorCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
}

export interface DoctorDeps {
  /** Ollama reachability + version, and the minimum version Artha requires. */
  ollama: () => Promise<{ reachable: boolean; version: string | null; minVersion: string }>;
  /** Active model (null = none configured). `local` is false for cloud/BYOK models. */
  activeModel: () => Promise<{ name: string; local: boolean } | null>;
  /** Whether a local model is installed in Ollama. */
  isModelInstalled: (name: string) => Promise<boolean>;
  /** Names of MCP servers currently quarantined. */
  quarantinedMcpServers: () => Promise<string[]>;
  /** Count of interactions still `pending` with created_at older than the cutoff (unix seconds). */
  stalePendingInteractions: (olderThanSec: number) => Promise<number>;
  /** Count of task_executions still in `running` with started_at older than the cutoff (unix seconds). */
  stuckRunningTasks: (olderThanSec: number) => Promise<number>;
  /** Free bytes on the volume holding the app's data; null if unknown. */
  freeDiskBytes: () => Promise<number | null>;
  /** Current time in unix seconds. */
  now: () => number;
}

export const PENDING_INTERACTION_MAX_AGE_SEC = 24 * 60 * 60;
/** A task execution that has been `running` this long is considered stuck. */
export const STUCK_TASK_AGE_SEC = 60 * 60;
export const MIN_FREE_DISK_BYTES = 2 * 1024 ** 3;

async function safe<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try { return { ok: true, value: await fn() }; }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}

function probeFailed(id: string, label: string, error: string): DoctorCheck {
  return { id, label, status: 'warn', detail: `Could not check: ${error}` };
}

export async function inspect(deps: DoctorDeps): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const now = deps.now();

  // 1. Ollama reachable + version.
  const o = await safe(deps.ollama);
  let ollamaUp = false;
  if (!o.ok) {
    checks.push(probeFailed('ollama', 'Ollama', o.error));
  } else if (!o.value.reachable) {
    checks.push({
      id: 'ollama', label: 'Ollama', status: 'error',
      detail: 'The local Ollama server is not responding.',
      fix: 'Start Ollama (or install it from Settings → Models), then re-run the check.',
    });
  } else {
    ollamaUp = true;
    const { version, minVersion } = o.value;
    if (!version) {
      checks.push({ id: 'ollama', label: 'Ollama', status: 'warn', detail: 'Ollama is running but did not report a version.' });
    } else if (compareVersions(version, minVersion) < 0) {
      checks.push({
        id: 'ollama', label: 'Ollama', status: 'warn',
        detail: `Ollama ${version} is running; ${minVersion} or newer is required.`,
        fix: 'Update Ollama from Settings → Models.',
      });
    } else {
      checks.push({ id: 'ollama', label: 'Ollama', status: 'ok', detail: `Ollama ${version} is running.` });
    }
  }

  // 2. Active model installed.
  const m = await safe(deps.activeModel);
  if (!m.ok) {
    checks.push(probeFailed('active-model', 'Active model', m.error));
  } else if (!m.value) {
    checks.push({
      id: 'active-model', label: 'Active model', status: 'error',
      detail: 'No model is selected.', fix: 'Choose a model in Settings → Models.',
    });
  } else if (!m.value.local) {
    checks.push({ id: 'active-model', label: 'Active model', status: 'ok', detail: `${m.value.name} (cloud model, nothing to install).` });
  } else if (!ollamaUp) {
    checks.push({ id: 'active-model', label: 'Active model', status: 'warn', detail: `Cannot verify ${m.value.name} while Ollama is unreachable.` });
  } else {
    const name = m.value.name;
    const inst = await safe(() => deps.isModelInstalled(name));
    if (!inst.ok) checks.push(probeFailed('active-model', 'Active model', inst.error));
    else if (inst.value) checks.push({ id: 'active-model', label: 'Active model', status: 'ok', detail: `${name} is installed.` });
    else checks.push({
      id: 'active-model', label: 'Active model', status: 'error',
      detail: `${name} is selected but not installed in Ollama.`,
      fix: 'Download the model from Settings → Models, or pick an installed one.',
    });
  }

  // 3. Quarantined MCP servers.
  const q = await safe(deps.quarantinedMcpServers);
  if (!q.ok) checks.push(probeFailed('mcp-quarantine', 'Connected tools', q.error));
  else if (q.value.length === 0) checks.push({ id: 'mcp-quarantine', label: 'Connected tools', status: 'ok', detail: 'No tool servers are paused.' });
  else checks.push({
    id: 'mcp-quarantine', label: 'Connected tools', status: 'warn',
    detail: `Paused after repeated failures: ${q.value.join(', ')}.`,
    fix: 'Check the server configuration in Settings → Tools, then Retry.',
  });

  // 4. Pending interactions older than 24 h.
  const p = await safe(() => deps.stalePendingInteractions(now - PENDING_INTERACTION_MAX_AGE_SEC));
  if (!p.ok) checks.push(probeFailed('stale-interactions', 'Waiting questions', p.error));
  else if (p.value === 0) checks.push({ id: 'stale-interactions', label: 'Waiting questions', status: 'ok', detail: 'No questions have been waiting over 24 hours.' });
  else checks.push({
    id: 'stale-interactions', label: 'Waiting questions', status: 'warn',
    detail: `${p.value} question${p.value === 1 ? ' has' : 's have'} been waiting for an answer for over 24 hours.`,
    fix: 'Open the pending questions and answer or decline them.',
  });

  // 5. task_executions stuck in running.
  const t = await safe(() => deps.stuckRunningTasks(now - STUCK_TASK_AGE_SEC));
  if (!t.ok) checks.push(probeFailed('stuck-tasks', 'Scheduled tasks', t.error));
  else if (t.value === 0) checks.push({ id: 'stuck-tasks', label: 'Scheduled tasks', status: 'ok', detail: 'No task runs are stuck.' });
  else checks.push({
    id: 'stuck-tasks', label: 'Scheduled tasks', status: 'warn',
    detail: `${t.value} task run${t.value === 1 ? ' has' : 's have'} been marked running for over an hour.`,
    fix: 'Restart Artha; interrupted runs are closed out on launch.',
  });

  // 6. Free disk space.
  const d = await safe(deps.freeDiskBytes);
  if (!d.ok) checks.push(probeFailed('disk', 'Disk space', d.error));
  else if (d.value === null) checks.push({ id: 'disk', label: 'Disk space', status: 'warn', detail: 'Free disk space could not be determined.' });
  else {
    const gb = (d.value / 1024 ** 3).toFixed(1);
    if (d.value < MIN_FREE_DISK_BYTES) checks.push({
      id: 'disk', label: 'Disk space', status: 'error',
      detail: `Only ${gb} GB free; at least 2 GB is needed.`,
      fix: 'Free up disk space or remove unused models.',
    });
    else checks.push({ id: 'disk', label: 'Disk space', status: 'ok', detail: `${gb} GB free.` });
  }

  return { checks };
}

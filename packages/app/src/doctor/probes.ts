/** Real probes for the Doctor report (see inspect.ts). Read-only. */

import * as fs from 'fs';
import { app } from 'electron';
import { getDb } from '../db/schema';
import { getRuntimeReport } from '../llm/ollamaRuntime';
import { isModelInstalled } from '../llm/ollamaPull';
import { isOllamaManaged } from '../llm/providerKind';
import { MCPRegistry } from '../mcp/registry';
import type { DoctorDeps } from './inspect';

export function realDoctorDeps(): DoctorDeps {
  return {
    ollama: async () => {
      const r = await getRuntimeReport();
      // The pinned runtime version is the minimum Artha is built and tested against.
      return { reachable: r.serverReachable, version: r.serverVersion, minVersion: r.pinned.version };
    },
    activeModel: async () => {
      const row = getDb()
        .prepare(`SELECT ollama_name, provider, base_url FROM llm_models WHERE is_active=1 LIMIT 1`)
        .get() as { ollama_name?: string; provider?: string; base_url?: string } | undefined;
      if (!row?.ollama_name) return null;
      return { name: row.ollama_name, local: isOllamaManaged(row.provider, row.base_url) };
    },
    isModelInstalled: (name) => isModelInstalled(name),
    quarantinedMcpServers: async () => MCPRegistry.getInstance().getQuarantinedServers().map(s => s.name),
    stalePendingInteractions: async (cutoff) =>
      (getDb().prepare(`SELECT COUNT(*) AS n FROM interactions WHERE status='pending' AND created_at < ?`)
        .get(cutoff) as { n: number }).n,
    stuckRunningTasks: async (cutoff) =>
      (getDb().prepare(`SELECT COUNT(*) AS n FROM task_executions WHERE status='running' AND started_at < ?`)
        .get(cutoff) as { n: number }).n,
    freeDiskBytes: async () => {
      try {
        const s = await fs.promises.statfs(app.getPath('userData'));
        return Number(s.bavail) * Number(s.bsize);
      } catch { return null; }
    },
    now: () => Math.floor(Date.now() / 1000),
  };
}

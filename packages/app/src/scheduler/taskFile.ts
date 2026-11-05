/**
 * Task files — export/import a scheduled task as a Markdown file with YAML-style
 * frontmatter, so automations can be shared, versioned or backed up:
 *
 *   ---
 *   name: Morning invoices
 *   schedule: 0 8 * * 1-5
 *   notify: on_change
 *   ---
 *   Check the Invoices folder and summarise anything new.
 *
 * The prompt is the Markdown body. `schedule` is a cron expression (or empty
 * for a trigger-only task). Only these four keys are read; nothing in the file
 * can enable a webhook, a folder watch or any permission — triggers are always
 * configured locally after import. Imported schedules go through the same
 * 15-minute floor as the UI (SchedulerService.create).
 */
import { normalizeNotifyPolicy, NOTIFY_POLICIES, type NotifyPolicy } from './automationPolicy';

/** The portable subset of a task. */
export interface TaskFileData {
  name: string;
  schedule: string | null;
  prompt: string;
  notify: NotifyPolicy;
}

/** Quote a frontmatter value when it could be misread (leading/trailing space, '#', quotes, ':'). */
function fmValue(v: string): string {
  return /^\s|\s$|^["']|#|: /.test(v) ? JSON.stringify(v) : v;
}

/** Serialise a task to Markdown with frontmatter. */
export function exportTaskMarkdown(t: { name: string; cron: string | null; prompt: string; notify?: string | null }): string {
  const name = t.name.replace(/[\r\n]+/g, ' ');
  return [
    '---',
    `name: ${fmValue(name)}`,
    `schedule: ${t.cron ? fmValue(t.cron) : ''}`,
    `notify: ${normalizeNotifyPolicy(t.notify)}`,
    '---',
    t.prompt.trim(),
    '',
  ].join('\n');
}

/** Unquote a frontmatter scalar ("…" via JSON, '…' literally). */
function unquote(v: string): string {
  const s = v.trim();
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try { return JSON.parse(s) as string; } catch { return s.slice(1, -1); }
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1);
  return s;
}

/** Parse a task file. Throws a user-readable error for anything malformed. */
export function parseTaskMarkdown(text: string): TaskFileData {
  const src = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(src);
  if (!m) throw new Error('Task file must start with a --- frontmatter block.');
  const fields: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const i = line.indexOf(':');
    if (i <= 0) throw new Error(`Unreadable frontmatter line: "${line}"`);
    fields[line.slice(0, i).trim().toLowerCase()] = unquote(line.slice(i + 1));
  }
  const name = (fields.name ?? '').trim();
  const prompt = m[2].trim();
  if (!name) throw new Error('Task file is missing "name".');
  if (!prompt) throw new Error('Task file has no prompt (the text after the frontmatter).');
  if (name.length > 200) throw new Error('Task name is too long.');
  if (prompt.length > 20_000) throw new Error('Task prompt is too long.');
  const notifyRaw = (fields.notify ?? 'always').trim();
  if (!NOTIFY_POLICIES.includes(notifyRaw as NotifyPolicy)) {
    throw new Error(`"notify" must be one of: ${NOTIFY_POLICIES.join(', ')}.`);
  }
  return { name, schedule: (fields.schedule ?? '').trim() || null, prompt, notify: notifyRaw as NotifyPolicy };
}

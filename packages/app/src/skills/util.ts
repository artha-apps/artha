/**
 * Pure helpers for the skill system — no DB, no Electron, no LLM. Extracted so
 * they can be unit-tested in isolation and reused by the registry.
 */
import OpenAI from 'openai';

/** Lowercase, hyphenate, strip anything that isn't [a-z0-9-]. Always returns a
 *  non-empty slug (falls back to "skill"). */
export function normaliseSlug(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'skill';
}

/** Parse an explicit "/slug rest…" invocation. Returns the slug (lowercased)
 *  and the remaining message, or null when the message isn't a slash command. */
export function parseSlashInvocation(message: string): { slug: string; rest: string } | null {
  const m = message.trimStart().match(/^\/([a-z0-9][a-z0-9-]*)\b[ \t]*([\s\S]*)$/i);
  if (!m) return null;
  return { slug: m[1].toLowerCase(), rest: m[2].trim() };
}

/** A skill in portable form — what gets written to / read from a `.artha-skill`
 *  file. Only `name` is truly required. */
export interface SkillExportData {
  slug?: string;
  name: string;
  description?: string;
  instructions?: string;
  allowedTools?: string[];
  icon?: string;
}

/** Normalise an imported JSON payload into a list of skills. Accepts a bare
 *  skill object, `{ skill: {...} }`, `{ skills: [...] }`, or a bare array, and
 *  drops anything without a name or slug. Defensive against hand-edited files. */
export function parseSkillImport(raw: unknown): SkillExportData[] {
  const r = raw as Record<string, unknown> | unknown[] | null;
  let items: unknown[];
  if (Array.isArray(r)) items = r;
  else if (r && Array.isArray((r as Record<string, unknown>).skills)) items = (r as { skills: unknown[] }).skills;
  else if (r && (r as Record<string, unknown>).skill) items = [(r as { skill: unknown }).skill];
  else if (r && typeof r === 'object') items = [r];
  else items = [];

  return items
    .filter((it): it is Record<string, unknown> => !!it && typeof it === 'object')
    .filter(it => typeof it.name === 'string' || typeof it.slug === 'string')
    .map(it => ({
      slug: typeof it.slug === 'string' ? it.slug : undefined,
      name: typeof it.name === 'string' ? it.name : String(it.slug),
      description: typeof it.description === 'string' ? it.description : '',
      instructions: typeof it.instructions === 'string' ? it.instructions : '',
      allowedTools: Array.isArray(it.allowedTools) ? it.allowedTools.filter((x): x is string => typeof x === 'string') : [],
      icon: typeof it.icon === 'string' ? it.icon : '✨',
    }));
}

/** Filter tool schemas down to those an allowlist permits. An entry ending in
 *  "_" is a name *prefix* (e.g. "fs_"); any other entry is an exact name. An
 *  empty allowlist means "all tools". */
export function filterToolsByAllowlist(
  tools: OpenAI.ChatCompletionTool[],
  allowedTools: string[]
): OpenAI.ChatCompletionTool[] {
  if (!allowedTools || allowedTools.length === 0) return tools;
  return tools.filter(t => {
    const name = t.function.name;
    return allowedTools.some(a => (a.endsWith('_') ? name.startsWith(a) : name === a));
  });
}

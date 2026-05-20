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

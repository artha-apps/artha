/**
 * Skill Registry — manages reusable agent "skills".
 *
 * A Skill is a named, described playbook (à la Claude Skills). When a skill is
 * active, its `instructions` are injected into the ReAct system prompt and its
 * `allowedTools` (if any) scope which tools the agent may call. Skills are
 * resolved one of two ways for each user message:
 *
 *   1. Explicit  — the message begins with "/slug" (e.g. "/research best LLMs").
 *   2. Automatic — a cheap LLM classification picks the best-matching enabled
 *                  skill by description, or none.
 *
 * Tool allowlist convention: an entry ending in "_" is a name *prefix* (e.g.
 * "fs_" allows every filesystem tool); any other entry is an exact tool name.
 * An empty allowlist means "all tools".
 */
import OpenAI from 'openai';
import { getDb } from '../db/schema';
import { getActiveLLMClient } from '../llm/client';
import { normaliseSlug, parseSlashInvocation, filterToolsByAllowlist } from './util';

/** A row from the `skills` table, normalised for use in the main process. */
export interface Skill {
  skill_id: string;
  slug: string;
  name: string;
  description: string;
  instructions: string;
  allowed_tools_json: string;
  icon: string;
  is_enabled: number;
  is_builtin: number;
  created_at: number;
  updated_at: number;
}

/** A skill resolved for a specific message, with its allowlist parsed. */
export interface ActiveSkill {
  slug: string;
  name: string;
  icon: string;
  instructions: string;
  allowedTools: string[];
}

/** Result of resolving a user message against the skill set. `goal` is the
 *  message with any leading "/slug" stripped off. */
export interface SkillResolution {
  skill: ActiveSkill | null;
  goal: string;
}

export interface SkillInput {
  slug: string;
  name: string;
  description?: string;
  instructions?: string;
  allowedTools?: string[];
  icon?: string;
  isEnabled?: boolean;
}

export class SkillRegistry {
  private static instance: SkillRegistry;

  static getInstance(): SkillRegistry {
    if (!SkillRegistry.instance) SkillRegistry.instance = new SkillRegistry();
    return SkillRegistry.instance;
  }

  /** All skills, newest first, built-ins pinned to the top. */
  list(): Skill[] {
    return getDb()
      .prepare(`SELECT * FROM skills ORDER BY is_builtin DESC, name ASC`)
      .all() as Skill[];
  }

  /** Only enabled skills — the set considered for matching. */
  listEnabled(): Skill[] {
    return getDb()
      .prepare(`SELECT * FROM skills WHERE is_enabled = 1 ORDER BY is_builtin DESC, name ASC`)
      .all() as Skill[];
  }

  getBySlug(slug: string): Skill | undefined {
    return getDb()
      .prepare(`SELECT * FROM skills WHERE slug = ?`)
      .get(slug) as Skill | undefined;
  }

  create(input: SkillInput): Skill {
    const db = getDb();
    db.prepare(
      `INSERT INTO skills (slug, name, description, instructions, allowed_tools_json, icon, is_enabled, is_builtin)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
    ).run(
      normaliseSlug(input.slug),
      input.name,
      input.description ?? '',
      input.instructions ?? '',
      JSON.stringify(input.allowedTools ?? []),
      input.icon ?? '✨',
      input.isEnabled === false ? 0 : 1
    );
    return this.getBySlug(normaliseSlug(input.slug))!;
  }

  /** Patch a skill by id. Built-in skills can be edited and disabled but their
   *  slug is left alone so explicit "/slug" invocation stays stable. */
  update(skillId: string, patch: Partial<SkillInput>): Skill | undefined {
    const db = getDb();
    const existing = db.prepare(`SELECT * FROM skills WHERE skill_id = ?`).get(skillId) as Skill | undefined;
    if (!existing) return undefined;

    const next = {
      slug: existing.is_builtin ? existing.slug : (patch.slug ? normaliseSlug(patch.slug) : existing.slug),
      name: patch.name ?? existing.name,
      description: patch.description ?? existing.description,
      instructions: patch.instructions ?? existing.instructions,
      allowed_tools_json: patch.allowedTools ? JSON.stringify(patch.allowedTools) : existing.allowed_tools_json,
      icon: patch.icon ?? existing.icon,
      is_enabled: patch.isEnabled === undefined ? existing.is_enabled : (patch.isEnabled ? 1 : 0),
    };

    db.prepare(
      `UPDATE skills SET slug=?, name=?, description=?, instructions=?, allowed_tools_json=?, icon=?, is_enabled=?, updated_at=unixepoch()
       WHERE skill_id=?`
    ).run(
      next.slug, next.name, next.description, next.instructions,
      next.allowed_tools_json, next.icon, next.is_enabled, skillId
    );
    return db.prepare(`SELECT * FROM skills WHERE skill_id = ?`).get(skillId) as Skill;
  }

  toggle(skillId: string, enabled: boolean): void {
    getDb().prepare(`UPDATE skills SET is_enabled=?, updated_at=unixepoch() WHERE skill_id=?`)
      .run(enabled ? 1 : 0, skillId);
  }

  /** Delete a user-created skill. Built-in skills are protected — toggle them
   *  off instead. Returns false if the skill is built-in or missing. */
  remove(skillId: string): boolean {
    const db = getDb();
    const row = db.prepare(`SELECT is_builtin FROM skills WHERE skill_id=?`).get(skillId) as { is_builtin: number } | undefined;
    if (!row || row.is_builtin) return false;
    db.prepare(`DELETE FROM skills WHERE skill_id=?`).run(skillId);
    return true;
  }

  /** Resolve a user message to a skill (explicit "/slug" wins; otherwise
   *  auto-match by description) and return the message with the prefix removed. */
  async resolve(message: string): Promise<SkillResolution> {
    // 1. Explicit "/slug …" invocation.
    const explicit = parseSlashInvocation(message);
    if (explicit) {
      const skill = this.getBySlug(explicit.slug);
      if (skill && skill.is_enabled) {
        return { skill: toActive(skill), goal: explicit.rest.length ? explicit.rest : skill.name };
      }
      // Unknown slug — fall through and treat the whole thing as a normal goal.
    }

    // 2. Automatic match against enabled skills by description.
    const enabled = this.listEnabled();
    if (enabled.length === 0) return { skill: null, goal: message };

    const matched = await this.autoMatch(message, enabled);
    return { skill: matched ? toActive(matched) : null, goal: message };
  }

  /** Filter a list of OpenAI tool schemas down to those a skill permits.
   *  No allowlist → return everything unchanged. */
  filterTools(
    tools: OpenAI.ChatCompletionTool[],
    skill: ActiveSkill | null
  ): OpenAI.ChatCompletionTool[] {
    return filterToolsByAllowlist(tools, skill?.allowedTools ?? []);
  }

  /** Ask a cheap model to pick the single best-matching skill, or none.
   *  Any failure (timeout, malformed output) safely yields null. */
  private async autoMatch(message: string, enabled: Skill[]): Promise<Skill | undefined> {
    const catalogue = enabled
      .map(s => `- ${s.slug}: ${s.description || s.name}`)
      .join('\n');

    try {
      const llm = getActiveLLMClient(undefined, 'plan');
      const resp = await llm.complete([
        {
          role: 'system',
          content:
            `You route a user request to at most one skill. Skills:\n${catalogue}\n\n` +
            `Reply ONLY with compact JSON: {"slug":"<slug>"} if exactly one skill clearly fits, ` +
            `otherwise {"slug":null}. Do not invent slugs.`,
        },
        { role: 'user', content: message },
      ]);
      const raw = resp.choices[0]?.message?.content ?? '';
      const json = raw.replace(/```json\n?|\n?```/g, '').trim();
      const parsed = JSON.parse(json) as { slug?: string | null };
      if (parsed?.slug) {
        return enabled.find(s => s.slug === parsed.slug);
      }
    } catch {
      /* no match on any failure */
    }
    return undefined;
  }
}

function toActive(skill: Skill): ActiveSkill {
  let allowedTools: string[] = [];
  try {
    const parsed = JSON.parse(skill.allowed_tools_json);
    if (Array.isArray(parsed)) allowedTools = parsed.filter((x): x is string => typeof x === 'string');
  } catch { /* empty allowlist */ }
  return {
    slug: skill.slug,
    name: skill.name,
    icon: skill.icon,
    instructions: skill.instructions,
    allowedTools,
  };
}

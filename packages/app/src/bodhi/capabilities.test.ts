/**
 * Unit tests for the Bodhi capability layer. Everything here is exercised
 * without a database: the registry takes a `SkillSource`, so a small fake
 * stands in for `SkillRegistry`.
 */
import { describe, it, expect } from 'vitest';
import {
  skillToCapability,
  activeSkillToCapability,
  CapabilityRegistry,
  type SkillSource,
  type Capability,
  type CapabilityExecutor,
  type CapabilityContext,
} from './capabilities';
import type { Skill, ActiveSkill, SkillResolution } from '../skills/registry';

function makeSkill(over: Partial<Skill> = {}): Skill {
  return {
    skill_id: 'id-1',
    slug: 'research',
    name: 'Web Research',
    description: 'Research a topic on the web',
    instructions: 'Do research',
    allowed_tools_json: '["web_","browser_navigate"]',
    icon: '🔎',
    is_enabled: 1,
    is_builtin: 1,
    kind: 'skill',
    created_at: 0,
    updated_at: 0,
    ...over,
  };
}

describe('skillToCapability', () => {
  it('projects a skill row into a capability', () => {
    const cap = skillToCapability(makeSkill());
    expect(cap).toEqual<Capability>({
      id: 'research',
      name: 'Web Research',
      description: 'Research a topic on the web',
      icon: '🔎',
      kind: 'skill',
      tools: ['web_', 'browser_navigate'],
      skillSlug: 'research',
    });
  });

  it('treats a malformed allowlist as "all tools" (empty)', () => {
    const cap = skillToCapability(makeSkill({ allowed_tools_json: 'not json' }));
    expect(cap.tools).toEqual([]);
  });

  it('filters non-string allowlist entries', () => {
    const cap = skillToCapability(makeSkill({ allowed_tools_json: '["fs_", 42, null]' }));
    expect(cap.tools).toEqual(['fs_']);
  });

  it('surfaces kind="agent" when the row is a promoted agent', () => {
    // The agent seam: a skill row flagged kind='agent' projects to an agent
    // capability — "promote a skill to an agent" is a flag, not a rewrite.
    const cap = skillToCapability(makeSkill({ slug: 'crm', name: 'CRM Agent', kind: 'agent' }));
    expect(cap.kind).toBe('agent');
  });

  it('defaults an unknown kind to "skill"', () => {
    const cap = skillToCapability(makeSkill({ kind: 'something-else' }));
    expect(cap.kind).toBe('skill');
  });
});

describe('activeSkillToCapability', () => {
  it('projects a resolved ActiveSkill into a capability', () => {
    const active: ActiveSkill = { slug: 'organize', name: 'File Organizer', icon: '🗂️', instructions: '…', allowedTools: ['fs_'], kind: 'skill' };
    const cap = activeSkillToCapability(active);
    expect(cap.id).toBe('organize');
    expect(cap.kind).toBe('skill');
    expect(cap.tools).toEqual(['fs_']);
    expect(cap.skillSlug).toBe('organize');
  });
});

/** Minimal fake of the skill source for registry tests. */
function fakeSource(skills: Skill[], resolution: SkillResolution): SkillSource {
  return {
    listEnabled: () => skills.filter((s) => s.is_enabled),
    getBySlug: (slug) => skills.find((s) => s.slug === slug),
    resolve: async () => resolution,
  };
}

describe('CapabilityRegistry', () => {
  it('lists enabled skills as capabilities', () => {
    const reg = new CapabilityRegistry(
      fakeSource(
        [makeSkill(), makeSkill({ skill_id: 'id-2', slug: 'organize', name: 'File Organizer', is_enabled: 0 })],
        { skill: null, goal: '' },
      ),
    );
    const caps = reg.list();
    expect(caps).toHaveLength(1);
    expect(caps[0].id).toBe('research');
  });

  it('gets a capability by id', () => {
    const reg = new CapabilityRegistry(fakeSource([makeSkill()], { skill: null, goal: '' }));
    expect(reg.get('research')?.name).toBe('Web Research');
    expect(reg.get('missing')).toBeNull();
  });

  it('selects a capability by routing through the skill resolver', async () => {
    const active: ActiveSkill = { slug: 'research', name: 'Web Research', icon: '🔎', instructions: '…', allowedTools: ['web_'], kind: 'skill' };
    const reg = new CapabilityRegistry(fakeSource([makeSkill()], { skill: active, goal: 'research llms' }));
    const cap = await reg.select('research the best llms');
    expect(cap?.id).toBe('research');
  });

  it('returns null when the resolver picks no skill (handle directly)', async () => {
    const reg = new CapabilityRegistry(fakeSource([makeSkill()], { skill: null, goal: 'hi' }));
    expect(await reg.select('hello')).toBeNull();
  });
});

describe('CapabilityExecutor contract', () => {
  it('is satisfiable by a simple fake executor (shape check)', async () => {
    const executor: CapabilityExecutor = {
      async invoke(cap: Capability, input: string, ctx: CapabilityContext) {
        return { status: 'completed' as const, output: `${cap.id}:${input}:${ctx.sessionId}`, runId: 'run-1' };
      },
    };
    const res = await executor.invoke(skillToCapability(makeSkill()), 'go', { sessionId: 's1' });
    expect(res.status).toBe('completed');
    expect(res.output).toBe('research:go:s1');
    expect(res.runId).toBe('run-1');
  });
});

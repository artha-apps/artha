import { describe, it, expect } from 'vitest';
import OpenAI from 'openai';
import { normaliseSlug, parseSlashInvocation, filterToolsByAllowlist, parseSkillImport } from './util';

const tool = (name: string): OpenAI.ChatCompletionTool => ({
  type: 'function',
  function: { name, description: '', parameters: { type: 'object', properties: {} } },
});

describe('normaliseSlug', () => {
  it('lowercases and hyphenates', () => {
    expect(normaliseSlug('Weekly Report')).toBe('weekly-report');
  });
  it('strips punctuation and collapses separators', () => {
    expect(normaliseSlug('  Foo!!  Bar  ')).toBe('foo-bar');
  });
  it('trims leading/trailing hyphens', () => {
    expect(normaliseSlug('--Hello--')).toBe('hello');
  });
  it('falls back to "skill" for empty input', () => {
    expect(normaliseSlug('!!!')).toBe('skill');
    expect(normaliseSlug('')).toBe('skill');
  });
});

describe('parseSlashInvocation', () => {
  it('splits slug and rest', () => {
    expect(parseSlashInvocation('/research best local LLMs')).toEqual({ slug: 'research', rest: 'best local LLMs' });
  });
  it('handles a bare slug with no rest', () => {
    expect(parseSlashInvocation('/organize')).toEqual({ slug: 'organize', rest: '' });
  });
  it('lowercases the slug and tolerates leading whitespace', () => {
    expect(parseSlashInvocation('   /Report  topic')).toEqual({ slug: 'report', rest: 'topic' });
  });
  it('returns null for non-slash messages', () => {
    expect(parseSlashInvocation('just a normal message')).toBeNull();
    expect(parseSlashInvocation('/')).toBeNull();
  });
});

describe('filterToolsByAllowlist', () => {
  const tools = [tool('fs_list_directory'), tool('fs_move_file'), tool('web_search'), tool('docs_generate')];

  it('returns all tools for an empty allowlist', () => {
    expect(filterToolsByAllowlist(tools, [])).toHaveLength(4);
  });
  it('matches a trailing-underscore entry as a prefix', () => {
    const names = filterToolsByAllowlist(tools, ['fs_']).map(t => t.function.name);
    expect(names).toEqual(['fs_list_directory', 'fs_move_file']);
  });
  it('matches exact tool names', () => {
    const names = filterToolsByAllowlist(tools, ['web_search', 'docs_generate']).map(t => t.function.name);
    expect(names).toEqual(['web_search', 'docs_generate']);
  });
  it('does not let an exact name leak prefix siblings', () => {
    const names = filterToolsByAllowlist(tools, ['fs_list_directory']).map(t => t.function.name);
    expect(names).toEqual(['fs_list_directory']);
  });
});

describe('parseSkillImport', () => {
  const full = { slug: 'rep', name: 'Rep', description: 'd', instructions: 'i', allowedTools: ['web_'], icon: '📊' };

  it('accepts a bare skill object', () => {
    const out = parseSkillImport(full);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ slug: 'rep', name: 'Rep', allowedTools: ['web_'] });
  });

  it('accepts { skill } and { skills: [] } wrappers and bare arrays', () => {
    expect(parseSkillImport({ skill: full })).toHaveLength(1);
    expect(parseSkillImport({ skills: [full, full] })).toHaveLength(2);
    expect(parseSkillImport([full, full, full])).toHaveLength(3);
  });

  it('drops entries with neither name nor slug, and fills defaults', () => {
    const out = parseSkillImport({ skills: [{ foo: 'bar' }, { name: 'OnlyName' }] });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: 'OnlyName', description: '', instructions: '', icon: '✨', allowedTools: [] });
  });

  it('returns [] for junk input', () => {
    expect(parseSkillImport(null)).toEqual([]);
    expect(parseSkillImport(42)).toEqual([]);
  });
});

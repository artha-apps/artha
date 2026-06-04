/**
 * Tests for the Bring-Your-Own-Memory heuristic parser. The parser is pure (no
 * DB), so we exercise it directly; importMemories/exportMemories touch SQLite
 * and are covered by the running-app smoke test instead.
 */
import { describe, it, expect } from 'vitest';
import { parseMemoryExport } from './memoryImport';

describe('parseMemoryExport', () => {
  it('parses the canonical ARTHA MEMORY IMPORT v1 skeleton', () => {
    const raw = [
      '=== ARTHA MEMORY IMPORT v1 ===',
      '[INSTRUCTIONS]',
      '[2025-03-01] - Always respond concisely, no preamble.',
      '[unknown] - Never use emojis.',
      '[IDENTITY]',
      '[unknown] - Name: Jay Kambo.',
      '[CAREER]',
      '[2024-01-01] - Founder at Artha.',
      '[PROJECTS]',
      '[2025-05-01] - Artha — local-first AI agent. Status: in dev.',
      '[PREFERENCES]',
      '[unknown] - Prefers DOCX over PDF.',
      '[OTHER]',
      '=== END ===',
    ].join('\n');

    const entries = parseMemoryExport(raw, 'source:chatgpt');
    expect(entries).toHaveLength(6);

    const byType = (t: string) => entries.filter(e => e.entity_type === t).length;
    expect(byType('preference')).toBe(3);  // 2 instructions + 1 preference
    expect(byType('person')).toBe(1);
    expect(byType('fact')).toBe(1);
    expect(byType('project')).toBe(1);

    // Verbatim content + provenance tag preserved.
    expect(entries[0].content).toBe('Always respond concisely, no preamble.');
    expect(entries[0].date).toBe('2025-03-01');
    expect(entries[1].date).toBeNull();           // [unknown] → null
    expect(entries[0].tags).toContain('source:chatgpt');
    expect(entries[0].tags).toContain('imported');

    // Names are unique slugs.
    const names = entries.map(e => e.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('tolerates a fenced code block, markdown headers, and bullets', () => {
    const raw = [
      '```',
      '**Instructions**',
      '- Keep answers short.',
      '## Projects',
      '* Built a budgeting app.',
      '```',
    ].join('\n');

    const entries = parseMemoryExport(raw);
    expect(entries).toHaveLength(2);
    expect(entries[0].entity_type).toBe('preference');
    expect(entries[0].content).toBe('Keep answers short.');
    expect(entries[1].entity_type).toBe('project');
    expect(entries[1].content).toBe('Built a budgeting app.');
  });

  it('ignores helper comments, (none) placeholders, and separators', () => {
    const raw = [
      '=== ARTHA MEMORY IMPORT v1 ===',
      '[INSTRUCTIONS]',
      '# this is a helper comment, should be ignored',
      '(none)',
      '[2025-01-01] - Real instruction.',
      '=== END ===',
    ].join('\n');

    const entries = parseMemoryExport(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toBe('Real instruction.');
  });

  it('returns an empty array for empty input', () => {
    expect(parseMemoryExport('')).toEqual([]);
    expect(parseMemoryExport('   \n  ')).toEqual([]);
  });
});

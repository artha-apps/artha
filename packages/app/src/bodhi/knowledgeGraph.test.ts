/**
 * Unit tests for the pure Knowledge Graph helpers. The DB-backed query/mutation
 * functions are thin wrappers over SQLite and covered by integration use; the
 * row→object projections and the in-memory graph assembly are the pieces worth
 * pinning down (the `tasks.test.ts` convention).
 */
import { describe, it, expect } from 'vitest';
import {
  parseProps,
  rowToKgEntity,
  rowToKgRelation,
  normaliseEntityKey,
  projectGraph,
  formatNeighborhood,
  parseRelationSpec,
  queryGraph,
  type KgEntity,
  type KgRelation,
} from './knowledgeGraph';

function makeEntity(over: Partial<KgEntity> = {}): KgEntity {
  return {
    entity_id: 'e1',
    kind: 'person',
    name: 'Alice',
    external_id: null,
    source: 'manual',
    props: {},
    project_id: null,
    created_at: 0,
    updated_at: 0,
    ...over,
  };
}

function makeRelation(over: Partial<KgRelation> = {}): KgRelation {
  return {
    relation_id: 'r1',
    src_id: 'e1',
    dst_id: 'e2',
    rel_type: 'works_at',
    props: {},
    created_at: 0,
    ...over,
  };
}

describe('parseProps', () => {
  it('parses a JSON object', () => {
    expect(parseProps('{"a":1}')).toEqual({ a: 1 });
  });
  it('falls back to {} on malformed or non-object input', () => {
    expect(parseProps('not json')).toEqual({});
    expect(parseProps('[1,2]')).toEqual({});
    expect(parseProps(null)).toEqual({});
    expect(parseProps(undefined)).toEqual({});
  });
});

describe('rowToKgEntity / rowToKgRelation', () => {
  it('projects an entity row, parsing props', () => {
    const e = rowToKgEntity({
      entity_id: 'e1', kind: 'company', name: 'Acme', external_id: 'c1',
      source: 'crm', props_json: '{"domain":"acme.com"}', project_id: null,
      created_at: 10, updated_at: 20,
    });
    expect(e).toEqual<KgEntity>({
      entity_id: 'e1', kind: 'company', name: 'Acme', external_id: 'c1',
      source: 'crm', props: { domain: 'acme.com' }, project_id: null,
      created_at: 10, updated_at: 20,
    });
  });
  it('tolerates malformed props_json', () => {
    const e = rowToKgEntity({
      entity_id: 'e1', kind: 'person', name: 'Bob', external_id: null,
      source: 'manual', props_json: 'oops', project_id: null, created_at: 0, updated_at: 0,
    });
    expect(e.props).toEqual({});
  });
  it('projects a relation row', () => {
    const r = rowToKgRelation({ relation_id: 'r1', src_id: 'a', dst_id: 'b', rel_type: 'knows', props_json: '{}', created_at: 5 });
    expect(r).toEqual<KgRelation>({ relation_id: 'r1', src_id: 'a', dst_id: 'b', rel_type: 'knows', props: {}, created_at: 5 });
  });
});

describe('normaliseEntityKey', () => {
  it('lowercases and trims both parts', () => {
    expect(normaliseEntityKey('Person', '  C1 ')).toBe('person:c1');
  });
  it('is stable for the same logical record', () => {
    expect(normaliseEntityKey('company', 'X')).toBe(normaliseEntityKey('COMPANY', 'x'));
  });
});

describe('projectGraph', () => {
  it('assembles a center entity with its outgoing and incoming edges', () => {
    const alice = makeEntity({ entity_id: 'e1', name: 'Alice' });
    const acme = makeEntity({ entity_id: 'e2', kind: 'company', name: 'Acme' });
    const bob = makeEntity({ entity_id: 'e3', name: 'Bob' });
    const out = makeRelation({ relation_id: 'r1', src_id: 'e1', dst_id: 'e2', rel_type: 'works_at' });
    const inc = makeRelation({ relation_id: 'r2', src_id: 'e3', dst_id: 'e1', rel_type: 'knows' });
    // An edge that doesn't touch the center must be excluded.
    const unrelated = makeRelation({ relation_id: 'r3', src_id: 'e2', dst_id: 'e3', rel_type: 'sponsors' });

    const n = projectGraph(alice, [alice, acme, bob], [out, inc, unrelated]);
    expect(n.entity).toBe(alice);
    expect(n.edges).toHaveLength(2);
    const byRel = Object.fromEntries(n.edges.map(e => [e.relation.rel_type, e]));
    expect(byRel.works_at.direction).toBe('out');
    expect(byRel.works_at.other).toBe(acme);
    expect(byRel.knows.direction).toBe('in');
    expect(byRel.knows.other).toBe(bob);
  });

  it('leaves `other` null when the connected entity is not in the pool', () => {
    const alice = makeEntity({ entity_id: 'e1' });
    const rel = makeRelation({ src_id: 'e1', dst_id: 'missing' });
    const n = projectGraph(alice, [alice], [rel]);
    expect(n.edges[0].other).toBeNull();
  });
});

describe('formatNeighborhood', () => {
  it('renders directed edges with arrows', () => {
    const alice = makeEntity({ entity_id: 'e1', name: 'Alice' });
    const acme = makeEntity({ entity_id: 'e2', kind: 'company', name: 'Acme' });
    const text = formatNeighborhood(projectGraph(alice, [alice, acme], [makeRelation({ src_id: 'e1', dst_id: 'e2', rel_type: 'works_at' })]));
    expect(text).toContain('Alice (person)');
    expect(text).toContain('—[works_at]→ Acme (company)');
  });
  it('notes when there are no relationships', () => {
    const text = formatNeighborhood(projectGraph(makeEntity(), [makeEntity()], []));
    expect(text).toContain('no relationships recorded');
  });
});

describe('parseRelationSpec', () => {
  it('accepts a complete triple and defaults props', () => {
    expect(parseRelationSpec({ src_id: 'a', dst_id: 'b', rel_type: 'knows' }))
      .toEqual({ srcId: 'a', dstId: 'b', relType: 'knows', props: {} });
  });
  it('rejects an incomplete triple', () => {
    expect(parseRelationSpec({ src_id: 'a', rel_type: 'knows' })).toBeNull();
    expect(parseRelationSpec({})).toBeNull();
  });
});

describe('queryGraph', () => {
  const alice = makeEntity({ entity_id: 'e1', name: 'Alice', kind: 'person' });
  const acme = makeEntity({ entity_id: 'e2', name: 'Acme', kind: 'company' });
  const edge = makeRelation({ src_id: 'e1', dst_id: 'e2', rel_type: 'works_at' });

  it('matches by name substring (case-insensitive) and returns incident edges', () => {
    const res = queryGraph([alice, acme], [edge], 'ac');
    expect(res.nodes.map(n => n.name)).toEqual(['Acme']);
    expect(res.edges).toHaveLength(1); // works_at is incident to Acme
  });
  it('filters by kind', () => {
    const res = queryGraph([alice, acme], [edge], 'a', { kind: 'person' });
    expect(res.nodes.map(n => n.name)).toEqual(['Alice']);
  });
  it('returns nothing for an empty query', () => {
    expect(queryGraph([alice, acme], [edge], '   ')).toEqual({ nodes: [], edges: [] });
  });
});

/**
 * Unit tests for the pure CRM → Knowledge Graph projection. These pin down the
 * mapping (and its idempotency by external id) without a database — the
 * side-effecting tool/DB layer is covered by integration use.
 */
import { describe, it, expect } from 'vitest';
import { filterToolsByAllowlist } from '../skills/util';
import {
  compactProps,
  dedupeContactKey,
  dedupeCompanyKey,
  interactionLabel,
  contactToEntityInput,
  projectContactGraph,
  projectInteractionGraph,
  projectDealGraph,
  type CrmContactRow,
  type CrmCompanyRow,
} from './crmProject';

const alice: CrmContactRow = { contact_id: 'c1', name: 'Alice Rivera', email: 'alice@acme.com', title: 'CTO' };
const acme: CrmCompanyRow = { company_id: 'co1', name: 'Acme Corp', domain: 'acme.com' };

describe('compactProps', () => {
  it('drops null/undefined/empty values', () => {
    expect(compactProps({ a: 1, b: null, c: undefined, d: '', e: 'x' })).toEqual({ a: 1, e: 'x' });
  });
});

describe('dedupe keys', () => {
  it('contact key is name+company, normalized', () => {
    expect(dedupeContactKey(' Alice ', ' Acme ')).toBe('alice|acme');
    expect(dedupeContactKey('alice', 'acme')).toBe(dedupeContactKey('ALICE', 'ACME'));
  });
  it('contact key without a company differs from one with', () => {
    expect(dedupeContactKey('Alice')).not.toBe(dedupeContactKey('Alice', 'Acme'));
  });
  it('company key is the normalized name', () => {
    expect(dedupeCompanyKey('  Acme Corp ')).toBe('acme corp');
  });
});

describe('interactionLabel', () => {
  it('combines kind and summary, truncating long summaries', () => {
    expect(interactionLabel({ interaction_id: 'i1', kind: 'call', summary: 'Intro call', occurred_at: 0 })).toBe('call: Intro call');
    expect(interactionLabel({ interaction_id: 'i1', kind: 'note', summary: '', occurred_at: 0 })).toBe('note');
    expect(interactionLabel({ interaction_id: 'i1', kind: 'meeting', summary: 'x'.repeat(60), occurred_at: 0 })).toMatch(/…$/);
  });
});

describe('contactToEntityInput', () => {
  it('maps a contact to a person node keyed by its contact_id', () => {
    expect(contactToEntityInput(alice)).toEqual({
      kind: 'person',
      name: 'Alice Rivera',
      externalId: 'c1',
      source: 'crm',
      props: { email: 'alice@acme.com', title: 'CTO' },
    });
  });
});

describe('projectContactGraph', () => {
  it('projects person + company + works_at when a company is given', () => {
    const proj = projectContactGraph(alice, acme);
    expect(proj.entities.map(e => e.kind)).toEqual(['person', 'company']);
    expect(proj.relations).toEqual([
      { from: { kind: 'person', externalId: 'c1' }, to: { kind: 'company', externalId: 'co1' }, relType: 'works_at' },
    ]);
  });
  it('projects only a person (no company node/edge) when no company', () => {
    const proj = projectContactGraph(alice, null);
    expect(proj.entities.map(e => e.kind)).toEqual(['person']);
    expect(proj.relations).toEqual([]);
  });
  it('is idempotent by external id — projecting twice keys the same node', () => {
    const a = projectContactGraph(alice, acme);
    const b = projectContactGraph(alice, acme);
    expect(a.entities[0].externalId).toBe(b.entities[0].externalId);
    expect(a.entities[1].externalId).toBe(b.entities[1].externalId);
  });
});

describe('projectInteractionGraph', () => {
  it('projects the person, an interaction node, and an interacted_with edge', () => {
    const proj = projectInteractionGraph(alice, { interaction_id: 'i1', kind: 'call', summary: 'Intro', occurred_at: 0 });
    expect(proj.entities.map(e => e.kind)).toEqual(['person', 'interaction']);
    expect(proj.relations[0]).toEqual({
      from: { kind: 'person', externalId: 'c1' },
      to: { kind: 'interaction', externalId: 'i1' },
      relType: 'interacted_with',
    });
  });
});

describe('projectDealGraph', () => {
  it('links owner (person) and company to the deal when both attached', () => {
    const proj = projectDealGraph({ deal_id: 'd1', title: 'Big deal', stage: 'lead' }, alice, acme);
    expect(proj.entities.map(e => e.kind).sort()).toEqual(['company', 'deal', 'person']);
    expect(proj.relations.map(r => r.relType).sort()).toEqual(['has_deal', 'owns_deal']);
  });
  it('emits just the deal node when no parties attached', () => {
    const proj = projectDealGraph({ deal_id: 'd1', title: 'Solo', stage: 'lead' }, null, null);
    expect(proj.entities).toHaveLength(1);
    expect(proj.relations).toEqual([]);
  });
});

describe('CRM Agent tool allowlist', () => {
  // The CRM Agent is seeded with the allowlist ["crm_","kg_"] — prefix entries
  // (trailing underscore). Confirm that scopes to exactly its tools.
  const tool = (name: string) => ({ type: 'function' as const, function: { name, description: '', parameters: { type: 'object' as const, properties: {} } } });
  const all = [tool('crm_add_contact'), tool('kg_query'), tool('fs_move_file'), tool('web_search')];

  it('keeps crm_/kg_ tools and excludes others', () => {
    const allowed = filterToolsByAllowlist(all, ['crm_', 'kg_']).map(t => t.function.name);
    expect(allowed).toEqual(['crm_add_contact', 'kg_query']);
  });
  it('a bare "crm" (no trailing underscore) is an exact name and matches nothing here', () => {
    expect(filterToolsByAllowlist(all, ['crm'])).toEqual([]);
  });
});

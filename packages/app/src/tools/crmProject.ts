/**
 * Pure CRM → Knowledge Graph projection helpers.
 *
 * The CRM Agent persists to its own local tables AND mirrors every record into
 * the general Knowledge Graph so relationships ("who works where", "who we last
 * spoke to") are queryable. This module is the PURE mapping between the two —
 * no DB, no side effects — so the projection logic (and its idempotency) is
 * unit-tested (`crmProject.test.ts`), mirroring how `ragFormat.ts`/`docPath.ts`
 * keep the testable logic out of the side-effecting tool module.
 *
 * A projection is a plan: a set of entity inputs (keyed by their CRM id via
 * `externalId`, so re-projection upserts in place) plus symbolic relation links
 * between them. The tool layer applies the plan against the KG engine.
 */

// ── Projection shapes ────────────────────────────────────────────────────────

/** A KG node to upsert, keyed idempotently by (source='crm', kind, externalId). */
export interface KgEntityInput {
  kind: string;
  name: string;
  externalId: string;
  source: 'crm';
  props: Record<string, unknown>;
}

/** A symbolic edge between two projected entities, referenced by their
 *  (kind, externalId) so the applier can resolve them to real entity ids. */
export interface KgRelationLink {
  from: { kind: string; externalId: string };
  to: { kind: string; externalId: string };
  relType: string;
}

/** A full projection plan for one CRM mutation. */
export interface CrmGraphProjection {
  entities: KgEntityInput[];
  relations: KgRelationLink[];
}

// ── Minimal CRM row shapes the projection needs (subset of the DB rows) ───────

export interface CrmContactRow {
  contact_id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  title?: string | null;
}
export interface CrmCompanyRow {
  company_id: string;
  name: string;
  domain?: string | null;
}
export interface CrmDealRow {
  deal_id: string;
  title: string;
  stage?: string | null;
  amount?: number | null;
}
export interface CrmInteractionRow {
  interaction_id: string;
  kind: string;
  summary?: string | null;
  occurred_at: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Drop null/undefined/empty-string values so KG node props stay clean. */
export function compactProps(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || v === '') continue;
    out[k] = v;
  }
  return out;
}

/** Case/whitespace-insensitive dedupe key for a contact, used to find an
 *  existing person before inserting a duplicate. */
export function dedupeContactKey(name: string, company?: string | null): string {
  return `${name.trim().toLowerCase()}|${(company ?? '').trim().toLowerCase()}`;
}

/** Case/whitespace-insensitive dedupe key for a company. */
export function dedupeCompanyKey(name: string): string {
  return name.trim().toLowerCase();
}

/** A short human label for an interaction node (kind + truncated summary). */
export function interactionLabel(i: CrmInteractionRow): string {
  const summary = (i.summary ?? '').trim();
  if (!summary) return i.kind;
  const short = summary.length > 48 ? `${summary.slice(0, 45)}…` : summary;
  return `${i.kind}: ${short}`;
}

export function contactToEntityInput(c: CrmContactRow): KgEntityInput {
  return {
    kind: 'person',
    name: c.name,
    externalId: c.contact_id,
    source: 'crm',
    props: compactProps({ email: c.email, phone: c.phone, title: c.title }),
  };
}

export function companyToEntityInput(co: CrmCompanyRow): KgEntityInput {
  return {
    kind: 'company',
    name: co.name,
    externalId: co.company_id,
    source: 'crm',
    props: compactProps({ domain: co.domain }),
  };
}

export function dealToEntityInput(d: CrmDealRow): KgEntityInput {
  return {
    kind: 'deal',
    name: d.title,
    externalId: d.deal_id,
    source: 'crm',
    props: compactProps({ stage: d.stage, amount: d.amount }),
  };
}

export function interactionToEntityInput(i: CrmInteractionRow): KgEntityInput {
  return {
    kind: 'interaction',
    name: interactionLabel(i),
    externalId: i.interaction_id,
    source: 'crm',
    props: compactProps({ kind: i.kind, summary: i.summary, occurred_at: i.occurred_at }),
  };
}

/** Project a contact (and optional employer) into the graph: a person node,
 *  optionally a company node, and a `works_at` edge between them. With no
 *  company there is exactly one node and no edge. */
export function projectContactGraph(
  contact: CrmContactRow,
  company: CrmCompanyRow | null,
): CrmGraphProjection {
  const person = contactToEntityInput(contact);
  const entities: KgEntityInput[] = [person];
  const relations: KgRelationLink[] = [];
  if (company) {
    const co = companyToEntityInput(company);
    entities.push(co);
    relations.push({
      from: { kind: 'person', externalId: person.externalId },
      to: { kind: 'company', externalId: co.externalId },
      relType: 'works_at',
    });
  }
  return { entities, relations };
}

/** Project a logged interaction: the person, an interaction node, and an
 *  `interacted_with` edge from the person to it. */
export function projectInteractionGraph(
  contact: CrmContactRow,
  interaction: CrmInteractionRow,
): CrmGraphProjection {
  const person = contactToEntityInput(contact);
  const node = interactionToEntityInput(interaction);
  return {
    entities: [person, node],
    relations: [{
      from: { kind: 'person', externalId: person.externalId },
      to: { kind: 'interaction', externalId: node.externalId },
      relType: 'interacted_with',
    }],
  };
}

/** Project a deal: the deal node plus `owns_deal` (person→deal) and/or
 *  `has_deal` (company→deal) edges for whichever parties are attached. */
export function projectDealGraph(
  deal: CrmDealRow,
  contact: CrmContactRow | null,
  company: CrmCompanyRow | null,
): CrmGraphProjection {
  const dealNode = dealToEntityInput(deal);
  const entities: KgEntityInput[] = [dealNode];
  const relations: KgRelationLink[] = [];
  if (contact) {
    const person = contactToEntityInput(contact);
    entities.push(person);
    relations.push({
      from: { kind: 'person', externalId: person.externalId },
      to: { kind: 'deal', externalId: dealNode.externalId },
      relType: 'owns_deal',
    });
  }
  if (company) {
    const co = companyToEntityInput(company);
    entities.push(co);
    relations.push({
      from: { kind: 'company', externalId: co.externalId },
      to: { kind: 'deal', externalId: dealNode.externalId },
      relType: 'has_deal',
    });
  }
  return { entities, relations };
}

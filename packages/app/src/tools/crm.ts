/**
 * CRM Agent tools — a local-first, private CRM the agent maintains, plus the
 * projection of every record into the Knowledge Graph so relationships are
 * queryable. No cloud, no API keys: everything is in the local SQLite DB.
 *
 * Tool contract mirrors `tools/memory.ts` / `tools/rag.ts`: a `*_TOOL_SCHEMAS`
 * array, an `is*Tool` predicate, and a dispatcher. The dispatcher is sync
 * (better-sqlite3 is blocking). The pure CRM→KG mapping lives in `crmProject.ts`;
 * the data-access functions here are also exported so the Settings UI's IPC
 * handlers read/write the SAME tables (one source of truth, never a second store).
 */
import OpenAI from 'openai';
import { getDb } from '../db/schema';
import { upsertEntity, linkEntities } from '../bodhi/knowledgeGraph';
import {
  projectContactGraph,
  projectInteractionGraph,
  projectDealGraph,
  type CrmGraphProjection,
} from './crmProject';

// ── DB row types ─────────────────────────────────────────────────────────────

export interface CompanyRow {
  company_id: string;
  name: string;
  domain: string | null;
  notes: string;
  project_id: string | null;
  created_at: number;
  updated_at: number;
}
export interface ContactRow {
  contact_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  company_id: string | null;
  title: string | null;
  notes: string;
  project_id: string | null;
  created_at: number;
  updated_at: number;
}
export interface DealRow {
  deal_id: string;
  title: string;
  company_id: string | null;
  contact_id: string | null;
  stage: string;
  amount: number | null;
  project_id: string | null;
  created_at: number;
  updated_at: number;
}
export interface InteractionRow {
  interaction_id: string;
  contact_id: string | null;
  kind: string;
  summary: string;
  occurred_at: number;
  created_at: number;
}

/** A contact joined with its company name + last-interaction time — the shape
 *  the UI list renders. */
export interface ContactSummary {
  contact_id: string;
  name: string;
  email: string | null;
  company: string | null;
  title: string | null;
  last_interaction_at: number | null;
  created_at: number;
}

// ── Projection applier (CRM rows → KG nodes + edges) ─────────────────────────

/** Apply a pure projection plan against the KG engine: upsert each entity
 *  (idempotent by external id), then link them. */
function applyProjection(proj: CrmGraphProjection, projectId: string | null): void {
  const idByKey = new Map<string, string>();
  for (const e of proj.entities) {
    const ent = upsertEntity({
      kind: e.kind,
      name: e.name,
      externalId: e.externalId,
      source: e.source,
      props: e.props,
      projectId,
    });
    idByKey.set(`${e.kind}:${e.externalId}`, ent.entity_id);
  }
  for (const r of proj.relations) {
    const from = idByKey.get(`${r.from.kind}:${r.from.externalId}`);
    const to = idByKey.get(`${r.to.kind}:${r.to.externalId}`);
    if (from && to) linkEntities(from, to, r.relType);
  }
}

// ── Data-access layer (reused by the dispatcher AND the IPC handlers) ────────

/** Find a company by name within the project bucket, creating it if absent. */
function resolveCompany(name: string, projectId: string | null): CompanyRow {
  const db = getDb();
  const existing = db.prepare(
    `SELECT * FROM crm_companies WHERE lower(name)=lower(?) AND IFNULL(project_id,'')=IFNULL(?, '')`
  ).get(name, projectId) as CompanyRow | undefined;
  if (existing) return existing;
  return db.prepare(
    `INSERT INTO crm_companies (name, project_id) VALUES (?, ?) RETURNING *`
  ).get(name, projectId) as CompanyRow;
}

/** Add or update a contact (and its employer), then project both into the KG. */
export function addContact(input: {
  name: string;
  email?: string | null;
  phone?: string | null;
  title?: string | null;
  company?: string | null;
  projectId?: string | null;
}): { contact: ContactRow; company: CompanyRow | null } {
  const db = getDb();
  const projectId = input.projectId ?? null;
  const name = input.name.trim();
  const company = input.company?.trim() ? resolveCompany(input.company.trim(), projectId) : null;

  // Find an existing contact: by email first (the strongest signal), else by
  // name within the same company bucket — so re-adding the same person updates.
  let existing: ContactRow | undefined;
  if (input.email) {
    existing = db.prepare(`SELECT * FROM crm_contacts WHERE lower(email)=lower(?)`).get(input.email) as ContactRow | undefined;
  }
  if (!existing) {
    existing = db.prepare(
      `SELECT * FROM crm_contacts WHERE lower(name)=lower(?) AND IFNULL(company_id,'')=IFNULL(?, '')`
    ).get(name, company?.company_id ?? null) as ContactRow | undefined;
  }

  let contact: ContactRow;
  if (existing) {
    contact = db.prepare(
      `UPDATE crm_contacts
         SET email=COALESCE(?, email), phone=COALESCE(?, phone), title=COALESCE(?, title),
             company_id=COALESCE(?, company_id), updated_at=unixepoch()
       WHERE contact_id=? RETURNING *`
    ).get(
      input.email ?? null, input.phone ?? null, input.title ?? null,
      company?.company_id ?? null, existing.contact_id,
    ) as ContactRow;
  } else {
    contact = db.prepare(
      `INSERT INTO crm_contacts (name, email, phone, title, company_id, project_id)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING *`
    ).get(
      name, input.email ?? null, input.phone ?? null, input.title ?? null,
      company?.company_id ?? null, projectId,
    ) as ContactRow;
  }

  applyProjection(projectContactGraph(contact, company), projectId);
  return { contact, company };
}

/** Resolve a contact reference that may be a contact_id or a name. */
function resolveContactRef(ref: string): ContactRow | undefined {
  const db = getDb();
  const byId = db.prepare(`SELECT * FROM crm_contacts WHERE contact_id=?`).get(ref) as ContactRow | undefined;
  if (byId) return byId;
  return db.prepare(`SELECT * FROM crm_contacts WHERE lower(name)=lower(?) ORDER BY updated_at DESC LIMIT 1`)
    .get(ref) as ContactRow | undefined;
}

/** Log a dated interaction against a contact, then project it into the KG. */
export function logInteraction(input: {
  contactId: string;
  kind?: string;
  summary?: string;
  occurredAt?: number | null;
  projectId?: string | null;
}): InteractionRow {
  const db = getDb();
  const contact = db.prepare(`SELECT * FROM crm_contacts WHERE contact_id=?`).get(input.contactId) as ContactRow | undefined;
  if (!contact) throw new Error(`No contact with id "${input.contactId}".`);
  const kind = (input.kind ?? 'note').trim() || 'note';
  const interaction = db.prepare(
    `INSERT INTO crm_interactions (contact_id, kind, summary, occurred_at)
     VALUES (?, ?, ?, COALESCE(?, unixepoch())) RETURNING *`
  ).get(contact.contact_id, kind, (input.summary ?? '').trim(), input.occurredAt ?? null) as InteractionRow;

  applyProjection(projectInteractionGraph(contact, interaction), contact.project_id ?? input.projectId ?? null);
  return interaction;
}

/** Create a deal, optionally tied to a contact and/or company, then project it. */
export function addDeal(input: {
  title: string;
  contact?: string | null;
  company?: string | null;
  stage?: string | null;
  amount?: number | null;
  projectId?: string | null;
}): DealRow {
  const db = getDb();
  const projectId = input.projectId ?? null;
  const contact = input.contact?.trim() ? resolveContactRef(input.contact.trim()) ?? null : null;
  const company = input.company?.trim()
    ? resolveCompany(input.company.trim(), projectId)
    : (contact?.company_id
        ? (db.prepare(`SELECT * FROM crm_companies WHERE company_id=?`).get(contact.company_id) as CompanyRow | undefined) ?? null
        : null);

  const deal = db.prepare(
    `INSERT INTO crm_deals (title, company_id, contact_id, stage, amount, project_id)
     VALUES (?, ?, ?, COALESCE(?, 'lead'), ?, ?) RETURNING *`
  ).get(
    input.title.trim(), company?.company_id ?? null, contact?.contact_id ?? null,
    input.stage ?? null, input.amount ?? null, projectId,
  ) as DealRow;

  applyProjection(projectDealGraph(deal, contact, company), projectId);
  return deal;
}

/** Contacts with company + last-interaction, newest activity first (UI list). */
export function listContacts(projectId?: string | null): ContactSummary[] {
  return getDb().prepare(
    `SELECT c.contact_id, c.name, c.email, c.title, c.created_at,
            co.name AS company,
            (SELECT MAX(occurred_at) FROM crm_interactions i WHERE i.contact_id = c.contact_id) AS last_interaction_at
       FROM crm_contacts c
       LEFT JOIN crm_companies co ON co.company_id = c.company_id
      WHERE (? IS NULL OR c.project_id = ? OR c.project_id IS NULL)
      ORDER BY COALESCE(last_interaction_at, c.created_at) DESC`
  ).all(projectId ?? null, projectId ?? null) as ContactSummary[];
}

/** Interactions for one contact, newest first. */
export function listInteractions(contactId: string): InteractionRow[] {
  return getDb().prepare(
    `SELECT * FROM crm_interactions WHERE contact_id=? ORDER BY occurred_at DESC`
  ).all(contactId) as InteractionRow[];
}

/** Delete a contact (its interactions cascade). Returns false if not found. */
export function deleteContact(contactId: string): boolean {
  return getDb().prepare(`DELETE FROM crm_contacts WHERE contact_id=?`).run(contactId).changes > 0;
}

/** Keyword search across contacts, companies, and deals. */
export function findRecords(query: string): { contacts: ContactRow[]; companies: CompanyRow[]; deals: DealRow[] } {
  const db = getDb();
  const pat = `%${query}%`;
  return {
    contacts: db.prepare(`SELECT * FROM crm_contacts WHERE name LIKE ? OR email LIKE ? ORDER BY updated_at DESC LIMIT 20`).all(pat, pat) as ContactRow[],
    companies: db.prepare(`SELECT * FROM crm_companies WHERE name LIKE ? OR domain LIKE ? ORDER BY updated_at DESC LIMIT 20`).all(pat, pat) as CompanyRow[],
    deals: db.prepare(`SELECT * FROM crm_deals WHERE title LIKE ? ORDER BY updated_at DESC LIMIT 20`).all(pat) as DealRow[],
  };
}

// ── Tool schemas ─────────────────────────────────────────────────────────────

export const CRM_TOOL_SCHEMAS: OpenAI.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'crm_add_contact',
      description:
        'Add a person to the local CRM (or update them if they already exist). The company is created automatically. ' +
        'Returns the contact_id — use it for crm_log_interaction.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: "The person's full name." },
          email: { type: 'string', description: 'Email address, if known.' },
          company: { type: 'string', description: 'Company / organisation they belong to, if known.' },
          title: { type: 'string', description: 'Job title, if known.' },
          phone: { type: 'string', description: 'Phone number, if known.' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'crm_log_interaction',
      description:
        'Log a call, email, meeting, or note against a contact. Identify the contact by their contact_id (preferred) or exact name.',
      parameters: {
        type: 'object',
        properties: {
          contact: { type: 'string', description: 'The contact_id (from crm_add_contact) or the exact name of the person.' },
          kind: { type: 'string', enum: ['call', 'email', 'meeting', 'note'], description: 'Type of interaction.' },
          summary: { type: 'string', description: 'A short description of what happened.' },
        },
        required: ['contact', 'summary'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'crm_add_deal',
      description: 'Create a deal / opportunity, optionally tied to a contact and/or company.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Name of the deal.' },
          contact: { type: 'string', description: 'contact_id or name of the primary contact, if any.' },
          company: { type: 'string', description: 'Company the deal is with, if any.' },
          stage: { type: 'string', description: "Pipeline stage, e.g. 'lead', 'qualified', 'won'. Defaults to 'lead'." },
          amount: { type: 'number', description: 'Deal value, if known.' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'crm_find',
      description: 'Search the CRM for contacts, companies, and deals matching a query. Returns matching records with their ids.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Name, email, or keyword to search for.' },
        },
        required: ['query'],
      },
    },
  },
];

const CRM_TOOL_NAMES = new Set(CRM_TOOL_SCHEMAS.map(t => t.function.name));

/** True when `name` is a built-in CRM tool — used by MCPRegistry for routing. */
export function isCrmTool(name: string): boolean {
  return CRM_TOOL_NAMES.has(name);
}

/** Synchronous dispatcher for the CRM tools (better-sqlite3 is blocking). */
export function invokeCrmTool(name: string, args: Record<string, unknown>, projectId?: string | null): string {
  try {
    if (name === 'crm_add_contact') {
      const nm = String(args.name ?? '').trim();
      if (!nm) return 'Error: "name" is required.';
      const { contact, company } = addContact({
        name: nm,
        email: args.email ? String(args.email) : null,
        phone: args.phone ? String(args.phone) : null,
        title: args.title ? String(args.title) : null,
        company: args.company ? String(args.company) : null,
        projectId: projectId ?? null,
      });
      const at = company ? ` at ${company.name}` : '';
      return `Contact saved (contact_id: ${contact.contact_id}): ${contact.name}${at}.`;
    }

    if (name === 'crm_log_interaction') {
      const ref = String(args.contact ?? '').trim();
      if (!ref) return 'Error: "contact" (contact_id or name) is required.';
      const contact = resolveContactRef(ref);
      if (!contact) return `Error: no contact found matching "${ref}". Add them with crm_add_contact first.`;
      const interaction = logInteraction({
        contactId: contact.contact_id,
        kind: args.kind ? String(args.kind) : 'note',
        summary: String(args.summary ?? ''),
        projectId: projectId ?? null,
      });
      return `Logged ${interaction.kind} with ${contact.name} (interaction_id: ${interaction.interaction_id}).`;
    }

    if (name === 'crm_add_deal') {
      const title = String(args.title ?? '').trim();
      if (!title) return 'Error: "title" is required.';
      const deal = addDeal({
        title,
        contact: args.contact ? String(args.contact) : null,
        company: args.company ? String(args.company) : null,
        stage: args.stage ? String(args.stage) : null,
        amount: typeof args.amount === 'number' ? args.amount : null,
        projectId: projectId ?? null,
      });
      return `Deal created (deal_id: ${deal.deal_id}): "${deal.title}" [${deal.stage}].`;
    }

    if (name === 'crm_find') {
      const query = String(args.query ?? '').trim();
      if (!query) return 'Error: "query" is required.';
      const { contacts, companies, deals } = findRecords(query);
      if (!contacts.length && !companies.length && !deals.length) return `No CRM records match "${query}".`;
      const parts: string[] = [];
      if (contacts.length) parts.push('Contacts:\n' + contacts.map(c => `  [${c.contact_id}] ${c.name}${c.email ? ` <${c.email}>` : ''}`).join('\n'));
      if (companies.length) parts.push('Companies:\n' + companies.map(c => `  [${c.company_id}] ${c.name}`).join('\n'));
      if (deals.length) parts.push('Deals:\n' + deals.map(d => `  [${d.deal_id}] ${d.title} (${d.stage})`).join('\n'));
      return parts.join('\n\n');
    }

    return `Unknown CRM tool: ${name}`;
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

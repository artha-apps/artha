/**
 * Tier → capability matrix.
 *
 * Artha ships as one binary that serves four commercial tiers. Tier, seats,
 * and expiry are encoded in a signed license key (see ./verify.ts); when no
 * valid key is present we fall back to FREE_ENTITLEMENTS. Every gated feature
 * consults the entitlement returned by getEntitlements() rather than checking
 * the tier string directly, so adding a new SKU is one edit here.
 *
 * Commercial names vs wire tiers (the wire string lives inside SIGNED keys,
 * so it never changes even when marketing labels do):
 *   free       → "Free"     — capped solo (doc-gen limit, no scheduler/templates)
 *   pro        → "Personal" — full solo experience, subscription or grandfathered
 *                             perpetual (pre-restructure $29 keys keep working)
 *   team       → "Team"     — LAN hub, shared memory + shared context packs, seats
 *   enterprise → "Business" — + org hub, RBAC, audit export (air-gapped custom
 *                             deals are minted on this tier too)
 */

export type Tier = 'free' | 'pro' | 'team' | 'enterprise';

export interface Entitlements {
  tier: Tier;
  /** Hard cap on (team_members ∪ api_keys). 1 for solo tiers. */
  seats: number;
  /** Allowed to bind the 0.0.0.0:7842 LAN/team server. */
  lanServer: boolean;
  /** Allowed to mark memories as shared (injected into LAN sessions). */
  sharedMemory: boolean;
  /** Allowed to mark context packs as shared (served to LAN teammates). */
  sharedPacks: boolean;
  /** Marketing flag — orchestrator/hub deployment is licenced. Not strictly
   *  enforced at boot in Phase 1 (no headless yet); used by Settings UI copy. */
  orgHub: boolean;
  /** Enforce role-based access on hub management routes. */
  rbac: boolean;
  /** Allowed to export the tool_audit_log. */
  auditExport: boolean;
  /** Generated documents per calendar month; null = unlimited. The Free tier's
   *  conversion lever — doc generation is the flagship feature. */
  docsPerMonth: number | null;
  /** Scheduled/recurring tasks allowed. */
  scheduler: boolean;
  /** Max saved context packs; null = unlimited. */
  maxContextPacks: number | null;
  /** Starter-template gallery installs (SkillsPanel vertical playbooks). */
  skillTemplates: boolean;
  /** Organisation name from the license, or null on Free. */
  org: string | null;
  /** Unix seconds. null on Free; checked by parseAndVerify, not enforced here. */
  expiresAt: number | null;
}

/** Capability matrix, keyed by tier. Seats/org/expiresAt come from the license. */
const BASE = {
  free:       { tier: 'free'       as Tier, lanServer: false, sharedMemory: false, sharedPacks: false, orgHub: false, rbac: false, auditExport: false, docsPerMonth: 5 as number | null,    scheduler: false, maxContextPacks: 1 as number | null,    skillTemplates: false },
  pro:        { tier: 'pro'        as Tier, lanServer: false, sharedMemory: false, sharedPacks: false, orgHub: false, rbac: false, auditExport: false, docsPerMonth: null as number | null, scheduler: true,  maxContextPacks: null as number | null, skillTemplates: true  },
  team:       { tier: 'team'       as Tier, lanServer: true,  sharedMemory: true,  sharedPacks: true,  orgHub: false, rbac: false, auditExport: false, docsPerMonth: null as number | null, scheduler: true,  maxContextPacks: null as number | null, skillTemplates: true  },
  enterprise: { tier: 'enterprise' as Tier, lanServer: true,  sharedMemory: true,  sharedPacks: true,  orgHub: true,  rbac: true,  auditExport: true,  docsPerMonth: null as number | null, scheduler: true,  maxContextPacks: null as number | null, skillTemplates: true  },
} as const;

export const TIER_ENTITLEMENTS = BASE;

/** Returned whenever no license / invalid / expired. Solo, local-only. */
export const FREE_ENTITLEMENTS: Entitlements = {
  ...BASE.free,
  seats: 1,
  org: null,
  expiresAt: null,
};

/** Build an Entitlements record from a verified license payload. */
export function entitlementsFor(
  tier: Tier,
  seats: number,
  org: string | null,
  expiresAt: number | null,
): Entitlements {
  return {
    ...BASE[tier],
    seats: Math.max(1, Math.floor(seats)),
    org,
    expiresAt,
  };
}

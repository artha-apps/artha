/**
 * Tier → capability matrix.
 *
 * Artha ships as one binary that serves three commercial tiers. Tier, seats,
 * and expiry are encoded in a signed license key (see ./verify.ts); when no
 * valid key is present we fall back to FREE_ENTITLEMENTS. Every gated feature
 * (LAN server, seat caps, RBAC on the hub, etc.) consults the entitlement
 * returned by getEntitlements() rather than checking the tier string directly,
 * so adding a new SKU is one edit here.
 */

export type Tier = 'free' | 'pro' | 'enterprise';

export interface Entitlements {
  tier: Tier;
  /** Hard cap on (team_members ∪ api_keys). 1 for solo Free. */
  seats: number;
  /** Allowed to bind the 0.0.0.0:7842 LAN/team server. */
  lanServer: boolean;
  /** Allowed to mark memories as shared (injected into LAN sessions). */
  sharedMemory: boolean;
  /** Marketing flag — orchestrator/hub deployment is licenced. Not strictly
   *  enforced at boot in Phase 1 (no headless yet); used by Settings UI copy. */
  orgHub: boolean;
  /** Enforce role-based access on hub management routes. */
  rbac: boolean;
  /** Allowed to export the tool_audit_log (Phase 2 feature flag). */
  auditExport: boolean;
  /** Organisation name from the license, or null on Free. */
  org: string | null;
  /** Unix seconds. null on Free; checked by parseAndVerify, not enforced here. */
  expiresAt: number | null;
}

/** Capability matrix, keyed by tier. Seats/org/expiresAt come from the license. */
const BASE = {
  free:       { tier: 'free'       as Tier, lanServer: false, sharedMemory: false, orgHub: false, rbac: false, auditExport: false },
  pro:        { tier: 'pro'        as Tier, lanServer: true,  sharedMemory: true,  orgHub: false, rbac: false, auditExport: false },
  enterprise: { tier: 'enterprise' as Tier, lanServer: true,  sharedMemory: true,  orgHub: true,  rbac: true,  auditExport: true  },
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

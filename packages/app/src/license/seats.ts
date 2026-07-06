/**
 * Seat accounting for the license cap.
 *
 * Seats in use = team members ∪ unbound enabled API keys. A key BOUND to a
 * member does not consume a second seat (one human = one seat), matching the
 * "team_members ∪ api_keys" cap documented in entitlements.ts. The two
 * counters were previously enforced independently in the IPC handlers, which
 * let a 5-seat license admit 5 members AND 5 unbound keys (10 actors).
 *
 * Kept in its own module (rather than ipc/handlers.ts) so the arithmetic is
 * unit-testable without pulling in Electron.
 */
import { getDb } from '../db/schema';

export function usedSeats(): number {
  const db = getDb();
  const members = (db.prepare(`SELECT COUNT(*) AS n FROM team_members`).get() as { n: number }).n;
  const unboundKeys = (db.prepare(
    `SELECT COUNT(*) AS n FROM api_keys WHERE is_enabled=1 AND member_id IS NULL`
  ).get() as { n: number }).n;
  return members + unboundKeys;
}

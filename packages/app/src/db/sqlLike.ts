/**
 * Minimal synchronous SQL handle shared by the durability modules (undo,
 * checkpoints, resume).
 *
 * Purpose: those modules take a handle instead of calling getDb() directly so
 * the same code runs against the app's better-sqlite3 connection in
 * production AND against Node's built-in `node:sqlite` in vitest (the native
 * better-sqlite3 binary is built for Electron and cannot load under plain
 * Node). Only positional parameters are used so both drivers behave the same.
 */

/** A prepared statement: the three calls the durability modules use. */
export interface SqlStatement {
  run(...params: unknown[]): { changes: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

/** A connection: raw multi-statement exec plus prepare. */
export interface SqlDb {
  exec(sql: string): unknown;
  prepare(sql: string): SqlStatement;
}

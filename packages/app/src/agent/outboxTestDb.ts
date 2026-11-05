/**
 * Test-only helper: an in-memory SQLite (node:sqlite) loaded with the real
 * outbox DDL plus the slice of chat_sessions/messages the outbox touches.
 * The production better-sqlite3 binary is rebuilt for Electron's ABI and
 * cannot load under vitest, so the outbox suites run the same SQL here.
 * Not imported by any production module.
 */
import { OUTBOX_SCHEMA_SQL } from '../db/outboxSchema';
import type { OutboxDb } from './outbox';

/** Open a fresh in-memory DB with the outbox schema and the given sessions. */
export function makeOutboxTestDb(sessionIds: string[] = ['s1']): OutboxDb {
  // Loaded at runtime (Node ≥ 22) so neither the bundler nor tsc's Node 20
  // typings need to know about node:sqlite.
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as unknown as {
    DatabaseSync: new (path: string) => OutboxDb;
  };
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE chat_sessions (
      session_id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'New Chat',
      outbox_paused INTEGER NOT NULL DEFAULT 0,
      outbox_paused_reason TEXT
    );
    CREATE TABLE messages (
      message_id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      sender_type TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT ''
    );
  `);
  db.exec(OUTBOX_SCHEMA_SQL);
  const ins = db.prepare(`INSERT INTO chat_sessions (session_id) VALUES (?)`);
  for (const id of sessionIds) ins.run(id);
  return db;
}

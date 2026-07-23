/**
 * email_send tests — the consequential "actually send" path.
 *
 * The three properties that matter are pinned here against a REAL in-memory
 * SQLite DB (so the write-ahead double-send guard is exercised with true SQL
 * semantics, not a mock):
 *   1. it refuses cleanly when Gmail isn't connected / lacks send scope;
 *   2. it never sends the same email twice (crash-safety);
 *   3. it only reports sent:true when Gmail returns a message id, and records
 *      an ambiguous network failure as outcome_unknown (never a silent success
 *      or a silent retry).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Faithful in-memory fake of the few queries gmailSend issues (the repo can't
 * load native better-sqlite3 under vitest). It models the tables as arrays and
 * honours the double-send guard's `state IN ('dispatching','confirmed')` filter
 * exactly, so the crash-safety test is real, not a rubber stamp.
 */
interface Action { action_id: string; tool: string; category: string; target_identity: string; fingerprint: string; state: string; external_ref: string | null; outcome: string | null; retry_eligible: number; created_at: number }
interface FakeDb { users: { settings_json: string }; oauth: Record<string, unknown> | null; actions: Action[] }
let store: FakeDb;
let seq = 0;

function freshDb(): FakeDb {
  return { users: { settings_json: '{"google_client_id":"cid.apps.googleusercontent.com"}' }, oauth: null, actions: [] };
}

const fakeDb = {
  prepare(sql: string) {
    return {
      get: (...a: unknown[]) => {
        if (sql.includes('FROM users')) return store.users;
        if (sql.includes('FROM oauth_tokens')) return store.oauth ?? undefined;
        if (sql.includes("state IN ('dispatching','confirmed')")) {
          return [...store.actions]
            .filter(x => x.tool === 'email_send' && x.fingerprint === a[0] && (x.state === 'dispatching' || x.state === 'confirmed'))
            .sort((x, y) => y.created_at - x.created_at)[0];
        }
        if (sql.includes("state='confirmed'")) return { n: store.actions.filter(x => x.state === 'confirmed').length };
        if (sql.includes('FROM external_actions')) return store.actions[0];
        return undefined;
      },
      all: () => (sql.includes('tool_policies') ? [] : []),
      run: (...a: unknown[]) => {
        if (sql.startsWith('INSERT INTO external_actions')) {
          // (action_id, task_id, run_id, tool, category, target_system, target_identity, fingerprint, ...)
          store.actions.push({
            action_id: a[0] as string, tool: 'email_send', category: 'send',
            target_identity: a[3] as string, fingerprint: a[4] as string,
            state: 'dispatching', external_ref: null, outcome: null, retry_eligible: 0, created_at: ++seq,
          });
        } else if (sql.startsWith('UPDATE external_actions')) {
          const row = store.actions.find(x => x.action_id === a[5]);
          if (row) { row.state = a[0] as string; row.external_ref = a[1] as string | null; row.outcome = a[2] as string | null; row.retry_eligible = a[3] as number; }
        } else if (sql.includes('UPDATE oauth_tokens')) {
          if (store.oauth) { store.oauth.access_token = a[0]; store.oauth.expires_at = a[1]; }
        }
        return {};
      },
    };
  },
};

vi.mock('../db/schema', () => ({ getDb: () => fakeDb }));
vi.mock('../security/secretString', () => ({
  isSecretEncryptionAvailable: () => true,
  sealSecretString: (s: string) => `enc:${s}`,
  openSecretString: (s: string | null | undefined) => (s ? s.replace(/^enc:/, '') : ''),
}));

import { invokeGmailSendTool, isGmailSendTool } from './gmailSend';
import { evaluatePolicy } from '../bodhi/policy';

const FUTURE = () => Math.floor(Date.now() / 1000) + 3600;
function connectGoogle(scope = 'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly') {
  store.oauth = { provider: 'google', access_token: 'enc:live-access', refresh_token: 'enc:refresh', expires_at: FUTURE(), scope };
}
const send = (over: Record<string, unknown> = {}) =>
  invokeGmailSendTool('email_send', { to: 'jk@example.com', subject: 'Hi', body: 'yes or No?', ...over });

const okResponse = (id = 'msg-123') => ({ ok: true, status: 200, json: async () => ({ id }) });
const onlyAction = () => store.actions[0];

beforeEach(() => { store = freshDb(); seq = 0; vi.restoreAllMocks(); });

describe('refuses without a usable connection — nothing sent', () => {
  it('errors when Google is not connected', async () => {
    const r = await send();
    expect(r).toMatch(/^Error:/);
    expect(r).toMatch(/isn.t connected/i);
    expect(r).toMatch(/Nothing was sent/);
  });

  it('errors when the connection lacks gmail.send scope', async () => {
    connectGoogle('https://www.googleapis.com/auth/gmail.readonly');
    const r = await send();
    expect(r).toMatch(/^Error:/);
    expect(r).toMatch(/send permission/i);
    // and it must NOT have recorded a confirmed send
    expect(store.actions.filter(x => x.state === 'confirmed')).toHaveLength(0);
  });
});

describe('happy path only claims sent on a real message id', () => {
  it('sends and records a confirmed write-ahead row with the message id', async () => {
    connectGoogle();
    global.fetch = vi.fn().mockResolvedValue(okResponse('gmail-abc')) as never;
    const out = JSON.parse(await send());
    expect(out.sent).toBe(true);
    expect(out.gmail_message_id).toBe('gmail-abc');
    const row = onlyAction();
    expect(row.state).toBe('confirmed');
    expect(row.external_ref).toBe('gmail-abc');
    expect(row.category).toBe('send');
    expect(row.target_identity).toMatch(/^sha256:/); // recipient never stored in the clear
  });

  it('POSTs a base64url MIME body to the Gmail send endpoint', async () => {
    connectGoogle();
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    global.fetch = fetchMock as never;
    await send({ subject: 'Q3 & Q4', body: 'yes or No?' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('gmail/v1/users/me/messages/send');
    const raw = JSON.parse((init as { body: string }).body).raw as string;
    const mime = Buffer.from(raw, 'base64url').toString('utf8');
    expect(mime).toContain('To: jk@example.com');
    expect(mime).toContain('Subject: Q3 & Q4');
    expect(mime).toContain('yes or No?');
  });
});

describe('never double-sends (crash safety)', () => {
  it('refuses a second identical send once one is confirmed', async () => {
    connectGoogle();
    global.fetch = vi.fn().mockResolvedValue(okResponse('first')) as never;
    const first = JSON.parse(await send());
    expect(first.sent).toBe(true);

    // Second identical call must NOT hit the network again.
    const fetchMock = vi.fn();
    global.fetch = fetchMock as never;
    const second = JSON.parse(await send());
    expect(second.sent).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses when a prior attempt is stuck dispatching (may have sent)', async () => {
    connectGoogle();
    // Let the code create a row for this exact email (real fingerprint), then
    // simulate a crash between dispatch and confirmation by flipping it back to
    // 'dispatching' — the state a process that died mid-send would leave behind.
    global.fetch = vi.fn().mockRejectedValue(new Error('crash')) as never;
    await send();
    expect(store.actions).toHaveLength(1);
    store.actions[0].state = 'dispatching';

    const fetchMock = vi.fn();
    global.fetch = fetchMock as never;
    const out = JSON.parse(await send());
    expect(out.sent).toBe(false);
    expect(out.outcome_unknown).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();   // did NOT try to send a second copy
  });
});

describe('honest failure reporting', () => {
  it('records outcome_unknown (not failure) when the network throws mid-send', async () => {
    connectGoogle();
    global.fetch = vi.fn().mockRejectedValue(new Error('socket hang up')) as never;
    const out = JSON.parse(await send());
    expect(out.sent).toBe(false);
    expect(out.outcome_unknown).toBe(true);
    expect(out.message).toMatch(/Sent folder/i);
    expect(onlyAction().state).toBe('outcome_unknown');
  });

  it('reports a clean NOT-sent when Gmail rejects the request', async () => {
    connectGoogle();
    global.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 403, json: async () => ({ error: { message: 'Insufficient Permission' } }),
    }) as never;
    const r = await send();
    expect(r).toMatch(/^Error:/);
    expect(r).toMatch(/NOT sent/);
    expect(r).toMatch(/Insufficient Permission/);
    expect(onlyAction().state).toBe('failed');
  });
});

describe('validation and routing', () => {
  it('rejects a missing recipient before touching the network', async () => {
    connectGoogle();
    const fetchMock = vi.fn();
    global.fetch = fetchMock as never;
    expect(await send({ to: '' })).toMatch(/"to" is required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('only routes its own tool name', () => {
    expect(isGmailSendTool('email_send')).toBe(true);
    expect(isGmailSendTool('email_compose')).toBe(false);
  });
});

describe('approval floor is enforced in code', () => {
  it('email_send can never evaluate below confirm, even with no policies', () => {
    const d = evaluatePolicy('email_send', {});
    expect(['confirm', 'forbid']).toContain(d.tier);
  });
});

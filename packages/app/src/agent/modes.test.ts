/**
 * Permission-mode tests: the mode × tool matrix, the decision order (forbid >
 * floor > mode > grant > baseline), the email_send floor, expired grants, and
 * the auto gate's fail-closed classifier.
 */
import { describe, it, expect } from 'vitest';
import {
  decideToolCall, autoGate, parseClassifierOutput, resolveEffectiveMode, defaultModeFor,
  decidePlanGate, isPermissionMode, type PermissionMode, type ToolCallGateInput, type AutoGateClassifier,
} from './modes';
import { InMemoryGrantStore } from '../bodhi/grants';
import type { PolicyTier } from '../bodhi/policy';

const NOW = 1_800_000_000;
const ROOT = '/home/u/proj';
const SUBJECTS = ['session:s1', 'global'];

/** Build a gate input with sensible defaults (attended, scoped chat, auto policy). */
function input(over: Partial<ToolCallGateInput> & { tier?: PolicyTier } = {}): ToolCallGateInput {
  const { tier, ...rest } = over;
  return {
    toolName: 'fs_read_file',
    args: { path: `${ROOT}/a.txt` },
    mode: 'ask',
    policy: { tier: tier ?? 'auto', matchedPattern: null, note: '' },
    isFloor: false,
    attended: true,
    roots: [ROOT],
    planApproved: false,
    subjects: SUBJECTS,
    grants: new InMemoryGrantStore(),
    now: NOW,
    ...rest,
  };
}

/** Representative calls for the matrix. */
const CALLS = {
  read: { toolName: 'fs_read_file', args: { path: `${ROOT}/a.txt` } },
  editIn: { toolName: 'fs_move_file', args: { source: `${ROOT}/a.txt`, destination: `${ROOT}/b/a.txt` } },
  editOut: { toolName: 'fs_copy_file', args: { source: `${ROOT}/a.txt`, destination: '/tmp/a.txt' } },
  del: { toolName: 'fs_delete_file', args: { path: `${ROOT}/a.txt` } },
  web: { toolName: 'web_search', args: { query: 'x' } },
  click: { toolName: 'browser_click', args: { selector: '#go' } },
} as const;

type Call = keyof typeof CALLS;
const MODES: PermissionMode[] = ['ask', 'accept_edits', 'plan', 'auto', 'unattended'];

// Expected action per (mode, call) for an attended run, no grants, auto policy,
// plan NOT yet approved. 'ask' in unattended can't happen — it would be 'block'.
const MATRIX: Record<PermissionMode, Record<Call, string>> = {
  ask:          { read: 'run', editIn: 'ask', editOut: 'ask', del: 'ask', web: 'run', click: 'ask' },
  accept_edits: { read: 'run', editIn: 'run', editOut: 'ask', del: 'ask', web: 'run', click: 'run' },
  plan:         { read: 'run', editIn: 'block', editOut: 'block', del: 'block', web: 'run', click: 'block' },
  auto:         { read: 'run', editIn: 'run', editOut: 'ask', del: 'ask', web: 'run', click: 'run' },
  unattended:   { read: 'run', editIn: 'run', editOut: 'run', del: 'run', web: 'run', click: 'run' },
};

describe('mode × tool matrix', () => {
  for (const mode of MODES) {
    for (const call of Object.keys(CALLS) as Call[]) {
      it(`${mode} × ${call} → ${MATRIX[mode][call]}`, async () => {
        const d = await decideToolCall(input({ mode, ...CALLS[call] }));
        expect(d.action).toBe(MATRIX[mode][call]);
      });
    }
  }

  it('a confirm-tier policy asks in every attended mode and blocks unattended', async () => {
    for (const mode of ['ask', 'accept_edits', 'auto'] as PermissionMode[]) {
      const d = await decideToolCall(input({ mode, ...CALLS.web, tier: 'confirm' }));
      expect(d.action).toBe('ask');
    }
    expect((await decideToolCall(input({ mode: 'unattended', ...CALLS.web, tier: 'confirm' }))).action).toBe('block');
    // attended flag false (LAN / scheduler) also fails closed, whatever the mode
    expect((await decideToolCall(input({ mode: 'auto', attended: false, ...CALLS.web, tier: 'confirm' }))).action).toBe('block');
  });

  it('accept_edits never asks less than an explicit confirm rule', async () => {
    const d = await decideToolCall(input({ mode: 'accept_edits', ...CALLS.editIn, tier: 'confirm' }));
    expect(d.action).toBe('ask');
  });

  it('plan mode allows changes once the plan is approved', async () => {
    const d = await decideToolCall(input({ mode: 'plan', planApproved: true, ...CALLS.editIn }));
    expect(d.action).toBe('run');
  });

  it('auto mode lets deletes in a user-approved plan run', async () => {
    const d = await decideToolCall(input({ mode: 'auto', planApproved: true, ...CALLS.del }));
    expect(d.action).toBe('run');
  });

  it('auto/accept_edits deletes block (not hang) when unattended', async () => {
    const d = await decideToolCall(input({ mode: 'auto', attended: false, ...CALLS.del }));
    expect(d.action).toBe('block');
    expect(d.reason).toMatch(/unattended/);
  });
});

describe('decision order', () => {
  it('forbid beats everything, including a matching grant', async () => {
    const grants = new InMemoryGrantStore();
    grants.add({ scopeKind: 'tool', scopeValue: 'fs_delete_file', subject: 'global', ttlSeconds: 3600 }, NOW);
    const d = await decideToolCall(input({ mode: 'auto', ...CALLS.del, tier: 'forbid', grants, planApproved: true }));
    expect(d).toMatchObject({ action: 'block', source: 'policy-forbid' });
  });

  it('dry_run policy describes without executing', async () => {
    const d = await decideToolCall(input({ mode: 'auto', ...CALLS.editIn, tier: 'dry_run' }));
    expect(d.action).toBe('dry_run');
  });

  it('mode block is not overridden by a grant', async () => {
    const grants = new InMemoryGrantStore();
    grants.add({ scopeKind: 'tool', scopeValue: 'fs_delete_file', subject: 'global', ttlSeconds: 3600 }, NOW);
    const d = await decideToolCall(input({ mode: 'plan', ...CALLS.del, grants }));
    expect(d).toMatchObject({ action: 'block', source: 'mode' });
  });

  it('an active grant turns an ask into a run', async () => {
    const grants = new InMemoryGrantStore();
    const g = grants.add({ scopeKind: 'tool', scopeValue: 'fs_delete_file', subject: 'session:s1', ttlSeconds: 3600 }, NOW);
    const d = await decideToolCall(input({ mode: 'auto', ...CALLS.del, grants }));
    expect(d).toMatchObject({ action: 'run', source: 'grant', grantId: g.id });
  });

  it('a folder grant covers in-folder deletes only', async () => {
    const grants = new InMemoryGrantStore();
    grants.add({ scopeKind: 'folder', scopeValue: `${ROOT}/tmp`, subject: 'global', ttlSeconds: 3600 }, NOW);
    expect((await decideToolCall(input({ mode: 'accept_edits', toolName: 'fs_delete_file', args: { path: `${ROOT}/tmp/x` }, grants }))).action).toBe('run');
    expect((await decideToolCall(input({ mode: 'accept_edits', toolName: 'fs_delete_file', args: { path: `${ROOT}/x` }, grants }))).action).toBe('ask');
  });

  it('an expired grant is ignored', async () => {
    const grants = new InMemoryGrantStore();
    grants.add({ scopeKind: 'tool', scopeValue: 'fs_delete_file', subject: 'global', ttlSeconds: 60 }, NOW - 120);
    const d = await decideToolCall(input({ mode: 'auto', ...CALLS.del, grants }));
    expect(d.action).toBe('ask');
  });

  it('a revoked grant is ignored', async () => {
    const grants = new InMemoryGrantStore();
    const g = grants.add({ scopeKind: 'tool', scopeValue: 'fs_delete_file', subject: 'global', ttlSeconds: 3600 }, NOW);
    grants.revoke(g.id);
    expect((await decideToolCall(input({ mode: 'auto', ...CALLS.del, grants }))).action).toBe('ask');
  });

  it('grants never apply when the run has no subjects (LAN)', async () => {
    const grants = new InMemoryGrantStore();
    grants.add({ scopeKind: 'tool', scopeValue: 'web_search', subject: 'global', ttlSeconds: 3600 }, NOW);
    const d = await decideToolCall(input({ mode: 'unattended', attended: false, subjects: [], ...CALLS.web, tier: 'confirm', grants }));
    expect(d.action).toBe('block');
  });
});

describe('email_send always-confirm floor', () => {
  const send = { toolName: 'email_send', args: { to: 'a@b.co', subject: 's', body: 'b' }, isFloor: true, tier: 'confirm' as PolicyTier };

  it('still asks without an explicit grant, in every attended mode', async () => {
    for (const mode of ['ask', 'accept_edits', 'auto', 'plan'] as PermissionMode[]) {
      const d = await decideToolCall(input({ mode, ...send, planApproved: true }));
      expect(d).toMatchObject({ action: 'ask', source: 'floor' });
    }
  });

  it('blocks unattended without an explicit schedule grant', async () => {
    const grants = new InMemoryGrantStore();
    grants.add({ scopeKind: 'tool', scopeValue: 'email_send', subject: 'global', ttlSeconds: 3600 }, NOW);
    const d = await decideToolCall(input({ mode: 'unattended', attended: false, ...send, grants }));
    expect(d.action).toBe('block');
  });

  it('is NOT satisfied by folder / connector / non-expiring grants', async () => {
    const grants = new InMemoryGrantStore();
    grants.add({ scopeKind: 'connector', scopeValue: 'gmail', subject: 'global', ttlSeconds: 3600 }, NOW);
    grants.add({ scopeKind: 'tool', scopeValue: 'email_send', subject: 'global', expiresAt: null }, NOW);
    const d = await decideToolCall(input({ mode: 'auto', ...send, connector: 'gmail', grants }));
    expect(d).toMatchObject({ action: 'ask', source: 'floor' });
  });

  it('is satisfied by an explicit, unexpired grant naming email_send', async () => {
    const grants = new InMemoryGrantStore();
    grants.add({ scopeKind: 'tool', scopeValue: 'email_send', subject: 'session:s1', ttlSeconds: 3600 }, NOW);
    expect((await decideToolCall(input({ mode: 'auto', ...send, grants }))).action).toBe('run');
    // …but not once it has expired
    expect((await decideToolCall(input({ mode: 'auto', ...send, grants, now: NOW + 3600 }))).action).toBe('ask');
  });

  it('forbid still beats the explicit grant, and plan mode still blocks before approval', async () => {
    const grants = new InMemoryGrantStore();
    grants.add({ scopeKind: 'tool', scopeValue: 'email_send', subject: 'global', ttlSeconds: 3600 }, NOW);
    expect((await decideToolCall(input({ mode: 'auto', ...send, tier: 'forbid', grants }))).action).toBe('block');
    expect((await decideToolCall(input({ mode: 'plan', ...send, grants }))).action).toBe('block');
  });
});

describe('autoGate classifier fails closed', () => {
  const unknown = { toolName: 'acme_create_invoice', args: { amount: 10 }, policyTier: 'auto' as PolicyTier, roots: [], planApproved: false };
  const cls = (fn: () => Promise<string>): AutoGateClassifier => ({ classify: fn });

  it('no classifier ⇒ connector tools keep today\'s behaviour', async () => {
    expect((await autoGate({ ...unknown, attended: true })).decision).toBe('allow');
  });

  it('timeout ⇒ ask when attended, block when unattended', async () => {
    const never = cls(() => new Promise<string>(() => { /* never resolves */ }));
    expect((await autoGate({ ...unknown, attended: true }, never, 20)).decision).toBe('ask');
    expect((await autoGate({ ...unknown, attended: false }, never, 20)).decision).toBe('block');
  });

  it('unparseable output ⇒ fail closed', async () => {
    const junk = cls(async () => 'sure, go ahead!');
    expect((await autoGate({ ...unknown, attended: true }, junk)).decision).toBe('ask');
    expect((await autoGate({ ...unknown, attended: false }, junk)).decision).toBe('block');
    const bad = cls(async () => '{"decision":"yolo"}');
    expect((await autoGate({ ...unknown, attended: true }, bad)).decision).toBe('ask');
  });

  it('a throwing classifier ⇒ fail closed', async () => {
    const boom = cls(async () => { throw new Error('model gone'); });
    expect((await autoGate({ ...unknown, attended: false }, boom)).decision).toBe('block');
  });

  it('a clear verdict is used; "ask" unattended becomes block', async () => {
    expect((await autoGate({ ...unknown, attended: true }, cls(async () => '```json\n{"decision":"allow","reason":"ok"}\n```'))).decision).toBe('allow');
    expect((await autoGate({ ...unknown, attended: true }, cls(async () => '{"decision":"block","reason":"no"}'))).decision).toBe('block');
    expect((await autoGate({ ...unknown, attended: false }, cls(async () => '{"decision":"ask"}'))).decision).toBe('block');
  });

  it('the classifier is never consulted for built-in tools', async () => {
    let called = false;
    const spy = cls(async () => { called = true; return '{"decision":"allow"}'; });
    await autoGate({ ...unknown, toolName: 'fs_delete_file', args: { path: '/x' }, attended: true }, spy);
    expect(called).toBe(false);
  });

  it('parseClassifierOutput rejects non-strings', () => {
    expect(parseClassifierOutput(undefined)).toBeNull();
    expect(parseClassifierOutput('{"decision":"allow"}')?.decision).toBe('allow');
  });
});

describe('mode resolution + plan gate', () => {
  it('autonomousActions maps to the default mode', () => {
    expect(defaultModeFor(false)).toBe('ask');
    expect(defaultModeFor(true)).toBe('auto');
    expect(defaultModeFor(undefined)).toBe('auto');
  });

  it('an unattended or LAN run is always unattended', () => {
    expect(resolveEffectiveMode('auto', true, { unattended: true })).toBe('unattended');
    expect(resolveEffectiveMode('accept_edits', true, { lan: true })).toBe('unattended');
    expect(resolveEffectiveMode(null, false, null)).toBe('ask');
    expect(resolveEffectiveMode('plan', true, undefined)).toBe('plan');
  });

  it('plan gate: ask/plan always show the card; auto uses blast radius', () => {
    const safe = { deletions: 0, reversible: true, moves: 2, writes: 0 };
    const risky = { deletions: 1, reversible: false, moves: 0, writes: 0 };
    expect(decidePlanGate('ask', safe).auto).toBe(false);
    expect(decidePlanGate('plan', safe).auto).toBe(false);
    expect(decidePlanGate('auto', safe).auto).toBe(true);
    expect(decidePlanGate('auto', risky).auto).toBe(false);
    expect(decidePlanGate('accept_edits', safe).auto).toBe(true);
    expect(decidePlanGate('auto', undefined).auto).toBe(false);
  });

  it('isPermissionMode guards IPC input', () => {
    expect(isPermissionMode('auto')).toBe(true);
    expect(isPermissionMode('yolo')).toBe(false);
    expect(isPermissionMode(3)).toBe(false);
  });
});

describe('ask mode asks before any change until its plan is approved (live QA 2026-11-12)', () => {
  it('a copy inside the attached folder asks; after plan approval the policy decides', async () => {
    const copy = { toolName: 'fs_copy_file', args: { source: `${ROOT}/a.txt`, destination: `${ROOT}/b.txt` } };
    expect((await decideToolCall(input({ mode: 'ask', ...copy }))).action).toBe('ask');
    expect((await decideToolCall(input({ mode: 'ask', ...copy, planApproved: true }))).action).toBe('run');
  });
  it('an unattended run never gets the ask: it is blocked', async () => {
    const copy = { toolName: 'fs_copy_file', args: { source: `${ROOT}/a.txt`, destination: `${ROOT}/b.txt` } };
    expect((await decideToolCall(input({ mode: 'ask', ...copy, attended: false }))).action).toBe('block');
  });
});

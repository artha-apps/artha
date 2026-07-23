import { describe, it, expect } from 'vitest';
import { scrubEvent } from './sentryScrub';

// scrubEvent is the privacy backstop for opt-out telemetry: it runs as Sentry's
// `beforeSend` and must guarantee NOTHING that identifies the user or reveals
// their local data ever leaves the machine. These tests pin that guarantee.

describe('scrubEvent', () => {
  it('replaces absolute paths in the message with <path>/basename', () => {
    const out = scrubEvent({ message: 'Failed to read /Users/jane/Projects/secret/notes.md' });
    expect(out?.message).toBe('Failed to read <path>/notes.md');
    expect(out?.message).not.toContain('jane');
    expect(out?.message).not.toContain('secret');
  });

  it('strips paths from exception values and reduces frames to basenames', () => {
    const out = scrubEvent({
      exception: {
        values: [{
          type: 'Error',
          value: 'ENOENT: /Users/jane/.artha/db.sqlite missing',
          stacktrace: {
            frames: [{
              filename: '/Users/jane/Projects/artha/packages/app/src/main.ts',
              abs_path: '/Users/jane/Projects/artha/packages/app/src/main.ts',
              vars: { secretToken: 'abc123', fileContents: 'private notes' },
            }],
          },
        }],
      },
    });
    const ex = out!.exception!.values![0];
    expect(ex.value).toBe('ENOENT: <path>/db.sqlite missing');
    const frame = ex.stacktrace!.frames![0];
    expect(frame.filename).toBe('main.ts');     // basename only
    expect(frame.abs_path).toBeUndefined();      // full path dropped
    expect(frame.vars).toBeUndefined();          // locals (content/prompts) dropped
  });

  it('hard-removes user, request, server_name and device context', () => {
    const out = scrubEvent({
      user: { id: 'u1', email: 'jane@example.com' },
      request: { url: 'http://localhost/secret', data: 'prompt text' },
      server_name: 'janes-macbook.local',
      contexts: { device: { name: 'Jane’s MacBook' }, os: { name: 'macOS' } },
    } as Parameters<typeof scrubEvent>[0]);
    expect(out?.user).toBeUndefined();
    expect(out?.request).toBeUndefined();
    expect(out?.server_name).toBeUndefined();
    expect(out?.contexts?.device).toBeUndefined();
    // Non-identifying context is preserved.
    expect(out?.contexts?.os).toEqual({ name: 'macOS' });
  });

  it('keeps only artha.* breadcrumbs and drops the rest (e.g. console)', () => {
    const out = scrubEvent({
      breadcrumbs: [
        { category: 'console', message: 'logged a user prompt' },
        { category: 'artha.db_health', message: 'db checkpoint' },
        { category: undefined, message: 'uncategorised' },
        { category: 'artha.health_check', message: 'daily health check' },
      ],
    } as Parameters<typeof scrubEvent>[0]);
    expect(out?.breadcrumbs?.map(b => b.category)).toEqual(['artha.db_health', 'artha.health_check']);
  });

  it('is a no-op-safe pass-through for an empty event', () => {
    expect(scrubEvent({})).toEqual({});
  });

  it('redacts credential-shaped substrings in exception values (review L5)', () => {
    const out = scrubEvent({
      exception: { values: [{
        value: 'Provider said: Incorrect API key sk-live-Abc123XYZ789 with Bearer eyJhbGciOi.abc123 and blob v1:enc:Zm9vYmFy',
      }] },
    } as Parameters<typeof scrubEvent>[0]);
    const v = out?.exception?.values?.[0].value ?? '';
    expect(v).not.toContain('sk-live-Abc123XYZ789');
    expect(v).not.toContain('eyJhbGciOi.abc123');
    expect(v).not.toContain('Zm9vYmFy');
    expect(v).toContain('<redacted-key>');
    expect(v).toContain('Bearer <redacted>');
    expect(v).toContain('<redacted-envelope>');
  });
});

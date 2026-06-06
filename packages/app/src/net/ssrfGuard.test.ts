import { describe, it, expect } from 'vitest';
import { assertPublicURL, isPrivateIp, isPrivateUrlSync } from './ssrfGuard';

describe('isPrivateIp', () => {
  it('flags loopback, private, link-local and metadata ranges', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.4.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1']) {
      expect(isPrivateIp(ip)).toBe(true);
    }
  });
  it('flags IPv6 loopback / link-local / unique-local and IPv4-mapped', () => {
    for (const ip of ['::1', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:127.0.0.1']) {
      expect(isPrivateIp(ip)).toBe(true);
    }
  });
  it('passes public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111']) {
      expect(isPrivateIp(ip)).toBe(false);
    }
  });
});

describe('assertPublicURL', () => {
  it('rejects non-http(s) schemes', async () => {
    await expect(assertPublicURL('file:///etc/passwd')).rejects.toThrow(/only http/i);
    await expect(assertPublicURL('ftp://example.com')).rejects.toThrow(/only http/i);
  });

  it('rejects internal hostnames without needing DNS', async () => {
    await expect(assertPublicURL('http://localhost:11434/api/tags')).rejects.toThrow(/internal host/i);
    await expect(assertPublicURL('http://printer.local')).rejects.toThrow(/internal host/i);
    await expect(assertPublicURL('http://metadata.google.internal/')).rejects.toThrow(/internal host/i);
  });

  it('rejects literal private/loopback/metadata IPs', async () => {
    await expect(assertPublicURL('http://127.0.0.1:6379')).rejects.toThrow(/private\/loopback/i);
    await expect(assertPublicURL('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(/private\/loopback/i);
    await expect(assertPublicURL('http://192.168.0.1/admin')).rejects.toThrow(/private\/loopback/i);
  });

  it('allows a public literal IP', async () => {
    const u = await assertPublicURL('https://1.1.1.1/');
    expect(u.hostname).toBe('1.1.1.1');
  });

  it('honours the allowlist for a deliberately-permitted internal host', async () => {
    const u = await assertPublicURL('http://localhost:3000/dev', ['localhost']);
    expect(u.port).toBe('3000');
  });
});

describe('isPrivateUrlSync (redirect / window-open guard)', () => {
  it('blocks literal private/loopback/metadata IPs and internal hostnames', () => {
    for (const u of [
      'http://127.0.0.1:6379',
      'http://169.254.169.254/latest/meta-data/',
      'http://192.168.0.1/admin',
      'https://localhost:11434/api/tags',
      'http://printer.local',
      'http://metadata.google.internal/',
      'file:///etc/passwd',
      'not a url',
    ]) {
      expect(isPrivateUrlSync(u)).toBe(true);
    }
  });

  it('allows public http(s) and the agent-browser data:/about: pages', () => {
    for (const u of ['https://example.com', 'http://1.1.1.1/', 'about:blank', 'data:text/html,hi']) {
      expect(isPrivateUrlSync(u)).toBe(false);
    }
  });

  it('does not block a host the user explicitly allowlisted', () => {
    expect(isPrivateUrlSync('http://localhost:3000', ['localhost'])).toBe(false);
  });

  it('lets DNS hostnames through (the async guard owns those)', () => {
    // We cannot resolve synchronously, so a plain name is not blocked here.
    expect(isPrivateUrlSync('http://intranet.example.com')).toBe(false);
  });
});

# Dependency security triage — work item (separate from PR #42)

**Trigger:** GitHub reports 32 open Dependabot alerts on `main` (1 critical, 9 high, 19 moderate, 3 low). Founder directive 2026-07-23: triage separately; no dependency changes inside PR #42.

## Critical — triaged first (COMPLETE)

| Field | Value |
|---|---|
| Package / CVE | `shell-quote` · CVE-2026-9277 ("quote() does not escape newlines in object .op values") |
| Installed → fixed | 1.8.3 → 1.8.4 |
| Severity | Critical (advisory) |
| Dependency type | **Transitive, devDependency-only**: `concurrently@8.2.2 → shell-quote@1.8.3` (dev-server script runner) |
| In packaged app? | **No** — `npx asar list` of the built `app.asar`: zero shell-quote entries |
| Reachable via Artha functionality? | **No** — nothing in shipped code imports it; exploit requires our code passing untrusted objects to `quote()`, which never occurs |
| Breaking upgrade? | No — patch bump; `overrides` entry or `concurrently` bump suffices |
| Classification (founder rubric) | **Build/development environment risk — NOT reachable in the shipped product — NOT a PR #42 merge blocker** |
| Remediation | Add `"shell-quote": "^1.8.4"` to root `overrides` (or bump concurrently) in the dedicated dependency PR |
| Release-blocking? | Not for shipped-product security; fix anyway as hygiene in the dedicated PR before the next distributable build (founder-designated release gate) |

## Remaining 31 alerts — register skeleton (to complete in the dedicated PR)
For each: package · installed/fixed versions · severity · direct/transitive · prod/dev · in-asar? (`npx asar list | grep`) · reachability through Artha surfaces (credential handling, IPC, updater, browser, network stack get priority) · exploit conditions · breaking? · remediation · release-gate status. Method: `gh api /repos/artha-apps/artha/dependabot/alerts?state=open` per-alert + asar-presence check; `npm audit` cross-reference. Priority order: the 9 highs first, anything with `dependency.scope == "runtime"` AND asar-present is presumed release-blocking until shown otherwise.

**Owner:** next session after PR #42 merges (or before next release, whichever first). **Output:** one narrowly-scoped PR: overrides/bumps + this register completed.


## Pre-existing finding surfaced by the cross-OS CI matrix (not introduced by PR #42)

**Windows system-path sandboxing is POSIX-only.** ✅ **RESOLVED (v0.4.16, issue #43).**
Previously `filesystem.ts` blocked writes using a POSIX-only list, so on Windows
the agent's sandbox relied only on the per-chat scope check. Now `isSystemPath`
is platform-aware: on Windows it blocks `C:\Windows`, `C:\Program Files` /
`(x86)`, `C:\ProgramData`, `System Volume Information`, `$Recycle.Bin`,
`Recovery`, and UNC shares — on any drive, case-insensitively, both separators.
Every filesystem op (read, list, move src+dst, copy src+dst, create, delete)
runs through it, so writes into system dirs are blocked too. Covered by
`filesystem.systemPath.test.ts`, which exercises both blocklists on any host
(no Windows machine required).

| Field | Value |
|---|---|
| Severity | Medium (defence-in-depth gap, Windows only) |
| Introduced by | Pre-existing — predates PR #42 |
| Enforcement boundary | Agent filesystem tool dispatch |
| Owner phase | Release gate for the next **Windows** distributable build |
| Acceptance | Platform-aware system-path denylist + tests that run on all three OSes |

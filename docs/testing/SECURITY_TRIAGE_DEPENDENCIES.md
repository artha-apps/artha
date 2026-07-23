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

**Windows system-path sandboxing is POSIX-only.** `packages/app/src/tools/filesystem.ts:61` blocks writes using a POSIX list (`/System`, `/Library/System`, `/usr`, `/etc`, `/bin`, `/sbin`, `/private/etc`). There is no Windows equivalent (`C:\Windows`, `C:\Program Files`, `%SystemRoot%`), so on Windows the agent's filesystem sandbox relies only on the per-chat scope check, not on an absolute system-directory denylist. The two tests covering this were POSIX-only and had never run on Windows before the OS matrix was added in this PR; they are now skipped on win32 rather than asserting behaviour the code does not implement.

| Field | Value |
|---|---|
| Severity | Medium (defence-in-depth gap, Windows only) |
| Introduced by | Pre-existing — predates PR #42 |
| Enforcement boundary | Agent filesystem tool dispatch |
| Owner phase | Release gate for the next **Windows** distributable build |
| Acceptance | Platform-aware system-path denylist + tests that run on all three OSes |

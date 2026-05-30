# Known-issue: upstream dependency vulnerabilities we cannot patch ourselves

Last reviewed: 2026-05-30.

`npm audit` continues to report a small set of moderate-severity findings
after the security-bumps PR. Each is either **upstream-unfixable today** or
**bundled inside a transitive dep in a way `overrides` cannot reach**. None
are exploitable in Artha's actual runtime — but they will surface on every
audit, so this file is the canonical "yes we know, here's why" record.

## 1) Desktop-control chain — `@nut-tree-fork/nut-js` and friends

| Package | Severity | Fix available |
|---|---|---|
| `@nut-tree-fork/nut-js` | moderate | ❌ no upstream fix |
| `@nut-tree-fork/provider-interfaces` | moderate | (transitive of nut-js) |
| `@nut-tree-fork/shared` | moderate | (transitive of nut-js) |
| `jimp` | moderate | ❌ no upstream fix |
| `@jimp/core` | moderate | (transitive of jimp) |
| `@jimp/custom` | moderate | (transitive of jimp) |
| `file-type` | moderate | ❌ no upstream fix (ASF parser infinite-loop, [GHSA-5v7r-6r5c-r473](https://github.com/advisories/GHSA-5v7r-6r5c-r473)) |

**Context.** Artha's desktop-control feature (move mouse, type keys, take
a screenshot from the agent) uses `@nut-tree-fork/nut-js` — the community
fork of the abandoned `@nut-tree/nut-js`. We migrated to it in commit
`5d62d1e` precisely because the original was dead. The fork itself depends
on `jimp@0.x` (image processing), which pulls in old `file-type` and
internal `@jimp/*` modules. None of those have releases that address the
listed advisories.

**Real-world risk.** Effectively zero for Artha's usage:
- `file-type` ASF parser DoS — exploitable only when parsing ASF audio
  files from an untrusted source. Artha never parses untrusted media in
  the desktop-control path; jimp is only invoked on screenshots Artha
  itself captures.
- `jimp` advisories chain into the same internal image-buffer code paths
  that we don't hit in the screenshot-only flow.

**Mitigation.** None needed today. **Watch:**
- https://github.com/nut-tree/nut.js/issues for upstream movement on the
  jimp-2 / sharp migration.
- Track if/when `file-type` ships a patched 21.3.1+.

If the desktop-control feature is removed or replaced with a different
native bridge, these advisories vanish with it.

## 2) Next.js bundled `postcss@8.4.31`

| Package | Severity | Path |
|---|---|---|
| `postcss` | moderate ([GHSA-qx2v-qp2m-jg93](https://github.com/advisories/GHSA-qx2v-qp2m-jg93)) | `node_modules/next/node_modules/postcss` |
| `next` | moderate | (flagged because of the bundled postcss above) |

**Context.** `next@16.2.6` ships with a vendored `postcss@8.4.31` inside
its own tarball. The `overrides` field at root and in `landing/` was
added (forcing `postcss@^8.5.10` everywhere npm can reach) — and it
**does** work for every other postcss instance in the tree (renderer,
top-level, landing). But npm `overrides` does not penetrate the way next
bundles postcss internally, so the inner copy stays at 8.4.31 until next
itself ships a patched release.

**Real-world risk.** Zero for static-rendered landings. GHSA-qx2v-qp2m-jg93
is XSS via *unescaped `</style>` in CSS stringify output* — exploitable
only when postcss is used to serialize **untrusted** CSS into a page that
will be rendered by a browser. Artha's landings use postcss exclusively
at build time on **our own** Tailwind / CSS modules input. There is no
runtime postcss serialization of user-supplied CSS in either landing.

**Mitigation.** Will resolve automatically when next ships a release with
a postcss bump. Latest stable at time of writing is `16.2.6` (vulnerable);
`16.3.0` exists only as canary. Re-check on each `next` minor release.
The override block is already in place — once next picks up postcss
≥ 8.5.10 the audit will go silent on its own.

---

## Vulns that were fixed

For the record, the security-bumps PR did patch:

- `tmp` (HIGH, path-traversal [GHSA-ph9p-34f9-6g65](https://github.com/advisories/GHSA-ph9p-34f9-6g65)) — root, via `npm audit fix`.
- Standalone `landing/`: next 14.x → 16.2.6, closing **fourteen** distinct
  HIGH-severity Next.js advisories (image-optimizer DoS, request smuggling,
  cache poisoning, SSRF on WebSocket upgrade, RSC DoS, App Router CSP-nonce
  XSS, etc. — see the PR description).
- Top-level postcss everywhere `overrides` can reach: now `^8.5.14`.

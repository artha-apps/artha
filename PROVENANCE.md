# Artha — Source Provenance Review

**Purpose.** This document records an internal source-provenance review of Artha
against the open-source project [open-cowork](https://github.com/OpenCoworkAI/open-cowork),
which earlier versions of Artha's NOTICE/README referenced. It exists so that any
representation that "Artha is Shree Labs Inc.'s own work" is backed by evidence,
and so a legal reviewer can make the final call on attribution.

> This is an engineering review, not legal advice or a legal opinion. A
> qualified IP lawyer should review and sign off before Artha is represented as
> wholly original to investors, grant programs, or acquirers.

## What was compared

- **Subject A — current Artha:** 154 TypeScript/TSX source files under
  `packages/app/src` and `packages/renderer/src` (tests and type-decls excluded).
- **Subject B — Artha's first commit** (`6f813a8`, "initial Artha scaffold",
  2026-05-17): 17 source files — the rawest state, before later development.
- **Baseline — open-cowork v3.3.0** (commit `57697de`, 2026-05-09): 196 source
  files. This is the version of open-cowork that existed when Artha began
  (open-cowork had been stable at v3.3.0 since April 2026), so it is the
  era-correct comparison, not a later, diverged release.

## Method

Two independent similarity measures, each file against every upstream file:

1. **Verbatim line coverage** — fraction of a file's comment-stripped, non-trivial
   lines that appear identically anywhere in upstream. Detects copy/paste.
2. **Token 6-gram containment** — fraction of a file's 6-token code sequences
   (language keywords removed) also present upstream. Detects *refactored*
   copying — renamed variables, reordered functions — that a line diff misses.

## Results

| Comparison | Max overlap | Mean | Notes |
|---|---|---|---|
| Current Artha (154 files) | 0.24 token-containment (1 file) | 0.07 | Verbatim line coverage maxed at ~0.06 (boilerplate). |
| Artha scaffold (17 files) | 0.31 on `main.ts` only | < 0.15 | Every other file 0.02–0.18. |
| Current `main.ts` vs upstream entry | 0.13 | — | Down from scaffold as the file was built out. |

The single elevated file in every pass is `main.ts`, the Electron main-process
entry point. Its overlap is the framework boilerplate common to all Electron
apps (`app.whenReady`, `BrowserWindow`, `ipcMain`, window-lifecycle), not
application logic. The "closest upstream match" the tooling reported for most
files pairs unrelated features (e.g. Artha's agent orchestrator vs upstream's
GUI-operate server), which is the signature of *no* real relationship.

## Conclusion

On the evidence, **Artha is an independently written codebase.** It shares
architecture, concepts, and the unavoidable vocabulary of an Electron + React +
MCP + Skills application with open-cowork — none of which is protected by
copyright — but it does not contain copied or refactored open-cowork source
code, even at its earliest commit.

The "incorporates source code from open-cowork" wording in Artha's earlier
NOTICE/README therefore appears to have been an inaccurate overstatement of the
relationship rather than a description of actual code reuse.

## Recommended handling

1. Keep the open-cowork attribution in place **until** a lawyer reviews this
   document. Over-crediting is harmless; under-crediting while claiming
   originality is the risk.
2. On legal sign-off, the attribution may be removed truthfully, and Artha may be
   represented as Shree Labs Inc.'s own work.
3. Preserve git history as-is (no rewriting). The transparent record —
   over-attributed, reviewed, corrected — is the strongest possible position.

---
*Review run on the repository state at the time of writing. To reproduce, diff
`6f813a8` and the current tree against open-cowork `57697de` (v3.3.0) using the
two measures above.*

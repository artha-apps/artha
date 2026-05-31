# Documentation Site Map

The index of Artha's docs — what each one is for and when to read it. For the
**file-level map of the source code**, see the authoritative
[`../SITEMAP.md`](../SITEMAP.md) (one line per source file; kept in sync as code changes).

## Start here

| Doc | Read it when you want to… |
|---|---|
| [`user-guide.md`](./user-guide.md) | Be a first-time, non-technical **user** — install → first model → first document, in plain English. |
| [`getting-started.md`](./getting-started.md) | Run, build, or develop locally (prereqs, commands, native rebuilds, data paths). |
| [`idea-inbox-mvp-roadmap.md`](./idea-inbox-mvp-roadmap.md) | Know what we're building, MVP scope (in/out), current status, and the roadmap + idea backlog. |
| [`feature-deep-dive.md`](./feature-deep-dive.md) | Understand how each major feature works and where its code lives. |
| [`architecture.md`](./architecture.md) | Go deeper on system design — module map, ReAct loop internals, tool tiers, doc pipeline, DB. |
| [`DEVELOPMENT_LOG.md`](./DEVELOPMENT_LOG.md) | See the current snapshot + durable key decisions and conventions. |
| [`PROGRESS.md`](./PROGRESS.md) | Resume work — the chronological session log; where we left off and what's pending. |

## Reference docs

| Doc | Purpose |
|---|---|
| [`../README.md`](../README.md) | Public-facing product overview. |
| [`../CHANGELOG.md`](../CHANGELOG.md) | Per-version release notes (Keep a Changelog + SemVer). |
| [`../REQUIREMENTS.md`](../REQUIREMENTS.md) | Launch/infra requirements + implementation log (phases, acceptance criteria). |
| [`../SITEMAP.md`](../SITEMAP.md) | **Code** site map — every source file with a one-line purpose. |
| [`Artha_PRD_v4.0.md`](./Artha_PRD_v4.0.md) | Full product requirements doc (vision, personas, competitive analysis, roadmap, KPIs). |
| [`requirement.md`](./requirement.md) | Earlier requirements draft (superseded by the PRD + REQUIREMENTS; kept for history). |
| [`gtm/`](./gtm/) | Go-to-market drafts (pricing, privacy, ToS, SOC 2 readiness). |

## How these fit together

```
What & why ........ idea-inbox-mvp-roadmap.md  ·  Artha_PRD_v4.0.md
How it works ...... feature-deep-dive.md  ·  architecture.md  ·  SITEMAP.md (code)
How to use it ..... user-guide.md (end users)
How to run it ..... getting-started.md  ·  README.md (developers)
Where we are ...... DEVELOPMENT_LOG.md (decisions)  ·  PROGRESS.md (journal)  ·  CHANGELOG.md (releases)
```

> Doc conventions (when to update which file) are listed at the bottom of
> [`DEVELOPMENT_LOG.md`](./DEVELOPMENT_LOG.md).

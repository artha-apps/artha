# Phase 2 — deferred from the licensing / dual-SKU build

The Phase 1 dual-SKU release (B2C desktop + B2B org hub) shipped foundation-first: licensing, tier entitlements, forked onboarding, seat caps, hub identity + RBAC, and a packaged org-hub deploy. Four items were **deliberately** held back. This document captures each one — what was deferred, why, what unblocks it, the rough scope to do it later, and which Phase 1 decisions already pave the way so no rework is needed.

**Phase 1 principle:** ship the smallest credible enterprise story now. Don't build complexity that Phase 1 customers cannot yet feel.
**Phase 2 principle:** only break what Phase 1 already validated demand for.

---

## Summary

| # | Item | Unblock signal | Scope | Phase 1 alignment |
|---|---|---|---|---|
| 1 | Headless org-hub service (drop Electron) | First enterprise that demands containerised, no-display deploy at scale | ~1–2 weeks | LAN server already isolated in `ipc/handlers.ts`; `Dockerfile.hub` interim path proves the deploy story |
| 2 | SQLite → Postgres | ≥ 30 concurrent active hub seats, or a customer with HA requirements | ~1–2 weeks | All DB writes go through `getDb()` singleton; schema is already migration-style |
| 3 | SSO (SAML/OIDC) + SCIM | First enterprise procurement that gates close on "SSO required" | ~2–3 weeks | API keys + team roster already carry identity; auth resolves an `LanIdentity` on every request |
| 4 | In-app "Connect to team hub" thin-client mode | First customer where the curl/IDE/MCP API isn't enough for non-technical members | ~3–5 days | LAN `/chat` endpoint already streams NDJSON; preload bridge ready to be re-pointed |

---

## 1. Headless org-hub service (drop Electron from the hub)

### Today (Phase 1)

The org hub runs the same Electron desktop binary as a B2C user, on a dedicated host (Option A in `docs/deploy/org-hub.md`) or wrapped in `xvfb` inside `Dockerfile.hub` (Option B, interim). The LAN HTTP server (`packages/app/src/ipc/handlers.ts`, around lines 165–305) lives in the Electron main process and shares the orchestrator with the desktop UI.

### Why deferred

- The Option A deploy story works today on real hardware and is normal in enterprise (Splunk, GitLab self-managed). No customer has yet rejected it.
- A true headless build is at least a week of refactor: extracting the HTTP server, abstracting Electron-only deps (BrowserWindow, BrowserView, desktopCapturer, dialog), and re-wiring the orchestrator without IPC events.
- The interim `xvfb`-wrapped container covers IT shops that hard-require containers, with one caveat (`docs/deploy/org-hub.md` calls it out): no in-container onboarding GUI.

### What unblocks it

- A signed enterprise deal that's hard-blocked by "must run as a container daemon at scale" (no `xvfb`, no display, k8s-native).
- Or three Option-B customers reporting operational pain with `xvfb` (CPU overhead, debug awkwardness).

### Phase 2 scope

1. Extract the HTTP server (currently in `registerIpcHandlers` as a `node:http` instance) into a standalone module that boots without an `app.getPath('userData')`-style Electron call. Pass the data directory in as config.
2. Build an "orchestrator-lite" entry point that doesn't own a `BrowserWindow` — strip the IPC `webContents.send` calls (used for renderer streaming) behind an emitter interface so the hub can use a different sink (logging, audit).
3. Stub `BrowserController` (Electron `WebContentsView`) — gracefully fail any tool that requires it on the hub, since headless agents shouldn't be driving a browser anyway. The skill registry already exposes per-skill allowlists for this.
4. Replace `Dockerfile.hub` with a `node:bookworm-slim` runtime that runs the new headless binary directly. No `xvfb`, no Electron in the image.

### Phase 1 alignment (no rework needed)

- The LAN HTTP server is already isolated as a region — search `// ── LAN collaboration server` in `handlers.ts`.
- All license verification (`packages/app/src/license/verify.ts`) is plain Node + `crypto`; no Electron dependency.
- The seat/license/RBAC checks all flow through `currentEntitlements()` which uses only `getDb()`, not Electron.
- `Dockerfile.hub` already establishes the volume + env-var contract (`ARTHA_LICENSE_KEY`, `/data` volume) the headless build will inherit.

---

## 2. SQLite → Postgres

### Today (Phase 1)

A single SQLite file holds everything: `artha.db` under Electron's userData dir (`packages/app/src/db/schema.ts`). WAL mode gives concurrent reads while writes are serialised. The hub's entire state — chat sessions, messages, team members, API keys, memories, artifacts, projects, scopes, RAG indexes, audit log — is in one file.

### Why deferred

- For a hub serving ≤ ~20–25 active concurrent seats, SQLite-with-WAL is dramatically simpler and the right call. No connection pool, no separate process, no HA story to debug.
- The "no data leaves the machine" pitch is cleaner when the database literally is a file on the host disk.
- Postgres adds operational surface (backups, restores, point-in-time recovery, secret management) that small/mid customers don't want.

### What unblocks it

- Sustained concurrent writes that exhaust WAL (rare even at 50 seats; common at 200+).
- A customer with a hard HA / failover requirement (standby read-replica).
- Wanting to do server-side analytics or BI across the hub data — Postgres makes this trivial; SQLite makes it possible but awkward.

### Phase 2 scope

1. Introduce a `DatabaseAdapter` interface above the current better-sqlite3 calls. The hot path uses `db.prepare(...).run/get/all` — these need a Postgres-shaped equivalent.
2. Port the inline `ALTER TABLE` migrations (lines 460–540 of `schema.ts`) into a real migration runner. Two reasonable choices:
   - **Drizzle Kit** (TypeScript-first, codegen for both SQLite and Postgres) — best if we want one schema and two adapters.
   - **Plain SQL files** in `packages/app/src/db/migrations/` (the empty dir already exists) — most predictable for ops.
3. Add a `node-postgres` (`pg`) adapter for the hub. Desktop apps keep SQLite.
4. Keep the same row shapes; the entire app codebase still talks via `db.prepare(...)` semantics, so the change is concentrated in the adapter, not the call sites.

### Phase 1 alignment (no rework needed)

- Every DB call already goes through `getDb()` (one place to swap).
- `packages/app/src/db/migrations/` directory already exists, intended for this.
- Schema is additive-only (every migration is `IF NOT EXISTS` / `ALTER ADD COLUMN`), so a translation pass is mechanical, not architectural.

---

## 3. SSO (SAML/OIDC) + SCIM provisioning

### Today (Phase 1)

Authentication on the hub is per-member API keys (`api_keys` table, `member_id`/`role` linkage). The admin provisions a seat in OrgSetup or in `Settings → Team`: it creates a `team_members` row and mints a Bearer key bound to it. The LAN server's `authoriseLanRequest` resolves identity from the token on every request.

### Why deferred

- API keys are universally understood and work today for every member quick-connect path.
- SSO is engineering work that's usually deal-gated; mid-market customers commonly accept Bearer tokens; only Fortune-500-type procurement reliably blocks on SAML/OIDC.
- SCIM provisioning matters once you have hundreds of members churning. Small deployments provision by hand once and never again.

### What unblocks it

- A close that's hard-gated on "we must SSO into Artha via Okta/Entra."
- A customer with > 200 active members whose IT refuses to manually rotate keys.
- A SOC 2 / regulator deliverable that specifically calls out "centrally managed identity."

### Phase 2 scope

1. **OIDC first** (easier than SAML, covers Okta/Entra/Google): add `/auth/oidc/login` + `/auth/oidc/callback` to the hub HTTP server. Issue a short-lived hub session cookie (or JWT) on successful login.
2. **`team_members` becomes the identity source of truth** — each row gets an `external_id` (the IdP `sub`). API keys continue to work in parallel (for IDE/MCP integrations that don't speak OIDC).
3. **SAML** as a follow-on for the customers that need it (Microsoft Entra w/ SAML, etc.) — same callback shape, different XML.
4. **SCIM 2.0** endpoint at `/scim/v2/Users` and `/scim/v2/Groups`. Pure CRUD over `team_members`. Use `passport-scim` or a hand-rolled handler — the surface is small.
5. Update the hub deploy runbook (`docs/deploy/org-hub.md`) with IdP-configuration steps per supported provider.

### Phase 1 alignment (no rework needed)

- `authoriseLanRequest` already returns an identity object (`LanIdentity { memberId, memberName, role }`) and is called from every protected route — SSO sessions resolve to the same shape.
- `team_members` table is the canonical roster and is independent of the auth mechanism; adding `external_id` is a one-column migration.
- RBAC enforcement is already gated by `currentEntitlements().rbac`, so admin-only routes can immediately use the role on the resolved identity.

---

## 4. In-app "Connect to team hub" thin-client mode

### Today (Phase 1)

Members of an org connect to the hub via the LAN `/chat` API directly: curl examples, the IDE bridge (Settings → Integrations → IDE generates a `.vscode/mcp.json`/`.cursor/mcp.json` pointing at the hub), or any MCP-aware tool. The desktop app, when installed by a member, still runs as a standalone (with its own Ollama). There is no in-app "thin client" that routes the desktop's chat into a remote hub.

### Why deferred

- The LAN API works today for technical members (and most early B2B deals close on developer-tooling buyer personas — the IDE/curl path is fine).
- Building a true thin-client mode means deciding whether the desktop app *replaces* its local orchestrator with a remote one (clean but heavy), or *augments* it (messier). Better to delay until customer behaviour resolves the design question.
- Phase 2's headless extraction (#1) naturally clarifies the protocol the thin client will speak.

### What unblocks it

- The first deal where non-technical members can't or won't use curl/IDE bridges.
- A request for "one Artha download, configure once, points at our hub" — a normal expectation for office software but not how Phase 1 ships.
- Convergence with headless server (#1): once the server is a proper service, the client/server split becomes obvious.

### Phase 2 scope

1. Add a `hub_url` + `hub_key` setting (and a `team_mode` flag) under `settings_json`.
2. Add a new `RemoteHubLLMClient` (or wrap at orchestrator level) that, when `team_mode === 'connected'`, intercepts chat sends and routes to `<hub_url>/chat` instead of the local orchestrator.
3. UX: a one-line "Connect to your team's hub" panel in Onboarding for members (paste the connection card → all set). Show a hub badge in the chat header so the member sees they're using a shared instance.
4. Local vs hub artifacts: artifacts produced on the hub still need to land somewhere usable on the member's machine. Either stream the bytes back through the LAN response (simple) or expose a `/artifacts/<id>` GET (cleaner).
5. Fallback: if the hub is unreachable, surface that to the member and offer the local model as a fallback — don't silently route to the local agent.

### Phase 1 alignment (no rework needed)

- The LAN `/chat` endpoint already streams NDJSON token/done events the same way the desktop UI handles them — a thin client can consume that without protocol changes.
- The preload bridge (`packages/app/src/preload.ts`) already exposes `window.artha.lan.*` and `window.artha.license.*` — the thin-client toggle slots in next to them.
- Onboarding (`Onboarding.tsx`) already has a persona fork; adding a third persona ("Member connecting to a team hub") is a copy of the existing structure.

---

## Discipline notes

- **No SaaS / multi-tenant pivot.** Every item above stays single-tenant: each customer runs their own hub (or each user runs their own desktop). Multi-tenancy would force a re-architecture the privacy story cannot support — see `docs/gtm/onboarding/institution.md` for the rationale.
- **Compliance docs follow the deployment model**, not the codebase. The SOC 2 readiness checklist in `docs/gtm/` covers your SDLC and the artefact you ship; once Phase 2 #1 lands, update the audit copy to reflect "service the customer operates."
- **Keep one binary**, three packages. Tier flags + entitlements stay the only gate. Forking the codebase per SKU is the failure mode to never accept.

## Cross-links

- Phase 1 plan: `~/.claude/plans/polymorphic-rolling-stream.md` (also in this repo's PR description)
- Deploy runbook: [`docs/deploy/org-hub.md`](../deploy/org-hub.md)
- B2C onboarding SOP: [`docs/gtm/onboarding/single-client.md`](../gtm/onboarding/single-client.md)
- B2B onboarding SOP: [`docs/gtm/onboarding/institution.md`](../gtm/onboarding/institution.md)

# Artha Security Threat Model

> Status: living document. Last grounded against the codebase 2026-07-22 (v0.2.0).
> Scope: the Electron desktop app (`packages/app` main process + `packages/renderer`),
> the LAN hub server (embedded in the main process), and the boundaries to cloud
> LLM providers, MCP servers, and telemetry. The Next.js landing site
> (`landing/`, Stripe + license minting) has its own operational surface and is
> only covered here where it touches license verification.
>
> Honesty rule for this document: every control is labeled with its real
> enforcement status (Section 5). Controls that are planned but not shipped are
> marked **(Phase A/B/C)**. Nothing in this document should be read as a claim
> stronger than what the referenced code actually does.

---

## 1. Assets

| Asset | Where it lives | Sensitivity |
|---|---|---|
| User files in attached scopes | User's disk; per-chat scopes in `chat_scopes` (`src/db/scopes.ts`) | High — arbitrary personal/business documents |
| Chat history | `chat_sessions` / `chat_messages` in `~/Library/Application Support/Artha/artha.db` | High — free-text, often mirrors scoped file content |
| Memories (entity graph) | `memory_entities` (+ cached embeddings), `kg_entities` | High — distilled facts about the user/org |
| RAG indexes | On-disk index files (`src/rag/indexFormat.ts`) + `rag_indexes` table | High — chunked plaintext of indexed documents |
| BYOK cloud LLM API keys | `llm_models.api_key` (`src/db/schema.ts:157`) | Critical — currently **plaintext** (see 3) |
| MCP connector credentials | `tools.credentials_enc`, sealed by `src/security/secrets.ts` | Critical — encrypted at rest (`v1:enc:`) with documented `v1:raw:` fallback |
| OAuth tokens (Google Workspace) | `oauth_tokens` table (access/refresh tokens, plaintext TEXT columns) | Critical — grants live cloud account access |
| LAN hub API keys | `api_keys.key_hash` — SHA-256 digest only; raw key shown once at creation | High — digest storage is the correct design |
| License keys | Signed Ed25519 token on disk; verified offline (`src/license/verify.ts`) | Medium — commercial asset, not user data |
| Tool audit log | `tool_audit_log` (with `actor` column: local vs `lan:*`) | Medium — forensic record; itself contains tool args |
| Generated artifacts + receipts | `~/Library/Application Support/Artha/artifacts/`, `.artha-receipt.json` sidecars | Varies with content |
| Skill files / bundles | `skills/` YAML dir; `.artha-bundle` imports | Medium — they are *instructions the agent will follow* |

The database file `artha.db` is the single highest-value target: it aggregates
chat history, memories, OAuth tokens, and (today) plaintext LLM API keys.
Artha does not encrypt the database itself; it relies on OS user-account
isolation and full-disk encryption, which are outside Artha's control.

---

## 2. Trust boundaries and attack surfaces

### 2a. Renderer ↔ main IPC

**Current controls (verified):**
- `contextIsolation: true`, `nodeIntegration: false` on the main window
  (`src/main.ts:145-147`). The renderer talks to the main process only through
  the `window.artha.*` API exposed by `contextBridge.exposeInMainWorld` in
  `src/preload.ts:855`. Zero Node access in renderer code.
- Secrets do not cross this boundary: `llm_models.api_key` is excluded from
  every renderer-bound query via explicit column lists (verified this week);
  MCP credentials are decrypted only in the main process at spawn time.
- Note: `sandbox: false` on the main window (required by the current preload).
  Renderer JS still has no Node access, but the preload itself runs unsandboxed.

**Threats:** a compromised renderer (e.g. via a markdown-rendering XSS) can call
any `window.artha.*` handler with attacker-chosen arguments. IPC handlers are
the real privilege boundary and must validate inputs; they currently trust the
renderer for things like file paths within already-attached scopes.

### 2b. MCP servers (child processes)

**Current controls (verified):**
- Connector credentials are encrypted at rest with Electron `safeStorage`
  (`src/security/secrets.ts`, format `v1:enc:<b64>`) and injected only into
  that connector's own child-process environment at spawn
  (`src/mcp/registry.ts` — `openCredentials` → `spawnEnv(credEnv)`).
- `ENV:KEY=value` install tokens are parsed once (`src/mcp/envTokens.ts`) and
  sealed; stored URIs are kept clean.

**Threats:** an MCP server is arbitrary code running as the user. Artha cannot
sandbox it (User-managed control: only install trusted connectors). A malicious
server receives its own credentials legitimately, can read anything the user
can read, and can return prompt-injection payloads in tool results (Section 7).
The `permissions_json` column exists on the tools table but per-server fs/network
enforcement is not implemented (Known limitation / Future research).

### 2c. Embedded browser / web content

**Current controls (verified):**
- The agent browser is a `WebContentsView` with `sandbox: true`,
  `contextIsolation: true`, `nodeIntegration: false`
  (`src/browser/controller.ts:135-138`). Remote pages have no preload API and
  no Node access.
- SSRF guard `src/net/ssrfGuard.ts`: `assertPublicURL()` allows http(s) only,
  resolves DNS and rejects every private/loopback/link-local/CGNAT/metadata
  address on any returned record (catches DNS rebinding at resolve time), with
  a user allowlist for deliberate localhost targets. The synchronous
  `isPrivateUrlSync()` closes the redirect/popup bypass in `will-navigate` and
  `setWindowOpenHandler`, and blocks `file:` URLs outright.
- Honest limitation (documented in the guard itself): the resolved IP is not
  pinned to the socket, so a determined rebinding race remains theoretically
  possible. Accepted risk for a single-user desktop agent.

**Threats:** hostile page content driving the agent — covered in Section 6.

### 2d. LAN hub server

**Current controls (verified, `src/ipc/handlers.ts` LAN section):**
- Bearer-token auth on every route except `GET /health`; incoming tokens are
  SHA-256-hashed and compared to `api_keys.key_hash` (raw keys never stored).
- License gating (Team/Business tiers) on hub features; seat cap =
  `team_members ∪` unbound enabled keys (`src/license/seats.ts`).
- Per-identity token-bucket rate limiting on `POST /chat`
  (`src/net/rateLimiter.ts`) plus a request-body size cap.
- Privacy filters: only `is_shared=1` memories enter the LAN memory preamble;
  only `is_shared=1` context packs are listable/appliable, with an is_shared
  re-check at /chat time so un-sharing wins races (tested in
  `src/license/lanPrivacy.test.ts`).
- LAN runs are audit-logged with `actor = lan:<member>`.
- BYOK API keys and OAuth tokens are not reachable through any LAN route
  (verified this week).

**Threats:** the hub speaks plain HTTP on the LAN — no TLS. Anyone on the
network segment can sniff Bearer tokens in transit (Known limitation; the
deployment runbook assumes a trusted office LAN). A leaked key allows /chat
runs as that member until the key is disabled.

### 2e. Cloud LLM providers — the explicit cloud boundary

When a cloud model is active (BYOK), the assembled prompt — user message,
context block (memories, scope tree, RAG snippets, pack pins), and tool
results — **leaves the device** to the provider. This is the one boundary
where user content intentionally exits local-first custody. Controls today:
the user chooses per-model, cloud escalation on a failed local run is an
explicit per-message user action ("Retry on ☁ X", audit-logged). Sensitivity
tags gating what may enter a cloud-bound context are normative policy
(Section 4) with enforcement landing in **Phase B**.

### 2f. Desktop control (nut-js)

Opt-in only: tools are not exposed to the orchestrator unless
`desktop_control_enabled` is set (`src/tools/desktop.ts` header comment).
While active, the always-on-top control overlay (`src/controlOverlay.ts`)
makes the takeover visible and is armed before each desktop tool call.
Threat: a prompt-injected agent with desktop control can act as the user on
any application. The overlay is a visibility control, not a constraint —
approvals and risk tiers for desktop actions are **Phase C** work.

### 2g. Sentry telemetry

Opt-out crash reporting (`src/sentry.ts`), with `scrubEvent`
(`src/sentryScrub.ts`, unit-tested) as the privacy backstop: absolute paths
reduced to basenames; `user`, `request`, `server_name`, `device`, and frame-
local variables dropped; only `artha.*` breadcrumbs kept. Verified this week:
no path carries `llm_models.api_key` or chat content into Sentry payloads.
Residual risk: exception *messages* thrown by third-party code could embed
user strings; scrubbing is best-effort on message bodies.

### 2h. Auto-update and license verification

- Updates: `electron-updater` against GitHub Releases, `autoDownload = false`
  (user-confirmed). macOS builds are Developer ID signed + notarized; Windows
  code signing is a known open item (unsigned installer → SmartScreen warnings,
  and weaker supply-chain posture on Windows).
- License: Ed25519 signature verification fully offline
  (`src/license/verify.ts`, Node `crypto`, no network). Tampered/expired/
  wrong-key tokens fall back to Free; expiry is re-checked on every cache hit.
  The private key never ships (`scripts/sign-license.mjs`, `~/.artha-license-key.pem`).

---

## 3. Credential storage policy (normative)

This section is policy: where implementation currently diverges, the divergence
is stated and scheduled.

1. **The only permitted persistent form is keychain-sealed** — `v1:enc:<b64>`
   via Electron `safeStorage`: macOS Keychain, Windows DPAPI, Linux Secret
   Service (libsecret/kwallet). The `v1:` prefix is the version hook (key
   rotation, algorithm change). Prohibited persistent forms, with or without a
   UI warning: plaintext, base64, any reversible obfuscation, a locally stored
   key beside the database, an application-wide static key.
   **(Implemented — commits 1 + 3.5: `security/secretString.ts`, `secrets.ts`.)**
2. **"Available" means trustworthy.** `safeStorage.isEncryptionAvailable()` is
   necessary but not sufficient: on Linux the `basic_text` backend reports
   available while using a static key baked into the Chromium binary — a
   prohibited application-wide static key. `isSecretEncryptionAvailable()`
   additionally rejects `basic_text` via `getSelectedStorageBackend()`.
   `ARTHA_FORCE_NO_KEYCHAIN=1` is a QA override that forces the unavailable
   state; it fails safe (stricter only). **(Implemented — commit 3.5.)**
3. **When no trustworthy keychain exists** the user gets exactly two honest
   options, per credential:
   - **Session-only:** the DB stores the zero-material sentinel `v1:session`;
     the real key lives in process memory (`security/sessionKeys.ts`) and dies
     with the app. After restart the UI reports the key as expired and asks
     for re-entry. **(Implemented for BYOK LLM keys — commit 3.5.)**
   - **Secure-storage-required:** persistent saving is refused with remediation
     instructions (enable GNOME Keyring / KWallet / Secret Service). Local
     models and credential-less providers keep working. Credentialed MCP
     installs are refused the same way (session-only MCP support may follow).
     **(Implemented — commit 3.5.)**
   The legacy `v1:raw:<b64>` envelope is **read-only compatibility**: it is
   never written anymore; rows found in it are resealed on read/migration when
   a keychain exists, else locked (rule 4). A user-configured external secret
   source (e.g. a vault) is a possible later addition for advanced users; it
   is not implemented and nothing in the current architecture depends on it.
4. **Migration semantics (implemented — commit 3.5):**
   - Each plaintext or legacy-raw key is sealed independently; success replaces
     the value atomically.
   - No trustworthy keychain → rows are left **intact but LOCKED**: the request
     boundary (`usableApiKey` in `llm/client.ts`) refuses them with a typed
     `CredentialLockedError` — interactive and background paths alike — until
     the keychain is fixed or the user re-enters the key for the session. A
     persistently stored plaintext key is never silently read and sent.
   - Seal-on-read closes the window opportunistically: the first use after a
     keychain becomes available seals the row before the request is made.
   - Migration is idempotent, never destroys a credential, logs only sanitized
     counts (never key material), ends with a verification scan
     (`unsealedRemaining`), and on any successful seal the WAL is
     checkpoint-truncated and the DB VACUUMed so old plaintext bytes do not
     survive in WAL frames or freelist pages.
5. **Verified non-leak paths for `api_key`:** excluded from renderer-bound
   column lists (`llm:listConfigured` exposes only a derived `key_state`:
   none/sealed/session/session_expired/locked), absent from all LAN hub
   routes, stripped from bundle exports (`ENV:` scrubbing in
   `src/bundles/bundle.ts`), and not present in Sentry payloads post-
   `scrubEvent`. Typed credential errors carry no key material.
6. **Remaining divergence:** `oauth_tokens.access_token/refresh_token` are
   still plaintext TEXT columns — same class of problem, same mechanism.
   **(Scheduled: Phase A commit 4.1, approved as a dedicated commit; includes
   reseal-on-read for any legacy `v1:raw:` MCP rows in the wild.)**

---

## 4. Tag / sensitivity enforcement boundaries (normative)

Sensitivity classification (e.g. `local-only`, `team-shareable`,
`cloud-eligible`) is only meaningful if it is enforced at **testable object
boundaries**. The enforceable objects in Artha are: workspace, project, file,
folder, conversation, browser session, task (agent run), artifact, context
pack, and memory record. Policy:

- **Enforcement points:** cloud eligibility is checked (a) during context
  assembly (`gatherContext`, pack pins, RAG snippet selection) and (b) as a
  final gate immediately before provider transmission in the LLM client. Both
  checks are required; the second exists so a new context source added later
  fails closed. **(Phase B — the `is_shared` LAN filters are the shipped
  precedent; cloud-eligibility tags are not yet implemented)**
- **Derived content:** a summary, memory, or copied fact derived from a tagged
  object must carry its own classification or inherit the most restrictive
  classification of its sources at write time.
- **Honest limitation, stated plainly:** Artha **cannot** identify every
  derived fact crossing a cloud boundary. Once a model has read sensitive
  content in a local run, facts from it can resurface in later model output,
  user paraphrases, or memories written by the agent, without machine-
  detectable lineage. Tag enforcement bounds the *direct* flows at object
  boundaries; it does not and cannot provide information-flow control through
  model inference. Marketing and UI copy must not claim otherwise.

---

## 5. Control classification

| Control | Status |
|---|---|
| Renderer context isolation, no Node in renderer, contextBridge-only API | Enforced |
| Explicit column lists keeping `api_key` out of renderer/LAN/bundles/Sentry | Enforced (regression-test on Phase A change) |
| MCP credential encryption at rest (`v1:enc:`) + spawn-time-only injection | Enforced (with detectable `v1:raw:` fallback) |
| `llm_models.api_key` sealed at rest | Known limitation → Enforced after Phase A commit 1 |
| `oauth_tokens` sealed at rest | Known limitation (Phase A follow-up) |
| SSRF guard (http(s)-only, private/metadata IP rejection, DNS check, sync redirect guard) | Enforced |
| SSRF socket-level IP pinning (rebinding race) | Known limitation (documented, accepted) |
| Embedded-browser process sandbox (`sandbox: true`, no preload API for pages) | Enforced |
| LAN Bearer auth (hashed keys), body caps, per-identity rate limiting | Enforced |
| LAN `is_shared` filters on memories/packs (incl. un-share race re-check) | Enforced (tested) |
| LAN transport encryption (TLS) | Known limitation — trusted-LAN assumption, documented in the org-hub runbook |
| Filesystem tool scope sandbox (reads/writes confined to attached scopes) | Enforced when scopes attached; unscoped chats are User-managed |
| Cloud boundary: user-chosen model, explicit audited escalation | Enforced (choice) / Best-effort (content awareness) |
| Sensitivity tags gating cloud-bound context | Future → Phase B |
| Desktop control opt-in gate + visible control overlay | Enforced (gate) / Best-effort (overlay is visibility, not constraint) |
| Desktop/browser action risk tiers + approvals | Future → Phase C |
| Sentry scrubbing (`scrubEvent`) | Best-effort (thorough, unit-tested, but message bodies are open-world) |
| Sentry opt-out toggle | Enforced |
| License Ed25519 offline verification, fail-to-Free | Enforced |
| Update integrity: macOS signing + notarization, user-confirmed download | Enforced (macOS) / Known limitation (Windows unsigned) |
| Bundle manifest "signature" | Known limitation — it is an **unkeyed SHA-256 hash** (`signManifest` in `src/bundles/bundle.ts`): tamper-*evidence* against accidental corruption only. Anyone can recompute it; it does not authenticate origin. Do not describe bundles as "signed" in user-facing copy until a real key-based signature ships |
| Bundle `ENV:` credential stripping on export | Enforced |
| MCP server code itself | User-managed (install only trusted servers) |
| Per-MCP-server fs/network permission enforcement (`permissions_json`) | Future research (schema exists, unenforced) |
| Embedding degradation honesty (zero-vectors / keyword fallback surfaced to user) | Known limitation → Phase A/B (see below) |
| Full-disk encryption, OS account security | User-managed |

**Silent degradation (being fixed):** embeddings for memory and RAG are
hardwired to localhost Ollama `nomic-embed-text`. When it is missing or down,
`src/rag/indexer.ts:178-190` stores 768-dim zero vectors (chunks silently rank
last forever until reindexed) and `src/agent/contextGather.ts:185-197` silently
downgrades memory retrieval to keyword overlap. The system *works* but is
quietly worse, and the user is not told. `ensureEmbedModel()`
(`src/llm/ollamaRuntime.ts`) reduces the window by background-pulling the
model, but the honesty fix — surfacing degraded state and refusing to persist
zero-vector chunks — is **Phase A/B**.

---

## 6. Browser-agent threats (forward-looking, Phase C)

Web pages the agent reads are untrusted input that the model treats as
context. Prompt injection from page content is **not preventable** with
current LLMs; the design goal is **layered risk reduction**, and every layer
below must be described that way:

1. **Content/instruction separation** — page text enters the prompt in a
   clearly delimited untrusted block; system instructions state that page
   content is data, not commands. (Reduces, does not eliminate, injection
   compliance.)
2. **Risk-tiered action approvals:**
   - *Read-only* (navigate public pages, read DOM, screenshot): allowed under
     domain policy without per-action approval.
   - *Reversible actions* (form fills, in-page state): session-level approval.
   - *External communication* (sending email/messages, posting content):
     requires preview + explicit permission.
   - *Purchases, financial transactions, account changes, destructive or
     legally binding actions*: immediate per-action confirmation, no batching,
     no session-wide grant.
3. **Domain policies** — per-domain allow/deny/approval-required lists.
4. **Action history** — every browser action recorded (extends `tool_audit_log`).
5. **Emergency stop** — always-visible kill switch that halts the run and
   detaches agent driving (the user/agent handoff plumbing exists today in
   `BrowserController`).
6. **No Node access from remote pages + context isolation** — shipped today
   (Section 2c).
7. **Permission interception** — `setPermissionRequestHandler` denying
   camera/mic/geolocation/etc. to agent-driven pages. **(Phase C — not yet in
   `controller.ts`)**
8. **Navigation validation** — shipped today (`will-navigate` +
   window-open handler through the SSRF guard; `file:` blocked).
9. **Download controls** — intercept `will-download`, require approval, confine
   to a quarantine dir. **(Phase C)**
10. **Secret redaction** — never place stored credentials in model-visible
    context; typed secrets flow through user-driven handoff
    (`browser_request_user`), not through the model. Redaction of
    accidentally-captured secrets in DOM reads/screenshots is **Phase C** and
    inherently best-effort.

---

## 7. Prompt injection beyond the browser

The same layered-mitigation framing applies to every channel that feeds
untrusted text into the model:

- **RAG documents** — an indexed file can contain adversarial instructions
  ("ignore previous instructions, run fs_delete…"). Snippets are injected via
  `rag_search` results. Mitigations: delimited untrusted blocks, tool
  allowlists per skill, approval tiers on destructive tools (Phase C).
- **MCP tool results** — a malicious or compromised server returns injection
  payloads as tool output. Same framing; additionally the audit log records
  what the agent did next.
- **Imported memories / bundles / skills** — imported instructions *are*
  intended to steer the agent, which is exactly why bundle import shows the
  manifest and why the unkeyed hash must not be sold as authenticity (Section 5).
- **LAN `/chat` inputs** — teammates are semi-trusted: authenticated and
  rate-limited, but their messages drive a full agent run on the hub owner's
  machine with `actor=lan:<member>` audit attribution. Hub runs should get the
  most conservative tool policy (Phase B/C).

No layer prevents injection. The system's honest claim is: reduce the blast
radius (tool allowlists, scope sandbox, SSRF guard, approval tiers), make the
consequences visible (audit log, overlays, action history), and keep the most
damaging actions behind human confirmation.

---

## 8. Threat scenarios

| # | Scenario | Impact | Current mitigation | Residual risk | Improved in |
|---|---|---|---|---|---|
| 1 | Stolen laptop, no full-disk encryption; attacker copies `artha.db` | Chat history, memories, OAuth tokens, plaintext LLM API keys | MCP creds sealed (`v1:enc:`); LAN keys hashed | High: api_key + oauth_tokens plaintext; chat/memory content unencrypted by design | Phase A (seal api_key, then oauth_tokens); DB-level encryption is Future research |
| 2 | Malicious MCP server installed by user | Arbitrary code as user; data exfil; injection via tool results | User choice + curated catalog; per-server creds only; conn status surfaced | High: no sandbox, `permissions_json` unenforced | Future research (server sandboxing/permissions) |
| 3 | Malicious webpage instructs the browsing agent | Agent takes attacker-directed actions | SSRF guard, sandboxed WebContentsView, nav validation, user visibility (WorkingIndicator, handoff) | High until approval tiers exist: agent may comply with injected instructions within its tool allowlist | Phase C (risk-tiered approvals, domain policies) |
| 4 | LAN Bearer key leaked (sniffed on wire or shared carelessly) | Attacker runs /chat as that member; reads shared memories/packs | Hashed storage, rate limiter, per-key disable, audit `actor` | Medium: no TLS; key valid until revoked | Phase B (TLS or token rotation for the hub) |
| 5 | Compromised/malicious cloud LLM provider | Everything sent in prompts is exposed; poisoned completions | BYOK user choice; explicit cloud boundary; escalation is per-message + audited | Medium: no tag gating of what enters cloud context yet | Phase B (cloud-eligibility enforcement at assembly + transmission) |
| 6 | Sensitive data in a Sentry crash payload | PII/content leak to telemetry vendor | `scrubEvent` (paths→basenames, drops user/request/device/frame vars, artha.*-only breadcrumbs); opt-out | Low: third-party exception messages may embed user strings | Ongoing hardening; keep scrub tests green |
| 7 | Malicious skill bundle imported | Agent adopts hostile playbook; drift from claimed golden output | Manifest display, golden-content hash diff, `ENV:` stripping | Medium: hash is unkeyed — no origin authenticity; user judgment is the real control | Phase B/C (real signing key + publisher identity) |
| 8 | Plaintext key exfil by any local process copying `artha.db` | Immediate theft of BYOK keys → provider spend/abuse | None beyond OS user isolation (this is the audit finding) | High today | Phase A commit 1 (seal in place; failure path surfaces unencrypted state, never drops the key) |
| 9 | Injection payload inside an indexed document (RAG) | Agent executes attacker instructions when the doc is retrieved | Scope sandbox on fs tools, skill tool allowlists, audit log | Medium-high: retrieval is automatic once indexed | Phase C (untrusted-block framing + destructive-tool approvals) |
| 10 | Cloud escalation of a sensitive-scope chat ("Retry on ☁") | Local-only content leaves device on an explicit user click | Escalation is opt-in, per-message, visibly labeled, audit-logged | Medium: user may not realize scope content rides along; no tag enforcement yet | Phase B (tags block ineligible context; derived-content caveat in Section 4 still applies) |

---

## 9. Security remediation register (founder-approved, 2026-07-22)

Pre-existing findings tracked to closure. Phase A is not a security rewrite —
each item has an owner phase, severity, enforcement boundary, and acceptance
condition.

| # | Finding | Severity | Enforcement boundary | Owner phase | Acceptance condition |
|---|---|---|---|---|---|
| R1 | `oauth_tokens` access/refresh tokens plaintext in SQLite | High | At-rest storage (main process) | **A — commit 4.1** (dedicated, approved) | Tokens sealed `v1:enc:`; in-place migration; no plaintext readable post-VACUUM; Google API calls still succeed; legacy `v1:raw:` MCP rows resealed on read |
| R2 | LAN hub transport is plain HTTP (Bearer keys + chat content readable on the LAN segment) | High | Network transport (hub ↔ members) | **RELEASE GATE**, not a phase: must be resolved before (a) production org-hub use, (b) remote LAN access involving sensitive data, (c) ANY claim that LAN traffic is protected, (d) enterprise deployment relying on the hub. Until then the org-hub runbook carries an explicit trusted-network-only warning | TLS with a pinned self-signed cert embedded in member connection cards/QR, or an equivalently authenticated channel; plain HTTP requires an explicit "trusted network" override |
| R3 | MCP `permissions_json` exists in schema but is not enforced at dispatch | High | Tool dispatch (orchestrator → MCP registry) | **RELEASE GATE**: must be resolved before (a) expanded MCP availability, (b) autonomous workflow execution through MCP, (c) browser/scheduler/Dispatch workflows invoking consequential MCP tools, (d) enterprise or shared-workspace use | Declared fs/network scopes enforced per server at invocation; violations blocked + audit-logged; default-deny for new servers |
| R4 | Skill-bundle integrity uses unkeyed SHA-256, formerly described as "HMAC-signed" (integrity only, not authenticity) | Medium | Import trust decision (user-facing) | Terminology: **DONE** (commit bbd04d4). Keyed/public-key signing is a **RELEASE GATE**: before (a) third-party skill distribution, (b) public skill imports, (c) any workflow/skill marketplace, (d) any claim that imported bundles are authenticated | UI/docs no longer imply authenticity (done); bundles carry an Ed25519 author signature verified against a trusted-key list; unsigned imports show an explicit unauthenticated warning |
| R5 | Legacy `v1:raw:` envelopes in the wild (MCP credentials written by older builds on keychain-less Linux) | Medium | At-rest storage | **A — commit 4.1** rider | Reseal-on-read implemented; raw rows counted at startup (sanitized); zero raw rows after keychain present + one use |

## Review cadence

Re-ground this document against the code at every phase boundary (A, B, C) and
whenever a new table, IPC route, LAN route, or tool family lands. The Section 5
table is the contract: a status upgrade there requires a code reference and,
where feasible, a test.

# PR #42 — Founder review packet

**Branch:** `phase-a/provider-foundation` → `main` · **Scope:** Phase 0 architecture + Phase A provider foundation · **Tests:** 405 automated, all passing · **Manual matrix:** 14/14 rows PASS (no conditional passes remaining) · **Recommendation at bottom.**

## 1. What changed, in plain language
Artha now treats external AI providers as first-class citizens without weakening its local-first core. A new user chooses where intelligence runs (local / own API key / decide later); a BYOK user picks from 12 providers, pastes a key that is **only ever stored keychain-encrypted** (or held in memory for one session — never plaintext, never base64), sees the endpoint's models and capabilities, proves the connection before activating, and keeps working across restarts with zero Ollama noise. Every empty or degraded state now says the truth. Six architecture documents lock the platform direction (execution modes, provider SDK, threat model, object model, monetization foundation, roadmap incl. founder-critical Phase A.5).

## 2. Commit-by-commit (17 commits)
| Commit | Summary |
|---|---|
| d697efc | **1** Seal BYOK api_keys at rest (v1 envelope + launch migration) |
| 438cd4e | **2** Provider-aware Ollama lifecycle (providerKind; zero unintended localhost calls) |
| ff0654e | **3** Explicit no-model state (typed error; honest banner; no silent llama3.2 fallback) |
| 6b15940 | lint follow-up (superseded warning card) |
| bbd04d4 | Bundle "HMAC" → integrity-checksum honesty (register R4 terminology) |
| d9fbf5a | Phase 0 docs (6) + 46-row traceability |
| d27e727 | **3.5** Remove insecure persistent credential fallback (session-only; Linux basic_text rejected; migrate-or-lock; WAL+VACUUM cleanup) |
| 738a1b5 | **4** Mock OpenAI-compat provider fixture (no live keys in CI) |
| 94425a8 | **4.1** Seal oauth_tokens + reseal legacy raw MCP blobs (R1+R5 closed) |
| 65a4f41 | **5** Provider preset registry (12 providers, data-driven) |
| a520234 | **6** Model discovery + connection test + ErrorNormalizer v0 |
| e43eb30 | **7** ModelsPanel rework (presets, discovery, test-before-activate, key_state badges) |
| e6a6dfe | **8** Onboarding execution-mode paths + integration state-transition suite + manual matrix doc |
| 52dcc6b | **9** Capability registry v1 (absorbs thinkingUnsupported; retention notes) |
| a79a7a9 | **10** execution_profiles v0 + honest degraded states (semanticStatus, RAG warning, capability chips) |
| 7e6e6d9 | Independent-review remediation (B1 blocker, H1–H3, M1–M6, L1/L2/L5/L6) |
| (3) | Release gates R2–R4 + CI OS matrix; ModelPicker live-chip fix + QA profile isolation + Phase A.5 recorded; QA-lock ordering + validation evidence |
| 38525a4 | **Row-13 integrity patch** — never persist or compare an invalid embedding vector (typed `EmbeddingUnavailableError`, `pending_embedding` state, retrieval exclusion, validated memory cache); 20 tests |
| c62a4b4 | Runtime status race — `ensureModelReady` returns its own terminal status; onboarding surfaces a real error card instead of a perpetual spinner; 5 tests |
| a4387c6 | QA isolation — RAG indexer resolved lazily so isolated profiles stay isolated, + static regression guard |

## 3. Database migrations (all additive/in-place; each idempotent)
api_key sealing (+verify, WAL-truncate, VACUUM) · oauth_tokens sealing · legacy raw MCP blob reseal · provider-id normalization · execution_profiles table + Default row. **Verified on a synthetic pre-Phase-A DB:** migrates once, zero re-runs across two restarts, `integrity_check` ok, zero plaintext bytes on disk.

## 4. Credential storage (end state)
Persistent = `v1:enc:` (OS keychain) only. No keychain → session-only (`v1:session` sentinel, key dies with the process) or refusal with remediation; Linux `basic_text` counts as no keychain; legacy plaintext seals-on-read or LOCKS (typed error, background paths included). Renderer sees derived `key_state` only. `ARTHA_FORCE_NO_KEYCHAIN=1` (QA, fails-strict) and `ARTHA_QA_MODE=1`+`ARTHA_USER_DATA_DIR` (guarded profile isolation) are the two validation flags added.

## 5. Manual matrix & evidence — 14/14 PASS
Full detail in `PHASE_A_VALIDATION_RESULTS.md`. The two remaining rows were completed with the controlled-stub method:
- **Row 10:** genuine unavailability (sanitized 127.0.0.1 stub holding the port; Ollama binary/config untouched) → runtime reports `error`, never "ready"; **1 spawn attempt, ~600 ms probes inside one 20 s deadline, 0 further probes over 45 s idle**; honest recovery card + Try again + BYOK escape hatch; cloud session unaffected with **5 loopback requests, all read-only GETs**; Ollama restored and the release app reconnected.
- **Row 13 (was FAIL, now PASS):** with the embedder unavailable, indexing persisted **0 zero-vector rows** — chunks stored as `pending_embedding` with `embedding: null`, text retained for keyword use, `doc_count` 0, semantic retrieval excluding them, **0 cloud embedding requests**. With the embedder restored, a rebuild upgraded both chunks to valid 768-dim vectors (`doc_count` 0→2).

**Live-provider smoke: skipped** per your rule — no temporary/revocable key was available, and long-lived credentials must not be requested. Provider behaviour is covered by the full mock-provider fixture (discovery, streaming, tool calls, usage, 401/429/400/503, malformed, interrupted streams) **plus a real-internet authentication-error round-trip against `api.openai.com`**, which also evidences direct desktop→provider routing. Non-blocking.

## 6. Cross-platform & CI
CI green on the branch; unit suite now runs ubuntu/windows/macos (proves mocked policy logic cross-OS — **not** native keychain integration). macOS native keychain genuinely exercised in the headed run. Linux Secret Service / Windows DPAPI remain manual-validation debt (threat model §3 states this).

## 7. Independent review
Two adversarial agents (uninvolved in implementation). Findings: 1 merge blocker (B1 onboarding spinner — mine, fixed), 3 high (H1 probe-URL key exfiltration; H2 cross-provider key bleed; H3 keyless-provider breakage — all fixed with regression tests), 6 medium + 4 low fixed, 4 deferred-with-rationale (L3 VACUUM retry marker, L4 probe-comment accuracy, L7 local-address rows hidden in cloud list, L8 legacy local plaintext keys locked on keychainless systems). Full classifications in the PR conversation.

## 8. Security remaining
R2 LAN plain HTTP, R3 unenforced MCP permissions, R4 unkeyed bundle checksum — capability-tied **release gates** (threat model §9), none newly exposed by this PR. Dependabot: **critical CVE-2026-9277 (shell-quote ≤1.8.3 via `concurrently`) = devDependency-only, absent from the packaged asar, unreachable in shipped product → NOT a merge blocker**; classified build-environment risk; fix + triage of the other 31 alerts tracked in `SECURITY_TRIAGE_DEPENDENCIES.md` as a separate narrowly-scoped PR (release gate for the next distributable build).

## 9. Rollback
Branch revert = clean (no destructive migrations). Data rollback: old builds read sealed keys as invalid bearers → provider auth error, keys recoverable by re-entry or re-upgrade; no crash path; verified conceptually and via the passthrough design. Release note required if ever rolling back a shipped build past commit 1.

## 10. Diff-review guide — where to spend your 30 minutes
1. `packages/app/src/security/secretString.ts` — THE trust boundary. Check: no write path emits `v1:raw:`; `isSecretEncryptionAvailable` basic_text rejection; migration never destroys a row.
2. `packages/app/src/llm/client.ts` (`usableApiKey`, `resolveTransport`) — key-use policy + transport selection. Check: every path to a provider goes through `usableApiKey`; H2 fix (transport row's own key); no localhost default survives.
3. `packages/app/src/ipc/handlers.ts` (llm:addCloudModel, probeTarget, listConfigured) — renderer boundary. Check: no api_key column ever selected for the renderer; probes with modelId ignore renderer URLs (H1 fix).
4. `packages/app/src/db/schema.ts` migration tail — ordering, VACUUM condition, per-block try/catch.
5. `packages/app/src/llm/ollamaRuntime.ts` — lifecycle gating (`ollamaManaged`), no_model/not_installed precedence, `ollamaInstalled` flag (B1).
6. `packages/app/src/system/qaProfile.ts` + `main.ts` top — the ONLY code that can redirect userData; verify the guards match your approval (must sit above the instance lock and telemetry boot).
6b. `packages/app/src/rag/vectorIntegrity.ts` + `indexer.ts` — the data-integrity invariant. Check: `embed()` throws rather than returning a vector; nothing writes a placeholder; retrieval scores only `isValidVector` chunks.
7. `packages/renderer/.../Onboarding.tsx` (ByokSetup) — the new user-facing flow; check the session-only consent language.
8. Skim: providerPresets/capabilities (data honesty), threat model §3/§9 (must match code).

**Recommendation: MERGE — via merge commit (not squash)**, preserving the reviewed commit sequence and evidence trail. All pre-merge decision rules are satisfied; the two row exceptions (13 structural fix = Phase B by design; live-key smoke = skipped per your own fallback clause) are justified above. Awaiting your approval — no auto-merge.

# Phase A manual test matrix

The rendered-UI half of the Phase A smoke strategy (founder-approved option B:
integration tests below the UI + this documented manual matrix). The
below-the-UI halves are automated in
`packages/app/src/llm/integration.providerLifecycle.test.ts` and the suites
listed per row.

**Environment helpers**

- `ARTHA_FORCE_NO_KEYCHAIN=1` — forces the no-trustworthy-keychain state on any
  platform (fails safe: makes storage stricter, never weaker). Required to test
  rows 11–12 on macOS/Windows.
- Fresh-profile reset (macOS): quit Artha, `rm -rf ~/Library/Application
  Support/Artha`, relaunch.
- A throwaway OpenRouter or OpenAI key is useful for rows 2, 4–9; any invalid
  string works for row 4.

| # | Scenario | Steps | Expected | Automated below UI? |
|---|---|---|---|---|
| 1 | Fresh local onboarding | Fresh profile → launch → "Just me" → "Run models on this computer" → pick/pull a model | Model warms; chat replies; no error banners | partial (`ollamaRuntime.test.ts` warm path) |
| 2 | Fresh BYOK onboarding | Fresh profile → "Just me" → "Use my own API key" → pick provider → paste key → Find models → pick one → Test & start | Connection test passes; chat replies via provider; NO Ollama banner at any point | yes (integration suite: BYOK scenario) |
| 3 | Configure later | Fresh profile → "Just me" → "Configure later" | Lands in app; persistent "No model configured" card bottom-left with working "Open Model Settings" action; first chat send shows the typed no-model error + "Open Model Settings" button — never a connection error | yes (`no_model` + `NoModelConfiguredError` tests) |
| 4 | Invalid key | BYOK flow with a wrong key → Find models / Test & start | Normalized "provider rejected this API key" message; the key value never appears in any error text | yes (probe auth tests) |
| 5 | Successful model discovery | BYOK flow, valid key → Find models | Datalist populates (deduplicated); count note shown | yes (probe discovery tests) |
| 6 | Discovery unavailable, manual fallback | BYOK flow → base URL of an endpoint without /models (or offline) → Find models | Clear error or "no models listed" note; typing a model name manually still proceeds | yes (empty-catalogue + network tests) |
| 7 | Provider activation | Settings → Models → Cloud Models → Activate on a saved cloud row | ModelPicker chip shows the cloud model; chat uses it | yes (integration switching test) |
| 8 | Restart with cloud provider active | Row 2 or 7, then quit + relaunch | No "Ollama isn't installed" banner; no warming states for the cloud model; chat still works without re-entering the key (sealed) | yes (integration restart test) |
| 9 | Provider switching | Switch active model cloud → local → cloud via ModelPicker/ModelsPanel | Each switch takes effect on the next message; local switch resumes warm-up; no stale-transport errors | yes (integration switching test) |
| 10 | No Ollama installed | Row 2 on a machine without Ollama (or temporarily rename the binary) | BYOK onboarding + chat fully work; the ONLY localhost traffic is a single reachability probe (verify with a proxy/`lsof` if in doubt) | yes (zero-unintended-localhost tests) |
| 11 | No secure keychain available | `ARTHA_FORCE_NO_KEYCHAIN=1` → BYOK save | Save is refused with the remediation card; "Use for this session only" offered; nothing written to disk except the `v1:session` sentinel (verify: `sqlite3 artha.db "select api_key from llm_models"`) | yes (credential-policy tests) |
| 12 | Session-only key across restart | Row 11 → accept session-only → chat → relaunch | Chat works during the session; after relaunch the saved row shows "Session key expired — re-enter"; chat send gives the typed expiry message | yes (integration session test) |
| 13 | Missing embedding capability | Cloud-only user (no Ollama): use memory/RAG features | Keyword fallback works; degraded state surfaced (commit 10 — until then this row documents the KNOWN silent degradation) | Phase B target |
| 14 | Existing-user upgrade migration | Install this branch over a profile that has a pre-branch plaintext cloud key | First launch logs `api_key seal migration: 1 sealed…`; key column shows `v1:enc:`; chat works unchanged; `sqlite3 artha.db` shows no plaintext remnant (post-VACUUM) | yes (migration + integration upgrade tests) |

**Sign-off:** record app version, platform, and pass/fail per row in the PR
conversation. Rows 2, 3, 8, 11, 12 double as the four founder-required PR
screenshots.

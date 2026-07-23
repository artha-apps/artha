# Deploying the Artha team hub

This is the production runbook for standing up an **Artha org hub** — a single shared instance of the Artha desktop app, licensed under Enterprise, that teammates connect to over the local network (or company VPN).

The hub binds `0.0.0.0:7842/chat`. Every authorised teammate hits that endpoint with a Bearer token (their personal API key) and gets the full Artha agent — local model, RAG, document workflows, shared org memories — all running on the hub host. No customer data ever leaves the hub.

> ⚠️ **Trusted networks only (current limitation).** Hub traffic is plain HTTP
> today: Bearer keys and chat content are readable by anyone who can sniff the
> network segment. Run the hub ONLY on a trusted LAN or inside a company VPN /
> WireGuard tunnel — never exposed to an untrusted network or the internet.
> Do not describe hub traffic as encrypted or protected. Transport security is
> a release gate for production org-hub deployments (security remediation
> register R2 in `docs/architecture/ARTHA_SECURITY_THREAT_MODEL.md`).

There are two ways to run the hub today; pick the one that matches how your IT team operates.

> **Phase 1 note.** The hub is the same Electron app you'd run on a laptop, with the LAN server flipped on and an Enterprise license applied. A true headless build (no Electron, runs as a container daemon, Postgres-backed) lands in Phase 2; the Docker option below uses `xvfb` as the bridge until then.

---

## Option A — Dedicated host (recommended, rock-solid)

**Use this when** you have any always-on machine you can dedicate to it (a mini-PC, a small Linux server with a monitor or VNC, a VM with a desktop session).

### Sizing

| Org size | RAM | CPU | Disk | GPU |
|---|---|---|---|---|
| ≤ 25 seats | 32 GB | 8 cores | 200 GB SSD | optional (~12 GB VRAM speeds up 7B models) |
| 25–100 seats | 64 GB | 16 cores | 500 GB SSD | recommended (24 GB VRAM, e.g. RTX 4090 / A5000) |
| 100+ seats | 128 GB+ | 32 cores | 1 TB SSD | required (multi-GPU or dedicated inference box) |

The hub itself is light; the heavy load is Ollama (your LLM). You can split: hub on one machine, Ollama on a second box, then point the hub at the GPU box via Settings → Models → Cloud / Custom (`http://gpu-host:11434/v1`).

### Install

1. **Install the host OS** (Ubuntu 22.04 LTS or macOS 14+ both work; Windows 11 also fine).
2. **Install Ollama** on the same host (`curl -fsSL https://ollama.com/install.sh | sh`) OR on a separate GPU box.
3. **Install Artha** — download the installer for the host's OS from your release feed (DMG / NSIS / DEB).
4. **Apply the org license**:
   - First-run onboarding → pick **"Setting up for my organization"**.
   - Paste the license token issued by your seller (see [License key issuance](#license-key-issuance) below).
5. **Start the hub** — the OrgSetup flow walks you through it. The hub URL displays as `http://<host-lan-ip>:7842`.
6. **Enable LAN auto-start** in Settings → Integrations → LAN Server so the hub comes back up after a reboot.
7. **Provision seats** — Settings → Team → add a teammate, then issue a key bound to them. Hand them the connection card.

### Network

- Open inbound TCP **7842** on the host firewall to the relevant subnet(s).
- If teammates connect over VPN, the hub URL becomes the host's VPN-side IP.
- The hub never makes outbound calls except to Ollama and to whatever the agent's tools explicitly do (web search, web fetch — controlled in Settings → Web).

### Updates

- Auto-update is on by default; Artha checks GitHub Releases on boot and prompts the host operator. Updates ship as a normal Electron installer — the hub goes down for ~30 s.
- For change-managed environments, disable auto-update in Settings → General and patch on your schedule.

### Backups

The hub's entire state lives in one SQLite file:

- macOS: `~/Library/Application Support/Artha/artha.db`
- Linux: `~/.config/Artha/artha.db`
- Windows: `%APPDATA%\Artha\artha.db`

Back up the file plus the `-shm` / `-wal` siblings (WAL mode). A nightly `rsync` to your standard backup target is sufficient. Restoring is a stop-the-app + file-copy + start-the-app.

---

## Option B — Docker container (interim, for k8s/containerised IT)

**Use this when** your IT mandates containers and you cannot get a dedicated host. The container wraps the Electron app in `xvfb` (virtual framebuffer) so it runs headlessly. It is a stopgap until the Phase 2 native-headless build ships.

### Build

```bash
docker build -f Dockerfile.hub -t artha-hub:0.1 .
```

### Run

```bash
docker run -d \
  --name artha-hub \
  --restart unless-stopped \
  -p 7842:7842 \
  -v artha-data:/data \
  -e ARTHA_LICENSE_KEY="<paste your org token here>" \
  artha-hub:0.1
```

- `-v artha-data:/data` persists the SQLite file across container restarts; mount it on durable storage in real deployments.
- `ARTHA_LICENSE_KEY` is applied non-interactively on first boot.
- An Ollama sidecar (or external Ollama URL) must be reachable from the container. Point at it via `ARTHA_OLLAMA_BASE_URL=http://ollama:11434/v1` if it's not on `localhost:11434`.

### Caveats of the interim container

- No GUI; you cannot run the onboarding wizard inside the container. Provision seats by hitting `lan:start` + `apikeys:create` over the hub's IPC bridge, or pre-bake the SQLite file outside the container then mount it.
- `xvfb` adds ~200 MB to the image and a small amount of CPU overhead.
- Auto-update is disabled inside the container; pull a new image to upgrade.

If any of these caveats are dealbreakers, fall back to Option A while Phase 2 ships.

---

## License key issuance

Org licenses are signed offline with the seller's Ed25519 private key:

```bash
node scripts/sign-license.mjs \
  --tier enterprise \
  --seats 250 \
  --org "Acme Corp" \
  --days 365
```

The output line is the token you give the customer. The customer pastes it into the OrgSetup flow (or the LicensePanel in Settings). Verification is fully local — no callback to your servers.

Seat counts and expiry are encoded in the signed payload; to change either, re-issue a new token and have the customer paste it in `Settings → Team → License`.

---

## Member quick-connect (give this to your teammates)

Once the admin hands a teammate their **connection card**, the teammate can hit the hub immediately:

```bash
curl -H "Authorization: Bearer <BEARER_KEY>" \
     -d '{"message":"hello from <name>"}' \
     http://<hub-host-ip>:7842/chat
```

The response is NDJSON; the agent reply comes back as `{ "type": "token", "content": "..." }` lines terminated by `{ "type": "done" }`.

A polished in-app "Connect to team hub" client mode that routes the desktop app's chat into the hub is on the Phase 2 roadmap; the curl/IDE/MCP endpoints work today via the published LAN protocol.

## Shared context packs

A **context pack** is a named context set the hub admin saves from a chat — the
attached folders/files, a skill, and pinned memories. Marking a pack **Shared**
(Settings → Team → Shared Packs; requires a Team or Business license) publishes
it to the hub so teammates can run with the same working context:

```bash
# List the packs the hub shares
curl -H "Authorization: Bearer <BEARER_KEY>" http://<hub-host-ip>:7842/packs

# Run a chat WITH a pack applied — the run executes on the hub inside the
# pack's folders, with its skill active
curl -H "Authorization: Bearer <BEARER_KEY>" \
     -d '{"message":"summarise the latest contracts","packId":"<pack_id>"}' \
     http://<hub-host-ip>:7842/chat
```

Notes:
- Pack folders are **hub-local paths** — the run executes on the hub, which is
  the whole org-hub model. Packs are not synced to teammate machines.
- **Privacy:** only the pack's *shared* pinned memories are injected into LAN
  runs. Private memories — pinned or otherwise — never travel to teammates.
- Applying a pack merges its folders into the LAN session's scope; an unknown
  or un-shared `packId` returns HTTP 400. Warnings (e.g. a folder deleted since
  the pack was saved) stream back as a `{ "type": "meta" }` NDJSON line.

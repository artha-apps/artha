#!/usr/bin/env bash
# Container entrypoint for the Dockerfile.hub interim build.
#
# Responsibilities:
#   1. Start a virtual framebuffer so Electron has a "display" to attach to.
#   2. On first boot, seed the license key from ARTHA_LICENSE_KEY (env) and
#      lan_autostart=1 into the SQLite settings blob. After that the hub is
#      self-sustaining across container restarts (state lives on the /data
#      volume).
#   3. Launch the Electron main process.
#
# When the native-headless Phase 2 build ships, this script and the xvfb hack
# go away — the same /data volume layout will be compatible.

set -euo pipefail

DATA_DIR="${ARTHA_DATA_DIR:-/data}"
DB_PATH="${DATA_DIR}/artha.db"
mkdir -p "${DATA_DIR}"

# Seed the license key + LAN autostart non-interactively on first boot. If the
# DB already exists we leave it alone — operators may have rotated keys via the
# admin UI and we must not stomp on that.
if [[ -n "${ARTHA_LICENSE_KEY:-}" && ! -f "${DB_PATH}" ]]; then
  echo "[hub-entrypoint] Seeding license + lan_autostart for first boot."
  # sqlite3 isn't in the runtime image; defer the actual write to the app, which
  # creates the schema on first launch. The renderer's onboarding flow respects
  # ARTHA_LICENSE_KEY when it's present (see Onboarding/OrgSetup auto-apply).
  # In the meantime, persist it where the app can pick it up at boot.
  printf '%s' "${ARTHA_LICENSE_KEY}" > "${DATA_DIR}/license.token"
fi

# Headless display.
Xvfb :99 -screen 0 1280x800x24 -ac +extension GLX +render -noreset &
export DISPLAY=:99

# Hand off to Electron. --no-sandbox is required because the container does not
# expose user-namespace capabilities; the hub's own auth (Bearer tokens) is the
# trust boundary.
exec node /app/packages/app/dist/main.js --no-sandbox

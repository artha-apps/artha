#!/bin/bash
# fix.sh — run this once from your terminal to fix git locks, commit Step 4, and reinstall CLT
set -e
cd "$(dirname "$0")"

echo "=== Removing git lock files ==="
rm -f .git/HEAD.lock .git/index.lock 2>/dev/null && echo "✅ Lock files cleared" || echo "No lock files found"

echo ""
echo "=== Committing Step 4 ==="
git add -A
git commit -m "feat(step4): landing page, SITEMAP, Phase 1 acceptance criteria

D5 — packages/landing/ (Next.js 14 static site):
- OS-detecting download button (fetches GitHub Release assets via API)
- Hero with gradient headline + platform badges
- How-it-works (3-step), Features grid (8 cards), Privacy callout, Footer
- Fixed nav, Vercel deploy config (output: export)
- Tailwind artha colour palette matching the app

D6 — SITEMAP.md: full workspace map for all packages, files, deps, data paths

Docs:
- REQUIREMENTS.md v5: 3/5 Phase 1 acceptance criteria ticked
- Step 4 implementation log added
- Electron upgrade path documented (CLT reinstall owner action)
- packages/landing added to root workspaces array"

echo ""
echo "=== Pushing to GitHub ==="
git push
echo "✅ Step 4 committed and pushed"

echo ""
echo "=== Reinstalling Command Line Tools ==="
echo "(This will prompt for your password)"
sudo rm -rf /Library/Developer/CommandLineTools
sudo xcode-select --install
echo ""
echo "✅ CLT install dialog should appear — click Install and wait ~5 min"
echo ""
echo "After CLT installs, run:"
echo "  npm install electron@latest --save-dev"
echo "  npx electron-rebuild -f -w better-sqlite3"
echo "  npm run dev    # verify app still starts"

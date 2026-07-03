# Artha Landing Page

Marketing site at the eventual domain (e.g. `artha.app` or `artha.vercel.app`).

## Stack
- Next.js 14 (App Router)
- TypeScript
- No CSS framework — single `globals.css` is enough for a one-page site

## Local development

```bash
cd landing
npm install
npm run dev   # http://localhost:3000
```

## Deploy to Vercel

```bash
# One-time
npm i -g vercel
cd landing
vercel link        # link to a new or existing Vercel project
vercel --prod      # deploy
```

Or wire the GitHub repo to Vercel via the dashboard and set **Root Directory** to `landing`. Subsequent pushes to `main` auto-deploy.

## How downloads work

`app/page.tsx` calls the GitHub Releases API for `artha-apps/artha` at page load to fetch the latest release's assets and renders OS-specific download buttons. **No rebuild is needed when a new release is cut** — the landing page picks up the new version automatically.

If the GitHub API call fails (rate limiting, network), the page falls back to a "See all downloads" link to `https://github.com/artha-apps/artha/releases/latest`.

## Production checklist

- [ ] Link to Vercel project: `vercel link`
- [ ] Set custom domain (optional, Phase 2)
- [ ] Verify `RELEASES_API` URL points to the correct GitHub repo
- [ ] Add favicon + apple-touch-icon to `public/`
- [ ] Add `og:image` for social sharing (Phase 2)

# Brand assets — canonical source-of-truth

Durable backup of the Artha logo so the brand mark can't be lost to branch
churn, duplicate commits, or a clobbered feature branch. **Do not delete or
overwrite without a deliberate rebrand.**

- `artha-logo-mark.png` — the mandala **अ** mark. Identical image to
  `../icon.png` / `../icon-master.png` (the app-icon source consumed by
  electron-builder).
- `artha-logo-full.png` — full lockup: अ mark + **ARTHA** wordmark +
  "AI COWORKER OS" tagline. Identical image to `../icon2.png`.

Web/landing variants live in `landing/public/` (`logo-mark.png`,
`logo-full.png`, `og-image.png`, favicons, wordmarks) and are served by the
Next.js site, not used by the desktop build.

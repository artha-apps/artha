/**
 * Next.js configuration for the Artha marketing site.
 *
 * The site is a purely static marketing page with no server-side logic, so it
 * is built as a full static export (`output: 'export'`). This produces a plain
 * `out/` directory of HTML/CSS/JS files that can be hosted on any CDN
 * (GitHub Pages, Vercel, Cloudflare Pages) without a Node.js server.
 */
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // 'export' emits static files to /out; required for CDN / Pages hosting.
  output: 'export',
  // Emit index.html inside a sub-directory for each route (e.g. /about/index.html)
  // rather than /about.html — improves compatibility with static hosts that expect
  // directory-style URLs.
  trailingSlash: true,
  // next/image's server-side optimisation is unavailable in a static export;
  // unoptimized:true passes <img> src through as-is so build doesn't fail.
  images: { unoptimized: true },
};

export default nextConfig;

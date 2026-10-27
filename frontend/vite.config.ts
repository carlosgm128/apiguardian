import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

// Dev: `npm run dev:web` serves on :5173 and proxies /api to `apiguardian serve` on :4319.
// Build: emits to dist/web, which the server serves.
// Demo (`--mode demo`): a static build in dist/demo that needs no server (see src/demo).
export default defineConfig(({ mode }) => ({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), seo(mode === "demo")],
  base: mode === "demo" ? "./" : "/",
  build: {
    outDir: fileURLToPath(new URL(mode === "demo" ? "../dist/demo" : "../dist/web", import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    proxy: mode === "demo" ? undefined : { "/api": "http://127.0.0.1:4319" },
  },
}));

/**
 * Search engines and link previews need absolute URLs, which only the deployment knows:
 * SITE_URL, or the production domain Vercel exposes at build time. With one, the demo gets a
 * canonical link, og:url, og:image, robots.txt and sitemap.xml. The real dashboard is never
 * public (the server only accepts loopback), so its build is marked noindex.
 */
function seo(indexable: boolean): Plugin {
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const site = (process.env.SITE_URL ?? (vercel ? `https://${vercel}` : "")).replace(/\/+$/, "");
  return {
    name: "apiguardian-seo",
    transformIndexHtml(html) {
      if (!indexable) return html.replace(/<meta name="robots" content="[^"]*" \/>/, '<meta name="robots" content="noindex, nofollow" />');
      if (!site) return html;
      return html.replace(
        "</head>",
        [
          `<link rel="canonical" href="${site}/" />`,
          `<meta property="og:url" content="${site}/" />`,
          `<meta property="og:image" content="${site}/og-image.png" />`,
          `<meta name="twitter:image" content="${site}/og-image.png" />`,
          "</head>",
        ].join("\n    "),
      );
    },
    generateBundle() {
      const robots = indexable ? `User-agent: *\nAllow: /\n${site ? `\nSitemap: ${site}/sitemap.xml\n` : ""}` : "User-agent: *\nDisallow: /\n";
      this.emitFile({ type: "asset", fileName: "robots.txt", source: robots });
      if (indexable && site) {
        const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${site}/</loc><lastmod>${new Date().toISOString().slice(0, 10)}</lastmod></url>\n</urlset>\n`;
        this.emitFile({ type: "asset", fileName: "sitemap.xml", source: sitemap });
      }
    },
  };
}

import { defineConfig } from "vite";
import { crx, defineManifest } from "@crxjs/vite-plugin";
import { viteStaticCopy } from "vite-plugin-static-copy";

// `mime_types_handler` (Chrome 151+) registers VimDF as the browser's
// handler for application/pdf. This is strictly better than the
// declarativeNetRequest redirects below wherever it's available:
//
//   - **Local files work with no setup.** DNR is not evaluated at all for
//     `file://` requests unless the user ticks "Allow access to file URLs"
//     (Chromium's RulesetManager::ShouldEvaluateRulesetForRequest returns
//     early on the file scheme), and that box is OFF by default for every
//     Web Store install. A MIME handler is exempt from it.
//   - The address bar keeps the real URL instead of `viewer.html?file=…`.
//   - Chrome hands us the response it already fetched, so no second request
//     — which is what makes POST-delivered and single-use URLs work.
//
// Not in @crxjs's ManifestV3Options type, hence the cast at the call below.
const MIME_TYPES_HANDLER = {
  "application/pdf": {
    handler_url: "src/viewer/viewer.html",
    can_embed: true,
  },
};

// Declared as a plain object rather than inline: `mime_types_handler` is
// newer than @crxjs's manifest type, and a bare object literal would trip
// excess-property checking before the assertion on the call below applies.
const manifestConfig = {
  manifest_version: 3,
  name: "VimDF",
  version: "0.5.0",
  mime_types_handler: MIME_TYPES_HANDLER,
  description: "Navigate PDFs with Vim keybindings",
  author: { email: "tatsukamijo@icloud.com" },
  permissions: ["declarativeNetRequest", "storage", "downloads", "tabs"],
  host_permissions: ["<all_urls>"],
  // PDF.js 4.x decodes JBIG2 / JPEG2000 / OpenJPEG images via WebAssembly
  // modules. MV3's default CSP (`script-src 'self'`) blocks WASM compilation,
  // so images go missing while page background boxes render fine ("Dependent
  // image isn't ready yet" floods the console). `wasm-unsafe-eval` is the
  // MV3-sanctioned keyword that allows WASM but not eval(); it does not
  // trigger extra Web Store review.
  content_security_policy: {
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
  },
  background: {
    service_worker: "src/background/service-worker.ts",
    type: "module",
  },
  // Tiny script in every page that focuses the VimDF iframe when our
  // viewer postMessages `vimdf:loaded`. Without it, an embedded PDF
  // (live-preview servers, doc viewers that wrap PDFs in iframes) keeps
  // the host page focused and j/k just scroll the host until the user
  // clicks into the PDF. Covered by the existing `<all_urls>` host
  // permission, so this adds no new install-time warning.
  content_scripts: [
    {
      matches: ["<all_urls>"],
      js: ["src/content/focus-pdf-iframe.ts"],
      run_at: "document_start",
      all_frames: false,
    },
  ],
  options_page: "src/options/options.html",
  web_accessible_resources: [
    {
      resources: ["src/viewer/viewer.html", "assets/*", "cmaps/*"],
      matches: ["<all_urls>"],
    },
  ],
  icons: {
    "16": "assets/icons/icon16.png",
    "48": "assets/icons/icon48.png",
    "128": "assets/icons/icon128.png",
  },
};

const manifest = defineManifest(
  manifestConfig as unknown as Parameters<typeof defineManifest>[0],
);

export default defineConfig({
  plugins: [
    crx({ manifest }),
    viteStaticCopy({
      targets: [
        {
          src: "node_modules/pdfjs-dist/cmaps/*",
          dest: "cmaps",
        },
      ],
    }),
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "esnext",
    // Vite emits `<link rel="modulepreload" crossorigin>` for shared chunks.
    // On an extension page Chrome then refuses to reuse the preload ("cross-
    // world extension resource mismatch") and follows up a few seconds later
    // with "preloaded ... but not used", so every page load logs two warnings
    // on the extension's error card for a hint that bought nothing: these
    // modules come off local disk, where there is no latency to hide.
    modulePreload: false,
    rollupOptions: {
      input: {
        viewer: "src/viewer/viewer.html",
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    hmr: { port: 5173 },
  },
});

import { defineConfig } from "vite";
import { crx, defineManifest } from "@crxjs/vite-plugin";
import { viteStaticCopy } from "vite-plugin-static-copy";

const manifest = defineManifest({
  manifest_version: 3,
  name: "VimDF",
  version: "0.4.4",
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
});

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

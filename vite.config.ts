import { defineConfig } from "vite";
import { crx, defineManifest } from "@crxjs/vite-plugin";
import { viteStaticCopy } from "vite-plugin-static-copy";

const manifest = defineManifest({
  manifest_version: 3,
  name: "VimDF",
  version: "0.1.0",
  description: "Navigate PDFs with Vim keybindings",
  author: { email: "tatsukamijo@icloud.com" },
  permissions: ["declarativeNetRequest", "storage"],
  host_permissions: ["<all_urls>"],
  background: {
    service_worker: "src/background/service-worker.ts",
    type: "module",
  },
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

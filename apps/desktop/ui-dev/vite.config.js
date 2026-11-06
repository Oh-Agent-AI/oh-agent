import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Keep the current DOM/IPC surface intact while Vite supplies HMR and
  // full-page reloads for the existing workbench during migration.
  root: path.resolve(here, "../src-tauri/ui"),
  publicDir: path.resolve(here, "public"),
  cacheDir: path.resolve(here, ".vite-cache"),
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
  appType: "mpa",
  plugins: [
    {
      name: "agent-vitals-browser-tauri-mock",
      transformIndexHtml(html, ctx) {
        if (ctx.bundle) return html;
        return {
          html,
          tags: [{
            tag: "script",
            attrs: { src: "/tauri-mock.js" },
            injectTo: "head-prepend",
          }],
        };
      },
    },
  ],
  build: {
    outDir: path.resolve(here, "dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(here, "../src-tauri/ui/workbench.html"),
    },
  },
});

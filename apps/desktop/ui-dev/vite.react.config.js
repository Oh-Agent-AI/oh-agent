import path from "node:path";
import { createReadStream, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { registry, repo } from "../../../scripts/official-plugins.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

// Phase 1 deliberately has its own config and output. The existing static
// Workbench remains the production Tauri entry until the React pages pass the
// real-app gates described in WORKBENCH_REACT_MIGRATION_SPEC.md. The output is
// placed beside the Tauri config so the candidate config can package exactly
// what the preflight verifies, without changing the production frontendDist.
export default defineConfig({
  root: path.resolve(here, "react"),
  plugins: [react(), tailwindcss(), {
    name: "agent-vitals-react-browser-tauri-mock",
    transformIndexHtml(html, ctx) {
      return {
        html,
        tags: [
          { tag: "script", children: `window.__AV_PLUGIN_REGISTRY__=${JSON.stringify(registry).replace(/</g, "\\u003c")};`, injectTo: "head-prepend" },
          ...(!ctx.bundle ? [
            { tag: "script", attrs: { src: "/tauri-mock.js" }, injectTo: "head-prepend" },
            { tag: "script", attrs: { src: "/browser-plugin-host.js" }, injectTo: "head" },
          ] : []),
        ],
      };
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = new URL(request.url, "http://127.0.0.1");
        const definition = registry.plugins.find((plugin) => url.pathname.startsWith(`/${path.posix.dirname(plugin.entry)}/`));
        if (!definition) return next();
        const prefix = `/${path.posix.dirname(definition.entry)}/`;
        const dist = path.join(repo, definition.source, "dist");
        let file;
        try { file = path.resolve(dist, decodeURIComponent(url.pathname.slice(prefix.length))); }
        catch { response.statusCode = 400; response.end(); return; }
        if (!file.startsWith(`${dist}${path.sep}`) || !existsSync(file) || !statSync(file).isFile()) {
          response.statusCode = 404; response.end("Build official plugins with npm run build:browser first."); return;
        }
        const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".jpg": "image/jpeg", ".glb": "model/gltf-binary" };
        response.setHeader("Content-Type", types[path.extname(file)] ?? "application/octet-stream");
        createReadStream(file).pipe(response);
      });
    },
  }],
  resolve: { dedupe: ["react", "react-dom"] },
  publicDir: path.resolve(here, "public"),
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
  },
  base: "./",
  build: {
    outDir: path.resolve(here, "../src-tauri/ui-react-dist"),
    emptyOutDir: true,
  },
});

import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => ({
  root: here,
  plugins: [react()],
  define: { __CITY_GAME_UAT__: JSON.stringify(process.env.AGENT_VITALS_CITY_GAME_UAT === "1") },
  base: "./",
  build: {
    sourcemap: mode === "debug",
    outDir: path.join(here, "dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: path.join(here, "index.html"),
        remote: path.join(here, "remote.html"),
      },
    },
  },
}));

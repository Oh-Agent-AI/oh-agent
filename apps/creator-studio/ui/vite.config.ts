import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  // 视口源码来自 agent-city，react 必须去重到本应用的同一份，否则两份 React
  // 实例会让 hook 调用直接崩溃。
  resolve: {
    dedupe: ["react", "react-dom", "@agent-vitals/app-sdk", "@agent-vitals/city-sdk"],
    // creator-studio 直接引用 agent-city 的视口源码；Rollup 会从源文件所在目录
    // （apps/agent-city/ui）解析 `three`，而 CI 只安装了 creator-studio 的依赖，
    // 那里没有 agent-city 的 node_modules。显式 alias 到本应用的 three，避免
    // "Rollup failed to resolve import three"（Windows 打包实测）。
    alias: [
      { find: /^three$/, replacement: path.resolve(fileURLToPath(new URL(".", import.meta.url)), "node_modules/three/build/three.module.js") },
      { find: /^three\/addons\/(.*)$/, replacement: path.resolve(fileURLToPath(new URL(".", import.meta.url)), "node_modules/three/examples/jsm/$1") },
    ],
  },
});

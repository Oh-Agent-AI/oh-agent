import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  // 视口源码来自 agent-city，react 必须去重到本应用的同一份，否则两份 React
  // 实例会让 hook 调用直接崩溃。
  resolve: { dedupe: ["react", "react-dom", "@agent-vitals/app-sdk", "@agent-vitals/city-sdk"] },
});

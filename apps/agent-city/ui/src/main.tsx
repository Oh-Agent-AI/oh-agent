import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CityApp } from "./CityApp";
import { installMechaGlbs } from "./render/mecha/glbRegistry";
import "./standalone.css";

// 机甲 GLB：资产就绪时把程序模型原地升级；加载失败则保持程序模型（见 glbRegistry.ts）
installMechaGlbs();

if (import.meta.env.MODE === "debug") {
  void import("./debug/isolationFaults");
}

createRoot(document.getElementById("root")!).render(
  <StrictMode><CityApp /></StrictMode>,
);

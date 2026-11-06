# Workbench UI 开发

## 快速开始

```bash
cd apps/desktop/ui-dev
npm install
npm run dev
```

打开 `http://127.0.0.1:5173/workbench.html`，Vite 会从 `../src-tauri/ui` 提供
Workbench 页面，并注入 `public/tauri-mock.js`。mock 只用于浏览器中的演示数据和
交互检查，不会写入本机 Authority 数据库。

React 迁移预览使用隔离入口，不覆盖旧 Workbench：

```bash
npm run dev:react
```

如需在 Tauri dev 窗口中验证 React Shell，从 `apps/desktop/src-tauri` 运行：

```bash
cargo tauri dev --config tauri.react.conf.json
```

该配置切换 React 开发 URL，并声明隔离的 `ui-react-dist` 候选产物和
`index.html` 窗口入口；生产 `tauri.conf.json` 的 `frontendDist: "ui"` 仍保持不变。
执行 `npm run verify:react` 会把 shadow bundle 写到
`apps/desktop/src-tauri/ui-react-dist`，并检查所有资源均为相对路径、文件存在且不含
浏览器 mock。它是 Phase 4 的候选包输入，不代表已经切换生产入口。

## 回归检查

```bash
npm run verify
```

该命令先执行 production build，再运行当前 Workbench closeout verifier。样式或
交互修改在开发服务中确认后，仍需用 Tauri 构建和可操作的 `.app` 做原生 IPC、
文件权限、菜单栏、系统通知及安装升级验收。

Vite mock 验收不能替代真实 `.app` Computer Use、签名/公证或外部试用门槛。

桌面包预检：

```bash
node ../../../scripts/verify-macos-app-bundle.mjs
node ../../../scripts/verify-macos-app-bundle.mjs --require-developer-id
```

第一条检查包结构和随包 CLI，并把签名状态作为诊断警告；第二条是正式发布门禁，要求 Developer ID 签名及严格校验通过。

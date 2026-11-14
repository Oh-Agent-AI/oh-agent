# Miami（miami-islands）官方世界内容源码

官方 Agent City 内置世界「Miami 群岛」的内容源码项目，按
[City 项目目录与内容交付规范](../../../../docs/CITY_PROJECT_DIRECTORY_SPEC_2026_11_14.md)（§2、§7）组织。

## 状态：并行源码，尚非构建权威

本目录是规范 §7.2 迁移第 2 步的产物：与 `apps/agent-city/ui/src/engine/cityWorldProfile.ts` 的
`MIAMI_CITY_WORLD_V1` 并行存在。**运行时权威仍是应用内常量**，官方 bundle 尚未消费本目录
（第 3–5 步门槛未过，见 [design/migration-baseline.md](design/migration-baseline.md)）。

- 世界配方：`world/world.json`，由 `oh-agent-sdk init city-project --generator coastal-islands-v1` 生成
- 对照验收：`apps/agent-city/ui/tests/miami-content-source.test.ts` 钉住
  「文件 == 应用权威」「SDK 内容契约接受」「内置 ID 不被自定义导入覆盖」「生成器版本基线」
- 迁移基线与缺口登记：[design/migration-baseline.md](design/migration-baseline.md)

## 构建与校验

```bash
node ../../../../packages/agent-vitals-city-sdk/bin/oh-agent-sdk.mjs validate-world world
node ../../../../packages/agent-vitals-city-sdk/bin/oh-agent-sdk.mjs pack-world world --out dist/miami-world.json --seed 74031 --generator-version 6
node ../../../../packages/agent-vitals-city-sdk/bin/oh-agent-sdk.mjs verify-world dist/miami-world.json
```

`dist/` 是本地生成物，不入库。seed 与生成器版本是发行默认值（来源见基线文档），必须显式提供，
禁止覆盖已有产物。

## 已知限制

- 本项目只包含静态世界配方。Miami 的视觉与玩法资源均为应用代码生成或应用加载，
  不能进入 v2 world 包，也不能因本目录存在而被声称「已迁移」（详见基线文档缺口登记）。
- 本项目不是可安装的运行时内容包；官方身份不改变摘要、兼容与隔离校验要求。

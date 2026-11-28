// 由 scripts/generate-creator-capabilities.mjs 生成（PR12 统一创作模板目录）。
// 数据源：games/<id>/template.json（人工维护碎片）+ game.manifest.json 的 world
// 兼容性。不要手改本文件——改碎片后重新生成；Rust 消费同一份数据
// （assets/creator/code-templates-index.json，include_str!）。
export type CreatorCodeTemplateV1 = Readonly<{
  templateId: string;
  version: string;
  name: string;
  description: string;
  runtime: "code";
  genre: string;
  tags: readonly string[];
  source: Readonly<{ digest: string; entry: string }>;
  compatibility: Readonly<{ requiredCapabilities: readonly string[] }>;
  license: string;
  tests: readonly string[];
}>;

export const CREATOR_CODE_TEMPLATES_V1: readonly CreatorCodeTemplateV1[] = [
  {
    "templateId": "hello-city",
    "version": "0.1.0",
    "name": "Hello City",
    "description": "起步样例：一个自属实体沿 City 可信路线行进，并经 HUD 报告进度。",
    "runtime": "code",
    "genre": "starter",
    "tags": [
      "route",
      "hud"
    ],
    "source": {
      "digest": "sha256:25797efe73b02217beb52c26408e7dc408878e61d644b45cd214b70372e94c8e",
      "entry": "games/hello-city"
    },
    "compatibility": {
      "requiredCapabilities": [
        "world.read",
        "roads.read"
      ]
    },
    "license": "MIT",
    "tests": [
      "games/hello-city/tests/hello-city.test.ts"
    ]
  },
  {
    "templateId": "tower-defense",
    "version": "0.1.0",
    "name": "City Tower Defense",
    "description": "塔防样例：敌人沿可信路线行进，两座塔按弧长布防，三波清空即成功、基地被毁即失败。",
    "runtime": "code",
    "genre": "strategy",
    "tags": [
      "waves",
      "towers",
      "hud"
    ],
    "source": {
      "digest": "sha256:1372fb6826d90d8054689de6fecff01e2c527ee9e44042b45423642305344648",
      "entry": "games/tower-defense"
    },
    "compatibility": {
      "requiredCapabilities": [
        "world.read",
        "roads.read"
      ]
    },
    "license": "MIT",
    "tests": [
      "games/tower-defense/tests/tower-defense.test.ts"
    ]
  }
];

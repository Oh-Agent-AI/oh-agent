# games/

官方玩法的独立内容项目目录（规范 §2）。当前官方玩法（checkpoint-race、区域寻宝等）是应用内
模板并在运行时绑定布局锚点，v2 game 包尚未实现——此处暂无内容项目，见
[design/migration-baseline.md](../design/migration-baseline.md) 缺口登记第 2 条。

每个游戏一个子目录 `<game-id>/`（`game.json`、`layout.json`、`mount.json`、`scene.json`、
`assets/`），布局绑定是特定布局的快照，布局重建后必须重新生成并校验。

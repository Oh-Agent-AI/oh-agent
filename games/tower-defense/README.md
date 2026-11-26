# City Tower Defense (agent-authored sample)

由 DSH subagent 在创作闭环测试中独立写成（2026-11-18）：3 波 × 5 个敌人沿
`listRoutes()[0]` 行进，两座塔按弧长放在 1/3、2/3 处，漏怪扣基地血，HUD 报
`{wave, baseHealth, alive, killed}`，三波清空后 `success`。

它同时也是 P0-07 的塔防样本：`npm test` 会用生产构建器打包、用与 City 相同的
Host 无头跑完 1800 tick，断言 `success`、`killed = 15`、实体归零。

来源与失败修复记录见 `docs/CODE_GAME_AGENT_LOOP_2026_11_18.md`。

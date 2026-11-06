# C3 契约子批次证据

日期：2026-10-03。分支codex/app-layer-city，基线main 564c6726。

本轮实现city:v1 app-local请求/响应、受控错误和能力元数据；
JSON Schema生成SDK类型与协商表；合成fixture、语义不变量、保守兼容门、
生成漂移检查和GitHub Actions工作流。默认验证不写生成物。

本机验证：

- SDK npm run verify:contracts：7项测试与tsc通过。
- 生成两次逐字相同；故意生成漂移失败。
- 破坏required/type/enum/属性与页上限均被兼容门拒绝。
- 原始路径/参数/错误字段拒绝；未知时间与缺价格保留。
- 空窗口、多宿主与续页DTO通过；当前页计数不冒充全窗计数。
- City全部既有守卫、React typecheck/build通过；git diff --check通过。

独立审查发现并修复：费用basis/state不一致、actual状态缺失；
request各分支与错误协议元数据核对遗漏；兼容门不能误剥离名为
description的属性或literal值。actual新增已登记为未发布草案修订，
不是已发布客户端的无版本升级。

限制：跨字段语义校验目前为测试辅助，不是生产查询或授权边界。
独立subAgent复验通过；其指出的时间可靠性配对已补入语义校验与负例：
known两时间已知，unknown均null，partial恰好一个时间已知。
公共host/model目录成员验证、opaque身份绑定、快照维持、来源与订阅
路线证据仍需C4/C5落地。Rust输出实例、其他face和远端CI尚未验收；
schema结构验证不能证明数据来源安全。C3及M0整体不标记完成。

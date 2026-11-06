# City MP4 导出

默认影片由 WebM/VP8–VP9 改为 MP4/H.264；不是修改文件扩展名，也不经过中间 WebM 转码。保留独立 Worker、冻结模型和种子、固定帧时间戳、30 FPS、实际输出帧预览、取消/超时/256 MiB 编码数据上限。无音频轨，不上传数据，不新增宿主 IPC 或原生编码依赖。

WebCodecs 探测 H.264 High/Baseline Level 4.0（1080p30），使用 AVC 格式及 decoderConfig（含 SPS/PPS）封装。容器由锁定的 `mp4-muxer@5.2.2` 生成，MP4 MIME 与 `.mp4` 文件名一致，fast-start 元数据前置。无 H.264 编码能力时明确报错，可继续拍照；不静默回退 WebM。编码器 queue 背压和 Worker 终止机制保留。内存上限是编码数据上限，不是进程总内存上限；封装及 Blob 会产生额外分配。

## 依赖评审

原设计 §5.2 限 MIT/Apache 纯 JS 封装依赖。评估的后继库 Mediabunny 为 MPL-2.0，未留在最终依赖中，未修改该许可证约束。采用 MIT 的 mp4-muxer 5.2.2 并锁版本/完整性；完整许可证随插件 public/THIRD_PARTY_NOTICES.txt 打包。该库已被上游废弃，不再接收新功能/修复，是明确的维护风险；通过小型 Mp4Writer 适配层隔离，后续替换需另行评审。依赖仅本地编码/封装，不引入在线服务或下载型编码器。

## 验证

City typecheck、film job/MP4 writer、locale、帧表面、迁移、插件架构及 `npm run verify:city` 通过。更新真实 Worker 编码/解码 fixture，要求 MP4 `ftyp` 签名和 `video/mp4`，测试导出期间按钮与实时引擎响应。

最终依赖版本 `--film-only` 通过：76 帧、76 次预览、320×180、76 秒、777,380 bytes，实际 MP4 解码成功，UI 响应检查通过。这是小尺寸 fixture，非原生 30 FPS 证据。先前 Mediabunny 候选的构建/fixture 仅为探索记录，不用于最终验收。

`cargo tauri build --bundles app` 最终成功，bundle 主程序 SHA-256 `78cd441115272543b2f7ade6454e015dedbc541bf11b9d27375dc1bb305b3473`。通过 `open .app --args --show-workbench` 冷启动，不运行裸二进制，也未替换 `/Applications`。

Computer Use：真实 264 个会话、1080p H.264 编码启动；4% 取消后按钮恢复，再次完整导出；设置打开/关闭可响应，Escape 不取消影片，英文设置明确显示 MP4 (H.264)，实际预览持续运动。原生 Save 显示 `.mp4` 文件名，保存完成后 Photo/Export video 均恢复。

实际文件 `/tmp/city-final-uat-20261004.P4lHF0/city-final-en.mp4`：65,884,658 bytes、H.264/avc1、1920×1080、1,451 帧、48.366667 秒；stts/stsz 时间表及样本数核验为 30 FPS，moov 位于 mdat 前（fast-start）。Chromium 对原生文件在 5、24、44 秒进行解码抽样，分辨率/时长一致，有非黑画面。QuickTime Player 正常打开并播放，17 秒截图显示城市建筑及英文城区字幕；不是仅核验文件后缀。未宣称完整逐帧画质验收。证据截图 `mp4-preview.png`、`mp4-quicktime.png` 同目录。

日志：`/tmp/city-mp4-final-{build,browser}-20261004.log`、`/tmp/city-mp4-city-tests-20261004.log`、`/tmp/city-mp4-native-decode-20261004.log`。黑闪任务仍排除，未自动提交、推送或合并；以前的 WebM 成片不是 MP4 验收证据。

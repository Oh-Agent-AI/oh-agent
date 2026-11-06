# C2 native平台可行性子批次

2026-10-03；codex/app-layer-city；macOS26.5.2（25F84）、本机clang。
程序是Cocoa synthetic probe，不是Agent City或Tauri。
实际build→codesign --verify --strict→LaunchServices/open→OS访问结果。
所有文件与服务由测试生成；不读取authority、宿主日志、credential或canary。
TCP仅127.0.0.1，未连接外网，也没有notarization/timestamp上传。

| 签名/配置 | Unix socket | 合成禁读文件 | 本机TCP | 私有写入 |
| --- | --- | --- | --- | --- |
| ad-hoc；默认沙箱 | EPERM | EPERM | EPERM | 成功 |
| ad-hoc；socket目录文件例外 | EPERM | EPERM | EPERM | 成功 |
| ad-hoc；文件例外+network.client危险对照 | EPERM | EPERM | 成功 | 成功 |
| DeveloperID；socket目录文件例外 | EPERM | EPERM | EPERM | 成功 |
| DeveloperID；专用AppGroup容器，无network.client/文件例外 | 成功 | EPERM | EPERM | 成功 |

成功case从signed app通过NSFileManager解析group容器；宿主模拟器在其中创建
0700临时子目录/0600 socket。内核peer PID存在、UID与父测试进程匹配。
不从客户端自报PID授信；但本轮没有动态code signature验证或launch PID绑定，
所以也没有生产握手、数据授权或假冒进程拒绝证据。

修复：group路径较长导致sun_path104字节超限，缩短子目录/文件名后复验成功；
ad-hoc与DeveloperID复用同bundle id可能等待容器授权，改为不同kind id。
首次超时后用ps确认探针仍存活，精确停止该fixture PID；未停止任何用户应用。
harness为两类launch超时补精确fixture进程清理。测试临时bundle/socket均清理，
macOS可能保留空的fixture app/group容器与LaunchServices记录，未编辑系统注册表。

重现命令在tools/app-layer-spike/README.md。本机正式签名仅作为native sandbox
实验条件；探针未经notarization，也不是两个正式City发布包。不要将实验签名
身份或group配置自动写入宿主生产信任根。专用测试group没有任何宿主数据。

独立subAgent实际执行严格AppGroup命令，确认Unix成功、无network.client/
filesystem例外、file/TCP EPERM和私有写入成功，限定验收通过。
普通目录失败只证明这些已测试配置，不证明所有Unix目录均不可用；
本机TCP拒绝不是实际外网测试，也不代表Tauri/WebView子进程均受相同限制。

下一步：audit-token动态签名、实际启动实例绑定、同UID假冒拒绝；
NSSavePanel选择导出、Tauri/WebView子进程entitlements/CSP、
生产AppGroup授权/profile、平台notarization与C5逐次数据授权。
这些仍未完成，G07/C2/M0均不标记整体完成。

依据：[Apple App Groups](https://developer.apple.com/documentation/BundleResources/Entitlements/com.apple.security.application-groups)、
[group授权](https://developer.apple.com/documentation/xcode/accessing-app-group-containers)。

## 运行身份原型补验（2026-10-03）

上述首轮缺口中的native身份验证现已补验（不改写首轮历史证据）：
launch.m调用NSWorkspace openApplicationAtURL，返回确切新实例，
禁running application substitution，不注入argv或额外环境变量。
记录PID及PROC_PIDTBSDINFO出生秒/微秒；失败或已终止则不授权。

peer_check.m直接在继承的accepted descriptor上取LOCAL_PEERTOKEN，
用kSecGuestAttributeAudit识别动态guest。校验DeveloperID/team/bundle，
sealed resources、运行CDHash和精确sandbox profile，前后核对process birth。
host启动前固定CDHash于内存；不是握手时重新采信路径上的任意新版本。
内核audit token不写磁盘，也不由客户端提供。正常probe读取许可ack失败即退出。

实际命令：README的--verify-peer+配置signer+专用group。独立subAgent复跑结果：

| 场景 | 结果/reason |
| --- | --- |
| 正确LaunchServices实例+固定signed revision | allowed/verified |
| 错误PID | launch_instance_mismatch |
| birth标识变化 | launch_incarnation_mismatch |
| 同publisher重新签名但CFVersion变化 | expected_revision_mismatch |
| sealed fixture.json被篡改 | invalid_expected_signature |
| 同UID伪装app id/PID | launch_instance_mismatch |
| PID/birth符合该客户端，但其签名不符合City requirement | dynamic_signature_mismatch |

最后一例使用Python客户端的真实kernel birth，确保拒绝发生在签名层，
不是birth层的假阳性。所有negative的allowed均false。
Unix成功、无network.client/路径例外、file/TCP EPERM和private write继续通过。
没有真实数据、连接credential或notarization上传；临时artifact和探针进程已清理。

这些证据仍不等于生产身份授权：hash须来自C1已验证安装release，
catalog root、台账、撤权和每次交付检查尚未接线。客户端对宿主的身份验证、
导出选择器、Tauri/WebView子进程与正式发布仍需后续验证，C2/M0不整体完成。

API依据：[audit guest attribute](https://developer.apple.com/documentation/security/ksecguestattributeaudit)、
[NSWorkspace launch](https://developer.apple.com/documentation/appkit/nsworkspace/openapplication(at:configuration:completionhandler:))，
process birth来自当前macOS SDK公开libproc/PROC_PIDTBSDINFO。

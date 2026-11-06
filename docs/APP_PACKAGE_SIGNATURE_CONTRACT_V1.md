# C1 应用分发与签名契约草案

2026-10-03，范围为官方Agent City首期macOS。与data catalog v1完全分离。
本轮是schema与纯校验参考实现，不是可执行应用安装器；无正式信任根被加入宿主。

## 分发文件与签名

app-manifest-v1定义唯一包身份、精确平台、bundle/team、兼容范围、权限、状态、
逐文件hash/size/mode/许可和显示资源。首期发布版本采用无prerelease/build的
三段SemVer；每段最多9位。host兼容范围为[min,max_exclusive)。

app-release-v1 envelope包含manifest、manifest canonical SHA-256、archive的
原始字节SHA-256/精确大小/不可变URL和release_sequence。
app-index-v1 envelope覆盖完整release envelopes、source_id、catalog_sequence、
trust_sequence、发布时间和过期时间。权限摘要直接取签名manifest.permissions，
不维护第二份可矛盾的摘要。目录可包含不适配本机的版本；安装和启动再检查兼容性。

每个envelope固定payload与signature{algorithm,key_id,value}，算法Ed25519，
signature为64字节无padding的canonical base64url。待签名消息为UTF-8：

~~~text
agent-vitals/app-{index|release|trust}/v1 + NUL
  + JCS({algorithm: signature.algorithm, key_id: signature.key_id, payload})
~~~

key_id和algorithm包含在签名内；三种域不能互换。算法不接收用户自由选择。
canonical采用[RFC8785](https://www.rfc-editor.org/rfc/rfc8785)的安全整数子集：
UTF-16键排序、字符串保持原样、无空白，不做Unicode归一化；
拒绝重复JSON键、孤立surrogate、浮点数、不安全整数、负零和非UTF-8。
数字token只允许整数词法，不接受小数或指数写法，即使其数值舍入后为整数。
原始JSON解析先拒绝重复键，不可先JSON.parse后验签；最大深度64。
参考验签使用[Node标准crypto](https://nodejs.org/api/crypto.html)，
后续Rust必须对同一消息字节互验，不自行发明另一种canonical约定。

## 信任、轮换与高水位

app-trust-v1由宿主已信任的离线root验签，包含source_id、trust_sequence、
冻结download_prefix、签名key的publisher/team/用途/序号生效范围与revoked、
revoked_archive_sha256。自报publisher不授信；release的publisher/team必须
与root认证的key策略匹配。Ed25519发布签名不替代macOS代码签名/notarization。

轮换通过同root认证的新trust policy追加新key；保留旧key并可吊销。
既有key不得被同id换公钥、publisher/team，不得撤回吊销或删除历史key；
已吊销archive也不能从策略消失。根轮换不属于此格式的自动能力，需宿主可信更新。
目录不自行引入公钥，unknown/revoked key拒绝。
trust更新同序号同digest幂等，同序号不同digest或更低序号拒绝。

目录签名、所有entry及语义通过后才返回新高水位(source_id,sequence,digest)，
调用方须事务持久化；失败不修改输入状态。目录同序号分叉或旧目录重放拒绝。
catalog_sequence和app版本是不同状态：显式回滚使用已安装的verified release，
重新执行当前吊销/兼容检查，不降低目录高水位。离线按最后有效本地trust执法，
不能声称离线能获取新吊销。expired目录不能作为新远端更新依据，
但不使现有已验证离线对象自动失效。

## 包、路径与限额

归档只包含AgentCity.app下manifest.resources声明的regular文件，
入口固定AgentCity.app/Contents/MacOS/agent-city。每个文件都绑定path、
字节hash/size和file/executable mode。首期ASCII路径，拒绝空组件、绝对路径、
点段、反斜杠、大小写碰撞；许可notice/icon路径必须精确匹配声明文件。
regular文件不能同时成为另一文件的祖先目录（大小写等价也拒绝）。
首期zip剖面拒绝所有symlink/hardlink/special文件，不跟随链接；
若实际bundle需要links，须C2证明并独立评审安全剖面，不能默认放行。

release envelope作为归档外sidecar包含manifest，避免manifest对自身hash循环。
包内没有未签名控制文件例外；未列文件、缺文件、替换内容/size/mode都拒绝。
zip目录项由C7安全解包器检查，不计regular文件数；其路径同样须安全。
当前verifyFileRecords只校验提供的记录，不能证明真实文件已读取或解包安全。
C7必须从实际流式bytes/lstat推导记录，并验证archive原始bytes hash和size。

来源固定为root认证的HTTPS prefix；包名为{archive_sha256}.zip，
禁止用户信息、query/fragment、percent编码路径、URL归一化差异和其他来源。
下载器C7须禁止重定向并以实际读取字节计限额，不依赖header自报大小。

限额：index/control 4MiB，归档256MiB，展开1GiB，20000 regular文件，
已安装对象2GiB（含active、上一回滚版及本轮对象）。staging余量至少
archive+expanded+control+64MiB；不得为了通过预算自动回收承诺可回滚对象。
本轮installationBudget是纯预检；真实磁盘、事务和并发预算仍需C7/C10。

## 目录冻结与测试边界

宿主HomeResolver提供私有根，不硬编码用户home：

- apps/staging/{operation_id}/：同文件系统临时归档/展开，仅宿主拥有。
- apps/objects/{archive_sha256}/：不可变bundle和release sidecar，绝不复用data对象库。
- apps/state/{app_id}/{installation_id}/：宿主管理的状态恢复快照，非authority。
- apps/trust/、apps/catalog/：非秘密策略与已验证缓存/高水位。

City自己的seed/偏好存OS解析的应用sandbox私有容器；此容器与宿主恢复快照不同。
broker socket位置/沙箱IPC例外及导出文件许可留C2实测冻结。
生产根key、team id、官方HTTPS前缀尚未配置；所有测试key在内存临时生成，
example.invalid仅是fixture来源，无实际下载。默认开发入口不能获得真实数据。

验收执行packages/agent-vitals-app-sdk的npm run verify:contracts，
含签名/域混淆/吊销/重放/分叉/非法JSON/路径/权限/预算和data v1隔离正负例。
C1尚缺Rust互验、实际发布key/渠道冻结；C2/C7/C11的OS签名、真实包、
notarization、流式解包和原子安装不能由本轮合成测试替代。

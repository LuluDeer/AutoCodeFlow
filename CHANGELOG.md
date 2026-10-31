# Changelog

## [2.1.0](https://github.com/LuluDeer/AutoCodeFlow/compare/v2.0.0...v2.1.0) (2026-10-31)


### Features

* **deploy:** --project / --overlay——修「部署报成功但线上没变」 ([3159ad8](https://github.com/LuluDeer/AutoCodeFlow/commit/3159ad868244bf2a8c2727e31bd3490c859dd57d))
* **deploy:** --project / --overlay——修「部署报成功但线上没变」 ([5d303e7](https://github.com/LuluDeer/AutoCodeFlow/commit/5d303e7fd625b942e182c08606543df7d28ced66))
* **deploy:** --project / --overlay——修「部署报成功但线上没变」 ([07ea00e](https://github.com/LuluDeer/AutoCodeFlow/commit/07ea00ef5ad34e9634c17e792a72232e9250df3e))


### Bug Fixes

* **deploy:** $name 紧跟全角括号 → ${name}（macOS bash 3.2 会当场中止） ([fb462bc](https://github.com/LuluDeer/AutoCodeFlow/commit/fb462bc03bc0d46063f218d2df54e5ca1c717084))
* **executor:** 包下载同源改写 + 连接期重试，pull 长轮询语义修复，补单机部署方案 ([a505f39](https://github.com/LuluDeer/AutoCodeFlow/commit/a505f39dd1164062963eed22ddddd8ab9c1d2178))
* **executor:** 包缓存可观测性 + 5 处真实缺陷修复 ([4a74b0f](https://github.com/LuluDeer/AutoCodeFlow/commit/4a74b0f05b76473035057b19276bae09d43a0f4a))
* **executor:** 包缓存可观测性 + 5 处真实缺陷修复 ([#137](https://github.com/LuluDeer/AutoCodeFlow/issues/137)) ([4e3a07a](https://github.com/LuluDeer/AutoCodeFlow/commit/4e3a07a208d0e2aa564f652398c7d4a5a1741819))
* **frp:** loginFailExit=false —— frps 重启不再打死客户端 ([8a58516](https://github.com/LuluDeer/AutoCodeFlow/commit/8a5851620a52a7b6ebea1fc37af949a4fc29789d))
* **guards:** 补齐三条守卫缺口（image-pinned / 测试数字 / shell 多字节变量） ([1998cfe](https://github.com/LuluDeer/AutoCodeFlow/commit/1998cfe327308e22667ad2dab8b9728d84ed731e))

## [2.0.0](https://github.com/LuluDeer/AutoCodeFlow/compare/v1.15.0...v2.0.0) (2026-10-29)


### ⚠ BREAKING CHANGES

* **security:** 产物上传默认拒绝共享令牌（403 ARTIFACT_UPLOAD_REQUIRES_EXECUTOR_TOKEN）， artifact 下载默认拒绝 ?token= 查询串（401）。存量部署若仍在用共享令牌上传产物或 query 传参， 必须改用 per-executor 令牌 / Authorization 头，或临时打开兼容开关 （EXECUTOR_ARTIFACT_ALLOW_SHARED_TOKEN / EXECUTOR_ARTIFACT_QUERY_TOKEN_COMPAT）。 迁移与判定步骤见 docs/UPGRADING.md。

### Features

* **admin-api:** AI 接入从「一个全局 provider + 每厂商一套分支」换成「注册表 + 按用途路由」+ 视频转 SOP 后端闭环 ([d358ddb](https://github.com/LuluDeer/AutoCodeFlow/commit/d358ddb129ee6eced8b3d8e3d2c6bc24cb091af4))
* **agent:** 会话发起人落库 + 审批四眼原则开关（G4，OSS 对照审计） ([3b0cd7b](https://github.com/LuluDeer/AutoCodeFlow/commit/3b0cd7b879a67eaba16a0b6937a8866eff3c0398))
* **desktop:** 三页 V5 改版（配置工作台 / 应用台账 / 历史执行台账）+ 量化巡检工具 ([201e592](https://github.com/LuluDeer/AutoCodeFlow/commit/201e592a865a9f4a027b77b7d8651765db6eca74))
* **docs:** DOC-GUARD——文档指标名 ↔ 运行时注册表双向比对守卫（并行工作区实现，主会话复核后收编） ([327de91](https://github.com/LuluDeer/AutoCodeFlow/commit/327de919fbdd2e1f533faa15a456c8d2cdb68a39))
* **security:** 产物上传要求 per-executor 令牌 + artifact 下载下线 ?token=（SEC-1 / SEC-2） ([0389e0c](https://github.com/LuluDeer/AutoCodeFlow/commit/0389e0c0e0eff2b3e2699c8969c73b5976c9d93b))
* **storage:** S3 日志存储服务端 MinIO → RustFS（Apache-2.0，真实 put/get 已跑通） ([14cf740](https://github.com/LuluDeer/AutoCodeFlow/commit/14cf74099041bf3d046870a44cd27ebfa457ba14))


### Bug Fixes

* **acf-cli:** 受理≠成功 / --json 错误行落盘 / --json 判定被参数值翻转（P2+P3×2） ([7e06d82](https://github.com/LuluDeer/AutoCodeFlow/commit/7e06d820b0bc6defbee6cffe50761c4c5af4c8ed))
* **acf-cli:** 把「待审批」当部署成功、`--wait-timeout 1m` 被吞成 1 秒 ([737e200](https://github.com/LuluDeer/AutoCodeFlow/commit/737e200c40ff7adfbe9ace85c6a2afc7d3f3f19c))
* **admin-api:** @Cron 方法体补顶层异常闸 + 机械守卫（rt-5，审计 P1 上调项） ([05904b9](https://github.com/LuluDeer/AutoCodeFlow/commit/05904b9a97b622a19b98e8cf6db35084f32f5f57))
* **admin-api:** 审计轮 [#7](https://github.com/LuluDeer/AutoCodeFlow/issues/7)/[#11](https://github.com/LuluDeer/AutoCodeFlow/issues/11) 后端收口（per-IP 硬顶 / Agent 审批如实降级 / 列级 CAS） ([63bc11c](https://github.com/LuluDeer/AutoCodeFlow/commit/63bc11c0dbdae039bf39a2aa2382f5d6705346ee))
* **deps:** 修掉两条今天新披露且可修的 moderate CVE + 顺带修出 instance-id 的环境依赖 bug ([3652dea](https://github.com/LuluDeer/AutoCodeFlow/commit/3652dea6761b4b2961dddeebcfc585d7e538e211))
* **executor:** /execute 单一模型 + params 折叠冲突两端拒绝 + env 转发协议清单（EXEC-01/05/07） ([c59741f](https://github.com/LuluDeer/AutoCodeFlow/commit/c59741faef603a4eb152a63fa907d41b400b67f9))
* **mcp:** 写工具少声明的字段会静默丢弃——补 9 个字段 + 空 patch 拒绝 ([06bc8ca](https://github.com/LuluDeer/AutoCodeFlow/commit/06bc8ca77f070bac372b89bf96c7c9599aa2be5b))
* **mcp:** 写面拒绝「脱敏哨兵回传」——读-改-写会把 [redacted] 当真实值存下去 ([4cc9e25](https://github.com/LuluDeer/AutoCodeFlow/commit/4cc9e25523bba2fea8bc8f4762e202a6ad2aea4b))
* **mcp:** 目标执行器被静默替换时必须在响应里说出来（F4） ([6b84e2e](https://github.com/LuluDeer/AutoCodeFlow/commit/6b84e2edd97266b1a6299910d028bef998fb39cf))
* **release:** 包级 CHANGELOG 改「版本可校验的指针 stub」（SDK-DX-05） ([1fc494d](https://github.com/LuluDeer/AutoCodeFlow/commit/1fc494d5241e693f8b8adcb6cc03f02996f63a30))
* **sdk-py:** get_param 改为大小写不敏感——与 node ctx.getParam() 对齐（SDK-DX-09） ([b6bb7d2](https://github.com/LuluDeer/AutoCodeFlow/commit/b6bb7d21797b5cf6af973e3affee145254b9ea9c))
* **sdk:** 可靠性层三态归一 + 对外文档回到代码事实（SDK-DX-01/02/03/06/07/08） ([3004fa8](https://github.com/LuluDeer/AutoCodeFlow/commit/3004fa8f898f1366f0fef73fe5ee50cba1c4ffbc))
* **sdk:** 环形日志溢出改为「就地可见」的 stderr 告警；文档不再声称返回值会自动上报（SDK-DX-04） ([a32270a](https://github.com/LuluDeer/AutoCodeFlow/commit/a32270a5f0a6447acdc9c5b5da83ab4ed6e960b3))
* **tooling:** 本地开发入口三处假成功 + turbo 缓存键缺 7 个变量（P2×2 + P3） ([feb34ff](https://github.com/LuluDeer/AutoCodeFlow/commit/feb34ff90b17bdebae4c59d3b519e49c0f4fc3af))

## [1.15.0](https://github.com/LuluDeer/AutoCodeFlow/compare/v1.14.0...v1.15.0) (2026-10-26)


### Features

* **admin:** 中台九轮巡检收口——API Key 生命周期、SOP 归档、批量清理与失败归因 ([92a93f8](https://github.com/LuluDeer/AutoCodeFlow/commit/92a93f8c9dc8435a3d8f0c1cc81ab048cb03819a))
* **cli:** app releases 消费 truncated/retainedButTruncated——截断事实不再对 CLI 用户隐身 ([02a187a](https://github.com/LuluDeer/AutoCodeFlow/commit/02a187a90da35fc21ab40d082fddb9f03b37c06a))
* **deployment:** R1 回滚拆分双动作 + R5a 应用包内容寻址存储 ([182e9e7](https://github.com/LuluDeer/AutoCodeFlow/commit/182e9e7dd8e0e1750e5500c4ee6923d20abba914))
* **deployment:** R2 upgrade-all 覆盖面显式化——coverage 分组回显 + skipped 明细 + includeStopped opt-in ([2bddc70](https://github.com/LuluDeer/AutoCodeFlow/commit/2bddc7084816a8ee2d2009a29f9352f99f63d72a))
* **executor:** 5c releases 目录两段化——releases/&lt;version&gt;/&lt;deploymentId&gt;/（§9.7 设计稿实施） ([ec2184e](https://github.com/LuluDeer/AutoCodeFlow/commit/ec2184ec6d5fb9def781ccae9ae5e374fadbc14f))
* **executor:** P1 修复——私有 PyPI 凭据通道（netrc 子进程注入，E2E 实证 401 修复） ([4624e4e](https://github.com/LuluDeer/AutoCodeFlow/commit/4624e4e04342ae782cad2f34e74599239b0af1b2))
* **mcp:** update_task 参数面对齐 UpdateTaskDto——15 新字段 + 2 修复 ([a953e80](https://github.com/LuluDeer/AutoCodeFlow/commit/a953e807e87a2b9a9a10145631daf98b172575d1))


### Bug Fixes

* **acf-cli:** R108 覆盖闸补录 EXECUTOR_COMMAND_RESULT_NOT_OWNED——bf102733 新码(403,command-result meta 跨行回报归属绑定)未同步 CLI 基线的跨包疏漏；按同语义先例 SOP_ASSIGNMENT_NOT_OWNED_BY_EXECUTOR 入领域状态类基段(6 类规则给不出 CLI 处置建议，permission 规则只认 _NOT_OWNER/NO_OWNER)；410/410 ([a6b972a](https://github.com/LuluDeer/AutoCodeFlow/commit/a6b972a1dd03bda37fcec9f6c272fc36459965e3))
* **ci:** check-migrations 第二轮四条守卫收口——env 漂移/裸异常/ADR-026 豁免窗口/恒定时间标记位置 ([ea9dcec](https://github.com/LuluDeer/AutoCodeFlow/commit/ea9dcec19e97dd3514f8c52c381c3d5834e98caf))
* **ci:** R4/R5 提交引入的两处 CI 红收口——根 lock puppeteer 污染清除 + 漏改 spec 的 DataSource 替身 ([f8943ee](https://github.com/LuluDeer/AutoCodeFlow/commit/f8943eea56ec04d384578caf5ed6cb7570d3b0d1))
* **ci:** 二轮红灯——响应 schema 缺口、ip-address ReDoS、多义测试匹配 ([ef5a50f](https://github.com/LuluDeer/AutoCodeFlow/commit/ef5a50fc567fccd44e215067635ed17cd2e73cf0))
* **ci:** 修首推 CI 三处红灯——动态 i18n 键、CLI 错误码归类、测试隔离 ([7e747b0](https://github.com/LuluDeer/AutoCodeFlow/commit/7e747b01ba1149d7708df8aad22ecb7554ad496f))
* **config:** 执行器 shared token 读端点与校验同序（DB 优先 env 兜底）——env 形态部署下向导此前谎报「尚未配置」并诱导写入 DB token 触发全体执行器 401（demo 实测踩中）；install-cmd 503 按错误码分流文案（配置缺失≠服务故障）；demo 栈补 ADMIN_API_URL 且种子不落 DB token；补 3 个既有 spec 的 NestConfigService provider（DI 缺失回归拦截至本轮门禁） ([edc778b](https://github.com/LuluDeer/AutoCodeFlow/commit/edc778b403474f375bb4a27c005ad3710549cb99))
* **deps:** 安全审计轮——5 条新 GHSA 清偿（multer high / body-parser high / fast-uri×4 / nodemailer×3） ([ba5adfc](https://github.com/LuluDeer/AutoCodeFlow/commit/ba5adfc2e9a588b70878a54c70ada720092aeba8))
* **executor-node,sdk:** 日志脱敏三漏网收敛 + SDK 文档漂移两处 ([9c9710e](https://github.com/LuluDeer/AutoCodeFlow/commit/9c9710e4b8eea272ba3a566aba89fbe2ca0f0066))
* **executor,application:** 部署死锁链三层收口——①注册 409 自愈：容器化执行器重建后指纹盐落容器层+MAC 随机致身份漂移，按地址找回旧行却 foreignInstall 恒 409、token 双路全 409、心跳恒 401、部署行永久在途且 stop/删/删应用三面全堵（真机实证 789 次重试）；push 占位行满足 canTakeOverAbandonedAddressRow 三前置（OFFLINE 判死/push 模式/静默超 5min 窗，fail-closed）即接管重签令牌，否则维持 409 ②deploying 超时兜底：既有 detectStuckDeployments sweep 补 DEPLOYMENT_STALL_TIMEOUT_MS=30min（updatedAt=最后心跳续命防误杀慢网络大包）+PENDING 5min+中文判败文案 ③出口链 spec 钉死 sweep 判败→stop→remove 全链放行；SOP 写审计 8 端点补 username 透传（此前操作人显示「系统」且按用户筛不到）；push 链 statusMessage 三处英文直出改可读中文；compose admin-api 挂 admin_uploads 卷（上传包存容器层重建即悬空）；受影响模块 1707+全量 6049 用例绿 ([3ad32be](https://github.com/LuluDeer/AutoCodeFlow/commit/3ad32be928876223769d01e4b849cbc94f2dc637))
* **packages:** 共享包层审计 8 项收口——acf-cli 错误码覆盖活红修复（CORS_ORIGIN_NOT_ALLOWED/EXECUTOR_PACKAGE_STORAGE_PATH_ESCAPED 按 catalog 语义入基线，6 类规则会给误导建议；vitest 410/410）/autocodeflow-http 文档-实现漂移改 parity 地图（四端对齐虚假声称→本包↔node-sdk 两端+互指注释）/熔断 open 类型化 CircuitBreakerOpenError（对齐 node-sdk）/响应体 50MB cap 双包同构（流式双闸+构造参数出口+ResponseTooLargeError）/退避加性均匀 jitter（封顶防短退避被抖动支配）/ProtocolError 保持熔断不重试评估钉死（瞬时形态已被 5xx/429/网络/超时三路覆盖，落到协议错=确定性缺陷）/AI prompt XML 定界+同名闭合标签中和防逃逸（token 预算不变）/db statement_timeout 30s 可配置（PG 方言变体覆盖，短生命周期进程堵死面防护）/mcp-server·node-sdk /api 归一方向互指注释；各包套件 55/178/67/30/302/142/410 全绿 ([59b5ebe](https://github.com/LuluDeer/AutoCodeFlow/commit/59b5ebe49262275af5addda0957094dd52d8c75a))
* **registry-npm:** npm 私服审计收口——N-1 执行器私包安装 401 根治（compose 漏注凭据为与 PyPI netrc 完全对称的缺口；实测否定 token 路线——Bearer base64 被 5.31.1 拒、JWT 60d 静默断裂且存量用户不可重签，改 NPM_REGISTRY_USER/PASS Basic 通道回落 REGISTRY_USER/PASS，executor-node .npmrc 生成 _auth 行 token 优先兜底互斥，--ignore-scripts 闸扩为任一凭据；容器内真客户端探针 401→404 实证）/N-3 max_users:-1 关自助注册+摘 autoflow-public 网络（调用方逐一核对全在 internal）/N-4 npm 代理读面失败路径审计（成功高频低信号不落，recordRegistryReadAudit 与上传同形态，audit 失败不抬 502）/N-5 启动前 umask 077+chmod 600（read_only 容器卷内可行实证）/N-6+N-2 README 矩阵补齐+已知豁免节（search 200/401 回显 oracle 逐条接受理由）/N-8 新增 demo smoke 只读探针 6 项/N-9 verdaccio pin 从 compose 解析防漂移/N-7 空目录清理；registry 37/37+executor-node 170 用例+bug18 42 断言+smoke 6/6 全绿 ([f7078f4](https://github.com/LuluDeer/AutoCodeFlow/commit/f7078f4bbce7cef7dccd92b2f95191989d33bfff))
* **registry-pypi:** 独立审计 13 项收口——P1-1 预认证无界请求体缓冲（FastAPI 依赖解析前 await request.form() 完整消费 body，Starlette 对 file part 无上限，chunked 绕过 Content-Length 预检，50MB 闸只护 /data 不护网络侧，匿名可顶爆 16G tmpfs；中间件层上传路由拒 chunked 411+超限前置 413；连带根治 admin-api 代理 form-data 默认 chunked——显式 content-length 字节级探针验证含非 ASCII filename；tmpfs size=1g 兜底；流式根治评估登记）/P2 删除·下载链审计补全（registry.pypi.delete/download，404 不落防噪声）/P2 Basic 防爆破（对端 IP 键连续 5 次后 2^n 封顶 300s+TTL 清扫+成功清零，429+Retry-After）/P2 sidecar 先写后 link+失败回滚制品（500 必然未发布，孤儿 os.replace 矫正）/P3 启动+节流清扫 .upload 残留/竞态 500 收口（rmtree 幂等 404、stat OSError 跳行）/health 可写性探针 503 真实化/审计字段统一截断+归一化名/name·version 128·64 字节闸/ASCII 凭据启动闸/--no-access-log 保审计留存/wheel dist 段不一致 warning 审计；pytest 198(156+42)+registry 37/37 全绿 ([f2ca70d](https://github.com/LuluDeer/AutoCodeFlow/commit/f2ca70d8d4a97d3680e45dd5259ec5ee82e959de))
* **registry:** 包注册中心在 Docker 部署下必然 502——注入缺失 + Verdaccio 登录死循环 ([f8806be](https://github.com/LuluDeer/AutoCodeFlow/commit/f8806be253c441820e7567421011fdfa47ff5a2b))

## [1.14.0](https://github.com/LuluDeer/AutoCodeFlow/compare/v1.13.0...v1.14.0) (2026-10-22)


### Features

* **devx:** 激活 demo、真实模型桌面 Agent 与截图多模态诊断 ([4c32264](https://github.com/LuluDeer/AutoCodeFlow/commit/4c322643a75ff375848e96c3717dfa79bfc63bfd))


### Bug Fixes

* **deps:** py-libs 三包 certifi 升到 2026.10.19（清 3 条 critical）+ uv.lock 漂移校正 ([a091617](https://github.com/LuluDeer/AutoCodeFlow/commit/a091617c293233e3be8e6d8421c81dc58503db88))
* **deps:** py-libs 四包 certifi 升到 2026.10.19，并修掉 uv.lock 的 editable 版本漂移 ([bbf3ad0](https://github.com/LuluDeer/AutoCodeFlow/commit/bbf3ad0d82fd8db6bc53e0fdbc301bb4cb9cae41))
* **deps:** 清偿可修复的 Dependabot 告警 ([f17307e](https://github.com/LuluDeer/AutoCodeFlow/commit/f17307eb7cc6fbcef57dc2a7743b4f789af719ea))
* **executor:** 地址告警误报 + 部署下发失败（生产报告 2026-10-22 全量修复） ([8ec47e8](https://github.com/LuluDeer/AutoCodeFlow/commit/8ec47e89d2c039db464669973d5d801d79e07ccc))
* **install,compose:** 执行器地址采集加固 + compose 对外地址必填 ([2da0573](https://github.com/LuluDeer/AutoCodeFlow/commit/2da05734156a4e76cead219fd720c602ea50c74d))

## [1.13.0](https://github.com/LuluDeer/AutoCodeFlow/compare/v1.12.1...v1.13.0) (2026-10-21)


### ⚠ BREAKING CHANGES

* **desktop:** remove V2 renderer and restore V1 (1.9.2)
* **desktop:** ship V2 renderer as the default UI (2.0.0)

### Features

* **adr-026:** 守卫新增 `--report-saves` —— 盲区①的可见化（60 处候选） ([0bb940b](https://github.com/LuluDeer/AutoCodeFlow/commit/0bb940b6b545208ce27d671e1f453799c1545169))
* **ci:** ADR-026 静态守卫——无条件状态写「只减不增」棘轮 ([4bb9959](https://github.com/LuluDeer/AutoCodeFlow/commit/4bb99599142a1327fcd14d8ab6e50dd209027951))
* **ci:** 新增错误码化回退守卫 —— admin-api 裸内置异常 throw 恒为 0 ([500c8bc](https://github.com/LuluDeer/AutoCodeFlow/commit/500c8bcc03076e8f93c68b617d1aba06df06a9c3))
* **desktop:** ship V2 renderer as the default UI (2.0.0) ([43ec4b2](https://github.com/LuluDeer/AutoCodeFlow/commit/43ec4b23447d53922118255b94dc49ce390c3cb9))
* **errors:** 三端透出 admin-api errorCode/params（python http / python sdk / MCP） ([e6513f9](https://github.com/LuluDeer/AutoCodeFlow/commit/e6513f95b88cce5bc7b1f48f6d9839bc347199c8))
* **executor-desktop:** 多尺寸 UX 打磨与视觉巡检脚本 ([5ec4a88](https://github.com/LuluDeer/AutoCodeFlow/commit/5ec4a8814a6b48b4deceba95488bbaadf78389b7))
* **sdk,cli:** 透传 admin-api 稳定错误码并按 6 类给处置提示 ([1382253](https://github.com/LuluDeer/AutoCodeFlow/commit/138225378550e4e4ecc84b649edea7784d9ee8b0))


### Bug Fixes

* **cli:** 破坏性动作的确认门补全 + 本地数值参数不再静默兜底（R192-A1） ([8ad61fd](https://github.com/LuluDeer/AutoCodeFlow/commit/8ad61fdcfbddca1ad06bb15be0bd25968dae6109))
* **deps:** bump follow-redirects to 1.16.1 and uv to 0.13.4 ([758f35b](https://github.com/LuluDeer/AutoCodeFlow/commit/758f35b960e75044ab9aa82919f9496be401c8da))
* **deps:** mcp-server 锁文件升级 hono 4.13.7 -&gt; 4.13.13（修 GHSA-5r4p-p66f-jhc7） ([d31a0d4](https://github.com/LuluDeer/AutoCodeFlow/commit/d31a0d4872832a141dd4ceceb8642d92403ec910))
* **executor-desktop:** 主进程安全面审计——IPC sender 闸 + check-port 参数闸（R86-A1）+ 两个从未执行的 selftest 接线（R88） ([55ac29e](https://github.com/LuluDeer/AutoCodeFlow/commit/55ac29e7949a113d85e4eaca2f5cad2b725722b4))
* **mcp-server:** env 与 params 补**字节**口径上限——和 R111 的「码点」是两件事（R115） ([a8a9a02](https://github.com/LuluDeer/AutoCodeFlow/commit/a8a9a02f8696ca632255294dfbbe17b00a53adce))
* **mcp-server:** 入参字符串补长度上限，逐字段对齐后端 DTO（R111-A1） ([ba16215](https://github.com/LuluDeer/AutoCodeFlow/commit/ba16215e7efd603e945dfdc5ea5eb451e4f43f48))
* **mcp-server:** 工具出参加一层凭据剥除——上游干净，但只有一层（R110） ([fa5f8fa](https://github.com/LuluDeer/AutoCodeFlow/commit/fa5f8facd1e7e345fd0731cbd97c2b9ba16a8fa3))
* **mcp-server:** 形状漂移不再伪装成「全清」——list_dead_letters 补 isError（R114） ([5ccd81e](https://github.com/LuluDeer/AutoCodeFlow/commit/5ccd81ef29598bb62b503f9582c6dbc1c6da4173))
* **mcp-server:** 收紧 8 个枚举入参并为 params:{} 恢复「无覆盖」语义（R107-A1） ([58a551e](https://github.com/LuluDeer/AutoCodeFlow/commit/58a551e486f26a75be7b676249eef4d04bb9df07))
* **mcp-server:** 空载荷不再伪装成成功——get_execution / timeline 补 isError（R112） ([5c42f74](https://github.com/LuluDeer/AutoCodeFlow/commit/5c42f74e321559a84e4c8771a3c03abbf5bd03ba))
* **notification:** 出站面审计——未注册渠道静默丢告警、渠道开关失效、读面 ?key= 明文（R150-A1） ([ce67bc7](https://github.com/LuluDeer/AutoCodeFlow/commit/ce67bc7ededcfd5587a9c0fa29c15374ce1a84b5))
* **release:** atlas 的两处 lockstep 版本声明纳入 release-please 广播 ([fbdc812](https://github.com/LuluDeer/AutoCodeFlow/commit/fbdc8120c49db8acc0512c818341ab9f13fefd54))
* **release:** 把 atlas 的两处 lockstep 版本声明纳入 release-please 广播 ([53f0f22](https://github.com/LuluDeer/AutoCodeFlow/commit/53f0f222974cc93d10131ceba8239219ca19ea34))
* **sdk:** 对外 SDK 健壮性审计——错误面统一 / 尊重 Retry-After / 回调路径判定修正（R177-A1） ([103cff3](https://github.com/LuluDeer/AutoCodeFlow/commit/103cff341f0cfd8fc1cc902fae85e70d8d157996))
* **sdk:** 终态回调的单次重试等待封顶 5s——别让「为可靠性做的重试」把终态丢掉（R191） ([135f4b3](https://github.com/LuluDeer/AutoCodeFlow/commit/135f4b332838e632a76643870b2b183de80ed7fb))


### Reverts

* **desktop:** remove V2 renderer and restore V1 (1.9.2) ([7492dda](https://github.com/LuluDeer/AutoCodeFlow/commit/7492dda76ad51115a6a509a20a42019c64362572))


### Miscellaneous Chores

* **release:** 下一版按 minor 走（1.13.0），并校正 SDK README 的版本标注 ([175494e](https://github.com/LuluDeer/AutoCodeFlow/commit/175494efb361542c2fa2fd1ee738e11ce0af4032))

## [1.12.1](https://github.com/LuluDeer/AutoCodeFlow/compare/v1.12.0...v1.12.1) (2026-10-19)


### Bug Fixes

* **deps:** 一次性清偿 38 条 Dependabot 告警——27 条修复（js-yaml / tmp / dompurify / uuid / brace-expansion / glob / undici / vite / esbuild / anyio / pytest）+ 11 条登记豁免（extract-zip / http-cache-semantics / sprintf-js / stream-json，均为上游无修复版） ([d7e5f29](https://github.com/LuluDeer/AutoCodeFlow/commit/d7e5f292759a2b40ce8e2d1aef4f0fd172c8c203))
* **docs-site:** vitepress 1.6.4 → 2.0.0-alpha.20，vite 5 → 8.3.4，esbuild 告警归零 ([d7e5f29](https://github.com/LuluDeer/AutoCodeFlow/commit/d7e5f292759a2b40ce8e2d1aef4f0fd172c8c203))
* **desktop:** 修 history-watcher 真实 fs.watch 冒烟的测试竞态（macOS runner 偶发） ([494ff6a](https://github.com/LuluDeer/AutoCodeFlow/commit/494ff6a9))

### ⚠️ Breaking Changes

* **python-sdk:** `autoflow-sdk` 的 `requires-python` 由 `>=3.9` 收紧到 `>=3.10`。
  anyio 的修复版（4.14.2+）只支持 Python ≥3.10，而 3.9 分支解析到含 **critical** 漏洞
  且无修复版的 4.12.1。Python 3.9 用户需先升级解释器。

<!--
本节经人工校正（release-please 生成时把同一条修复按 develop commit / merge commit /
main merge 列了三次）。这是本仓已记录的已知偏差（见 1.11.0 / 1.10.1 小节注释与
.github/workflows/release-please.yml 的 v1.3.0 注记），根因是「非规范 merge 标题 +
develop 直推 commit」与 release-please 的遍历交互。此处按 1.11.0 的同一做法人工合并。
-->

## [1.12.0](https://github.com/LuluDeer/AutoCodeFlow/compare/v1.11.0...v1.12.0) (2026-10-18)


### Features

* **api:** 游标分页加性过渡 / 跨实例配置缓存失效 / 可观测性遗留清理 ([704f749](https://github.com/LuluDeer/AutoCodeFlow/commit/704f749e69f30ea52bee2f2ef174e7fd9679af66))
* **api:** 限流白名单守卫 / HTTP RED 指标 / 磁盘堆健康检查 / 备份恢复演练 ([6087b47](https://github.com/LuluDeer/AutoCodeFlow/commit/6087b47fed806411f78f1b8e9fc06b833680e355))
* 优化 CI 流水线并升级 README ([95fa789](https://github.com/LuluDeer/AutoCodeFlow/commit/95fa7892a6d5bdf5f00a95a7ede9632c6c3f91a8))
* 优化 CI 流水线并升级 README ([2060b7d](https://github.com/LuluDeer/AutoCodeFlow/commit/2060b7dff7f747630ba3d174d7073bd0ec3e6b33))


### Bug Fixes

* 修复审计报告的 7 项 P1 高危缺陷 ([f3e340d](https://github.com/LuluDeer/AutoCodeFlow/commit/f3e340df29c463ff82c99a620b0f8fe8555eef18))
* 修复审计报告的 P2/P3 缺陷（SDK 连接池、调度器异常、跨连接死锁、部署与脚本） ([5ce4356](https://github.com/LuluDeer/AutoCodeFlow/commit/5ce4356cec56a84bbd767f3e33b2d751e9193379))
* 修复测试隔离缺陷与自检脚本腐烂（三项真实缺陷） ([19aa9fb](https://github.com/LuluDeer/AutoCodeFlow/commit/19aa9fb46439d336a05dd6718fc3d53dafb1e48d))

## [1.11.0](https://github.com/LuluDeer/AutoCodeFlow/compare/v1.10.1...v1.11.0) (2026-10-16)


### Features

* **i18n,executor,admin:** 全量错误码化 + API 文档双语 + ADR-017 阶段 3 执行器行身份 ([4bfe376](https://github.com/LuluDeer/AutoCodeFlow/commit/4bfe376689ca9d938a41ba799434960dc44f512f))


### Bug Fixes

* **ci,i18n,e2e:** 修首轮 CI 的 6 个红——注入串联/守卫基线/产物摘要/playwright locale ([60659de](https://github.com/LuluDeer/AutoCodeFlow/commit/60659dedfbede1bbc6190e390a7daba250f731ed))
* **e2e,desktop:** 修二轮 CI 余下 2 红——e2e 断言随中文化与读面富化更新 + bundle 字节哈希回填 ([03c8cf4](https://github.com/LuluDeer/AutoCodeFlow/commit/03c8cf4ecc40aa66e3ceb836475c58a7699d65e1))
* **task,e2e:** 修三轮 CI 余下 2 红——pinned 离线被错报「脚本错误」+ e2e 状态级联 ([a3f719b](https://github.com/LuluDeer/AutoCodeFlow/commit/a3f719beec19dd13efbbc25468c25e900bec49b9))
* **task:** EXECUTOR_OFFLINE 判据收成单一事实源——pinned 离线被错报「脚本错误」的根因在第二份副本 ([9e55c12](https://github.com/LuluDeer/AutoCodeFlow/commit/9e55c1261a61f88cea09a7df57c866e740804ab5))

<!--
本节经人工校正（release-please 于 2026-10-16 生成时有两处偏差）：
1. **Features 重复**：同一条 feat 列了两次——596ac76（`Merge pull request #48`，
   取用了 PR 标题）与 4bfe376（该 PR 内的真实 commit）。已删去 merge 那条，
   保留真实 commit。
2. **Bug Fixes 漏三条**：原只列 60659de，漏了 03c8cf4 / a3f719b / 9e55c12——
   三条均属 `git log v1.10.1..v1.11.0` 范围内的真实修复。

⚠️ 该偏差**并非本轮特有**：v1.10.1 小节同样重复（8cbb22f 与 2b4a52f 为同一条
A-11R 消息）。根因是「非规范 merge 标题 + develop 直推 commit」与 release-please
的 PR 关联/遍历交互——`.github/workflows/release-please.yml` 的 v1.3.0 注记
「非规范 merge 标题触发 conventional 解析错误吞掉 feat 遍历」已记录同类现象。
规避建议（任选其一）：
  · develop → main 改 **squash merge**，且 squash 标题写规范 conventional 文案；或
  · 合并 Release PR 前**人工核对**其 CHANGELOG 差异，必要时按本节方式校正。
-->

## [1.10.1](https://github.com/LuluDeer/AutoCodeFlow/compare/v1.10.0...v1.10.1) (2026-10-14)


### Bug Fixes

* **executor,admin,sdk:** A-11R——params 注入字符串回归裸值 + 类型化通道，修 12 天静默停摆 ([8cbb22f](https://github.com/LuluDeer/AutoCodeFlow/commit/8cbb22f6fae64b582025e24c4c49f9dc26699845))
* **executor,admin,sdk:** A-11R——params 注入字符串回归裸值 + 类型化通道，修 12 天静默停摆 ([2b4a52f](https://github.com/LuluDeer/AutoCodeFlow/commit/2b4a52f29fc37bdfb046feaa34b242cbe4281ff4))

## [1.10.0](https://github.com/LuluDeer/AutoCodeFlow/compare/v1.9.1...v1.10.0) (2026-10-09)


### Features

* **cli,mcp,agent:** 互斥组三面同步补齐——CLI 命令组 + MCP 4 工具 + agent 闸门纳管 ([#41](https://github.com/LuluDeer/AutoCodeFlow/issues/41)) ([cbcd7aa](https://github.com/LuluDeer/AutoCodeFlow/commit/cbcd7aad0bac9b975dab022860112f9d26a1a77c))

## [1.9.1](https://github.com/LuluDeer/AutoCodeFlow/compare/v1.9.0...v1.9.1) (2026-10-09)


### Bug Fixes

* **acf-cli:** 收口无人值守语义（非交互假绿 / 示例 payload / Windows lint） ([8b75be9](https://github.com/LuluDeer/AutoCodeFlow/commit/8b75be97e4d9b2eb763285ccae53cfdb826fcfa6))
* **mcp-server:** 部署缺省不再落 daemon + 补齐 annotations/ADMIN 标注 ([b487ecf](https://github.com/LuluDeer/AutoCodeFlow/commit/b487ecfd8cc437a33926e42d76089a021a962e3d))
* **release:** 根治 release-please lockstep 失效——单一 root 条目 + extra-files 广播 ([#39](https://github.com/LuluDeer/AutoCodeFlow/issues/39)) ([3e5dd7d](https://github.com/LuluDeer/AutoCodeFlow/commit/3e5dd7d5829f874bce1cfeaf10a69216c9cfcd86))

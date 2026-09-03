# 第八轮进度报告（2026-09-03）

> 编排：侦察 → A/B/C/D 四路并行（per-execution 回调 token / artifact 通道+ci-local+registry-npm / Playwright E2E / 只读 audit）→ audit+E2E triage → W1/W2 修复（P0 表单+N25 SSRF 绕过+N26-N32）→ N31 协调员自修 → V 真机 5/5 → W 真机 P1 击穿修复 → 收尾。
> 基线：admin-api **840/840（53 suites）+ eslint 0/0** · executor-node **150/150** · executor-python **86/86** · admin-web vitest **35** · Playwright E2E **25/25** · acf-cli **48** · mcp-server **52** · registry-pypi **33** · autocodeflow-node-sdk **43** · autocodeflow-notify **7** · 全端 tsc/build ✓。

## 1. 核心交付

### 1.1 per-execution 回调 token（A 流，N23 根治，本轮最大功能）

任务内 SDK 代码此前无法回调 admin-api（SEC-01 白名单有意不注入共享凭证，node-sdk 回调永远 disabled）。落地无状态 HMAC 方案：

- **token 格式**：`v1.<executionId>.<expiresAtUnixSec>.<hmacHex>`；key=HMAC-SHA256(secret, "autocodeflow:execution-callback:v1") 域分离——无法从回调 token 反推/伪造共享 token。TTL = 任务 timeout + 900s 宽限。
- **注入链**：executor-node execute 路由显式注入 `AUTOFLOW_CALLBACK_TOKEN`（走 extra 通道，白名单机制不动）+ `AUTOFLOW_ADMIN_API_URL` + `AUTOFLOW_EXECUTOR_ADDRESS`；`EXECUTION_CALLBACK_SECRET` 加入 SECRET_ENV_DENYLIST 防泄漏。
- **admin 验证**：`v1.` 前缀分支——TTL 检查 → 候选 secret（EXECUTION_CALLBACK_SECRET → DB sharedToken → env）+ per-executor tokenHash（N26）逐个 timingSafeEqual → 逐 item executionId 绑定校验；非 v1. 前缀完全走原共享 token 路径（向后兼容零破坏）。fail-closed。
- **SDK**：fromEnv 识别三个 AUTOFLOW_* 变量自动启用回调；legacy 变量优先不破坏既有用法。
- **算法防漂移**：admin/executor 双端 spec 钉死同一测试向量。
- **N26 缺口修复**（W2，密码学矛盾解决）：tokenHash 是 bcrypt 单向，不能作 HMAC key——改方案 A：签名密钥为 **tokenHash 字符串本身**（双端持有同一字符串，register 响应回传 + executor-node 采纳 + admin 按地址查库 60s 缓存验签）。分节点 --secret 部署的回调 401 消除。
- **N27**：executor-node 注入自身地址，SDK 自动补齐 callback item 的 executorAddress，sdk-guide 去硬编码。

### 1.2 install.sh 真 artifact 通道 + ci-local + registry-npm（B 流）

- `GET /api/executors/artifact/executor-node.tar.gz`（@Public + 共享 token Bearer/query 双支持，fail-closed）+ `scripts/bundle-executor-artifact.sh`（tsc 构建 + npm ci --omit=dev + tar.gz 2.2MB）；install.sh 恢复远程下载分支（失败回退本地），**真机从 artifact 装出的执行器注册 online**。
- `scripts/ci-local.sh`：13 job 与 ci.yml 逐 job 对应的本机等价脚本（含 e2e 双轮迁移与 audit 分支），快速模式 11 job 全绿 ~73s——**CI push 无凭证期间的本机等价验收通道**。
- registry-npm：verdaccio config 加固（htpasswd 入持久卷/max_body_size/web 可关）+ compose healthcheck 修复（localhost→127.0.0.1，原恒 unhealthy）+ README 部署说明，compose 冒烟通过（ping 200/匿名拉包 401/建用户）。

### 1.3 Playwright E2E 25/25（C 流，含 P0 发现）

- 新增 9 例（角色门控 /notifications、AI Tab 降级零请求断言、TaskFormPage 四模式、executorId 残留清理服务端复核）；既有 16 例环境性修正（端口/antd zhCN/Origin）。
- **抓到 P0**：TaskFormPage 分步渲染下 `form.validateFields()` 只返回当前挂载字段 → 创建任务 UI 流程完全不可用（payload 缺 name → 400）。fixme 守卫用例，W1 修复后转正回归（25/25 全过）。

### 1.4 audit N25-N32（D 流 → W1/W2 修复）

- **N25(P1)** IPv4-mapped IPv6（`::ffff:x.x.x.x`）绕过 SSRF 分类 → `normalizeIpForClassification` 归一（含 `::/96` compatible 形态与完整 IPv6 危险段：loopback/link-local/ULA）。
- **N28(P2)** admin-web 模式清理只 `delete` 不置 null（PATCH 缺省=保留，N19 换字段复现）→ 三字段显式 null（后端链路已核实 null 放行）。
- **N29(P2)** 通知 test 面谎报成功 → per-channel results 真实语义（blocked/failed → success:false；空 results → "no enabled channels"）。
- **N30(P3)** registry-pypi 并发上传 TOCTOU → `os.link` 原子创建 + EEXIST 哈希比对（同 200 异 409），并发双线程测试实证（旧代码 2 例失败）。
- **N31(P3)** /api/metrics 并发 render 计数回退 → in-flight 共享串行化（协调员自修）；**N32(P3)** 幽灵注释删除。

### 1.5 真机 P1 击穿修复（V → W 闭环）

V 真机抓到：executor-node `fetchToken()` 不拆 ResponseInterceptor 信封 → token 恒 undefined → 每次心跳打 `POST /executors/token` → rotateToken 30s 轮换 HMAC 密钥 → per-execution token 稳态必 401（实测 9 分钟 14 次轮换）。还藏第二个 bug：Nest POST 返回 201 而代码判 200。

W 三层修复：①fetchToken 拆信封 + 2xx 区间判断；②admin `issueToken` 幂等签发（startupId 相同稳态永不轮换；legacy 60s 复用窗）+ 内存缓存明文；③心跳响应回传 tokenHash，executor-node 三点（register/token/heartbeat）采纳跟随轮换。**executor-node 150/150 + admin-api 840/840 全绿**。

## 2. 真机验证（V，docs/VERIFY-round8-e2e.md）

5/5 PASS：①回调 token 全链（注入取证 SEC-01 未破 + HTTP 直接打有效/错 id/过期/篡改/共享回归全中 + 任务代码持 token 真实回调 201）；②Playwright 25/25（P0 转正用例兑现）；③artifact 下载解压链路；④ci-local 全绿；⑤/api/metrics 30 路并发零畸形。

## 3. 基线

admin-api **840/840（53 suites）**（+66）· executor-node **150/150**（+25）· executor-python **86** · admin-web **35**（+2）· Playwright **25**（+9 转正）· acf-cli **48** · mcp-server **52** · registry-pypi **33**（+3）· node-sdk **43**（+11）· notify **7** · 全端 tsc/lint/build ✓。

## 4. 阻塞与第九轮建议

**阻塞**：GitHub push 无凭证（本地 develop 领先 origin/develop 65+ commits）——CI 真跑需用户配置凭证或切 SSH。

1. **CI push 真跑**（凭证解决后唯一剩余项；ci-local 已提供等价验收）。
2. **executor-python 同款信封 bug 排查**（W 修复时未在授权范围；admin 侧幂等已兜底其旋转风暴，但回调/心跳信封拆包应对齐 node 侧）。
3. **N26 轮换窗口文档化遗留**：admin UI 手动旋转 token 后，长运行执行器的 HMAC 密钥要等下一次 register/token 才对齐（sdk-guide 已写红字段，可考虑 admin 侧广播失效通知）。
4. **回调 token 观测**：401 分类指标（过期/绑定错/签名错）进 prometheus series，便于生产排障。
5. admin-web 页面级 E2E 深化（pinned 部署链路 UI 闭环）；跨平台矩阵（需真机）。

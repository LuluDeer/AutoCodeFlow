# R4-A 安全审计报告（第四轮 · 对抗性视角）

- 审计人：R4-A 安全审计 agent（只读审计，未修改任何源码）
- 日期：2026-09-02
- 范围：`apps/admin-api`（`src/common`、`src/modules` 全量），重点为前三轮修复之后的剩余/新引入问题
- 方法：Guard 覆盖矩阵枚举 → 逐 @Public 端点核实 → 出站 HTTP 全量清单 → mass assignment / IDOR / 注入 / 日志与错误泄漏逐项核对
- 级别定义：P0=可远程利用的严重漏洞；P1=需低权限即可利用或数据泄露；P2=纵深防御缺口；P3=加固建议

## 统计

| 级别 | 数量 |
|------|------|
| P0   | 0    |
| P1   | 2    |
| P2   | 5    |
| P3   | 6    |

---

## Findings

### [P1] F-1 RBAC 全局缺失：除 users 模块外，所有管理面端点对任意 `role=user` 的 JWT 完全开放，且可读出 executor 共享 token 明文

**证据**

- 全仓库 `@Roles(` 仅出现在 `apps/admin-api/src/modules/users/users.controller.ts:43,67,145`（3 处）；`RolesGuard` 从未被任何其他 controller 引用（grep 全量核实）。即 tasks / applications / app-deployments / executors / executor-packages / config / notification / audit / metrics / registry / ai 全部只挂 `@UseGuards(JwtAuthGuard)`，无 admin 约束。
- `apps/admin-api/src/modules/config/config.controller.ts:131-142`：
  ```ts
  @Get("executor-shared-token")
  async getExecutorSharedToken() {
    const cfg = await this.configService.findOne("executor.sharedToken");
    return { token: cfg.value ?? null, hasToken: !!cfg.value };  // 明文返回
  }
  ```
  注释写着 "admin only"，但仅有 `JwtAuthGuard`，没有任何角色校验。同文件 `POST /api/config/executor-shared-token/generate`（105-129）允许任意用户轮换共享 token；`PUT /api/config`、`POST /api/config/batch`、`DELETE /api/config/:key` 允许任意用户写/删全部系统配置（含 `ai.openaiApiKey`、`executor.sharedToken` 等 isSecret 键——`upsert` 写入时不管 isSecret，只有 GET 时才掩码）。
- `apps/admin-api/src/modules/executors`（`executor.controller.ts:35`）仅 `JwtAuthGuard`：任意用户可 `POST :id/rotate-token`（352-375，响应含新 per-executor token 明文）、`DELETE :id`（474）、`POST :id/reload-config`（301）、`GET install-cmd`（224-247，响应含 shared token 明文）。
- `executor-package.controller.ts`（仅 `JwtAuthGuard`）：任意用户可上传 500MB 包（62-94，`memoryStorage()` 全量驻留内存）、`POST :id/push`（269）向全部 executor 分发、删除包（158）。
- `notification-config.controller.ts` `GET /api/notification/channels`（21-25）返回 `NotificationConfigService.getAllChannels()`，其中 `email.config.password`（SMTP 密码）、各渠道 `webhookUrl` 均为明文（`notification-config.service.ts:78-87`）。

**触发条件与攻击链（已核实闭环）**

1. 攻击者持有一个最低权限账号（role=user，系统默认创建的用户即此角色），登录拿到 access token；
2. `GET /api/config/executor-shared-token` → 获得共享 token 明文；
3. 此后即可以"executor 身份"调用全部 `@Public` executor 端点（register/heartbeat/callback/push-result/offline），下载 `/uploads` 下所有应用包（upload-auth 中间件接受 executor shared token）；
4. 更进一步：结合 F-2（heartbeat 列注入）植入持久化 per-address token；或直接 `PUT /api/config` 覆写 `executor.sharedToken`，实现配置级持久化；
5. 纵向越权面还包括：读全量任务执行日志（`GET /api/tasks/executions/all`，params/env 可能含敏感值）、读全部审计日志、管理/删除其他用户创建的任务与应用、`POST /api/executors/:id/rotate-token` 让合法 executor 掉线。

**confidence**: verified（Guard 矩阵与上述每个端点的代码均已读通，链路无缺口）

**建议修复**
- 最小改动：在 `APP_GUARD` 全局注册 `RolesGuard`，将 config（含 shared-token 读写/生成）、executors 的 rotate-token/reload-config/install-cmd/set-offline/delete、executor-packages 的上传/push/delete/install-token、notification 配置、audit 导出、users 全部标 `@Roles(UserRole.ADMIN)`；
- `GET /api/config/executor-shared-token`、`GET /api/executors/install-cmd` 必须回到 admin-only；notification channels 响应中 password/webhookUrl 掩码；
- 若产品定位确为"单租户、任意登录用户可操作任务"，至少要把 token/密钥类端点与任务操作区分开。

**测试影响**
- `users.controller.spec.ts` 已覆盖的 RBAC 用例可作为模板；需新增 config.controller / executor.controller / executor-package.controller / notification-config.controller 的 403（role=user）用例；现有 `executor.controller.spec.ts`、`notification-config.controller.spec.ts` 中用普通 user 调用的用例需改fixture为 admin。

---

### [P1] F-2 executor heartbeat 列注入可覆写 `tokenHash`——击穿 40df910 per-address token 收紧，形成轮换共享 token 后仍存活的持久后门

**证据**

- `apps/admin-api/src/modules/executor/executor.controller.ts:129-147`：`heartbeat(@Body() body: {...inline type...})`——body 是 inline 类型而非 DTO class，全局 ValidationPipe（whitelist）对非 class metatype 完全跳过，**不做字段白名单**。
- `apps/admin-api/src/modules/executor/executor.service.ts:302-317`：
  ```ts
  const { restartedAt, startupId, ...metricValues } = metrics;
  ...
  Object.assign(e, metricValues, {
    status: ExecutorStatus.ONLINE,
    lastHeartbeat: new Date(),
  });
  ...
  const saved = await this.repo.save(e);
  ```
  `metricValues` = 除 `restartedAt`/`startupId` 外的**全部**请求字段。`Executor` 实体（`entities/executor.entity.ts`）中 `tokenHash`（`@Column({ nullable: true, select: false })`）、`runningTaskCount`、`maxConcurrentTasks`、`version`（乐观锁列）、`executorStartupId` 等均为可映射列 → `save()` 全部落库。
- 鉴权仅要求：`validateTokenByAddress(body.address, token)` 通过——per-address token **或共享 token 回退**（`executor.service.ts:874-897`）。结合 F-1，任何 role=user 都能拿到共享 token。

**触发条件与攻击链**

1. 拿到共享 token（见 F-1）后，对目标 executor 的 address 调 `POST /api/executors/heartbeat`，body 携带
   `{ "address": "<victim>", "tokenHash": "<bcrypt(attacker_token)>" }`；
2. `Object.assign` 将 `tokenHash` 写入实体并持久化——`status`/`lastHeartbeat` 被覆盖但 `tokenHash` 不会；
3. 此后 `validateTokenByAddress` 优先用 per-address bcrypt 比对（885-888 行）→ 攻击者 token 生效；
4. 管理员轮换共享 token（SEC-03 的修复动作）**无法**吊销该后门；且 `POST /api/executions/callback` 的 per-address 校验（execution-callback.controller.ts:93）、`POST /api/app-deployments/heartbeat` 的 `validateExecutorToken`（app-deployment.controller.ts:127）同样接受该 token；
5. 附带影响：`runningTaskCount: -1000`（容量校验 `runningTaskCount < max` 永真，占满调度）、`maxConcurrentTasks` 篡改、`executorStartupId` 篡改可伪造"重启"事件把 RUNNING executions 置 FAILED。

同族问题（同一根因：inline body 无白名单）：
- `POST /api/executors/register`（controller:78-107 → service:232-237 `repo.create(createData as Partial<Executor>)`）：可注入 `id` 指向既有 executor 行 → `save()` 变 UPDATE，整行覆写（含 address），实现 executor 记录劫持；可注入 `runningTaskCount` 负值。`tokenHash` 会被随后的 `rotateToken` 覆盖，此处不可利用。
- `PATCH /api/executors/:id`（controller:286-297 → service:346 `Object.assign(executor, data)`）：inline body 无白名单，任意 JWT 用户可写任意列。

**confidence**: verified（代码链路完整；建议负责人按下述步骤做一次运行时确认）

**验证方法**
```bash
TOKEN=<共享token>; ADDR=<已注册executor地址>
# 1) 注册并记住 rotate 返回的 token
curl -s -X POST :3105/api/executors/register -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"address\":\"$ADDR\",\"appName\":\"victim\"}"
# 2) 用另一个 token A 生成 hash 并注入
H=$(node -e "console.log(require('bcryptjs').hashSync('tokenA',12))")
curl -s -X POST :3105/api/executors/heartbeat -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"address\":\"$ADDR\",\"tokenHash\":\"$H\"}"
# 3) token A 现在可通过 per-address 校验：
curl -s -X POST :3105/api/executors/offline -H "Authorization: Bearer tokenA" \
  -H 'Content-Type: application/json' -d "{\"address\":\"$ADDR\"}"
```

**建议修复**
- heartbeat：构造显式 `HeartbeatDto`（仅 cpuUsage/memUsage/diskUsage/networkLatency/runningTaskCount 等指标字段，数值范围校验）交给全局 ValidationPipe；service 层再显式逐字段赋值，禁用 `Object.assign`；
- register：同样建 DTO，`repo.create` 前做显式字段挑选（现有 `version` 剥除逻辑扩展为白名单）；
- PATCH :id：建 `UpdateExecutorDto`（groupName/tags/description/maxConcurrentTasks 四字段）；
- 纵深：`tokenHash` 写路径仅允许 `rotateToken()`；可给实体加 `@Column({ update: false, insert: false })` 之外的专用写入口约定，或在 save 前断言 tokenHash 未被外部赋值。

**测试影响**
- 新增 `executor.controller.spec` / `executor.service.spec` 用例：heartbeat 携带 `tokenHash`/`runningTaskCount:-1`/`version` 时应被忽略或 400；register 携带 `id` 时应忽略；现有 `executor.controller.spec.ts` 的 heartbeat 用例需补 DTO 后回归。

---

### [P2] F-3 SSRF 防护层未覆盖 executor address 出站路径（6 处 axios 直连），`validateExecutorAddress` 只验格式不拦内网/元数据地址

**证据**

- `safe-http.util.ts:9-12` 自述"single chokepoint for all outbound HTTP"，但 `assertSafeHttpUrl` 全仓库仅 3 个调用点（webhook.channel、ai.service ×2）。
- executor address 出站点全部绕过该层：
  - `executor.service.ts:563`（dispatch → `getExecutorUrl(matched.address, "api/execute")`）
  - `executor.service.ts:648`（dispatchBroadcast）
  - `executor.controller.ts:342`（reload-config）
  - `executor-package.service.ts:263`（pushToExecutors → `/api/update-package`）
  - `task.service.ts:921`（backfillFullLogsFromExecutor → `api/logs/...`）
  - `app-deployment.service.ts:288,414`（app-stop / deploy）
- `app-deployment.service.ts:349-364` 的 `validateExecutorAddress` 仅校验 `host:port` 正则与端口范围，`http://169.254.169.254:80`、`http://127.0.0.1:6379`、`10.x` 均通过。

**触发条件与攻击链**

- 写入 address 需要 executor 共享 token（register/heartbeat 鉴权），因此非零权限攻击者即可利用：注册 `address=169.254.169.254:80`（或 heartbeat 不存在该行则先 register），设 `runningTaskCount=0` 抢占调度 → admin-api 携带共享 token 的 `Authorization` 头 POST 到目标地址（dispatch/push），形成"凭证外带 + 内网探测"原语；错误信息还会回传给调用方（见 F-8）。
- `task.service.ts:908-910` 的 backfill 使用 `execution.executorAddress`（DB 值，源头同样是注册地址）。

**confidence**: verified（覆盖面缺口是代码事实；利用前提是持有共享 token，故定级 P2 纵深防御而非 P1）

**建议修复**
- 出站点统一接入 `assertSafeHttpUrl(getExecutorUrl(...))`，或提供 `assertSafeExecutorAddress(address)`：DNS 解析后逐地址拒绝私网/环回/链路本地/元数据段（复用 `isBlockedAddress`）；
- 若部署形态要求 admin-api 与 executor 必须同内网，则将目标网段做成显式白名单（`EXECUTOR_ALLOWED_CIDRS`），而不是放开校验；
- `getExecutorUrl` 强制协议与端口白名单（如仅 http/https + 非特权端口）。

**测试影响**
- `executor.service.spec` / `app-deployment.service.spec` 新增：注册/部署 `169.254.169.254:80`、`127.0.0.1:xxxx` 应 400。

---

### [P2] F-4 登录接口用户名枚举时序侧信道——SEC-05 声明"always run the full check path"，实现并未做到

**证据**

- `apps/admin-api/src/modules/auth/auth.service.ts:45-46`：
  ```ts
  // SEC-05: always run the full check path to avoid username-enumeration timing leaks
  const passwordOk =
    user != null && (await bcrypt.compare(loginDto.password, user.password));
  ```
  `user == null` 时 `&&` 短路，**不执行 bcrypt.compare（cost 12，约 100–300ms）**；用户存在时必然执行。同理 `recordLoginFailure` 也只对存在的用户触发一次 DB 写。两条路径的服务端耗时差异稳定可测。
- 注释意图（防枚举）与实现不符；`bcrypt.hash` 假比较（如 `bcrypt.compare(password, DUMMY_HASH)`）才是惯用做法。

**触发条件与攻击链**：未认证攻击者对 `POST /api/auth/login` 以相同 payload 测量响应时间，区分"用户名存在但密码错"（慢）与"用户名不存在"（快），配合 20 次/分 的 IP 限流仍可在可接受时间内枚举账号清单，为 F-1 类攻击提供用户名侦察。

**confidence**: verified（代码短路路径明确；时序可测性建议运行时确认：对存在/不存在的用户名各测 ≥50 次取中位数差）

**建议修复**：user 不存在时执行 `bcrypt.compare(password, DUMMY_BCRYPT_HASH)`（模块级常量），保持两条路径 CPU 耗时一致；lockedUntil 快速失败分支同时考虑加固定延迟或同样跑假比较。

**测试影响**：`users.service.spec`/新增 auth 时序用例难以断言时间，建议至少补"用户不存在时调用了一次 bcrypt.compare"的单测（spy）。

---

### [P2] F-5 `/api/executions/callback` 全控制器 `@SkipThrottle()` + 55MB 专属 body 解析 + 未认证 → 资源耗尽 DoS 面

**证据**

- `execution-callback.controller.ts:20` `@SkipThrottle()` 使全局限流（60/min）对该控制器完全失效；`@Public()`（32）；
- `main.ts:87-95` 为该路径单独开 `express.json({ limit: "55mb" })`；单个请求最多 100 × 512KB logs + 4KB errorMessage；
- 鉴权阶段每个唯一 `executorAddress` 触发 `validateTokenByAddress` → 对存在 `tokenHash` 的 executor 执行 `bcrypt.compare`（cost 12，~200-300ms 纯 CPU）。非法 token 也先跑完 bcrypt 才失败；
- JSON.parse 55MB 本身即显著 CPU/内存开销。

**触发条件与攻击链**：未认证攻击者只需知道（或暴力枚举到）一个已注册 executor 的 address（例如曾经收到过回调日志、executor 地址命名可猜测），即可用普通请求持续触发 bcrypt + 大 JSON 解析；无任何限流计数。配合并发连接可压垮 admin-api 单实例。

**confidence**: verified（三个要素均为代码事实；实际命中率取决于是否知晓 address）

**建议修复**
- 恢复该路径的宽松限流（如 300/min/IP 而非 SkipThrottle），或在 token 校验失败路径上加每 IP 计数器/指数退避；
- 55MB 解析器只在 `Content-Length` 合理时启用，或对未认证请求先做轻量预检（先验 token 再解析大 body —— express body parser 在路由前执行，需将 token 校验改为中间件形式或限制该路由 body 上限并分批回调）；
- `bcrypt.compare` 结果可加进程内短时缓存（address+token 前缀 hash）。

**测试影响**：`execution-callback.controller.spec` 需补充限流行为回归（若移除 SkipThrottle，注意回调风暴场景的合法阈值）。

---

### [P2] F-6 无条件 `trust proxy = 1`：直连部署时限流键（req.ip）可被 `X-Forwarded-For` 伪造，登录限流与审计 IP 可绕过/污染

**证据**

- `main.ts:120`：`app.getHttpAdapter().getInstance().set("trust proxy", 1);` —— 无环境开关，注释理由仅是"反向代理后取真实 IP"；
- 全局限流（ThrottlerGuard 默认 tracker = `req.ip`）与 `@Throttle` login 20/min、`audit.log({ip: req.ip})`、config history `ipAddress` 全部基于 `req.ip`；
- trust proxy=1 时，若 admin-api 被直接访问（无前置代理），Express 将客户端自带的 `X-Forwarded-For` 最后一跳当作 client IP —— 攻击者每请求换一个 XFF 值即可让每次限流计数落在不同"IP"上：登录限流 20/min 形同虚设（账户锁定仍按用户名生效，但可用多用户名字典绕过账户维度），审计/config 历史记录的 IP 全部可伪造。

**confidence**: suspected（取决于部署形态：前置了可信 nginx 且 nginx 覆写 XFF 时不可利用；直连或代理透传 XFF 时成立）

**验证方法**：直连 admin-api 端口时
```bash
for i in $(seq 1 30); do curl -s -o /dev/null -w "%{http_code} " \
  -H "X-Forwarded-For: 10.9.9.$i" -X POST :3105/api/auth/login \
  -H 'Content-Type: application/json' -d '{"username":"nouser","password":"x"}'; done
```
若 30 次全为 401 而无 429，则限流被绕过，finding 成立。

**建议修复**：`TRUST_PROXY` 环境变量（默认 false/0），生产仅当显式声明前置代理时设 1 或具体网段；或用 `app.set('trust proxy', cfg.trustProxy)`。

**测试影响**：e2e 层面新增 XFF 行为用例；`main.ts` 无单测覆盖，需手工验证。

---

### [P2] F-7 executor `register` 可注入 `id` 覆写其他 executor 行（inline body → `repo.create` 直通）

**证据**

- `executor.controller.ts:78-94` inline body 无 DTO；`executor.service.ts:235-237`：
  ```ts
  const { version: _optimisticLock, ...createData } = data;
  e = this.repo.create(createData as Partial<Executor>);
  ```
  仅剥离 `version`，其余字段（含 `id`）全部进入 `repo.create`。当 body 的 `id` 命中既有行且 `address` 为新值时，`findOne({address})` 走 create 分支，`repo.save()` 因主键已存在转为 UPDATE，整行覆写目标 executor（appName/address/status/capabilities/...）。
- 前置条件：共享 token（同 F-2/F-3）。

**触发条件与攻击链**：持共享 token 的攻击者可把某台合法 executor 的记录"改名换姓"（address 指向自己的机器），此后该记录的调度流量/回调归属全部转移；配合 `tokenHash` 不可注入（rotate 兜底）但 `executorStartupId` 可伪造重启，影响为完整性破坏而非直接拿权。

**confidence**: verified（TypeORM `save()` 对带主键实体执行 UPDATE 是既定语义；建议运行时确认一次）

**验证方法**：注册 executor A 记下 id；再 `POST /api/executors/register`，body 带 `{"id":"<A-id>","address":"10.0.0.9:3002","appName":"hijack"}`，观察 A 记录被改。

**建议修复**：register 走白名单 DTO（同 F-2 修复），`repo.create` 前显式剔除 `id`/`tokenHash`/`status`/`createdAt` 等服务端列。

**测试影响**：`executor.service.spec` 增加注入字段被忽略的用例。

---

### [P3] F-8 reload-config 错误响应回显 axios `err.message`，泄漏内网拓扑并提供盲 SSRF oracle

**证据**：`executor.controller.ts:344-347`
```ts
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  throw new UnauthorizedException(`Failed to reach executor: ${msg}`);
}
```
axios 连接错误 message 形如 `connect ECONNREFUSED 10.0.0.9:8000` / `connect ETIMEDOUT`，区分端口开闭（ECONNREFUSED）与主机不通（timeout），向任意 JWT 用户暴露 executor address 与内网连通性差异；此外 401 状态码用于"executor 离线/不可达"语义也不准确。`handleCallback` 的 per-item error 原样回传（`task.service.ts:1074-1080`）同理。

**confidence**: verified（代码层面；利用价值低故 P3）

**建议修复**：对外固定消息（"Executor unreachable"），详细 message 仅入日志；离线/不可达改用 400/502。

**测试影响**：`executor.controller.spec` 断言错误消息不再包含原始 err.message。

---

### [P3] F-9 Content-Disposition 直接拼接未消毒的 `pkg.originalFilename`

**证据**：`executor-package.controller.ts:178-181`
```ts
res.setHeader("Content-Disposition",
  `attachment; filename="${pkg.originalFilename ?? pkg.filename ?? ...}"`);
```
`originalFilename` 来自上传时 `file.originalname` 原样入库（`executor-package.service.ts:112`），无字符过滤。携带 `"` 可逃逸引号、非 ASCII/控制字符导致下载文件名异常；`\r\n` 会让 Node `setHeader` 抛 `ERR_INVALID_CHAR` → 500（现代 Node 已阻断响应拆分，故非注入漏洞，而是下载功能破坏/编码缺失）。缺 RFC 5987/6266 的 `filename*` 编码。

**confidence**: verified（代码）；建议验证：上传 `originalFilename` 带引号/中文/CRLF 的包后调用 `GET /api/executor-packages/:id/download`。

**建议修复**：存储时消毒 originalFilename（剥离 `"\r\n` 与控制字符），响应头使用 `filename*=UTF-8''${encodeURIComponent(name)}` + ASCII 回退。

**测试影响**：`executor-package.service.spec` 增加特殊文件名上传→下载的往返用例。

---

### [P3] F-10 `/api/health/*` 全公开暴露内部运行指标

**证据**：`health.controller.ts` 5 个端点全部 `@Public()`；`GET /api/health`、`/health/services`、`/health/metrics` 返回 DB/Redis/队列连通状态、任务总数/活跃数、executor 总数/在线数。未认证者可借此绘制系统画像并感知内部故障时机（配合针对性攻击）。K8s 场景只需 `live`/`ready`；`full`/`services`/`metrics` 建议收进鉴权。

**confidence**: verified

**建议修复**：`live`/`ready` 保持公开，其余加 `JwtAuthGuard` 或要求内网来源；响应中不再输出具体组件错误信息。

**测试影响**：`health.service.spec` 不受影响；新增 controller 级守卫用例。

---

### [P3] F-11 会话加固缺口：refresh token 无重用检测/无告警；密码修改后 access token 不失效；application webhook 5 分钟窗口内可重放

**证据**
- `auth.service.ts:89-101`：revoked 的 refresh token 被重用时仅 401，不吊销该用户其余 token、不产生审计/告警——重用检测（token family）缺失，被盗 token 与正常轮换不可区分；
- `jwt.strategy.ts` 每请求校验 `isActive` 但无法感知"密码已改/已登出"，access token 最长 15 分钟窗口内继续有效（`upload-auth.middleware.ts` 的静态文件校验同样不查库，注释已声明取舍）；
- `application.controller.ts:235-245`：HMAC + ±5min 时间戳，无 nonce/jti，同一签名请求可在窗口内重放（`version` 覆盖幂等，危害有限）。

**confidence**: verified（均为设计缺口而非可利用漏洞）

**建议修复**：refresh 重用时执行 `revokeAllForUser(user.id)` 并写审计事件（`auth.refresh_reuse`）；如需即时吊销 access token，可引入短 TTL jti 黑名单（Redis）；webhook 可选 `X-Delivery-Id` + Redis 去重。

**测试影响**：`auth.service` 相关 spec 增加"重用 revoked token → 其余 token 全部失效"用例。

---

### [P3] F-12 杂项加固

1. **notification/AI URL 只在发送时校验**：`POST /api/ai/config` 接受任意字符串作为 `openaiBaseUrl`/`ollamaHost`（ai.controller.ts SaveAiConfigDto 无 URL 校验），发送时 `assertSafeHttpUrl` fail-closed（ai.service.ts:200,219）——无 SSRF 后果，但错误配置只会在运行期暴露；建议保存时校验格式并预跑 `assertSafeHttpUrl`。notification `updateChannel` 的 webhookUrl 同理（且该内存配置目前并未被发送通道消费——通道只读 env，属死配置，见下条）。
2. **`POST /api/executor-packages/install-token` 是装饰性端点**（executor-package.controller.ts:125-135 + service.generateInstallToken）：token 随机生成后既不持久化也无任何校验消费方，给前端/文档造成"有一次性授权"的假象。建议实现或移除。
3. **registry / git clone 未接入 assertSafeHttpUrl**：`registry.controller.ts` 的 PyPI/npm URL 来自 env（可接受），但 `application.service.deployFromGit`（234-247）允许任意 JWT 用户提交 `gitRepo` 触发 admin-api 发起 `git clone`（http/ssh），可作内网盲探测原语；建议对 `gitRepo` host 走同样的内网地址校验（或仅允许白名单 git host）。
4. **`PATCH /api/users/:id` 密码修改无额外限流**：拿到他人 access token 的攻击者可按 60/min 全局限流爆破 `currentPassword`；建议对该分支复用登录级 `@Throttle`。

**confidence**: verified（各项均为代码事实，风险低）

**测试影响**：ai.controller 保存校验用例；users.controller 密码分支限流用例。

---

## 已核实无问题的检查项

以下项本轮逐一代码核实，未发现可利用问题（防止后续轮次重复排查）：

1. **Guard 矩阵**：全局 `JwtAuthGuard`（APP_GUARD）+ `ThrottlerGuard` 生效；`@Public` 仅 auth(login/refresh)、executors(register/heartbeat/token/offline)、executions/callback、app-deployments/heartbeat、applications/webhook、executor-packages/push-result、health 全部——逐个核实鉴权逻辑（webhook HMAC、共享/per-address token）均已实现，无未设防的 @Public。
2. **JWT 类型混淆**：access/refresh 双 secret（`JWT_SECRET`/`JWT_REFRESH_SECRET`）；JwtStrategy 强制 `type==="access"`（SEC-001），refresh 端点强制 `type==="refresh"` 且必须有 `jti`（SEC-002）；upload-auth 中间件同样校验 `type==="access"`，refresh token 不能当 access 用。
3. **共享 token 比较**：`verifyExecutorToken`、`validateTokenByAddress`、`validateExecutorToken` 均为 length 前置 + `timingSafeEqual` 或 bcrypt.compare，无裸 `===` 比较；webhook HMAC 用 `timingSafeEqual`。
4. **弱密钥 fail-fast**：JWT_SECRET/JWT_REFRESH_SECRET/EXECUTOR_SECRET 生产环境长度与默认值校验在 configuration.ts + app.module Joi 双保险（前轮修复，本轮复核无回归）。
5. **/uploads 鉴权**：`PUBLIC_UPLOAD_PREFIXES` 为空、fail closed；JWT 与 executor token 双通道；无效 JWT 会继续尝试 executor token 后 401。
6. **SQL 注入**：全仓库无字符串拼接 SQL；TypeORM query builder 全部参数化（`ILIKE :param`、`executorAddress ILIKE` 等）；`config.service.getByTag` 对正则元字符转义；audit 的 action 参数做长度截断 + 字符白名单。唯一字符串内插 `'${ExecutionStatus.SUCCESS}'` 来自服务端枚举常量（executor.service.ts:991,995），非用户输入。
7. **命令注入**：`spawnSync("git", [args...])` 数组形式无 shell；gitBranch 正则 `^[a-zA-Z0-9._/\-]+$`、gitRepo 协议白名单（SSRF 除外，见 F-12.3）。
8. **路径穿越**：executor 包磁盘文件名由 `safeName-safeVersion-checksum前8` 构成（name/version 做字符替换）；application 包文件名 `safeName_Date.zip`；`getFileBuffer`/`fs.readFileSync` 均以 DB 内服务端生成路径为准，无用户可控路径拼接；`/uploads` 静态服务挂载点固定。
9. **Mass assignment（users/applications/tasks）**：全局 ValidationPipe `whitelist + forbidNonWhitelisted`；users `Object.assign(user, dto)` 的 DTO 仅 username/email/password/role/currentPassword，非 admin 改 role 被 403（users.controller.ts:107-110），role 不可自提权；password 走 strength 校验 + bcrypt(12) + `@MaxLength(128)` 防 bcrypt DoS。executor 模块为反例（见 F-2/F-7）。
10. **执行回调完整性**：per-item `executorAddress` 必填、与 execution.executorAddress 强匹配、原子终态转换（PENDING/RUNNING 才可写）、KILLED 状态不可被回调覆盖（R-P0-007）、批量 ≤100、多 executor 批禁用共享 token 回退（TASK-001）。
11. **应用 webhook**：统一 401 文案防应用名枚举（APP-001）、secret 缺失即拒、rawBody 签名（`${timestamp}.${body}`）、±5min 时间窗、timingSafeEqual（重放窗口除外，见 F-11）。
12. **错误响应泄漏**：HttpExceptionFilter 对非 HttpException 统一 "Internal server error"，QueryFailedError 映射 409/422 不回传 SQL；TypeORM `logging` 仅 development 开启；未发现堆栈/SQL 返回客户端（F-8 的 axios message 为唯一例外）。
13. **敏感值落日志**：grep 全量 logger 调用，无 token/password/secret 明文输出；rotate-token 只记录 id 与 address；per-executor token 原文仅单次响应返回。
14. **CORS**：显式白名单（生产 fail-fast 校验 https 格式）、无 `*`+credentials 组合、LAN 自动放行已移除、无 Origin 头的服务间调用放行（合理）。
15. **DoS 基本面**：全局 body 1MB 上限（callback 例外已单列 F-5）、TimeoutInterceptor、SSE 并发槽位（per-execution 4 / global 64）、metrics `days` 封顶 90、分页 `pageSize ≤ 100`（audit 内部再钳制 100）、包上传扩展名+magic number 双校验（application zip / executor 包 zip-whl-targz）。
16. **账户锁定**：原子自增（RETURNING）+ 条件置 lockedUntil，无并发丢更新；登录失败对不存在用户不触发计数（无资源浪费）；`isActive=false` 登录与 token 校验双重拒绝。
17. **BullMQ/Redis**：TLS 开关与证书校验可配；队列参数不含用户可控的执行路径。

---

## 修复优先级建议

1. 先修 F-1（RBAC）+ F-2（heartbeat tokenHash 注入）——两者组合构成"低权限用户 → 持久 executor 后门"完整链；
2. F-3/F-7 随 executor 模块 DTO 化一并落地；
3. F-4/F-5/F-6 为低成本的独立修补；
4. P3 项纳入常规加固迭代。

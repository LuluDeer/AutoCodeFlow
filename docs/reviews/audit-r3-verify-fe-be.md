# 后端/前端 P0+P1 复核（2026-09-14）

- 复核对象：`docs/reviews/audit-r1-backend.md`（R-01~R-06，P0/P1 全部）与 `docs/reviews/audit-r1-frontend.md`（F-01~F-07，报告实际 P0=1、P1=6；另按委托要求附带核对了 F-10/F-11——两者在原报告中均为 **P2**，不在 P0/P1 清单内）
- 基线：分支 `develop`，HEAD `0ef3bbe`，逐条回到源码读取报告给出的 file:line 及前后 ≥30 行上下文，未运行测试，未修改任何现有文件
- 判定口径：每条均独立重读证据、独立判断，报告结论有误处给出反证代码位置与摘录；成立者补查测试覆盖与既有缓解

---

## 一、复核总表

| 编号 | 原严重度 | 复核结论 | 一句话理由 |
|---|---|---|---|
| R-01 | P0 | **确认** | findOne 脱敏实体在 update 内被 Object.assign 后整体 save，掩码 `******` 落库，与 application 侧已修的对照代码形成直接证据 |
| R-02 | P1 | **确认** | `batchDelete` 确实漏传 user，对无主行与有主行均恒 403；且复核发现缺陷面比报告更大（另一注册控制器 tasks-batch 四个批量端点全部漏传） |
| R-03 | P1 | **确认** | updateGlue / rollback / rollbackToVersion 三端点 controller 有 user 不传、service 无守卫，仅 JwtAuthGuard（认证非授权） |
| R-04 | P1 | **确认** | findById 恒抛 404，jwt.strategy 与 refreshToken 的 401 分支均为死代码，`findByIdOrNull` 存在但调用点未换 |
| R-05 | P1 | **确认，建议改级 P1→P2** | totpVerifyLogin 确缺 clearExpiredLock，但标准 UI 流程必先过 /auth/login（已清过期锁），缺陷仅可达于绕过 login 直调 /auth/totp/verify 的非 UI 客户端 |
| R-06 | P1 | **部分确认，建议改级 P1→P2** | 「广播不占坑」成立；但「回调统一释放导致每执行器被减 1」的机制被证伪——广播执行 executorAddress 恒为 null，释放走 no-op 早退，不存在系统性虚减漂移 |
| F-01 | P0 | **确认** | @monaco-editor/react 无 loader.config，src 零处 import monaco-editor，默认走 jsdelivr CDN；内网/离线下 Glue 编辑器不可用，依赖与 chunk 均为死配置 |
| F-02 | P1 | **确认** | ParamsEditor 仅 useState 初始化消费 value，模板预填（异步 setFieldsValue）后表单存储有值而行显示为空，提交与显示不一致 |
| F-03 | P1 | **确认** | 克隆 payload 与 Task 类型逐字段对照，timeoutAction / timeoutWarnRatio / maintenanceWindows / runbook / 两类亲和标签 6 类字段确未复制 |
| F-04 | P1 | **确认** | `suggestCron` 全仓仅 TaskDetailPage:613 一处出现，TaskFormPage 只读 applicationId/templateId，死链成立 |
| F-05 | P1 | **确认（事实），建议改级 P1→P2** | 三处 `?access_token=` 属实；但后端已限定仅 3 条 SSE 路由 + type=access + 15min 短时效，且代码注释明确记录取舍，暴露面有界 |
| F-06 | P1 | **确认** | partialize 将 token+refreshToken（30 天）持久化 localStorage，PrivateRoute 注释与实现矛盾，均属实 |
| F-07 | P1 | **证伪（建议改级 P1→P3）** | 该类组件零引用是死代码；实际挂载的是 main.tsx 的 react-error-boundary + ErrorFallback（默认命名空间、i18n 正常、有测试），用户永远看不到原始 key |
| F-10（附带） | P2（原报告） | 确认 | listAllTasks 聚合与其消费方属实；小修正：DAG 拉取发生在 deps Tab 首次激活时（antd Tabs 懒挂载），非「进入详情页即拉」 |
| F-11（附带） | P2（原报告） | 部分确认 | 200页×2000行全量拉取属实；但「逐行切 span 全进 DOM」仅搜索高亮路径成立，默认路径已聚合为大块文本，DOM 爆炸表述夸大 |

### 计数
- 确认 9：R-01、R-02、R-03、R-04、F-01、F-02、F-03、F-04、F-06
- 部分确认 2：R-06、F-11（附带）
- 证伪 1：F-07
- 建议改级 4：R-05（P1→P2）、R-06（P1→P2）、F-05（P1→P2）、F-07（P1→P3）

---

## 二、逐条详述

### R-01【P0】任务 PATCH 不带 secrets 时掩码副本写回数据库 —— 确认

**报告声称**：`task.service.ts:533-541`（findOne 脱敏）+ `:544-577`（update 消费脱敏实体），未带 secrets 的 PATCH 把 `{"KEY":"******"}` 整体写回。

**实际读到的代码**（`apps/admin-api/src/modules/task/task.service.ts`）：

- L533-542 `findOne()`：
  ```ts
  async findOne(id: string) {
    const t = await this.taskRepo.findOne({ where: { id, status: Not(TaskStatus.DELETED) } });
    if (!t) throw new NotFoundException("Task not found");
    // SEC-02: 详情响应同样脱敏；写路径（update）走独立归一化，不受影响   ← 注释与实际不符
    t.secrets = this.secretsCrypto.maskForResponse(t.secrets) as ...
    return t;
  }
  ```
- L549：`const t = await this.findOne(id);`（update 直接消费脱敏实体）
- L560-566：
  ```ts
  if (normalized.secrets !== undefined) {
    normalized.secrets = this.secretsCrypto.encryptForStorage(...) ...
    t.secrets = normalized.secrets as Record<string, unknown> | null;
  }
  delete normalized.secrets;   // PATCH 未带 secrets 时上方分支不走，delete 为 no-op
  ```
- L570-577：`const updated = Object.assign(t, normalized); ... const saved = await this.taskRepo.save(updated);` → `t.secrets` 保持掩码值并随 save 落库。

**佐证链**：
- `apps/admin-api/src/common/utils/secret-crypto.util.ts:184-195`：`maskSecretsObject` 递归把叶子值替换为 `"******"`。
- 派发透传：同文件头注「a value that does not carry the prefix is treated as plaintext and passed through untouched」+ `isEncryptedSecret`（L31-33）；`executor.service.ts:261-279 buildDispatchParams` 直接并入派发载荷 → 掩码后任务凭据以字面量 `******` 注入，不可逆丢失。
- 团队已知该陷阱的对照证据：`apps/admin-api/src/modules/application/application.service.ts:371-376`：
  ```ts
  // R1: load the RAW row, never the masked findById() result — saving a
  // masked entity back would persist '***' over the real secret env values
  const app = await this.findByIdRaw(id);
  ```
  task.service **没有** `findByIdRaw`（全文件 grep 无此方法），同型修复确实漏做。

**判定**：成立。P0 定级合理（任意不带 secrets 的 PATCH 即可静默损毁任务凭据）。

**测试覆盖/缓解**：`task.service.spec.ts` 全部用降级桩装配（L39-40 注释 + L256-257 等多处 `new SecretsCryptoService({ get: () => "" })`），文件内无任何「PATCH 不带 secrets 后断言库中 secrets 不变」的行为测试 → 零覆盖，报告旁证成立（细节修正：grep `secrets` 命中约 12 行而非 1 行，但全部为 provider 装配与注释，无行为断言）。

**复核补充（报告未提）**：同型破坏面比报告更大——
- `updateGlue`（task.service.ts:587-594）同样 `findOne` 脱敏 → `save(t)`；
- `rollback`（task.service.ts:1252 取脱敏实体，L1258 `manager.save(Task, task)`）同型；
- 即 W-2 的疑点在 updateGlue 与 rollback 两处均实际成立，应与 R-01 一并修复。

---

### R-02【P1】batch/delete 漏传 user 恒 403 —— 确认

**报告声称**：`task.controller.ts:303-324` 调 `remove(id)` 未传 user；service 侧 `assertCanWrite` 对 undefined user 必 403。

**实际读到的代码**：
- `task.controller.ts:308-313`：
  ```ts
  const results = await Promise.all(
    body.taskIds.map((id) =>
      this.taskService.remove(id)            // ← user 未传
        .catch((err) => ({ id, error: err.message })),
    ),
  );
  ```
  同文件对照：batchTrigger L197 `.trigger(id, {}, user)`、batchPause L235、batchResume L273、单条 remove L506 均传 user，唯 batchDelete 漏。
- `task.service.ts:305-318`：`user?.role === ADMIN` 不成立（undefined）→ 无主行 403（L310-313）；`row.ownerUserId !== user?.id`（number !== undefined 恒 true）→ 403（L315-317）。任何行均 403，错误被 `.catch` 吞成 `{id, error}`，HTTP 仍 200。
- 前端确用该路由：`apps/admin-web/src/api/tasks.ts:398` `batchDelete: ... client.post('/tasks/batch/delete', ...)`。

**判定**：成立。管理员与属主均无法批量删除，NF-03 后新建任务全数命中。

**测试覆盖/缓解**：`task-batch.controller.spec.ts:121-122` `expect(taskSvc.remove).toHaveBeenCalledWith("t1")`——把缺陷固化为断言，报告属实。

**复核补充（报告未提）**：模块同时注册了第二个批量控制器 `task-batch.controller.ts`（`@Controller("tasks-batch")`，task.module.ts:49-53），其 **四个** 批量端点全部漏传 user——batchTrigger L56 `.trigger(id, {})`、batchPause L85 `.pause(id)`、batchResume L114 `.resume(id)`、batchDelete L144 `.remove(id)`。修复时应两处同改（或废弃该遗留控制器），报告只覆盖了 TaskController 侧。

---

### R-03【P1】updateGlue / rollback / rollbackToVersion 绕过归属守卫 —— 确认

**报告声称**：三个配置/代码写面完全绕过 NF-03/AUTH-02 守卫。

**实际读到的代码**：
- updateGlue：controller L470-490 有 `@CurrentUser() user`（仅用于审计 L481-488）但 L476-480 调 `updateGlue(id, body.source, body.language)` 不传 user；service L587-594 无任何 assert 调用。
- rollback：controller L766 `this.taskService.rollback(id, dto)`；service L1248-1314 全程无守卫（改 gitCommit + 直接触发执行）。
- rollbackToVersion：controller L796 `this.taskService.rollbackToVersion(id, versionId)`；service L2167-2181 无守卫（`Object.assign(task, version.snapshot)` 整体覆盖配置）。
- 控制器类级仅 `@UseGuards(JwtAuthGuard)`（L71），无 `@Roles`；三个方法上也无任何守卫装饰器。守卫在相邻的 update（L543、L551）与 remove（L599）上确实存在，属明显漂移而非产品决策（AUTH-02 注释明确 trigger/pause/resume 是「viewer 只读」执行面，与本三条「配置/代码写面」不同类）。

**判定**：成立。任意登录用户（含 viewer）可改写他人任务的执行代码（glue）、gitCommit 并触发执行、整体回滚配置。

**测试覆盖/缓解**：`task-owner-guard.spec.ts` 只隔离测守卫函数矩阵（describe 名即 `TaskService.assertCanWrite`），不测端点接线；`task.controller.endpoints.spec.ts:284-288` 断言 `updateGlue` 以 3 参调用（无 user）——同样把缺口固化。service 层无 RBAC 回归。

**复核补充（报告未提）**：updateGlue 与 rollback 还叠加 R-01 同型掩码回写（见 R-01 复核补充），守卫修复与掩码修复应同批进行。

---

### R-04【P1】已删除用户的有效 JWT 返回 404 而非 401 —— 确认

**报告声称**：`users.service.findById` 恒抛 NotFoundException；jwt.strategy 与 refreshToken 仍用它，`if (!user) throw new UnauthorizedException` 是死代码。

**实际读到的代码**：
- `users.service.ts:140-144`：
  ```ts
  async findById(id: number) {
    const user = await this.usersRepository.findOne({ where: { id } });
    if (!user) throw new NotFoundException(`User #${id} not found`);   // ← 恒抛 404
    return user;
  }
  ```
- `jwt.strategy.ts:92-93`：
  ```ts
  const user = await this.usersService.findById(payload.sub);
  if (!user) throw new UnauthorizedException("User not found");        // ← 不可达
  ```
- `auth.service.ts:293-294`（refreshToken）：`const user = await this.usersService.findById(payload.sub); if (!user || !user.isActive) throw new UnauthorizedException();`——`!user` 分支同样不可达。
- `findByIdOrNull` 已存在（users.service.ts:152-156），但其 docstring 自相矛盾："Auth flow paths keep using findById() so they can still produce a clean UnauthorizedException"——findById 产生的是 404 不是 401，说明 H-3 修复只落了辅助方法、没换调用点，还留下了错误的注释依据。

**判定**：成立。已删除用户持旧 access token 访问任意接口得到 404 "User #N not found"（泄漏存在性与数字 id），refresh 路径同型。

**测试覆盖/缓解**：`jwt.strategy.spec.ts` 全程 mock `findById`（L129/149/163/177）且从未返回 null/抛 NotFoundException——删除用户场景无测试。无任何缓解代码（无 try/catch、无全局过滤器把 NotFound 映射 401 的逻辑）。

---

### R-05【P1】TOTP 路径缺 clearExpiredLock —— 确认缺陷，但建议改级 P1→P2

**报告声称**：`totpVerifyLogin`（auth.service.ts:132-184）检查 lockedUntil 后直接进入校验，没有 login() L83-85 的 clearExpiredLock，锁过期后一次失败立即重锁 15 分钟，等效永久锁。

**实际读到的代码**：
- `login()` L83-85（R10 修复在场）：
  ```ts
  if (user && user.lockedUntil) {
    await this.usersService.clearExpiredLock(user.id);
  }
  ```
- `totpVerifyLogin()` L138-180：L140-147 检查 `lockedUntil > now` 即 401；**无 clearExpiredLock**；L173-179 验码失败 → `recordLoginFailure`（failCount 仍为 5 → 跨阈值立即再锁）。方法 docstring（L128-130）声称 "Failure counter semantics mirror login()"——与实现矛盾，报告判断准确。
- `clearExpiredLock`（users.service.ts:266-277）为条件 UPDATE，仅清真正过期的锁，语义无副作用风险。

**判定与理由**：缺陷在代码层成立。但报告的「等效永久锁」影响评估漏了一个关键缓解事实：**标准 UI 流程两段式登录必先经过 /auth/login**——`LoginPage.tsx` 先调 login（TOTP 用户返回 `{totpRequired:true}`，此调用已执行 clearExpiredLock 重置 failCount），再调 `/auth/totp/verify`。因此「锁过期后错一次立即再锁」在 Web UI 正常流程中不可达；可触达面是**绕过 /auth/login 直接调 `/auth/totp/verify` 的非 UI 客户端**（该端点公开独立可调，auth.controller.ts:262，收 username+password+code 三元组）。故建议降级 P2：真实缺陷 + 状态机不一致应修，但不是 P1 级「重要功能失效」。

**测试覆盖/缓解**：`auth.service.spec.ts:146-176` 的 R10 断言只覆盖 login 路径；`auth.totp-sessions.spec.ts:145-210` 覆盖错误码→recordLoginFailure，但**没有**「过期锁 + verify」场景。UI 流程的 login-first 时序是唯一事实缓解。

---

### R-06【P1】广播不占坑、回调统一释放导致计数漂移 —— 部分确认（释放机制证伪），建议改级 P1→P2

**报告声称**：dispatchBroadcast 无占坑 UPDATE；handleCallback/killExecution 对每个上报执行器 `releaseExecutorSlot()` → 每个执行器 `runningTaskCount` 被减 1（从未加过），容量闸门系统性漂移。

**实际读到的代码**：

成立的一半——广播不占坑：
- 单播占坑 `executor.service.ts:1244-1254`（条件 UPDATE `runningTaskCount + 1` WHERE 容量/在线），派发失败回滚减 1（L1342-1349）。
- `dispatchBroadcast`（L1379-1530）：过滤 ONLINE → `Promise.allSettled` 逐执行器 POST/pull 入队，**全程无任何 runningTaskCount 写入**。→ 广播负载对单播容量闸门（`runningTaskCount < max`）不可见，这一半成立。

证伪的一半——「回调统一释放 → 每执行器减 1」：
- `task.processor.ts:130-141`：**广播执行从不落 executorAddress**：
  ```ts
  const isBroadcast = task.executeMode === "broadcast";
  const rawResult = isBroadcast ? await this.executorService.dispatchBroadcast(task, exec) : ...
  if (!isBroadcast && exec.executorAddress) {          // ← 广播跳过落库
    await this.execRepo.update(exec.id, { executorAddress: exec.executorAddress });
  }
  ```
  dispatchBroadcast 本体也不给 `exec.executorAddress` 赋值；回调终态 UPDATE 的 patch（task.service.ts:1886-1923）不含 executorAddress。
- `task.service.ts:1970-1980`：
  ```ts
  const winnerAddress = winnerRow?.executorAddress ?? execution.executorAddress;  // 广播两者皆 null
  await this.releaseExecutorSlot(winnerAddress);
  ```
- `task.service.ts:1316-1317`：`releaseExecutorSlot(address?) { if (!address) return; ... }` —— **广播回调的释放是 no-op 早退**。killExecution 同型（L2306-2313 取 RETURNING 的 null 地址后调 L2313，同样早退）。

即：广播执行**既不加也不减**。报告主张的「从未加过却被减 1 → 系统性虚减 → 超卖」的漂移机制不存在；真实缺陷收缩为「广播负载不计入容量账本」（欠计方向），且执行器心跳上报 `runningTaskCount`（executor-node `src/scheduler.ts:118`；admin 侧白名单采纳 executor.service.ts:810/850-854）会在 ≤30s 心跳周期内覆写纠偏，欠计窗口有界。

**判定**：部分确认。「广播不占坑」属实且值得修（修复建议中「回调释放时跳过非占坑执行器」一条已无必要——现状本就天然跳过）；「回调统一释放导致虚减」证伪。P1 的「并发计数系统性漂移」定性不成立，建议降 P2（容量闸门对广播负载盲区 + 30s 心跳自愈窗口）。

**测试覆盖/缓解**：`executor.service.spec.ts:1847+` 与 `:3140+` 的 dispatchBroadcast 测试只覆盖过滤/失败路径，无槽位断言；`:3444-3462` 已有「executorAddress 为 null → releaseExecutorSlot 早退（executor qb 不触碰）」的断言（detectLostExecutions 路径，但证实了早退语义被测试锚定）；心跳上报纠偏是既有结构性缓解。

---

### F-01【P0】Monaco 默认走公网 CDN —— 确认

**报告声称**：GlueEditor.tsx:14（实际为 :3）引入 `@monaco-editor/react`，无 `loader.config`，vite manualChunks 的 monaco-editor 是死配置。

**实际读到的代码**：
- `apps/admin-web/src/components/GlueEditor.tsx:3`：`import { Editor } from '@monaco-editor/react';`；L141-155 `<Editor height="400px" ... theme="vs-dark" />`。
- 全 src grep `loader.config|from 'monaco-editor'`：**0 命中**（monaco 相关命中仅上述 import、vite.config.ts:31、package.json）。
- `package.json:19,26`：`@monaco-editor/react: ^4.7.0` 与 `monaco-editor: ^0.53.0` 并存；后者无任何源码 import → `vendor-monaco` chunk（vite.config.ts:31）里真正被打进去的只有 wrapper，`monaco-editor` 主包与该 chunk 配置均为死重。
- `@monaco-editor/react` v4 未调 `loader.config({ monaco })` 时经 `@monaco-editor/loader` 默认从 `https://cdn.jsdelivr.net/npm/monaco-editor@*/min/vs` 加载——报告的机制描述与库的既知行为一致。

**判定**：成立。GlueEditor 消费方为 TaskDetailPage 与 TaskFormPage（Glue 编排核心面），内网/离线部署下编辑器停 loading，P0（按报告「目标部署形态」口径）成立；同时存在 CDN 供应链风险。

**测试覆盖/缓解**：`task-form-ui06.test.tsx:25` 注释「GlueEditor 重依赖（monaco）裁剪：只断言区块挂载形态」——测试主动绕开编辑器，零覆盖。无任何本地化缓解代码。

---

### F-02【P1】ParamsEditor 半受控：模板预填不显示却被提交 —— 确认

**报告声称**：value 只在 useState 初始化消费一次；TaskFormPage 模板预填后表单存储有值、编辑器显示为空。

**实际读到的代码**：
- `ParamsEditor.tsx:29`：`const [rows, setRows] = useState<ParamRow[]>(() => toRows(value));`——之后对 `value` 的任何变更都被忽略（组件内无同步 effect）。
- `TaskFormPage.tsx:1027-1029`：`<Form.Item name="params"><ParamsEditor /></Form.Item>`——antd 注入 value/onChange。
- `TaskFormPage.tsx:281-296`：模板预填为**异步** effect（`taskTemplatesApi.get(templateId).then(...)`），Promise 解析必然晚于首帧渲染，ParamsEditor 已按空值初始化；随后 `form.setFieldsValue(templateConfigToFormValues(tpl.config))`（L288）更新表单存储但不触发组件内部 rows。
- `task-template-extract.ts:42-44`：模板提取确含 `params`（空对象归一为省略）。

**判定**：成立。创建态 `?templateId=` 时模板默认参数「看不见但会随 getFieldsValue 提交」，静默数据错误。报告所述「遮掩」亦核实：触发弹窗用 `destroyOnHidden`（TaskListPage.tsx:444、TaskDetailPage.tsx:586）按挂载时序侥幸正确；TaskFormPage 本体无此保护。

**测试覆盖/缓解**：`__tests__/` 无 ParamsEditor 专项测试（task-form-page.test.tsx mock 掉了 templates 链路）；无任何受控同步缓解代码。F-38 缺口声明属实。

---

### F-03【P1】任务克隆静默丢失 6 类配置字段 —— 确认

**报告声称**：TaskListPage.tsx:167-194 的 clone payload 缺 timeoutAction、timeoutWarnRatio、maintenanceWindows、runbook、executorAffinityTags、executorAntiAffinityTags。

**实际读到的代码**：
- `TaskListPage.tsx:167-194`：payload 逐行核对与报告摘录**逐字段一致**（name/description/runtime/entrypoint/requirements/triggerType/cronExpression/timezone/fixedRate/timeout/maxRetry/retryDelay/retryableErrors/priority/params/dependencies/executeMode/executorId/executorGroup/executorTags/gitRepo/gitBranch/gitCommit/glueSource/glueLanguage/applicationId）。
- `api/tasks.ts` Task 类型（timeoutAction/timeoutWarnRatio 紧随 timeout 字段，executorAffinityTags/executorAntiAffinityTags/maintenanceWindows/runbook 依次在类型中）——6 类字段全部存在于类型与后端实体，均不在 payload 中。

**判定**：成立。克隆配置了超时策略/维护窗口/运行手册/亲和标签的任务，副本静默退回默认值，无任何提示。

**测试覆盖/缓解**：`__tests__/` 无 clone payload 断言（task-list-deep.test.tsx 不覆盖 clone 链路，F-38 所述属实）；无白名单提取等结构性缓解。

---

### F-04【P1】AI 调度建议「应用 Cron」死链 —— 确认

**报告声称**：TaskDetailPage.tsx:613 跳转携带 `suggestCron`，TaskFormPage 只读 applicationId/templateId。

**实际读到的代码**：
- `TaskDetailPage.tsx:613`：`nav(`/tasks/${id}/edit?suggestCron=${encodeURIComponent(aiSuggestion.suggestedCron)}`);`
- 全仓 grep `suggestCron`：**仅此 1 处**。
- `TaskFormPage.tsx:133-136`：`searchParams.get('applicationId')` 与 `searchParams.get('templateId')`，无 suggestCron 读取。

**判定**：成立。AI 建议无法一键落地，功能性死链。

**测试覆盖/缓解**：无（无任何针对该跳转的测试；也无临时消费逻辑）。

---

### F-05【P1】SSE 鉴权 token 进 URL 查询串 —— 确认事实，建议改级 P1→P2

**报告声称**：3 处长驻连接把 access token 拼进 URL；属已知取舍但未量化风险。

**实际读到的代码**：
- `useMetricsStream.ts:66-67`、`useExecutionsStream.ts:90-91`、`ExecutionDetailPage.tsx:184-185`：三处均为 `new EventSource(url + (token ? `?access_token=${...}` : ''))`，属实。
- **报告未展开的后端缓解面**（jwt.strategy.ts，本次复核补充）：
  - L46-50：query token 仅对 `/logs/stream`、`/metrics/stream`、`/executions/stream` 三个路径后缀放行；
  - L89-90：`payload.type !== "access"` 即拒——refresh token 无法借道；
  - P1-6 契约注释（L32-37）明确记录「query strings are logged by proxies and leak into referers」的取舍。
  - access token 默认 TTL 15 分钟（configuration.ts:138 `JWT_EXPIRES_IN || "15m"`）。

**判定**：事实成立（token 入 URL、代理日志可留存），但暴露面被后端收窄到 3 条路由 + access 类型 + 15 分钟时效，且属两端都有注释记录的自觉取舍。作为安全债应排期（ticket/短效 token 方向正确），按 P1「明确可复现缺陷」口径偏重，建议 P2。

**测试覆盖/缓解**：两个 SSE hook 有行为测试（use-metrics-stream / use-executions-stream），但只测连接/退避，无鉴权形态断言；后端三路由白名单 + type=access 即结构性缓解（详见上）。

---

### F-06【P1】access+refresh token 双双持久化 localStorage —— 确认

**报告声称**：store/auth.ts:47-52 partialize 持久化 token+refreshToken；PrivateRoute.tsx:5-10 注释与实现矛盾。

**实际读到的代码**：
- `store/auth.ts:49-53`：
  ```ts
  partialize: (state) => ({ token: state.token, refreshToken: state.refreshToken, user: state.user }),
  ```
  存储键 `autoflow-auth`，storage 为 localStorage。store 自身注释只对 access token 做了「short-lived」辩护（15m），refresh token 30 天（auth.service.ts:414-420 `expiresIn: "30d"`）随行。
- `PrivateRoute.tsx:8`：`// token is not persisted (short-lived); use refreshToken to determine...`——与 partialize 直接矛盾，报告所指属实。

**判定**：成立。XSS 得手即可窃取 30 天 refresh token（无 HttpOnly/SameSite 保护）；注释矛盾会误导维护者。P1 定级合理（管理台高危面）。

**测试覆盖/缓解**：无持久化策略测试；无内存-only/加密存储等缓解（zustand persist 即现状）。

---

### F-07【P1】ErrorBoundary 兜底页显示 i18n 原始 key —— 证伪（用户不可见），建议改级 P1→P3

**报告声称**：`ErrorBoundary.tsx:61` `withTranslation('errorBoundary')` + i18n 只注册 translation ns → 崩溃时用户看到 "errorBoundary.title" 原始 key。

**复核过程与反证**：
1. 组件代码本身确有报告所述缺陷面：`components/ErrorBoundary.tsx:61` `const ErrorBoundary = withTranslation('errorBoundary')(ErrorBoundaryBase);`，L37/51 `t('errorBoundary.title')`/`t('errorBoundary.reload')`；`i18n/index.ts:44-53` 仅注册 `zh/en: { translation: ... }`、无 fallbackNS；key 以扁平形式存在于默认 ns（`locales/zh.ts:1977-1979` `'errorBoundary.title': '页面出现异常'`）。若该组件被挂载，i18next 在未注册的 `errorBoundary` ns 下解析失败会回显 key——机制推断本身没错。
2. **但该组件零引用**：全 src grep `components/ErrorBoundary`（import 语句）**0 命中**。
3. 实际挂载的兜底是另一套：`main.tsx:4,38-44`：
   ```tsx
   import { ErrorBoundary } from 'react-error-boundary';
   import ErrorFallback from './components/ErrorFallback';
   ...
   <ErrorBoundary FallbackComponent={ErrorFallback}>
   ```
   `ErrorFallback.tsx` 使用 `useTranslation()`（默认 ns）+ `errorFallback.title` 等 key，i18n 正常——测试 `state-feedback-ui08.test.tsx:66-74` 明确断言渲染文案 `'页面出错了'` 并通过。

**判定**：证伪（就「用户可见影响」而言）。应用崩溃时用户看到的是经过测试的正常兜底页；带 i18n 缺陷的类组件是**死代码**，真实问题是未清理（与 F-23 的 App.tsx 同类），建议改级 P3 并删除或修正 `withTranslation()`。原报告在待复核项中已自我标注「基于语义推断、未运行验证」——本次以挂载关系复核落定。

**测试覆盖/缓解**：实际生效路径有测试（state-feedback-ui08）；缺陷组件无测试也无挂载点（双重「不存在」）。

---

### F-10（附带核对，原报告 P2）listAllTasks 全量聚合 —— 确认（表述小修正）

- 机制属实：`api/tasks.ts:163` `TASK_LIST_PAGE_CONCURRENCY = 6`、`:170` `TASK_LIST_MAX_PAGES = 100_000`、`:236+` listAllTasks 分页聚合（含严格一致性校验）。
- 消费方属实：`TaskFormPage.tsx:195-203` 上游依赖下拉全量拉取（注释自认「分页拉全，取 id+name」）；`TaskDependencyGraph.tsx:16,39` 经 `useAllTasksForDag`（`queries.ts:242-248`，staleTime 60s）消费。
- **修正**：TaskDependencyGraph 位于 TaskDetailPage 的 deps Tab（L398+ items 配置），antd Tabs 默认懒挂载——全量拉取发生在 **deps Tab 首次激活**时，并非报告所称「进入详情页即拉」。请求放大的架构性判断不变。
- 测试：task-form-page.test.tsx mock listAll 断言调用；tasks.api.test 锚定分页校验（F-38 所述属实）。

### F-11（附带核对，原报告 P2）日志面板无虚拟化 —— 部分确认

- 属实部分：`ExecutionDetailPage.tsx:85/87` `LOG_PAGE_LIMIT=2000`、`LOG_MAX_PAGES=200`；`fetchAllLogLines`（L290-305）最多 200 页全量拉取 join；全量字符串进 `<pre>`（L792-815），maxHeight 500 仅为视觉滚动。
- 夸大部分：「256-280 logSegments 逐行切 span、全部渲染」——实际代码在**无关键词路径**做了聚合优化（L262-278：非高亮行持续并入单一缓冲块，注释「无高亮行聚合为单块，控制节点数量」），DOM 节点数远小于行数；逐段切分仅发生在搜索高亮路径（`buildLogSearchSegments`）。真实成本主要是 40 万行的字符串 join/split 内存与 CPU 峰值，而非「逐行 span 全进 DOM」。
- 结论：性能债成立（P2 合理），机制描述需按上述修正；无虚拟化缓解代码，无相关专项测试。

---

## 三、误报与改级建议汇总

| # | 类型 | 编号 | 说明 |
|---|---|---|---|
| 1 | 机制误报 | R-06（释放侧） | 「回调统一释放 → 每个上报执行器被减 1」不成立：广播执行 executorAddress 恒为 null（task.processor.ts:137 仅非广播落库），handleCallback/killExecution 的 winnerAddress 为 null，releaseExecutorSlot 首行早退（task.service.ts:1317）。广播计数「既不加也不减」，无系统性虚减漂移；真实缺陷收缩为「广播负载对容量闸门不可见（欠计）+ 心跳 30s 自愈」 |
| 2 | 影响面误判 | R-05 | 「等效永久锁」忽略标准 UI 两段式登录必先过 /auth/login（其中已 clearExpiredLock）；可触达面仅限绕过 login 直调 /auth/totp/verify 的非 UI 客户端 → 建议降 P2 |
| 3 | 整条误报 | F-07 | 缺陷组件 components/ErrorBoundary.tsx 零引用（死代码）；实际挂载 main.tsx:38 的 react-error-boundary + ErrorFallback（i18n 正常且有测试断言「页面出错了」）。用户永远看不到原始 key → 建议降 P3（死代码清理） |
| 4 | 严重度偏高 | F-05 | token 入 URL 属实，但后端已限 3 条 SSE 路由 + type=access + 15min TTL（jwt.strategy.ts:46-50、configuration.ts:138），两端注释均记录取舍 → 建议降 P2（改进方向 ticket/短效 token 仍值得做） |
| 5 | 严重度偏高 | R-06（整体） | 占坑缺失是真实一致性缺口，但按修正后的影响（欠计 + 有界自愈窗口）建议 P1→P2 |
| 6 | 范围低估（补充） | R-02 | 缺陷不止 TaskController 的 batch/delete：同模块注册的 TaskBatchController（/tasks-batch/*）四个批量端点全部漏传 user（task-batch.controller.ts:56/85/114/144），修复需两处同改 |
| 7 | 范围低估（补充） | R-01 | 同型掩码回写还存在于 updateGlue（task.service.ts:587-591）与 rollback（L1252+L1258），报告仅在待复核 W-2 中怀疑 updateGlue——复核确认两处均实际成立，应随 R-01 一并修复 |
| 8 | 表述偏差 | F-11 | 「逐行切 span 全进 DOM」仅搜索高亮路径成立；默认路径已有聚合为单块的优化（ExecutionDetailPage.tsx:262-278），夸大了 DOM 侧影响 |
| 9 | 表述偏差 | F-10 | DAG 全量拉取发生在 deps Tab 首次激活时（antd Tabs 懒挂载），非「进入详情页即拉」 |
| 10 | 佐证细节偏差 | R-01 旁证 | task.service.spec.ts 中 `secrets` 命中约 12 行（provider 装配 + 注释）而非「仅 1 行注释」，但「无行为级回归断言」的实质成立 |

---

## 四、复核方法备注

- 所有证据均在 HEAD 0ef3bbe 工作区直接读取，报告引用的 file:line 除 F-01（GlueEditor import 实为 :3 而非 :14）外均准确或偏差 ≤3 行。
- 测试覆盖核查以 `__tests__`/`*.spec.ts` 全文 grep + 关键文件抽读为准，未运行测试套件。
- R-06 的反证链（广播不落 executorAddress → 释放 no-op）由 task.processor.ts:130-141、task.service.ts:1886-1980、task.service.ts:1316-1324、executor.service.ts:1379-1530 四段互证，并有 executor.service.spec.ts:3459-3461 的早退断言佐证。
- F-07 的反证链（零 import + main.tsx 实际挂载 + 生效组件有测试）由全仓 grep、main.tsx 全文、state-feedback-ui08.test.tsx 三方互证。

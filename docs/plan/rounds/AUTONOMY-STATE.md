# AUTONOMY-STATE — 状态卡（R278 收尾交接版 · ≤50 行）

**基线**：`9c1d58cd`（R277）→ 本轮 **3 个提交**（R278-INBOX-01 `54ea04f7` / R278-DEC-01 `13368858` / R278-GUARD-01 `6a4b1141`）· **守卫链 121 段，121/121 = exit 0**
**会话**：第 278 轮 · **产品视角轮**（PM 立项 + 4 个 agent 编排）· 任务书 `artifacts/autonomy/R278/brief.md`

## 本轮主线：把「待办收件箱」从「少报且不说明少报」变成「可对账」

**五个用户现象 → 一个根因**（侦察 `R278/recon-approvals.md`）：
顶栏 3 vs 列表 7（会话口径 vs 审批单口径）· 第 51 个会话凭空消失（截断无标记）·
转圈/偶发读取失败（51 次请求共用 60/min 限流桶）· 200 被钳到 100 · 部署只显示 20。
根因 = 前端「先拉 50 个 `waiting_input` 会话，再逐个 `listApprovals`」。
⇒ **不做五个补丁，做一次搬迁**：聚合到服务端，一次返回带信封的行 + 计数 + 截断 + 降级。

## 落地产物

- **后端**（新 `agent-inbox.service.ts` +218）：`GET /agent/approvals/pending`、
  `GET /agent/inbox/counts`。`total` 是独立 `count()`、`sessionTotal` 是
  `COUNT(DISTINCT sessionId)`、标题一次 `In(...)` ⇒ **查询数与会话数无关**。
  `truncated = returned < total`；`total=null` 时 `truncated:false`、未知由 `degraded` 说。
  装配缺失 ⇒ **503，不回 200 空信封**。
- **前端**：`listApprovals` 调用**归零**（`toHaveBeenCalledTimes(1)` 钉死）；计数 5 请求 → 1。
  顺带修两条真缺陷：计数全未知时原渲染「当前没有待你处理的事项」；无 `total` 时
  原把已取条数渲染成「共 N 条」。
- **决策收口**：A4 / H1 / D1（`--json` 取值形态）/ B4 / B5 已定并落地；12 条**明确不做并写理由**。
- **守卫盲区**：`check-agent-stub-fidelity` 的 `declaredTypeOf()` 不容 `?`，认不出
  `@Optional()` 标准写法 `x?: T | null` ⇒ 一条误判造两条红。已加固（`\??` + 只剥
  `| null`/`| undefined`）+ 补替身 `list` 真实现（**零豁免**）。反证：去掉 `\??` ⇒ 红。

## 验证（真实 exit，**级别不越级**）

- 守卫链 **121/121 = 0**；`check:agent-stub-fidelity` 0 + selftest **17/17**。
- 后端 `npx jest` **494 套件 / 8305 例** 绿（新增 inbox 16 例）；`route-authz-matrix` 10/10（262 路由）。
- 前端 `vitest run` **337 文件 / 2661 例** 绿（新增 45 例）；双端 tsc/eslint 0。
- 生成物：`openapi:export` + i18n 注入 **1793/1793**；`gen:api-types` +130 行；
  `check-openapi-response-schema` 249/262（棘轮已 `--update`）。
- **未覆盖（如实）**：真 PG/Redis 集成、生产包浏览器 E2E **均未跑** ⇒「429 是否真发生」
  仍是**侦察推断**，未实测复现。

## 剩余 backlog（上一轮主表 **3** 条不变，全部外部阻塞）

`ci-pg-race-unverified` · `web-flake-not-reproduced` · `release-notice-ops`。

## 下轮第一步（按产品价值排序，建议只取 1 条）

1. **把「429 是否真发生」从推断升到实测**（M）：起真 PG/Redis + 造 60+ 待审会话，
   观察旧实现是否 429、新实现是否一次成功。这是本轮唯一没闭合的**证据缺口**。
2. **`backlogged` 小节统一到 D2 新口径**（S）：它仍用旧 `truncated`+`probed` 的 `3+` 文案，
   与其余小节不一致（本轮按纪律保留未改）。
3. **审批单删除/过期的可观测性**（M）：`agentApprovals` 现在只数 `status='pending'`，
   但 `expired` 从不进任何计数 —— 运营看不到「没人处置而自动过期」的量。
4. `approvals` 服务侧 10 个方法**没有任何 `agent-*.mjs` 替身**（既有范围外盲区），补替身或登记。

## 方法学（本轮新增 511–512，累积见 `AUTONOMY-STATE-ARCHIVE.md` / `PLAN-CLAIMS`）

- **511** 产品视角的第一件事是把 N 个现象归到**一个根因**，然后决定「**不做哪几个补丁**」。
  五个现象逐个修会得到五份截断逻辑；归因后正确解是搬迁，且**删掉的代码比新增多**。
- **512** `null` 与 `0` 的区分要在**契约层强制**，不能靠前端记得。做成响应信封必填字段后，
  「读失败渲染成没有」被类型系统挡住 —— 而同类错误此前已在本仓以两种形态复发三次。
# AUTONOMY-STATE — 状态卡（R289 收尾交接版 · ≤50 行）

**基线**：`bda8c9ce`～`bbd3e0ae` · 本轮 **4 个提交**（R289）· **守卫链 123 段，123/123 = exit 0**
**轮次特征**：PM 编排 4 Agent（`be-sop` / `fe-sop` / `sec-cli` / `qa-auditor`）四阶段看板流水线，跨角色拦截 5 处高危缺陷并达 **级别 4b 真机浏览器终验**。

## 已交付（用户可见面，R289）

| 项 | 一句话 |
|---|---|
| `blocked` 工单单条可处置 | 新增 `POST /api/sop/assignments/:assignmentId/cancel`（可选 `reason<=500`）+ `/inbox` 阻塞/澄清深链直达 `/sops?sop=<id>&assignment=<aid>` 高亮目标行与澄清 → 二次确认单条取消 → 衔接重派（**不误杀同 SOP 兄弟工单**） |
| 取消后防复活 CAS + 拒答 | 内联修 `sop.service.ts:714`（`pollPending`）与 `:1046`（`ingestClarification`）缺 `status` 谓词的并发复活漏洞；`humanReply` 拦 `cancelled\|completed`、放行 `failed` |
| 审批预览值级脱敏（C1） | `sanitize-secrets.util.ts` 单点补 PEM（多行/转义 `\n`/未闭合保尾）、裸 JWT、供应商前缀、`redis://:pass@host` 空用户名、`Authorization: Basic` 先行序与词元级高熵通道 A/B（扫 168 份 spec 零误伤） |
| CLI `deploy stop` 确认门（A3） | `acf deploy stop` 补 `-y/--yes` + `confirmDestructive`（非 TTY 缺 `--yes` 返码 2 且 0 请求），收口 `OPEN-DECISIONS.md` A3 |
| 529 弱等待清扫（#2） | `settings.ai-providers-load-error.test.tsx` 改等终态文案 `findByText('按用途选用模型')` + deferred Promise 钉死在途骨架帧，连跑 5 轮 20/20 零偶发 |

## 验证（真实 exit · 按 AGENTS.md §4.4 定级）

- **级别 4b（真浏览器+真后端+真 PG/Redis）**：`level4b-sop-cancel-e2e.mjs` **7/7 Steps = 0**（A 取消、兄弟单 B 保持 `blocked`、`audit_logs` 三类凭据全脱敏、`/inbox` 双节 `2→1`）。
- **级别 3（真 PG/Redis+真 Nest）**：`sop-assignment-cancel.integration.spec.ts` **4/4 = 0**（含 `Promise.all` 行锁并发双取消 1 胜 200 / 1 败 400）。
- **级别 2 & 守卫**：SOP 后端 **24 套 415 例** · C1 **51/51** · CLI **16 套 466 例** · 前端相关 **13 套 149 例** · `openapi-response-schema` 上探 **251→252** · 守卫链 **123/123 = 0** · 11 组反证 `matched/total = 1.0` 且 `check:mutation-residue = 0`。

## 未结项（如实，勿当缺陷）

- **23 条 `runtime-optional` query 欠账**（`scripts/query-param-required-allowlist.json`，跨 7 个 controller，`reviewBy 2027-03-31`）：本轮为保写域聚焦未并入。
- `apps/admin-web/e2e/agent-session-journey.spec.ts:145` 离线夹具未登记 R278/R280/R286 新增的 4 条顶栏/收件箱轮询路由（存量夹具漂移，非本轮引入）。
- 在途 `sop_review` Agent 直调 `SopService.replyClarification` 与取消含 `resolution IS NULL` 澄清单的 `sweepStuckClarifications` 通知属已知残余（不动 `sop.service.ts` 1708 顶格逻辑）。

## 下轮第一步（按价值排序，取 1 条）

1. **批量收口 23 条 `runtime-optional` query 欠账**（7 个 controller 补 `@ApiQuery({required:false})` + OpenAPI 五步重导出 + 回收 allowlist）。
2. 补齐 `apps/admin-web/e2e/agent-session-journey.spec.ts` 离线夹具的 4 条收件箱/顶栏 mock 路由，恢复 `test:e2e:agent` 4/4 全绿。
3. 推进 `AGENT_HANDOFF.md:460` 直接 API 客户端在 Agent 会话 `running` 态处理新审批单的竞态验证。

## 方法学（本轮 534–536，承 533）

- **534** 前端分支禁止硬编码猜测的 HTTP 状态码（如误猜 409），必须查后端错误目录或按 `errorCode` 判定（`SOP_ASSIGNMENT_TERMINAL` 实为 400）。
- **535** 新增「取消/终态」写路径时，必须反向审计同表所有非终态 CAS `UPDATE` 是否带了 `status NOT IN (terminal)`，否则在途 `poll`/`ingest` 会把已取消行原地复活。
- **536** 正则字符类 `[...]` 内的 `-` 必须置尾或转义为 `\-`；中置 `=-\\` 会静默变成 ASCII 区间 `61..92`（吞入 `> ? @ [`），只能靠边界字符对抗探针抓出。

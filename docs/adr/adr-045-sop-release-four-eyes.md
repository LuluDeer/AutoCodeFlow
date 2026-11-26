# ADR-045: 方案卡发布的四眼审批与系统代理发布

状态：Accepted（决策为"业务人员提交→四眼审批→系统代理发布，业务人员永不拿到 publish 权"）
- 日期：2026-11-27

## 动机（背景与判据来源）

GCO §5 杀手锏旅程「业务人员自然语言→方案卡→审批→执行→交付物」在第 70 轮后仍断在"方案卡→审批→执行"：业务人员能进 /workbench、commit 能落 SOP draft，但草稿只能到 ADMIN-only 的 /sops 页 publish，业务人员无法自己推进到执行。上一轮交接明确这是 blocks_usage 断点。

ADR-044 同时钉死硬边界：**发布权=指令注入权，业务人员不直接 publish**。所以不能用"给业务人员 publish 权限"来打通旅程——那会让业务人员拿到管理面。

两路 CodeGraph 审计确认了可复用的现成语义：

1. `agent-approvals.service.ts:299-407 request()` 产出 scope 硬写 once 的 pending 单，`:434-482 decide()` 条件写保证一次点头一次执行，`:890-941 consume()` 把 policyFingerprint 放进 WHERE 原子失效，`:286-295 buildKey()` 确定性键（同 draft 同参命中同一单）。
2. `sop.service.ts:329-457 publish(input)` 不校验 publishedBy 身份，只要受控调用点传系统身份即可走完整严格校验（body scan block、contentHash 判重、版本 CAS、audit）。
3. 四眼原则只在 `agent.controller.ts:650-661` controller 层且默认关闭（单人部署）；`phrase` 端点（`:893-973`）**整条无自批校验**。
4. 两处 createdBy 口径不同：session 是 `user:${username}`（`:500`），draft 是 `user:${user.id}`（workbench.controller.ts:370）——不能混用，四眼必须用 session 口径。

## 决策（方案）

**业务人员 commit 落 draft 成功后，系统建发布审批单；主管四眼 approve 后由系统代理调 `sop.publish`，业务人员与主管都不直接调用 publish 端点/`sop_publish` 工具。**

链路六步：

1. **建单**：commit 五道闸与 `sops.draft()` 逐字不动；draft 成功后建 `sop_review` session，`createdBy=user:${username}`（四眼申请人），以 `toolName='sop_publish'`、`args={sopId,cardHash,contentHash,bump}` 调 `request`，`argsDigest=computeApprovalArgsDigest(args)`、`preview=buildArgsPreview(args)`、`policyFingerprint=computeApprovalPolicyFingerprint(...)`。
2. **审批**：主管走 grant 端点 `decideApproval`（含服务端四眼）；发布审批单（`toolName='sop_publish'`）在服务端**强制**自批校验，不依赖 `agent.policy.blockSelfApproval` 配置开关。
3. **phrase 禁用**：`sop_publish` 审批单不得经 phrase 端点批准（phrase 无自批校验）；发布审批单的 approvalKey 在 phrase 路径显式拒绝。
4. **消耗发布**：主管 approve 后系统代理 `consume(approvalKey, 当前指纹)` 成功才调 `publish({sopId, publishedBy:'agent:tool-call', audit})`；失败语义：指纹变更/自批/非 pending/consume 失败一律不 publish。
5. **内容锚定**：系统代理 publish 前重读 draft 比对 `contentHash` 与审批 args 中的一致，防止"主管批后业务人员改 draft"借审批注入。
6. **publishedBy**：固定写系统身份 `agent:tool-call`，不写业务人员/主管个人身份（发布权审计不失真）。

## 影响面（后果与代价）

- 正向：GCO §5 的"审批→执行"一跳从"人工去 ADMIN 页 publish"变成"业务人员提交、主管审批、系统发布"，业务人员拿到业务结果但不拿管理权；四眼与策略指纹失效继续有效。
- 代价：新增一个编排 service（建 session + request + consume + publish）+ commit 末尾追加调用；`agent.controller` 需在 grant/phrase 路径识别 `sop_publish` toolName 做强制四眼与 phrase 禁用；均为结构性增量，不改审批/发布内部。
- 验收：真 PG 进程内 e2e 断言实际副作用——commit 后 approvals +1/sop_versions 0；自批 403；主管 approve 后版次 +1 且 publishedBy=系统身份；指纹变更与内容篡改均不 publish；重复 approve 409 且只发一次。

## 替代方案（被否）

- **让业务人员直接 publish（哪怕受限 bump）**：发布权=指令注入权，与 ADR-044 直接冲突，业务人员拿到管理面。
- **放开 SopController 类级 ADMIN**：会连带放开 publish/assign/clarification/cancelAssignment 全部管理写面。
- **走 phrase 端点批准发布审批**：phrase 整条无自批校验，主管之外的人（甚至申请人）可用短语绕过四眼。
- **审批单不绑 contentHash**：主管批准后 draft 被改仍放行，是借审批做指令注入的最隐蔽路径。
- **publishedBy 写业务人员或主管个人身份**：发布权审计失真，无法区分"谁发起/谁批准/谁执行"。

## 回滚

- commit 末尾的审批请求调用以 feature 开关（默认开）包裹，关闭即回到"只落 draft、需 ADMIN 页 publish"的上一轮行为，draft 与五道闸不受影响。
- 系统代理发布 service 独立文件，摘掉 workbench.controller 接线即无副作用；既有 SOP/publish/审批语义不改，回滚零数据迁移。

## 分步计划

1. （本 ADR）固化发布审批契约与红线；更新 strategy/GCO 的 N4/N7/N16 相关状态指向本 ADR。
2. 新建 `workbench/release-approval.service.ts`（建 session + request + consume + publish 编排）+ 单测。
3. `agent.controller` grant 路径对 `sop_publish` 强制四眼、phrase 路径禁用 + 单测。
4. `workbench.controller.commit` 末尾追加审批请求（五道闸/draft 逐字不动）+ 真 PG e2e。
5. 审计 action 与文档同步，`test:guards:chain` 全绿后分批提交。

## 明确不做（本轮）

- 不改 `sop.service.ts publish()` 内部任何校验/body scan/CAS/audit。
- 不改 `agent-approvals.service.ts` 的 request/decide/consume/buildKey/指纹/argsDigest/canonicalJson。
- 不新增 resource 列或迁移；SOP id 经 args.sopId 锚定。
- 不放开 SopController 类级 ADMIN、不把 sop_publish 加入任何 USER 工具白名单。
- 不改 UserRole/RolesGuard/引擎级 restrict deny/五道闸/四眼与 phrase 既有逻辑（只在发布审批专用路径强化）。

## 证据锚点

- `apps/admin-api/src/modules/agent/runtime/agent-approvals.service.ts:286-295,299-407,434-482,890-941`（buildKey/request/decide/consume）
- `apps/admin-api/src/modules/sop/sop.service.ts:146-153,329-457`（PublishSopInput/publish）
- `apps/admin-api/src/modules/agent/agent.controller.ts:650-661,893-973`（四眼默认关闭/phrase 无自批）
- `apps/admin-api/src/modules/workbench/workbench.controller.ts:251-427`（commit 只落 draft + 五闸）
- `apps/admin-api/src/modules/agent/entities/agent-session.entity.ts:31-45`（sop_review kind 已存在）
- `docs/adr/adr-044-enterprise-control-client-autonomy.md:21,34`（发布权硬边界）

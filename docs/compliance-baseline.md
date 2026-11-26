# N21 合规基线

> **受众**：合规/安全评审、运维、开发 · **状态**：稳定 · **最后核对**：2026-11-26
> 一页说明 AutoCodeFlow 当前合规相关能力、代码证据与待补项；本页只描述代码现状，测评结论由正式报告给出。
> 安全策略见[安全策略](../SECURITY.md)，红线回归见[安全红线回归清单](SECURITY-REDLINE-CHECKLIST.md)。

## 一、等保二/三级映射

| 控制项 | 本仓映射 | 状态 | 代码证据 |
|---|---|---|---|
| 身份鉴别 | 本地账号密码经 bcrypt 校验；JWT access/refresh 双令牌；TOTP 二段验证；OIDC SSO 绑定/首登。 | 已有能力 | `apps/admin-api/src/modules/auth/auth.service.ts:69-153`、`auth.service.ts:162-243`、`auth.service.ts:618-662`、`apps/admin-api/src/modules/auth/oidc.service.ts:507-577`、`apps/admin-api/src/modules/auth/totp.util.ts:91` |
| 访问控制 | 全局 `RolesGuard` 校验 `UserRole`；项目成员角色 `viewer/editor/admin` 与写面档位判定。 | 已有能力 | `apps/admin-api/src/common/guards/roles.guard.ts:17-35`、`apps/admin-api/src/modules/project/entities/project-member.entity.ts:27-41`、`apps/admin-api/src/modules/project/project-access.service.ts:170-178` |
| 审计 | `audit_logs` append-only 触发器；Q7 180 天保留；列表/CSV/keyset 共用过滤与分页。 | 已有能力 | `apps/admin-api/src/modules/audit/audit.service.ts:120-142`、`audit.service.ts:165-173`、`audit.service.ts:410-483` |
| 数据完整性 | 执行产物清单带 `sha256`；提示指纹/工具指纹使用 canonical JSON + SHA-256。 | 已有能力（局部） | `apps/admin-api/src/modules/task/entities/task-execution.entity.ts:187-191`、`apps/admin-api/src/modules/task/dto/execution-callback.dto.ts:90-108`、`apps/admin-api/src/modules/agent/runtime/agent-runtime.service.ts:163-174`、`agent-runtime.service.ts:207-216` |
| 入侵防范 | HTTP(S) scheme、DNS、私网/环回/云元数据分层出站闸；任务沙箱默认 opt-in 并有 compose 守卫。 | 已有能力 | `apps/admin-api/src/common/utils/safe-http.util.ts:461-543`、`apps/executor-node/src/lib/ssrf-guard.ts:74-112`、`scripts/check-compose-sandbox.mjs:63-81`、`check-compose-sandbox.mjs:260-295` |

> 注：本表的“已有能力”指仓库实现存在；二/三级测评项是否达标仍由部署形态与测评材料决定。

## 二、日志留存

- **6 月口径**：Q7 以 `180 * 24 * 60 * 60 * 1000` 计算截止点，每日 02:05 执行；`retentionDelete` 是唯一审计删除实现，分批 5000 行，在事务内 `SET LOCAL app.bypass_audit_guard = 'on'` 后按 `createdAt < cutoff` 删除。证据：`apps/admin-api/src/modules/audit/audit.service.ts:120-142`、`apps/admin-api/src/modules/audit/audit.service.ts:165-173`。
- **查询与导出**：`findAllByKeyset` 使用 `(createdAt, id)` 行值比较，`total` 在游标谓词前取；审计列表、CSV、keyset 共用同一过滤装配。证据：`apps/admin-api/src/modules/audit/audit.service.ts:410-483`、`audit.service.ts:75-91`。
- **append-only 边界**：`trg_audit_logs_append_only` 拒绝 `UPDATE/DELETE`，只为 retention GUC 放行 `DELETE`；`trg_audit_logs_no_truncate` 语句级拒绝 `TRUNCATE`，无逃生门。证据：`apps/admin-api/src/migrations/1790000000006-AuditLogsAppendOnlyGuard.ts:38-60`、`apps/admin-api/src/migrations/1790000000057-AuditLogsNoTruncateGuard.ts:45-65`。
- **诚实边界**：DBA/表属主可 `ALTER TABLE ... DISABLE TRIGGER` 后改删，超级用户可 `SET session_replication_role=replica` 后改删；触发器层不覆盖这两类。部署侧需收敛应用账号权限，详见[运维手册·审计防篡改（SEC-10）](operations.md#审计防篡改sec-10)。证据：`apps/admin-api/src/migrations/1790000000057-AuditLogsNoTruncateGuard.ts:33-36`、`docs/operations.md:1351-1365`。

## 三、数据分类分级

| 类别 | 本仓现状 | 状态与建议 | 代码证据 |
|---|---|---|---|
| 业务数据（任务/执行/产物） | 任务、执行记录与执行参数入库；产物清单含裸文件名、字节数与 `sha256`。 | 已有能力：基础字段与摘要；建议补正式分级标签、归档与销毁口径。 | `apps/admin-api/src/modules/task/entities/task-execution.entity.ts:409-413`、`task-execution.entity.ts:187-191`、`apps/admin-api/src/modules/task/dto/execution-callback.dto.ts:90-108` |
| 凭据（SEC-02） | `enc:v1:<iv>:<tag>:<ciphertext>` 信封；配置 `SEC_SECRETS_KEY` 时写密文，缺 key 时明文降级并告警。 | 已有能力：信封与读面掩码；建议生产强制配置密钥并补轮换流程。 | `apps/admin-api/src/common/utils/secret-crypto.util.ts:35-40`、`secret-crypto.util.ts:95-110`、`secret-crypto.util.ts:129-179`、`apps/admin-api/src/common/utils/secret-crypto.util.service.ts:32-71` |
| 遥测（匿名 HMAC） | 系统总闸 + 实例 opt-in 双闸；`install_id/user_id` 由 HMAC-SHA256 派生，原始 64-hex 指纹在 DTO 被拒。 | 已有能力：匿名派生与默认关；建议明确遥测留存期与数据出境边界。 | `apps/admin-api/src/modules/agent/runtime/telemetry-optin.service.ts:8-13`、`telemetry-optin.service.ts:43-62`、`apps/admin-api/src/common/utils/secret-crypto.util.service.ts:153-159`、`apps/admin-api/src/modules/agent/dto/agent-telemetry.dto.ts:25-39`、`agent-telemetry.dto.ts:119-124` |

## 四、公有模型出域管控

| 项 | 当前姿态 | 状态与建议 | 代码证据 |
|---|---|---|---|
| provider baseUrl | 注册条目定义为“一个 OpenAI 兼容端点定义”：id、baseUrl、key、model、参数与能力位；自定义条目可填任意 baseUrl。 | 已有能力：可配置端点；建议企业版收敛 baseUrl 域名白名单。 | `apps/admin-api/src/modules/ai/ai-providers.ts:10-15`、`ai-providers.ts:42-60`、`ai-providers.ts:188-192` |
| 路由校验 | 路由仅检查 `http(s)` 前缀、`enabled`、API Key、模型名；模型级 `allowedModels/deniedModels/modelEnabled` 可选，缺省全放行。 | 已有能力：形态与模型准入；建议与企业白名单联动。 | `apps/admin-api/src/modules/ai/ai-route.ts:140-175`、`ai-route.ts:160-167`、`ai-providers.ts:224-235` |
| supportsVideo | 视频用途要求 provider 显式声明 `supportsVideo`；`chatMultimodal` 对未声明视频能力的请求做兜底拒绝。 | 已有能力。 | `apps/admin-api/src/modules/ai/ai-providers.ts:373-384`、`apps/admin-api/src/modules/ai/ai-route.ts:140-149`、`apps/admin-api/src/modules/ai/ai.service.ts:924-929` |
| 出站闸 | admin/executor 已有 scheme、地址分类、DNS 复检、云元数据恒拒与 IP 钉扎等通用出站防线；AI provider baseUrl 当前未在本仓收敛为企业白名单。 | 已有能力：通用出站闸；待补：企业版模型端点白名单。 | `apps/admin-api/src/common/utils/safe-http.util.ts:461-543`、`apps/executor-node/src/lib/ssrf-guard.ts:74-112`、`apps/executor-node/src/lib/ssrf-guard.ts:138-195` |

## 五、待补清单

| 项 | 状态 | 说明 | 证据 |
|---|---|---|---|
| SCIM 用户生命周期 | 待补，非本仓能力 | ADR-014 明确记录不做 SCIM/组同步；当前只有 OIDC 登录、账号绑定与平台侧角色管理。 | `docs/adr/adr-014-oidc-sso.md:61-63`、`apps/admin-api/src/modules/auth/oidc.service.ts:507-577` |
| 等保测评报告 | 待补，非本仓能力 | 本仓提供控制实现与代码证据；正式测评/备案材料由测评机构与部署方产出。 | 代码证据：本页第一、二节逐项锚点 |
| 数据出境评估 | 待补，非本仓能力 | AI provider baseUrl 可由企业自定义；供应商地域、跨境传输与评估结论由部署方按实际接入完成。 | 代码证据：`apps/admin-api/src/modules/ai/ai-providers.ts:10-15`、`ai-providers.ts:188-192` |

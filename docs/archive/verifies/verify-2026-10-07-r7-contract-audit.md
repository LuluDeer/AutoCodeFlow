# VERIFY：R7 契约实证审计——openapi schema ↔ 真实响应体逐字段比对

- **日期**：2026-10-07（Linux 侧会话）
- **动机**：N-12 系列为 ~130 个端点标注了响应 schema，但全程是「读 service 源码
  推导形态」的静态标注——从未对真实 HTTP 响应体逐字段核验过。schema 若与
  实际 body 漂移，前端拿生成类型写代码会错得比没类型更 confidently。
- **方法**：真机环境（一次性 PG16+Redis7 容器 + 迁移 + dist 启动）→ API seed
  数据（任务/SOP 草稿+发布/API Key/用户/AI 配置）→ 比对脚本（/tmp 一次性，
  判定口径：EXTRA=契约漏声明键 / MISSING required=文档谎报非空；
  `required+nullable` 是 OpenAPI 3.0 合法形态——键恒在值可空，实体序列化即
  如此，不报）。

## 结果：138 findings → 甄别出 3 处真漂移 → 修复 → ALL GREEN

| # | 端点 | 漂移 | 根因 | 修复 |
|---|---|---|---|---|
| 1 | `POST /tasks`（及 update/pause/resume/rollbackToVersion 等 save() 回程） | body 多出 `webhookSecret` 键（值恒 null） | TypeORM `save()` 返回 hydrated 实体，**select:false 列以 null 形态出现在 save 回程**；而 findOne/列表等 select 读取不含该键——同一实体两种读面出现性不一致 | TaskResponseDto 补 `webhookSecret?: string \| null` 并注明出现性差异（值恒 null/掩码，明文只在 enable/rotate 一次性回显） |
| 2 | `GET /ai/config` | 契约建成 `{config:{...}, hasApiKey}`，实际是**扁平** `{provider, ..., hasApiKey}` | controller 返回 `{...effective, hasApiKey}`；首版 DTO 照「配置存储是键值对」臆测成嵌套 | AiConfigResponseDto 改扁平逐键声明（数值键在 config store 是字符串编码） |
| 3 | `POST /api-keys` | 契约建成 `{apiKey:{...}, plaintext}`，实际是**扁平** `{...view, plaintext}` | controller 返回 `{...apiKey, plaintext}`；首版照 service 签名 `{apiKey, plaintext}` 臆测 | ApiKeyCreateResponseDto 改为 extends ApiKeyViewDto + plaintext |
| - | `GET /audit` 行 | 契约漏 `result` 列（实体 46 行 `@Column({default:'success'})`） | 首版读实体时截断在 ip 之后 | AuditLogDto 补 `result` |

**佐证性的正面发现**：admin-web 手写 `AiConfig` 读模型**本来就是扁平形态**——
漂移的是后端契约而非前端（前端读模型作为唯一事实源的架构决策再次被证明
是对的）。

## 比对覆盖面（ALL GREEN 时的 9 组）

- `POST /tasks` + `GET /tasks/{id}` + `GET /tasks`（envelope 双键 + 行）
- `POST /sop` + `GET /sop/{id}` + `POST /sop/{id}/publish`（strict front-matter
  seed：target/capabilities/acceptance）+ `GET /sop`（裸 {items,total}）
- `POST /api-keys`（scope 枚举 readonly/trigger/manage）+ `GET /api-keys`
- `POST /users` + `GET /users`（paginate 双键）
- `GET /ai/config` + `POST /ai/config`
- `GET /notification/channels`（行投影）
- `GET /audit`（envelope + 行）
- `GET /metrics/summary` + `GET /metrics/scheduler`

未覆盖（如实）：部署行/执行器行需要真实执行器 seed（register 机器面 + 心跳），
二者 schema 源自实体直读 + mask 逻辑（QA1 双掩码），静态推导风险本就最低；
SSE/文件下载面无 JSON body 可比。

## 门禁

- admin-api jest 4567 例全绿；admin-web vitest 201 文件 1561 例全绿；双端 tsc
- 守卫 225/225 无倒退 + selftest 全过；gen:api-types 再生成
- R7-B 抽查：UserManagementPage 的 role 经表单字面量下拉约束，DTO 换型后
  语义与类型双过

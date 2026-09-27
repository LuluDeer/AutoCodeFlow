import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

/**
 * ARCH-23 / N-12：系统配置域（tag "System Config"）**响应体 DTO**。
 *
 * ## 为什么不能直接标 `type: SystemConfig` / `type: ConfigHistory`（实体）
 *
 * 两个实体都没有 `@ApiProperty`，@nestjs/swagger 只会 emit
 * `{type:'object', properties:{}}` —— **空壳 schema**。后果两层（本仓已在
 * Application 上实测踩过，见 `application-response.dto.ts` 头注）：
 *   ① 前端 `gen:api-types` 生成 `Record<string, never>`，比没有类型更坏；
 *   ② CI 的 PK-15 空 schema 闸直接打红（`::error:: openapi.json 出现白名单外
 *      的空 object schema`）。
 * 故必须落成带 `@ApiProperty` 的 DTO 类。
 *
 * ## 字段与「实际运行时返回」逐一对齐（含掩码语义）
 *
 * 本控制器是类级 `@BearerAuth + @UseGuards(JwtAuthGuard)` 且**读面**在
 * SEC-CFG-01 后全部收敛为 `@Roles(ADMIN)`——但"仅管理员可见"**不等于**
 * "契约可以写错"：契约是给消费方（admin-web / acf-cli / mcp-server）照着
 * 生成类型的，写错字段名或可空性会让前端按错误类型写代码。故逐端点核对：
 *
 *   · `GET /config`（findAll）：`configs.map(c => c.isSecret ? {...c, value:"***"} : c)`
 *     —— secret 行的 `value` 被替换为掩码哨兵 `"***"`；非 secret 行原值透出。
 *   · `GET /config/{key}`（findOne）：同款逐行掩码。
 *   · `PUT /config`（upsert）与 `POST /config/batch`（batchUpsert）：返回的是
 *     `repo.findOneBy({key})` / 事务内逐条 upsert 的**实体**，**不做掩码**
 *     （写面回显真实值，S3 的 `"***"` 哨兵语义只作用于读面与"提交掩码=不变"
 *     的写入判定）。故 `value` 的 description 必须同时说明两种语义。
 *   · `GET /config/history`、`GET /config/history/{key}`：`{data, total}` 包装，
 *     行级掩码（WIKI-OPT-2）：`h.isSecret === true || secretKeys.has(key)` 的行
 *     把 `oldValue`/`newValue` 掩码为 `"***"`，**但 `null` 保持 `null`**——
 *     "从未有过值"与"被掩码"是两种不同语义，契约必须区分（写错会让前端把
 *     掩码当空值渲染，或反之）。
 *   · `POST /config/history/{id}/rollback`：**联合返回**——正常回滚返回写回后的
 *     `SystemConfig`，回滚一条 `action='create'` 的历史（= 撤销创建）返回
 *     `{deleted: true}`。故用 `oneOf` 如实表达两种形态（详见控制器注解）。
 *
 * 刻意**不声明**的字段：无。实体字段即实际返回字段（`SystemConfig` 没有
 * `tag` 列——`GET /config?tag=` 是按 `description` 正则匹配的**过滤参数**，
 * 不是响应字段；admin-web 手写 interface 里的 `tag` 属既存漂移，见下）。
 *
 * ## 本批顺带查出的前端手写类型漂移（N-12 要消灭的正是这类）
 *
 *   · `apps/admin-web/src/api/config.ts` 的 `SystemConfig` 声明了
 *     `tag: string | null` —— 后端 `system_configs` 表**没有** tag 列
 *     （迁移 1717473142678），该字段永远是 `undefined`。
 *   · 同文件的 `ConfigHistory.userId: string | null` —— 迁移 1790000000023
 *     起已是 integer（PK-21），实际返回 number。
 *   · 同文件 `getRuntimeVersion` 声明了 `tier1/tier2/tier3` ——
 *     `ConfigController.getRuntimeVersion` **只返回 4 个字段**，三个 tier 表
 *     是前端本地常量（`configureRuntimeVersionConfig` 浅合并，缺字段保留默认值，
 *     故无运行时缺陷，但类型是想象的）。
 * 本 DTO 按**后端真实返回**声明，不复制上述漂移。
 */

/**
 * `GET /config`、`GET /config/{key}`、`PUT /config`、`POST /config/batch`
 * 以及回滚成功分支的单条配置行。
 */
export class SystemConfigResponseDto {
  @ApiProperty({ description: "Config row id (serial)" })
  id: number;

  @ApiProperty({
    description: "Unique config key (e.g. executor.sharedToken)",
    example: "executor.sharedToken",
  })
  key: string;

  @ApiPropertyOptional({
    description:
      "Stored value. Read surfaces (GET /config, GET /config/{key}) replace it with " +
      "the mask sentinel '***' when isSecret=true; write/rollback surfaces " +
      "(PUT /config, POST /config/batch, POST /config/history/{id}/rollback) return " +
      "the real persisted value. May be null when the row was written without a value.",
    nullable: true,
    example: "***",
  })
  value: string | null;

  @ApiPropertyOptional({
    description:
      "Human description. Also the field matched by the `tag` query filter on " +
      "GET /config (regex on description) — there is no separate tag column.",
    nullable: true,
  })
  description: string | null;

  @ApiProperty({
    description:
      "Value type. All write paths validate against this closed set " +
      "(SystemConfigService.validateConfig), so any value in the store came from it.",
    enum: ["string", "number", "boolean", "json"],
  })
  valueType: string;

  @ApiProperty({
    description:
      "True when the value is secret: read surfaces mask it as '***' and a " +
      "submitted '***' means 'keep the stored value' rather than 'write the mask'",
  })
  isSecret: boolean;

  @ApiProperty({ description: "Creation time (ISO-8601)" })
  createdAt: Date;

  @ApiProperty({ description: "Last update time (ISO-8601)" })
  updatedAt: Date;
}

/**
 * `GET /config/history`、`GET /config/history/{key}` 的单行。
 *
 * 字段与 `config_history` 实体逐一对齐；`oldValue`/`newValue` 的可空性与
 * **掩码**语义见类头注（`null` ≠ `"***"`）。
 */
export class ConfigHistoryResponseDto {
  @ApiProperty({ description: "History row id (serial)" })
  id: number;

  @ApiProperty({ description: "Config key this history row belongs to" })
  configKey: string;

  @ApiPropertyOptional({
    description:
      "Previous value. '***' when masked (row isSecret=true, or the key is " +
      "currently secret); null when the entry did not exist before. null is " +
      "distinct from the mask and must not be rendered as 'hidden'.",
    nullable: true,
  })
  oldValue: string | null;

  @ApiPropertyOptional({
    description:
      "New value. '***' when masked; null when the entry was deleted by this " +
      "change (remove records newValue=null).",
    nullable: true,
  })
  newValue: string | null;

  @ApiPropertyOptional({
    description: "Description snapshot taken when this change was recorded",
    nullable: true,
  })
  description: string | null;

  @ApiPropertyOptional({
    description:
      "valueType snapshot persisted with this row (migration 1790000000018). " +
      "null = pre-migration row, metadata unknown — do not read null as 'string'.",
    nullable: true,
    enum: ["string", "number", "boolean", "json"],
  })
  valueType: string | null;

  @ApiPropertyOptional({
    description:
      "isSecret snapshot persisted with this row (migration 1790000000018). " +
      "null = pre-migration row, metadata unknown — do not read null as false. " +
      "true always masks oldValue/newValue on the read surfaces.",
    nullable: true,
  })
  isSecret: boolean | null;

  @ApiProperty({
    description:
      "What produced this row (rollback marks rows written by the rollback endpoint)",
    enum: ["create", "update", "delete", "rollback"],
  })
  action: string;

  @ApiPropertyOptional({
    description:
      "Acting user id (integer since migration 1790000000023); null when the " +
      "actor is unknown (e.g. rows written before operator context was recorded)",
    nullable: true,
  })
  userId: number | null;

  @ApiPropertyOptional({ description: "Acting username", nullable: true })
  username: string | null;

  @ApiPropertyOptional({ description: "Acting client IP", nullable: true })
  ipAddress: string | null;

  @ApiProperty({ description: "When this change was recorded (ISO-8601)" })
  createdAt: Date;
}

/** `GET /config/history`、`GET /config/history/{key}` 的分页包装。 */
export class ConfigHistoryPageDto {
  @ApiProperty({
    description: "Page of history rows, newest first (old/new masked per row)",
    type: [ConfigHistoryResponseDto],
  })
  data: ConfigHistoryResponseDto[];

  @ApiProperty({ description: "Total matching rows before paging" })
  total: number;
}

/**
 * `DELETE /config/{key}` 的响应，也是
 * `POST /config/history/{id}/rollback` 撤销创建分支的形态。
 *
 * 语义：删除/回滚到"创建前"成功恒为 `{deleted: true}`；键不存在是 **404**，
 * 不存在 `{deleted: false}` 这种"软失败"。前端若把 `deleted: false` 当作
 * 可能分支写代码，会写出永不可达的分支。
 */
export class ConfigDeleteResultDto {
  @ApiProperty({
    description:
      "Always true on success — a missing key is a 404, never {deleted:false}",
  })
  deleted: boolean;
}

/** `POST /config/executor-shared-token/generate` 的响应（明文仅此一次）。 */
export class ExecutorSharedTokenDto {
  @ApiProperty({
    description:
      "Freshly generated executor shared token (64 hex chars). Returned once at " +
      "rotation time; the config store keeps it with isSecret=true so later reads " +
      "of GET /config return '***'.",
    example: "9f2c4a1d7b3e5f8091a2b3c4d5e6f70819a2b3c4d5e6f70819a2b3c4d5e6f708",
  })
  token: string;
}

/**
 * `GET /config/executor-shared-token` 的响应（R4 F-1：明文，ADMIN only）。
 *
 * 与 `generate` 的区别：本端点读**当前**已存令牌，键不存在时**不抛 404**，
 * 而是回退 `{token: null, hasToken: false}`（catch 分支），故 `token` 可空。
 */
export class ExecutorSharedTokenStatusDto {
  @ApiPropertyOptional({
    description:
      "Current shared token in plaintext (ADMIN only). null when no token is " +
      "stored — this endpoint never 404s for a missing key.",
    nullable: true,
  })
  token: string | null;

  @ApiProperty({
    description: "True when a non-empty token is stored (token !== null)",
  })
  hasToken: boolean;
}

/**
 * `GET /config/runtime-version`（G-1）的响应：Python 版本契约的权威下发。
 *
 * 只返回这 4 个字段——admin-web 手写类型里多出的 `tier1/tier2/tier3` 是
 * **前端本地常量**（`pages/executor-mode.ts` 的 `configureRuntimeVersionConfig`
 * 浅合并，缺字段保留默认值），后端从不返回，故不写进契约。
 */
export class RuntimeVersionContractDto {
  @ApiProperty({
    description:
      "Currently effective declareable lower bound (PYTHON_RUNTIME_VERSION_MIN, default 3.7)",
    example: "3.7",
  })
  min: string;

  @ApiProperty({
    description:
      "Currently effective declareable upper bound (PYTHON_RUNTIME_VERSION_MAX, default 3.14)",
    example: "3.14",
  })
  max: string;

  @ApiProperty({
    description:
      "Online-download floor (contract constant, not configurable): uv cannot " +
      "download interpreters below it, so those versions need an offline " +
      "pre-populated cache volume",
    example: "3.8",
  })
  onlineMin: string;

  @ApiProperty({
    description:
      "Fallback interpreter for legacy executors that report no interpreters list",
    example: "3.12",
  })
  legacyDefaultInterpreter: string;
}

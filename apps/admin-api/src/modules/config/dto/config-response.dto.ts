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
  @ApiProperty({ description: "配置行 ID（自增序列）" })
  id: number;

  @ApiProperty({
    example: "executor.sharedToken",
    description: "唯一配置键（例如 executor.sharedToken）",
  })
  key: string;

  @ApiPropertyOptional({
    nullable: true,
    example: "***",
    description:
      "存储值。读面（GET /config、GET /config/{key}）在 isSecret=true 时把它替换为掩码哨兵 '***'；写面/回滚面（PUT /config、POST /config/batch、POST /config/history/{id}/rollback）返回真实持久化的值。若该行写入时未带值，则可能为 null。",
  })
  value: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      "人类可读描述。同时也是 GET /config 的 `tag` 查询过滤所匹配的字段（对 description 做正则）—— 并不存在单独的 tag 列。",
  })
  description: string | null;

  @ApiProperty({
    enum: ["string", "number", "boolean", "json"],
    description:
      "值类型。所有写入路径都按这个封闭集合校验（SystemConfigService.validateConfig），因此库中任何值都来自该集合。",
  })
  valueType: string;

  @ApiProperty({
    description:
      "值为 secret 时为 true：读面将其掩码为 '***'，而提交 '***' 表示“保持已存值”而非“写入该掩码”",
  })
  isSecret: boolean;

  @ApiProperty({ description: "创建时间（ISO-8601）" })
  createdAt: Date;

  @ApiProperty({ description: "最后更新时间（ISO-8601）" })
  updatedAt: Date;
}

/**
 * `GET /config/history`、`GET /config/history/{key}` 的单行。
 *
 * 字段与 `config_history` 实体逐一对齐；`oldValue`/`newValue` 的可空性与
 * **掩码**语义见类头注（`null` ≠ `"***"`）。
 */
export class ConfigHistoryResponseDto {
  @ApiProperty({ description: "历史行 ID（自增序列）" })
  id: number;

  @ApiProperty({ description: "该历史行所属的配置键" })
  configKey: string;

  @ApiPropertyOptional({
    nullable: true,
    description:
      "变更前的值。被掩码时为 '***'（该行 isSecret=true，或该键当前为 secret）；此前不存在该条目时为 null。null 与掩码是两种不同语义，不得渲染为“已隐藏”。",
  })
  oldValue: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      "变更后的值。被掩码时为 '***'；该条目被本次变更删除（remove 记录 newValue=null）时为 null。",
  })
  newValue: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: "记录本次变更时留下的描述快照",
  })
  description: string | null;

  @ApiPropertyOptional({
    nullable: true,
    enum: ["string", "number", "boolean", "json"],
    description:
      "随该行持久化的 valueType 快照（迁移 1790000000018）。null = 迁移前的旧行，元数据未知 —— 不要把 null 读作 'string'。",
  })
  valueType: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      "随该行持久化的 isSecret 快照（迁移 1790000000018）。null = 迁移前的旧行，元数据未知 —— 不要把 null 读作 false。为 true 时读面总会掩码 oldValue/newValue。",
  })
  isSecret: boolean | null;

  @ApiProperty({
    enum: ["create", "update", "delete", "rollback"],
    description: "产生该行的动作（rollback 标记由回滚端点写入的行）",
  })
  action: string;

  @ApiPropertyOptional({
    nullable: true,
    description:
      "操作者用户 ID（自迁移 1790000000023 起为整数）；操作者未知时为 null（例如在记录操作者上下文之前写入的行）",
  })
  userId: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description: "操作者用户名",
  })
  username: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: "操作客户端 IP",
  })
  ipAddress: string | null;

  @ApiProperty({ description: "本次变更的记录时间（ISO-8601）" })
  createdAt: Date;
}

/** `GET /config/history`、`GET /config/history/{key}` 的分页包装。 */
export class ConfigHistoryPageDto {
  @ApiProperty({
    type: [ConfigHistoryResponseDto],
    description: "历史行分页，按最新在前（每行的 old/new 各自掩码）",
  })
  data: ConfigHistoryResponseDto[];

  @ApiProperty({ description: "分页前的匹配总行数" })
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
    description: "成功时恒为 true —— 键不存在是 404，绝不会是 {deleted:false}",
  })
  deleted: boolean;
}

/** `POST /config/executor-shared-token/generate` 的响应（明文仅此一次）。 */
export class ExecutorSharedTokenDto {
  @ApiProperty({
    example: "9f2c4a1d7b3e5f8091a2b3c4d5e6f70819a2b3c4d5e6f70819a2b3c4d5e6f708",
    description:
      "新生成的执行器共享令牌（64 位十六进制字符）。仅在轮换时返回一次；配置存储以 isSecret=true 保存它，因此后续 GET /config 读回 '***'。",
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
    nullable: true,
    description:
      "当前共享令牌的明文（仅 ADMIN）。未存储令牌时为 null —— 本端点对缺失的键绝不返回 404。",
  })
  token: string | null;

  @ApiProperty({ description: "存储了非空令牌时为 true（token !== null）" })
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
    example: "3.7",
    description: "当前生效的可声明下界（PYTHON_RUNTIME_VERSION_MIN，默认 3.7）",
  })
  min: string;

  @ApiProperty({
    example: "3.14",
    description:
      "当前生效的可声明上界（PYTHON_RUNTIME_VERSION_MAX，默认 3.14）",
  })
  max: string;

  @ApiProperty({
    example: "3.8",
    description:
      "在线下载下限（契约常量，不可配置）：uv 无法下载低于该版本的解释器，因此这些版本需要预置好的离线缓存卷",
  })
  onlineMin: string;

  @ApiProperty({
    example: "3.12",
    description: "legacy 执行器未上报解释器列表时的兜底解释器",
  })
  legacyDefaultInterpreter: string;
}

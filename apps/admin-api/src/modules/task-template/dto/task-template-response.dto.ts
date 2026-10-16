import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

/**
 * B-3（契约空壳修复）：任务模板域（tag "Task Templates"）**响应体 DTO**。
 *
 * ## 为什么不能直接标 `type: TaskTemplate`（实体）
 *
 * 实体没有 @ApiProperty，@nestjs/swagger 只会 emit
 * `{type:'object', properties:{}}` —— **空壳 schema**（先例与机理见
 * `config-response.dto.ts` 头注）：前端 `gen:api-types` 生成
 * `Record<string, never>`，比没有类型更坏；check:response-schema 守卫也会把
 * 新增空壳打红。baseline 里 5 条存量空壳中 3 条在本域
 * （GET /task-templates、GET /task-templates/{id}、POST /task-templates），
 * 本 DTO 逐条替换。
 *
 * ## 字段与「实际运行时返回」逐一对齐
 *
 * 控制器直接返回 service 的 `TaskTemplate` 实体（findAll/findOne/create），
 * 字段集 = 实体列（无掩码/无裁剪）。`createdBy` 为 nullable 列（历史行/迁移
 * seed 为 NULL），用 `@ApiPropertyOptional + nullable` 表达——前端生成类型
 * `createdBy?: string | null`，既有消费方（不读该字段）零影响。
 */
export class TaskTemplateResponseDto {
  @ApiProperty({
    format: "uuid",
    description: "模板 UUID",
  })
  id: string;

  @ApiProperty({
    example: "scheduled_backup",
    description:
      "稳定唯一键。官方模板使用固定键（scheduled_backup / health_check / data_sync / log_cleanup / webhook_ping），与 MCP 的 TASK_TEMPLATES 对齐；自定义键由用户建议。",
  })
  key: string;

  @ApiProperty({
    maxLength: 128,
    description: "显示名称",
  })
  name: string;

  @ApiPropertyOptional({
    nullable: true,
    type: "string",
    description: "模板卡片上展示的人类可读描述",
  })
  description: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: "string",
    maxLength: 32,
    description:
      "Coarse category tag (备份/巡检/同步/清理/通知…) rendered as a Tag",
  })
  category: string | null;

  @ApiProperty({
    type: "object",
    additionalProperties: true,
    example: {
      triggerType: "cron",
      cronExpression: "0 2 * * *",
      runtime: "shell",
      entrypoint: "backup.sh",
      timeoutSeconds: 3600,
      maxRetry: 3,
      retryDelay: 60,
      blockStrategy: "discard",
    },
    description:
      "合法的 CreateTaskDto 子集（不含 `name`；在实例化时提供）。从此模板实例化任务时用作默认值。",
  })
  config: Record<string, unknown>;

  @ApiProperty({ description: "迁移预置的官方预设为 true（只读，不可删除）" })
  isOfficial: boolean;

  @ApiPropertyOptional({
    nullable: true,
    type: "string",
    maxLength: 100,
    description:
      "创建者的用户名（JWT 用户名）。null = legacy 行/官方 seed；属主为 null 的行仅 ADMIN 可删除。",
  })
  createdBy: string | null;

  @ApiProperty({ description: "创建时间（ISO-8601）" })
  createdAt: Date;

  @ApiProperty({ description: "最后更新时间（ISO-8601）" })
  updatedAt: Date;
}

/**
 * `POST /task-templates/{id}/instantiate` 的 201 响应（最小面）。
 *
 * instantiate 经 TaskService.create 落库一个**任务**并返回完整 Task 实体；
 * 本 DTO 只契约化前端实际消费的标识/状态字段（前端 api 层此前对该响应零
 * 类型——201 空响应描述）。完整任务形状的权威契约在 Task Management 域
 * （GET /tasks/{id}），不在本 DTO 复制第二份。
 */
export class InstantiateTaskResponseDto {
  @ApiProperty({
    format: "uuid",
    description: "已创建任务的 UUID",
  })
  id: string;

  @ApiProperty({
    description: "任务名称（取自 overlay 请求体；在全部任务中唯一）",
  })
  name: string;

  @ApiProperty({
    enum: ["active", "paused", "deleted"],
    description: "所创建任务的生命周期状态",
  })
  status: string;

  @ApiProperty({
    enum: ["cron", "fixed_rate", "api", "manual"],
    description: "由模板 config / overlay 展开得到的触发类型",
  })
  triggerType: string;

  @ApiProperty({
    enum: ["python", "node", "shell"],
    description: "执行器将使用的运行时",
  })
  runtime: string;

  @ApiProperty({ description: "创建时间（ISO-8601）" })
  createdAt: Date;
}

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
  @ApiProperty({ description: "Template UUID", format: "uuid" })
  id: string;

  @ApiProperty({
    description:
      "Stable unique key. Official templates use fixed keys " +
      "(scheduled_backup / health_check / data_sync / log_cleanup / webhook_ping) " +
      "aligned with the MCP TASK_TEMPLATES; custom keys are user-suggested.",
    example: "scheduled_backup",
  })
  key: string;

  @ApiProperty({ description: "Display name", maxLength: 128 })
  name: string;

  @ApiPropertyOptional({
    description: "Human description shown on template cards",
    nullable: true,
    type: "string",
  })
  description: string | null;

  @ApiPropertyOptional({
    description:
      "Coarse category tag (备份/巡检/同步/清理/通知…) rendered as a Tag",
    nullable: true,
    type: "string",
    maxLength: 32,
  })
  category: string | null;

  @ApiProperty({
    description:
      "Valid CreateTaskDto subset (no `name`; provided at instantiate time). " +
      "Used as defaults when instantiating a task from this template.",
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
  })
  config: Record<string, unknown>;

  @ApiProperty({
    description:
      "True for migration-seeded official presets (read-only, cannot be deleted)",
  })
  isOfficial: boolean;

  @ApiPropertyOptional({
    description:
      "Username of the creator (JWT username). null = legacy row / official seed; " +
      "deletion of null-owner rows is ADMIN-only.",
    nullable: true,
    type: "string",
    maxLength: 100,
  })
  createdBy: string | null;

  @ApiProperty({ description: "Creation time (ISO-8601)" })
  createdAt: Date;

  @ApiProperty({ description: "Last update time (ISO-8601)" })
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
  @ApiProperty({ description: "Created task UUID", format: "uuid" })
  id: string;

  @ApiProperty({
    description: "Task name (from the overlay body; unique across tasks)",
  })
  name: string;

  @ApiProperty({
    description: "Lifecycle status of the created task",
    enum: ["active", "paused", "deleted"],
  })
  status: string;

  @ApiProperty({
    description: "Trigger type expanded from the template config / overlay",
    enum: ["cron", "fixed_rate", "api", "manual"],
  })
  triggerType: string;

  @ApiProperty({
    description: "Runtime the executor will use",
    enum: ["python", "node", "shell"],
  })
  runtime: string;

  @ApiProperty({ description: "Creation time (ISO-8601)" })
  createdAt: Date;
}

import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsArray, IsObject, IsOptional, IsString } from "class-validator";

/**
 * `POST /task-templates/import` 的请求体：**一份清单（manifest.json），或
 * `docs/skills/registry.json` 里的一条**，外加可选的 `config`。
 *
 * ## 为什么是「扁平」的（清单字段直接在顶层）
 *
 * 契约文档里的用法是「把一份 manifest 交给中台校验 / 导入 / 落库」，所以
 * `curl --data @docs/skills/templates/health_check/manifest.json` 与
 * `jq '.templates[0]' docs/skills/registry.json | curl --data @-` 都应当**原样可投**，
 * 不需要调用方再包一层。`path` / `contentHash` 正是 registry 条目比清单多出来的
 * 两个键（生成物的附加事实），出现时会被校验自洽。
 *
 * ## 字段语义
 *
 * 本 DTO 只声明**形状**（供 OpenAPI / 前端类型消费）；键集合封闭性、name 形状、
 * version 语义化、params 逐项形状、contentHash 自洽等**深度判据**一律在
 * `task-template.manifest.ts` 的 `parseTemplateImportRequest` 里，服务层调用——
 * 与 `CreateTaskTemplateDto` 把 config 语义交给 service 是同一分工。
 */
export class ImportTaskTemplateManifestDto {
  @ApiProperty({
    example: "health_check",
    description:
      "清单标识：与所在目录名逐字一致，同时就是落库后的 `task_templates.key`（全局唯一；已存在即 409）",
  })
  @IsString()
  name: string;

  @ApiProperty({
    example: "1.0.0",
    description:
      "清单版本（语义化 x.y.z）。只做校验与审计留痕：`task_templates` 表没有版本列，不落库",
  })
  @IsString()
  version: string;

  @ApiProperty({
    maxLength: 500,
    description: "清单说明（逐字落库到 `task_templates.description`）",
  })
  @IsString()
  description: string;

  @ApiProperty({
    type: [String],
    enum: ["browser", "gui", "filesystem", "http"],
    description:
      "能力域数组；取值复用 SOP front-matter 的四值域（browser/gui/filesystem/http）",
  })
  @IsArray()
  @IsString({ each: true })
  capabilities: string[];

  @ApiProperty({
    type: "object",
    additionalProperties: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["string", "number", "boolean"] },
        title: { type: "string" },
        description: { type: "string" },
        required: { type: "boolean" },
        default: {},
        options: { type: "array", items: {} },
      },
    },
    example: {
      url: {
        type: "string",
        title: "巡检地址",
        description: "要 GET 的地址；缺省为 https://example.com。",
        required: false,
        default: "https://example.com",
      },
    },
    description:
      "用户可配参数的声明（可为空对象）；每项照 `plugin.json` 的 userConfig 形状，未知键即 400",
  })
  @IsObject()
  params: Record<string, unknown>;

  @ApiProperty({
    type: [String],
    example: [],
    description:
      "相对本模板目录的入口文件路径数组（任务模板允许为空）；不接受绝对路径与 ../ 越界段",
  })
  @IsArray()
  @IsString({ each: true })
  entrypoints: string[];

  @ApiPropertyOptional({
    description:
      "清单所在路径（来自 registry 条目的附加事实；给了就要求其目录名逐字等于 name）",
  })
  @IsString()
  @IsOptional()
  path?: string;

  @ApiPropertyOptional({
    description:
      "清单内容锚（来自 registry 条目；给了就必须等于 sha256(稳定序列化后的清单)，否则 400）",
  })
  @IsString()
  @IsOptional()
  contentHash?: string;

  @ApiPropertyOptional({
    type: "object",
    additionalProperties: true,
    example: {
      triggerType: "fixed_rate",
      fixedRate: 60,
      runtime: "node",
      glueLanguage: "javascript",
      glueSource: "console.log('hi');",
    },
    description:
      "可执行内容载体（合法 CreateTaskDto 子集，落库到 `task_templates.config`）。清单本身刻意不携带它；省略时按 name 取官方模板常量，非官方 key 省略即 400",
  })
  @IsObject()
  @IsOptional()
  config?: Record<string, unknown>;
}

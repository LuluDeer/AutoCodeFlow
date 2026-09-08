import { BadRequestException } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate, type ValidationError } from "class-validator";
import { CreateTaskDto } from "../task/dto/create-task.dto";

/**
 * CORE-03：模板 config 的**校验**与**展开**纯逻辑。
 *
 * 校验复用既有 CreateTaskDto 的 validator 语义（plainToInstance + validate），
 * 确保落库的 `config` 永远是一份合法的 CreateTaskDto 子集——脏模板在写入时即
 * 被拒（400），实例化时不会再引入非法字段。whitelist + forbidNonWhitelisted
 * 与 main.ts 全局 ValidationPipe 一致（多余键直接拒绝，杜绝越权/漂移字段）。
 */

/** 探针名：CreateTaskDto 的 name 必填，但模板 config 不含 name——用固定探针名过校验。 */
const CONFIG_PROBE_NAME = "__template_config_probe__";

/** 展平 class-validator 错误树为「字段: 原因」列表（取叶子约束信息）。 */
function flattenErrors(errors: ValidationError[], prefix = ""): string[] {
  const out: string[] = [];
  for (const e of errors) {
    const path = prefix ? `${prefix}.${e.property}` : e.property;
    if (e.constraints) {
      out.push(`${path}: ${Object.values(e.constraints).join("; ")}`);
    }
    if (e.children?.length) {
      out.push(...flattenErrors(e.children, path));
    }
  }
  return out;
}

/**
 * 校验一份模板 config 是否合法（CreateTaskDto 子集）。非法抛 BadRequestException，
 * 消息携带字段级原因。空对象视为非法（至少要有 triggerType 等 CreateTaskDto 必填项）。
 */
export async function assertValidTaskTemplateConfig(
  config: unknown,
): Promise<Record<string, unknown>> {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new BadRequestException("模板 config 必须是对象");
  }
  const dto = plainToInstance(CreateTaskDto, {
    name: CONFIG_PROBE_NAME,
    ...(config as Record<string, unknown>),
  });
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: false,
  });
  // 探针名自身永远合法；若报错全来自 name（探针）之外才有意义——但探针恒定，
  // 故任何错误都反映真实 config 问题。
  if (errors.length > 0) {
    const detail = flattenErrors(errors).filter((m) => !m.startsWith("name:"));
    if (detail.length > 0) {
      throw new BadRequestException(`模板 config 非法：${detail.join(" | ")}`);
    }
  }
  return config as Record<string, unknown>;
}

/**
 * 把一份完整载荷（应含 name/triggerType 等 CreateTaskDto 必填项）按 CreateTaskDto
 * 语义校验，非法抛 BadRequestException，合法返回类型化的 CreateTaskDto 实例。
 * 供「从模板实例化任务」在展开 config + 覆盖后、调用 TaskService.create 前把关，
 * 与全局 ValidationPipe（whitelist + forbidNonWhitelisted）同口径。
 */
export async function assertValidCreateTaskPayload(
  payload: Record<string, unknown>,
): Promise<CreateTaskDto> {
  const dto = plainToInstance(CreateTaskDto, payload);
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: false,
  });
  if (errors.length > 0) {
    throw new BadRequestException(
      `任务载荷非法：${flattenErrors(errors).join(" | ")}`,
    );
  }
  return dto;
}

/**
 * 从模板 config 展开为一份可提交的 CreateTaskDto 子集：config 提供默认值，
 * 显式 overrides 逐键胜出；剥离探针 name 之后回填 overrides.name（若有）。
 * 纯函数、无副作用，便于单测「模板作默认 / 显式覆盖」语义。
 */
export function expandTemplateConfigIntoTaskDto(
  config: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    ...config,
    ...overrides,
  };
  delete merged.name; // 模板 config 不应携带 name；实例化名一律由 overrides 提供
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, "name")) {
    merged.name = overrides.name;
  }
  return merged;
}

/**
 * 自定义模板 key 缺省生成：由 name 规整为 `[a-z0-9_-]`，折叠分隔符、限长 64。
 * 保留原始 key（若调用方已提供合法 key）。仅用于展示/唯一性缺省，不做安全断言。
 */
export function suggestTemplateKey(name: string): string {
  const slug = (name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || `tpl-${Date.now().toString(36)}`;
}

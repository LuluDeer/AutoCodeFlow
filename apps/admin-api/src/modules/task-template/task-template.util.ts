import { plainToInstance } from "class-transformer";
import { validate, type ValidationError } from "class-validator";
import { CreateTaskDto } from "../task/dto/create-task.dto";
// LANG-ERR-01：用户可见失败抛稳定码 + 参数（文案由前端按用户语言翻译）。
import { AppError } from "../../common/errors/app-error";

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
    throw new AppError("TASK_TEMPLATE_CONFIG_NOT_OBJECT");
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
      throw new AppError("TASK_TEMPLATE_CONFIG_INVALID", {
        detail: detail.join(" | "),
      });
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
    throw new AppError("TASK_TEMPLATE_PAYLOAD_INVALID", {
      detail: flattenErrors(errors).join(" | "),
    });
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
 * R39-A1：模板**属主键**的编码/解码（`task_templates.createdBy` 列）。
 *
 * ## 为什么不再直接存 username
 * 历史实现把 `createdBy` 落成裸 username（controller 传 `user.username`），
 * 属主判定是 `tpl.createdBy !== requester.username`。username 是**可变且可回收**
 * 的身份标签，于是有两条后果：
 *  - ① 用户改名 → 属主判定立刻失效（自己删不掉自己的模板）；
 *  - ② 用户被删 → `users.service.remove` 是**硬删除**，username 唯一索引随之
 *    释放 → 同名新注册的账号**继承**旧模板的删除/修改权（越权，非仅可用性）。
 *
 * ## 现形态
 * `user:<id>` 或 `user:<id>|<username>`。**`id` 是唯一权威**，`|username` 段
 * 只作审计可读性，任何判定都不读它：
 *  - 改名不影响归属（判 id，不判名字）；
 *  - 列是 `varchar(100)`，而 username 最长 128 —— 「前缀 + 名字」装不下时
 *    **只截断展示段**（`buildTemplateOwnerKey` 保证 ≤ 100），绝不截断 id，
 *    因此不会出现写库报 `22001` 或键不可解析；
 *  - 键格式恒含 `|`，`parseTemplateOwnerKey` 也**要求** `|` 才认作新键——
 *    裸 `user:42` 这种历史 username 不会被误解析成 id 42（见下）。
 *
 * ## 历史行兼容（刻意保留，不是遗漏）
 * 不以 `user:<digits>|` 开头的值一律视为**历史行**，按 username 精确比对
 * （即旧语义）。去掉这条回退路径等于让全部历史行「谁都删不掉」——那是在修越权
 * 的同时制造可用性事故。历史行的残余风险（同名新号仍可删）无法在无回填的前提下
 * 消除，已在 `task-template.owner-identity.spec.ts` 末尾显式锁定。
 *
 * ## 残余歧义（已知，可忽略量级）
 * 历史行存的是**用户自填的 username**（无 charset 校验），理论上某个 username
 * 可以长得像 `user:42|x`，从而被解析成 id 42。要利用它，受害者必须先把自己的
 * 用户名设为「`user:<攻击者id>|…`」并在此形态下建模板，攻击者的 id 还需与之一致。
 * 与 sop 域既有的 `user:<uuid>` 约定（R34-A1）同型，不再额外界定字符集。
 */
export const TEMPLATE_OWNER_PREFIX = "user:";

/** 与实体列 `createdBy varchar(100)` 对齐的硬上限（键永远不超过它）。 */
export const TEMPLATE_OWNER_KEY_MAX_LENGTH = 100;

/** 创建者身份：只有 `id` 参与归属判定，`username` 仅用于可读性。 */
export interface TemplateOwnerRef {
  id: number;
  username: string;
}

/** 解析结果：新键（按 id 判）或历史行（按 username 判）。 */
export type ParsedTemplateOwner =
  | { kind: "keyed"; userId: number }
  | { kind: "legacy"; username: string };

/**
 * 由创建者身份构造属主键。
 *
 * 恒为 `user:<id>|<username>` 形态（保证可解析、可区分历史行）；name 段超长时
 * 截断——列宽 100，`user:`(5) + id(≤10) + `|`(1) 之后剩余空间才是展示段。
 */
export function buildTemplateOwnerKey(owner: TemplateOwnerRef): string {
  const base = `${TEMPLATE_OWNER_PREFIX}${owner.id}|`;
  const room = TEMPLATE_OWNER_KEY_MAX_LENGTH - base.length;
  const name = String(owner.username ?? "").slice(0, Math.max(room, 0));
  return `${base}${name}`;
}

/**
 * 解析属主键。
 *
 * 只有 `user:<digits>|` 才认作新键；其余（含形如 `user:abc`、裸 `user:42`、
 * 纯 username、空串）一律回退为历史行，按字面 username 比对。
 */
export function parseTemplateOwnerKey(raw: string): ParsedTemplateOwner {
  const m = /^user:(\d+)\|/.exec(raw);
  if (m) {
    const userId = Number(m[1]);
    if (Number.isSafeInteger(userId) && userId > 0) {
      return { kind: "keyed", userId };
    }
  }
  return { kind: "legacy", username: raw };
}

/**
 * 归属判定：新键按 id（id 相等即属主，与当前 username 无关）；历史行按 username。
 *
 * `requester.id` 缺失时**恒不**判为属主（fail-closed）——绝不回退到「拿键里的
 * 名字段去比 username」，那正是 R39-A1 要堵的越权路径。
 */
export function isTemplateOwner(
  raw: string | null | undefined,
  requester: TemplateOwnerRef,
): boolean {
  if (raw == null || raw === "") return false;
  const parsed = parseTemplateOwnerKey(raw);
  if (parsed.kind === "keyed") {
    return typeof requester?.id === "number" && parsed.userId === requester.id;
  }
  return parsed.username === requester?.username;
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

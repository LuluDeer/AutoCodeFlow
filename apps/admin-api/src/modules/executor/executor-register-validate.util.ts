/**
 * E-4（2026-10-26 执行器域审计）：register 身份键的**入站校验**单一事实源。
 *
 * ── 为什么在 service 层而不是 DTO ────────────────────────────────────────
 * `ExecutorRegisterDto` 是「仅 openapi schema 生成」形态（dto 头注）：控制器
 * 的 @Body() 用内联类型（metatype = Object），全局 ValidationPipe 对它不做
 * whitelist 校验——这是刻意设计（executor-node 注册体含 legacy 别名字段，
 * forbidNonWhitelisted 会把存量执行器 400 掉）。因此字段白名单在 controller
 * 的 F-7 显式转发、**校验**落在 service 入口（本文件），与
 * isAdoptableMaxConcurrentTasks / normalizeInterpreters 等既有采纳闸同层。
 *
 * ── 闸的宽严依据 ─────────────────────────────────────────────────────────
 * 机器面校验的第一原则：**不能让存量执行器注册失败**。上限全部取
 * 「合法输入的天花板」而非「理想值」：
 * - appName/address：实体列是无 length 的 @Column()（PG 默认 varchar(255)），
 *   超 255 撞 22001 = 裸 500——上限 255 与列物理上限对齐；字符集白名单来自
 *   scripts/install.sh 的既有校验（^[A-Za-z0-9._-]+$ 用于 --name）放宽为
 *   「可读打印字符 + 禁控制字符/引号/反斜杠」：仓内真实 address 存在
 *   URL 形态（"http://exec-a:3001"，version-follow spec :52）与主机名形态
 *   （"headless-agent-xxx:8010"，demo-headless-agent.mjs），硬钉 host:port
 *   会打断存量，故 address 闸只收窄到「非空白、无控制字符、长度有界」。
 * - type：实体列是 PG enum（executor_type_enum：python/node/universal，
 *   entity:28-32）——枚举外值直落库会 500（22P02 invalid input value），
 *   白名单必须与 ExecutorType 枚举同步（这里用字符串集合，避免 util 反向
 *   import entity 造成循环依赖；单测钉住两者一致）。
 * - capabilities/tags：simple-array 列（逗号连接存储）——禁逗号元素是**正确性**
 *   闸（任务域 create-task.dto.ts:414 的 F-7 先例：劈裂让标签 AND 匹配永远
 *   失败），64 项 × 64 字符是防写放大（jsonb/simple-array 列由执行器上报
 *   填充，不设上界等于把写放大权交给对端；对照 MAX_INTERPRETER_ENTRIES=200
 *   的同族取舍）。
 * - description：text 列无物理上限，300 字符封顶防 UI 拉爆（管理台列表
 *   直接渲染该列）。
 * - groupName：列 varchar 无 length（255 物理上限）+ 调度按精确名分组，
 *   同样收窄长度与控制字符。
 */

/** 与实体列 PG varchar(255) 物理上限对齐（无 length 的 @Column() 默认值）。 */
const MAX_APP_NAME_BYTES = 255;
const MAX_ADDRESS_BYTES = 255;
const MAX_GROUP_NAME_BYTES = 255;
/** 与实体 deviceFingerprint 列的 varchar(80) 无关——description 是 text 列，纯 UI 护栏。 */
const MAX_DESCRIPTION_BYTES = 300;
/** simple-array 列的元素数/元素长度护栏（写放大面，依据见头注）。 */
const MAX_ARRAY_ITEMS = 64;
const MAX_ARRAY_ITEM_BYTES = 64;

/** ExecutorType 枚举的字符串值（entity:28-32；单测钉住与枚举一致）。 */
export const REGISTER_ALLOWED_TYPES: readonly string[] = [
  "python",
  "node",
  "universal",
];

/** 控制字符/DEL + 反引号、反斜杠、引号——防注入终端/日志/SQL 拼接面的最小集。 */

const FORBIDDEN_CHARS_RE = /[\x00-\x1f\x7f`\\"']/;

const isNonEmptyTrimmedString = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

const withinByteLimit = (v: string, max: number): boolean =>
  Buffer.byteLength(v, "utf8") <= max;

/**
 * 校验 register 的身份/元数据入站字段。全部合法 → 返回 null；
 * 第一个非法字段 → 返回 {field, reason}（调用方映射成
 * EXECUTOR_REGISTER_FIELD_INVALID 400，reason 进稳定码文案，不含原始值——
 * 原始值可能含控制字符/超长垃圾，回显等于反射攻击面）。
 *
 * 校验域 = 「执行器自报且直接落库/参与调度」的字符串与数组列；maxConcurrentTasks
 * （isAdoptableMaxConcurrentTasks）、interpreters/installedPackages/deployedApps
 * （normalize* 三态）各有既有闸，不在此重复。缺省字段（undefined）不校验——
 * 「未上报」由采纳纪律处理（缺省 → 不动 DB），与三态语义一致。
 */
export function validateRegisterIdentityFields(data: {
  appName?: string;
  address?: string;
  type?: string;
  capabilities?: string[] | null;
  runtime?: string[] | null;
  tags?: string[] | null;
  description?: string | null;
  groupName?: string | null;
}): { field: string; reason: string } | null {
  // appName：必填语义由调用方（issueToken 的 "executor" 兜底 / register 主链）
  // 保证；这里校验「上报了就必须合法」。
  if (data.appName !== undefined) {
    if (!isNonEmptyTrimmedString(data.appName)) {
      return { field: "appName", reason: "不能为空白" };
    }
    if (!withinByteLimit(data.appName, MAX_APP_NAME_BYTES)) {
      return {
        field: "appName",
        reason: `长度超过 ${MAX_APP_NAME_BYTES} 字节`,
      };
    }
    if (FORBIDDEN_CHARS_RE.test(data.appName)) {
      return { field: "appName", reason: "含控制字符或引号/反斜杠/反引号" };
    }
  }
  if (data.address !== undefined) {
    if (!isNonEmptyTrimmedString(data.address)) {
      return { field: "address", reason: "不能为空白" };
    }
    if (!withinByteLimit(data.address, MAX_ADDRESS_BYTES)) {
      return {
        field: "address",
        reason: `长度超过 ${MAX_ADDRESS_BYTES} 字节`,
      };
    }
    if (FORBIDDEN_CHARS_RE.test(data.address)) {
      return { field: "address", reason: "含控制字符或引号/反斜杠/反引号" };
    }
    if (/\s/.test(data.address)) {
      return { field: "address", reason: "不含空白字符" };
    }
  }
  if (data.type !== undefined) {
    if (!REGISTER_ALLOWED_TYPES.includes(data.type)) {
      return {
        field: "type",
        reason: `必须是 ${REGISTER_ALLOWED_TYPES.join("/")} 之一`,
      };
    }
  }
  // capabilities 与 runtime 是同一列的两个别名（controller: capabilities ?? runtime）。
  for (const [field, value] of [
    ["capabilities", data.capabilities],
    ["runtime", data.runtime],
  ] as const) {
    if (value === undefined) continue;
    if (value !== null && !Array.isArray(value)) {
      return { field, reason: "必须是字符串数组" };
    }
    if (!value) continue;
    if (value.length > MAX_ARRAY_ITEMS) {
      return { field, reason: `最多 ${MAX_ARRAY_ITEMS} 项` };
    }
    for (const item of value) {
      if (typeof item !== "string" || item.trim().length === 0) {
        return { field, reason: "每项必须是非空白字符串" };
      }
      if (item.includes(",")) {
        // simple-array 列以逗号连接存储，读回时按逗号劈裂（F-7 先例）。
        return { field, reason: "元素不能含逗号（simple-array 列会劈裂）" };
      }
      if (!withinByteLimit(item, MAX_ARRAY_ITEM_BYTES)) {
        return {
          field,
          reason: `单元素不能超过 ${MAX_ARRAY_ITEM_BYTES} 字节`,
        };
      }
    }
  }
  if (data.tags !== undefined && data.tags !== null) {
    if (!Array.isArray(data.tags)) {
      return { field: "tags", reason: "必须是字符串数组" };
    }
    if (data.tags.length > MAX_ARRAY_ITEMS) {
      return { field: "tags", reason: `最多 ${MAX_ARRAY_ITEMS} 项` };
    }
    for (const item of data.tags) {
      if (typeof item !== "string" || item.trim().length === 0) {
        return { field: "tags", reason: "每项必须是非空白字符串" };
      }
      if (item.includes(",")) {
        return {
          field: "tags",
          reason: "元素不能含逗号（simple-array 列会劈裂）",
        };
      }
      if (!withinByteLimit(item, MAX_ARRAY_ITEM_BYTES)) {
        return {
          field: "tags",
          reason: `单元素不能超过 ${MAX_ARRAY_ITEM_BYTES} 字节`,
        };
      }
    }
  }
  if (data.description !== undefined && data.description !== null) {
    if (typeof data.description !== "string") {
      return { field: "description", reason: "必须是字符串" };
    }
    if (!withinByteLimit(data.description, MAX_DESCRIPTION_BYTES)) {
      return {
        field: "description",
        reason: `长度超过 ${MAX_DESCRIPTION_BYTES} 字节`,
      };
    }
  }
  if (data.groupName !== undefined && data.groupName !== null) {
    if (
      typeof data.groupName !== "string" ||
      data.groupName.trim().length === 0
    ) {
      return { field: "groupName", reason: "不能为空白" };
    }
    if (!withinByteLimit(data.groupName, MAX_GROUP_NAME_BYTES)) {
      return {
        field: "groupName",
        reason: `长度超过 ${MAX_GROUP_NAME_BYTES} 字节`,
      };
    }
    if (FORBIDDEN_CHARS_RE.test(data.groupName)) {
      return { field: "groupName", reason: "含控制字符或引号/反斜杠/反引号" };
    }
  }
  return null;
}

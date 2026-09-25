import { createHash } from "node:crypto";
import { load as yamlLoad } from "js-yaml";

/**
 * P5（agent-and-deployment）：SOP front-matter 的解析与校验（设计文档 04 §1）。
 *
 * ## 为什么校验是安全边界的一部分（04 §4.1）
 * SOP 会成为**另一个 Agent 的执行依据**——front-matter 里的 acceptance /
 * capabilities / constraints 就是跨 Agent 指令通道的结构化部分。所以：
 *   · schema **严格校验**（未知键拒绝）——front-matter 里混进说明性文字
 *     或未登记的指令字段，发布即失败；
 *   · **非法 SOP 无法发布**（draft 允许宽松，publish 必须全绿）——这是
 *     CI 级门槛，不是运行时警告。
 *
 * ## 为什么用声明式 schema（07 §7 调整）
 * `requiredTools` 已按 07 §7 改为 `capabilities`（能力域声明）：SOP 从
 * 「命令式脚本」变「声明式目标」，实现方式由执行器 Agent 自主决定，
 * `acceptance` 是唯一目标锚点。本文件按定案后的形状校验。
 */

/** 能力域（07 §7 定案：capabilities 取代 requiredTools）。 */
export const SOP_CAPABILITIES = [
  "browser",
  "gui",
  "filesystem",
  "http",
] as const;
export type SopCapability = (typeof SOP_CAPABILITIES)[number];

/** 验收项：command（执行器本地跑命令）/ platform（调平台 trigger + 查状态）。 */
export interface SopAcceptanceItem {
  kind: "command" | "platform";
  /** kind=command：要跑的命令。 */
  run?: string;
  /** kind=platform：check 语义（当前唯一 check）。 */
  check?: string;
  task?: string;
  expect?: string;
  timeoutSec?: number;
}

/** 硬边界（04 §4.1——平台代码强制，不靠 LLM 自觉）。 */
export interface SopConstraints {
  maxDurationSec?: number;
  allowedDomains?: string[];
  forbidden?: string[];
}

/** 澄清路由。 */
export interface SopClarificationPolicy {
  owner?: "center-agent" | "human";
  maxRounds?: number;
}

/** 解析并校验后的 front-matter（发布形态）。 */
export interface SopFrontMatter {
  target?: {
    application?: string;
    runtime?: string;
    manifestEntry?: string;
  };
  capabilities?: SopCapability[];
  acceptance: SopAcceptanceItem[];
  constraints?: SopConstraints;
  clarification?: SopClarificationPolicy;
}

/** 澄清轮次硬上限（roadmap §11 决策：maxRounds=5）。 */
export const SOP_MAX_ROUNDS_HARD_CAP = 5;
export const SOP_DEFAULT_MAX_ROUNDS = 5;

/** 问题文本长度上限（11 §5.2——防塞爆中台 Agent 上下文）。 */
export const SOP_CLARIFICATION_QUESTION_MAX = 4000;

export class SopFrontMatterError extends Error {}

/** 把 front-matter 对象稳定序列化（键递归排序）——contentHash 的前提。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/** sha256(stable(frontMatter + body))——执行器侧「我执行的是哪份」校验锚。 */
export function sopContentHash(
  frontMatter: SopFrontMatter,
  bodyMarkdown: string,
): string {
  return createHash("sha256")
    .update(stableStringify({ frontMatter, bodyMarkdown }))
    .digest("hex");
}

/**
 * 解析 YAML front-matter 文本 → 对象。
 *
 * 用 js-yaml 默认安全 schema：`!!js/function` 等执行类标签直接抛错——
 * front-matter 来自 LLM 输出，绝不能让它携带可执行语义。
 */
export function parseFrontMatterYaml(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = yamlLoad(text);
  } catch (err) {
    throw new SopFrontMatterError(
      `front-matter 不是合法 YAML：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (parsed === null || parsed === undefined) {
    throw new SopFrontMatterError("front-matter 为空");
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SopFrontMatterError("front-matter 顶层必须是映射");
  }
  return parsed as Record<string, unknown>;
}

// ── 内部校验工具 ─────────────────────────────────────────────────────

type Raw = Record<string, unknown>;

function fail(msg: string): never {
  throw new SopFrontMatterError(msg);
}

function isPlainObject(v: unknown): v is Raw {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown, where: string): string {
  if (typeof v !== "string" || v.trim() === "") {
    fail(`${where} 必须是非空字符串`);
  }
  return v;
}

function intInRange(
  v: unknown,
  min: number,
  max: number,
  where: string,
): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    fail(`${where} 必须是 ${min}..${max} 的整数`);
  }
  return v;
}

/**
 * 严格校验并归一化 front-matter。
 *
 * @param raw 解析后的顶层对象（可含 `sop:` 包裹层——设计文档示例的形态；
 *   也接受平铺。两种形态都校验未知键）。
 * @param opts.strict true = 发布校验（acceptance 必填、未知键拒绝）；
 *   false = 草稿校验（只挡结构性错误，允许留空待补）。
 */
export function validateFrontMatter(
  raw: Raw,
  opts: { strict: boolean },
): SopFrontMatter {
  // 兼容 `sop:` 包裹层与平铺两种写法
  const src: Raw = isPlainObject(raw.sop) ? (raw.sop as Raw) : raw;
  const strict = opts.strict;

  const allowedTop = [
    "target",
    "capabilities",
    "acceptance",
    "constraints",
    "clarification",
  ];
  for (const k of Object.keys(src)) {
    if (!allowedTop.includes(k))
      fail(`未知键 sop.${k}（front-matter 是机器契约，不接受自由字段）`);
  }

  const out: SopFrontMatter = { acceptance: [] };

  // ── target ──
  if (src.target !== undefined) {
    if (!isPlainObject(src.target)) fail("sop.target 必须是映射");
    const t = src.target as Raw;
    for (const k of Object.keys(t)) {
      if (!["application", "runtime", "manifestEntry"].includes(k)) {
        fail(`未知键 sop.target.${k}`);
      }
    }
    out.target = {};
    if (t.application !== undefined)
      out.target.application = str(t.application, "sop.target.application");
    if (t.runtime !== undefined)
      out.target.runtime = str(t.runtime, "sop.target.runtime");
    if (t.manifestEntry !== undefined)
      out.target.manifestEntry = str(
        t.manifestEntry,
        "sop.target.manifestEntry",
      );
  }

  // ── capabilities（07 §7：能力域声明，取代 requiredTools）──
  if (src.capabilities !== undefined) {
    if (!Array.isArray(src.capabilities)) fail("sop.capabilities 必须是数组");
    out.capabilities = src.capabilities.map((c, i) => {
      if (!(SOP_CAPABILITIES as readonly string[]).includes(String(c))) {
        fail(
          `sop.capabilities[${i}] = ${String(c)} 不在能力域枚举内（${SOP_CAPABILITIES.join("/")}）`,
        );
      }
      return c as SopCapability;
    });
  }

  // ── acceptance（声明式 SOP 的唯一目标锚点——发布时必填）──
  if (src.acceptance !== undefined) {
    if (!Array.isArray(src.acceptance) || src.acceptance.length === 0) {
      fail("sop.acceptance 必须是非空数组");
    }
    if (src.acceptance.length > 10) fail("sop.acceptance 最多 10 项");
    out.acceptance = src.acceptance.map((item, i) => {
      if (!isPlainObject(item)) fail(`sop.acceptance[${i}] 必须是映射`);
      const a = item as Raw;
      for (const k of Object.keys(a)) {
        if (
          !["kind", "run", "check", "task", "expect", "timeoutSec"].includes(k)
        ) {
          fail(`未知键 sop.acceptance[${i}].${k}`);
        }
      }
      const kind = a.kind;
      if (kind !== "command" && kind !== "platform") {
        fail(`sop.acceptance[${i}].kind 必须是 command | platform`);
      }
      const out2: SopAcceptanceItem = { kind };
      if (kind === "command") {
        if (a.run === undefined) {
          if (strict) fail(`sop.acceptance[${i}]（command）缺 run`);
        } else {
          out2.run = str(a.run, `sop.acceptance[${i}].run`);
        }
      } else {
        if (a.check === undefined) {
          if (strict) fail(`sop.acceptance[${i}]（platform）缺 check`);
        } else {
          out2.check = str(a.check, `sop.acceptance[${i}].check`);
        }
        if (a.task !== undefined)
          out2.task = str(a.task, `sop.acceptance[${i}].task`);
        if (a.expect !== undefined)
          out2.expect = str(a.expect, `sop.acceptance[${i}].expect`);
        if (a.timeoutSec !== undefined) {
          out2.timeoutSec = intInRange(
            a.timeoutSec,
            1,
            3600,
            `sop.acceptance[${i}].timeoutSec`,
          );
        }
      }
      return out2;
    });
  } else if (strict) {
    fail("发布要求 sop.acceptance 必填（声明式 SOP 的唯一目标锚点，07 §7）");
  }

  // ── constraints（平台代码强制的硬边界）──
  if (src.constraints !== undefined) {
    if (!isPlainObject(src.constraints)) fail("sop.constraints 必须是映射");
    const c = src.constraints as Raw;
    for (const k of Object.keys(c)) {
      if (!["maxDurationSec", "allowedDomains", "forbidden"].includes(k)) {
        fail(`未知键 sop.constraints.${k}`);
      }
    }
    out.constraints = {};
    if (c.maxDurationSec !== undefined) {
      out.constraints.maxDurationSec = intInRange(
        c.maxDurationSec,
        60,
        86400,
        "sop.constraints.maxDurationSec",
      );
    }
    if (c.allowedDomains !== undefined) {
      if (!Array.isArray(c.allowedDomains))
        fail("sop.constraints.allowedDomains 必须是数组");
      out.constraints.allowedDomains = c.allowedDomains.map((d, i) => {
        const s = str(d, `sop.constraints.allowedDomains[${i}]`);
        // 域名白名单是浏览器工具的导航闸——不接受协议/路径/通配符混入
        if (!/^[a-z0-9.-]+$/i.test(s) || s.includes("..")) {
          fail(
            `sop.constraints.allowedDomains[${i}] = ${s} 不是裸域名（不含协议/路径/通配符）`,
          );
        }
        return s.toLowerCase();
      });
    }
    if (c.forbidden !== undefined) {
      if (!Array.isArray(c.forbidden))
        fail("sop.constraints.forbidden 必须是数组");
      out.constraints.forbidden = c.forbidden.map((f, i) =>
        str(f, `sop.constraints.forbidden[${i}]`),
      );
    }
  }

  // ── clarification 路由 ──
  if (src.clarification !== undefined) {
    if (!isPlainObject(src.clarification)) fail("sop.clarification 必须是映射");
    const cl = src.clarification as Raw;
    for (const k of Object.keys(cl)) {
      if (!["owner", "maxRounds"].includes(k))
        fail(`未知键 sop.clarification.${k}`);
    }
    out.clarification = {};
    if (cl.owner !== undefined) {
      if (cl.owner !== "center-agent" && cl.owner !== "human") {
        fail("sop.clarification.owner 必须是 center-agent | human");
      }
      out.clarification.owner = cl.owner;
    }
    if (cl.maxRounds !== undefined) {
      out.clarification.maxRounds = intInRange(
        cl.maxRounds,
        1,
        SOP_MAX_ROUNDS_HARD_CAP,
        `sop.clarification.maxRounds（硬上限 ${SOP_MAX_ROUNDS_HARD_CAP}，防两个 Agent 礼貌循环）`,
      );
    }
  }

  return out;
}

/** 澄清轮次上限（front-matter > 默认值；恒 ≤ 硬上限）。 */
export function resolveMaxRounds(fm: SopFrontMatter | null): number {
  const r = fm?.clarification?.maxRounds;
  return Math.min(
    typeof r === "number" && r >= 1 ? r : SOP_DEFAULT_MAX_ROUNDS,
    SOP_MAX_ROUNDS_HARD_CAP,
  );
}

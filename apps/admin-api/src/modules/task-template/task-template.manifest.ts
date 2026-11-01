import { createHash } from "node:crypto";
// LANG-ERR-01：用户可见失败抛稳定码 + 参数（文案由前端按用户语言翻译）。
import { AppError } from "../../common/errors/app-error";
// 能力域与稳定序列化**复用 SOP 的既有实现**，不在这里抄第二份
// （契约文档 `docs/skills/manifest-contract.md` 的「事实源只有一个」）。
import { SOP_CAPABILITIES, stableStringify } from "../sop/sop-frontmatter";
import { OFFICIAL_TASK_TEMPLATES } from "./task-template.constants";

/**
 * 任务模板**清单（manifest.json）的导入契约**——`POST /task-templates/import`
 * 的解析与校验纯逻辑。
 *
 * ## 为什么清单是「封闭键集合」
 *
 * 清单是**机器契约**（导入即落库），不是自由文档。未知键必须失败，理由与
 * `scripts/check-template-manifest.mjs`、`sop-frontmatter.ts` 完全一致：
 * 自由字段会让「机器能读懂的」与「人以为机器能读懂的」分叉。
 *
 * ## 为什么不设计成插件系统（这是既有契约，不是本轮偷懒）
 *
 * 清单**不携带可执行 hook**（`hook` / `command` / `script` 都不在白名单里），
 * 于是它天然**不是执行通道**：
 *   ① 一份「被导入即执行」的清单等于把分发契约升级成远程代码执行面，
 *      而第三方扩展在本仓的定位是「只能提交**声明式产物**」；
 *   ② 可执行部分本来就有归宿——技能侧是 `entrypoints` 指向的独立文件（由执行器
 *      按自己的沙箱纪律跑），**任务模板侧是 DB 的 `config`**（本端点里由请求体的
 *      `config` 字段携带，或对官方 key 取 `OFFICIAL_TASK_TEMPLATES` 的常量）；
 *   ③ 判据是**结构性**的：`glueSource` 顶多出现在 `config` 里，写进清单本身
 *      就是「未知键 ⇒ 400」，不依赖人记住规则。
 * 同一纪律的推论：**不做目录自动遍历装载**、**不做热插拔**（变更走 review + 守卫
 * + 生成物），见 `check-template-manifest.mjs` 的 `ALLOWED_MANIFEST_KEYS`。
 *
 * ## 与守卫的关系（两份实现，一个口径）
 *
 * 守卫（`scripts/check-template-manifest.mjs`）守的是**仓库里签入的**清单文件，
 * 它必须零依赖、可读文件系统（entrypoints 是否存在、目录是否越界）。本文件守的
 * 是**请求体里的**清单，没有目录上下文（entrypoint 只做「必须是相对路径且不越界」
 * 的静态判据，不判存在性——落库时那些文件本来就不在中台机器上）。
 * 两边的**键集合、name 形状、version/description/params 判据保持一致**；内容哈希
 * 也刻意用同一个口径（`sha256(stableStringify(manifest))`），于是
 * `docs/skills/registry.json` 每条 `contentHash` 可直接与本端点对账
 * （见 `__tests__/task-template.import.spec.ts` 的对账用例）。
 */

/** 清单（manifest.json）的封闭键集合——多一个键就 400。 */
export const TEMPLATE_MANIFEST_KEYS = [
  "name",
  "version",
  "description",
  "capabilities",
  "params",
  "entrypoints",
] as const;

/**
 * `docs/skills/registry.json` 里**一条**多出来的两个键。
 *
 * 为什么要容忍它们：契约里说导入「接收一份 manifest（或 registry 里的一条）」，
 * 而从 registry 里 `jq '.templates[0]'` 拿到的对象就长这样。它们是**生成物的
 * 附加事实**（所在路径 / 内容锚），不是清单字段——校验时单独处理，不进哈希。
 */
export const TEMPLATE_REGISTRY_ENTRY_KEYS = ["path", "contentHash"] as const;

/**
 * 请求体里**清单之外**的唯一键：`config`（可执行内容的载体，落库到
 * `task_templates.config`）。清单本身绝不承载它——见文件头注「为什么不设计成
 * 插件系统」。
 */
export const TEMPLATE_IMPORT_CONFIG_KEY = "config";

/** params 每一项允许的键（照 `plugin.json` 的 userConfig 形状）。 */
export const TEMPLATE_MANIFEST_PARAM_KEYS = [
  "type",
  "title",
  "description",
  "required",
  "default",
  "options",
] as const;

/** 参数类型值域。 */
export const TEMPLATE_MANIFEST_PARAM_TYPES = [
  "string",
  "number",
  "boolean",
] as const;

/** `name` 形状：与 `task_templates.key`（varchar(64) 唯一）的既有约束对齐。 */
export const TEMPLATE_MANIFEST_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** `version`：语义化版本（含可选预发布/构建号）。 */
export const TEMPLATE_MANIFEST_VERSION_RE =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** description 长度上限（与守卫、CreateTaskTemplateDto 的 500 对齐）。 */
export const TEMPLATE_MANIFEST_DESCRIPTION_MAX = 500;

/** 归一化后的清单（**只含清单六键**——哈希与对账都以此为准）。 */
export interface NormalizedTemplateManifest {
  name: string;
  version: string;
  description: string;
  capabilities: string[];
  params: Record<string, Record<string, unknown>>;
  entrypoints: string[];
}

/** 一份导入请求解析后的形态。 */
export interface ParsedTemplateImport {
  manifest: NormalizedTemplateManifest;
  /** 请求体里显式携带的 config（缺省 = 走官方常量，见 `resolveImportConfig`）。 */
  explicitConfig?: Record<string, unknown>;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 清单内容哈希：`sha256(stableStringify(manifest))`。
 *
 * **口径必须与 `scripts/check-template-manifest.mjs` 的 `contentHash()` 一致**，
 * 否则 `docs/skills/registry.json` 的 `contentHash` 与本端点算出来的对不上，
 * 「可对账」就是一句空话。稳定序列化同样直接复用 SOP 的实现（键递归排序）。
 */
export function templateManifestContentHash(
  manifest: NormalizedTemplateManifest,
): string {
  return createHash("sha256").update(stableStringify(manifest)).digest("hex");
}

/**
 * 解析并校验一份导入请求体（清单六键 + registry 两键 + 可选的 `config`）。
 *
 * 失败一律 400 + `VALIDATION_FAILED`（**不新增错误码**：这是"参数校验失败"的
 * 既有语义），`detail` 里逐条列出字段级原因——排障时不用猜。
 */
export function parseTemplateImportRequest(raw: unknown): ParsedTemplateImport {
  const errors: string[] = [];
  const fail = (msg: string): void => {
    errors.push(msg);
  };

  if (!isPlainObject(raw)) {
    throw new AppError("VALIDATION_FAILED", {
      detail: "清单顶层必须是 JSON 对象",
    });
  }

  // ① 未知键即失败（封闭集合）。清单键 / registry 附加键 / config 之外的键
  //    一律拒绝——`glueSource`、`hook`、`command` 这类「想借清单塞可执行内容」
  //    的写法因此**结构性**地被挡在门外。
  const allowed = new Set<string>([
    ...TEMPLATE_MANIFEST_KEYS,
    ...TEMPLATE_REGISTRY_ENTRY_KEYS,
    TEMPLATE_IMPORT_CONFIG_KEY,
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      fail(
        `未知键 ${key}（清单是机器契约，不接受自由字段；` +
          `可执行内容只能放在 config 里，清单本身上限 ${TEMPLATE_MANIFEST_KEYS.join("/")}）`,
      );
    }
  }

  // ② name：形状 + 它同时是 DB 的 key（唯一）
  const name = raw.name;
  if (typeof name !== "string" || name.trim() === "") {
    fail("name 必须是非空字符串");
  } else if (!TEMPLATE_MANIFEST_NAME_RE.test(name)) {
    fail(
      `name「${name}」形状非法（只允许 [a-z0-9][a-z0-9._-]，≤64 字符——` +
        `与 task_templates.key 的列约束对齐）`,
    );
  }

  // ③ version（只校验、不落库：表里没有版本列，见 task-template.entity.ts）
  const version = raw.version;
  if (
    typeof version !== "string" ||
    !TEMPLATE_MANIFEST_VERSION_RE.test(version)
  ) {
    fail(`version「${String(version)}」必须是语义化版本（x.y.z）`);
  }

  // ④ description（落库到 task_templates.description）
  const description = raw.description;
  if (typeof description !== "string" || description.trim() === "") {
    fail("description 必须是非空字符串");
  } else if (description.length > TEMPLATE_MANIFEST_DESCRIPTION_MAX) {
    fail(
      `description 超过 ${TEMPLATE_MANIFEST_DESCRIPTION_MAX} 字符（${description.length}）`,
    );
  }

  // ⑤ capabilities（复用 SOP 的四值域，不抄副本）
  const capabilities: string[] = [];
  if (!Array.isArray(raw.capabilities)) {
    fail("capabilities 必须是数组");
  } else {
    for (const c of raw.capabilities) {
      if (!SOP_CAPABILITIES.includes(c as never)) {
        fail(
          `capabilities 含「${String(c)}」，不在能力域枚举内（${SOP_CAPABILITIES.join("/")}）`,
        );
        continue;
      }
      capabilities.push(String(c));
    }
    if (new Set(capabilities).size !== capabilities.length) {
      fail("capabilities 有重复项");
    }
  }

  // ⑥ params（每一项照 userConfig 形状；未知键同样拒绝）
  const params: Record<string, Record<string, unknown>> = {};
  if (!isPlainObject(raw.params)) {
    fail("params 必须是对象");
  } else {
    for (const [pkey, pval] of Object.entries(raw.params)) {
      const at = `params.${pkey}`;
      if (!isPlainObject(pval)) {
        fail(`${at} 必须是对象`);
        continue;
      }
      for (const k of Object.keys(pval)) {
        if (!(TEMPLATE_MANIFEST_PARAM_KEYS as readonly string[]).includes(k)) {
          fail(
            `未知键 ${at}.${k}（参数声明是机器契约，不接受自由字段；` +
              `也不接受 hook/command 这类可执行片段）`,
          );
        }
      }
      const type = pval.type;
      if (
        !(TEMPLATE_MANIFEST_PARAM_TYPES as readonly unknown[]).includes(type)
      ) {
        fail(`${at}.type 必须是 ${TEMPLATE_MANIFEST_PARAM_TYPES.join("/")}`);
      }
      if (pval.required !== undefined && typeof pval.required !== "boolean") {
        fail(`${at}.required 必须是布尔值`);
      }
      if (pval.title !== undefined && typeof pval.title !== "string") {
        fail(`${at}.title 必须是字符串`);
      }
      if (
        pval.description !== undefined &&
        typeof pval.description !== "string"
      ) {
        fail(`${at}.description 必须是字符串`);
      }
      if (pval.default !== undefined) {
        const d = pval.default;
        const ok =
          (type === "string" && typeof d === "string") ||
          (type === "number" && typeof d === "number" && Number.isFinite(d)) ||
          (type === "boolean" && typeof d === "boolean");
        if (!ok) fail(`${at}.default 的类型必须是 ${String(type)}`);
      }
      if (pval.options !== undefined) {
        if (!Array.isArray(pval.options) || pval.options.length === 0) {
          fail(`${at}.options 必须是非空数组`);
        } else {
          for (const o of pval.options) {
            if (!["string", "number", "boolean"].includes(typeof o)) {
              fail(`${at}.options 的成员只能是 string/number/boolean`);
              break;
            }
          }
          if (
            pval.default !== undefined &&
            !pval.options.some((o) => o === pval.default)
          ) {
            fail(`${at}.default 必须出现在 options 里`);
          }
        }
      }
      params[pkey] = pval;
    }
  }

  // ⑦ entrypoints：只做**静态**判据（相对、不越界、非空），不判存在性——
  //    请求体没有目录上下文，那些文件在中台机器上本来就不存在。
  const entrypoints: string[] = [];
  if (!Array.isArray(raw.entrypoints)) {
    fail("entrypoints 必须是数组");
  } else {
    for (const [i, ep] of raw.entrypoints.entries()) {
      const at = `entrypoints[${i}]`;
      if (typeof ep !== "string" || ep.trim() === "") {
        fail(`${at} 必须是非空字符串`);
        continue;
      }
      if (ep.includes("\0")) {
        fail(`${at} 含空字节`);
        continue;
      }
      if (ep.startsWith("/") || /^[A-Za-z]:[\\/]/.test(ep)) {
        fail(`${at}「${ep}」是绝对路径：entrypoint 必须相对本模板目录`);
        continue;
      }
      if (ep.split(/[\\/]/).includes("..")) {
        fail(
          `${at}「${ep}」越界：不允许 ../ 段（entrypoint 必须落在本模板目录内）`,
        );
        continue;
      }
      entrypoints.push(ep);
    }
  }

  // ⑧ registry 附加键：path 的目录名必须等于 name；contentHash 必须与清单内容
  //    自洽（否则「从 registry 导一条」就是导了个对不上的东西）。
  if (raw.path !== undefined) {
    if (typeof raw.path !== "string" || raw.path.trim() === "") {
      fail("path 必须是非空字符串（来自 registry 条目；可省略）");
    } else if (
      typeof name === "string" &&
      raw.path.split(/[\\/]/).filter(Boolean).pop() !== name
    ) {
      fail(
        `path「${raw.path}」的目录名必须逐字等于 name「${String(name)}」` +
          `（否则这条 registry 记录指向的不是这份清单）`,
      );
    }
  }
  if (raw.contentHash !== undefined) {
    if (
      typeof raw.contentHash !== "string" ||
      !/^[0-9a-f]{64}$/.test(raw.contentHash)
    ) {
      fail("contentHash 必须是 64 位小写十六进制（可省略）");
    }
  }

  if (errors.length > 0) {
    throw new AppError("VALIDATION_FAILED", { detail: errors.join(" | ") });
  }

  const manifest: NormalizedTemplateManifest = {
    name: name as string,
    version: version as string,
    description: description as string,
    capabilities,
    params,
    entrypoints,
  };

  // ⑨ 内容锚自洽：给了 contentHash 就必须等于本清单的哈希（防「清单改了、
  //    registry 没重生成」这类漂移被原样导进 DB）。
  if (typeof raw.contentHash === "string") {
    const actual = templateManifestContentHash(manifest);
    if (actual !== raw.contentHash) {
      throw new AppError("VALIDATION_FAILED", {
        detail:
          `contentHash 与清单内容不一致（声明 ${raw.contentHash}，实算 ${actual}）：` +
          `清单被改过而 registry 没重生成——先跑 ` +
          `node scripts/check-template-manifest.mjs --write`,
      });
    }
  }

  const cfg = raw[TEMPLATE_IMPORT_CONFIG_KEY];
  const parsed: ParsedTemplateImport = { manifest };
  if (cfg !== undefined) {
    if (!isPlainObject(cfg)) {
      // 与 create 端点同款错误码（config 必须是对象），保持对外契约一致。
      throw new AppError("TASK_TEMPLATE_CONFIG_NOT_OBJECT");
    }
    parsed.explicitConfig = cfg;
  }
  return parsed;
}

/** 官方模板里与 key 对应的种子（可能没有）。 */
export function findOfficialTemplate(
  key: string,
): (typeof OFFICIAL_TASK_TEMPLATES)[number] | undefined {
  return OFFICIAL_TASK_TEMPLATES.find((t) => t.key === key);
}

/**
 * 决定本次导入落库的 `config`，以及它从哪来。
 *
 * 优先级：**请求体显式 `config` > 官方常量**（与 instantiate 的「显式覆盖默认」
 * 同一取向）。两处都没有 ⇒ 400：清单不携带可执行内容（见文件头注），没有 config
 * 的模板即使落库也跑不起来，宁可当场拒绝也不留一条"看起来能用"的死模板。
 */
export function resolveImportConfig(
  manifest: NormalizedTemplateManifest,
  explicitConfig?: Record<string, unknown>,
): { config: Record<string, unknown>; source: "request" | "official" } {
  if (explicitConfig) {
    return { config: explicitConfig, source: "request" };
  }
  const official = findOfficialTemplate(manifest.name);
  if (official) {
    return { config: official.config, source: "official" };
  }
  throw new AppError("VALIDATION_FAILED", {
    detail:
      `清单「${manifest.name}」不是官方模板 key，且请求体没有 config —— ` +
      `清单是声明式分发物、刻意不携带可执行内容（glueSource/entrypoint 都在 ` +
      `task_templates.config 里），请在请求体补 config`,
  });
}

/**
 * 落库时用的展示名与分类：官方 key 取官方种子的 `name`/`category`（这样
 * 「按清单重建一行」与迁移 seed 的行长得一样）；非官方 key 没有别的名字来源，
 * 退回用 `name`（即 key）作展示名，category 留 NULL。
 */
export function resolveImportDisplay(manifest: NormalizedTemplateManifest): {
  name: string;
  category: string | null;
} {
  const official = findOfficialTemplate(manifest.name);
  return {
    name: official ? official.name : manifest.name,
    category: official ? official.category : null,
  };
}

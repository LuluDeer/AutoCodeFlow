#!/usr/bin/env node
/**
 * WEB-TYPE-FIELD-DRIFT：admin-web 手写类型 ↔ 生成 schema 的**字段级**漂移守卫。
 *
 * ## 为什么需要它（与既有 `check-web-type-drift.mjs` 的分工）
 *
 * 既有守卫（第 47 条）守的是**名字集合**：它把 `src/api/*.ts` 里 133 处顶层声明
 * 冻在基线里，新增手写类型即红。它**看不见字段**——这是本轮实测确认的空档：
 *
 *   `interface Executor`（api/executors.ts:3，手写）与
 *   `components['schemas']['ExecutorResponseDto']`（生成物）语义重复，
 *   但生成物有而手写版**没有** `capabilities` / `consecutiveHeartbeatMisses` /
 *   `createdAt` / `executorStartedAt` / `executorStartupId` / `updatedAt` 六个字段。
 *   后端一旦开始下发这些字段，前端**编译照样通过**、运行时静默读到 `undefined`，
 *   tsc 与既有 47 条守卫**全都不会红**。
 *
 * 本守卫补的就是这一层：比对手写类型与对应生成 schema 的**字段集合**。
 *
 * ## 判据（人能复核的规则）
 *
 * 扫描面与既有守卫**逐字一致**（直接复用它的 parse 层，不抄第二份判据）：
 *   `apps/admin-web/src/api/*.ts`（非递归，排除 `*.spec.ts` / `*.test.ts` / `*.d.ts`），
 *   只统计**第 0 列**的 `interface` / `type` 声明。
 * 排除面同样一致：**合同派生**（RHS/extends 里出现 `components['schemas']`）与
 * **字面量镜像**（`(typeof X)[number]`）不进本守卫的比较面——它们本就来自生成物。
 *
 * 配对（手写名 → 生成 schema 名），按**先严后宽**四级，命中即停：
 *   ① 严格同名；
 *   ② 手写名 + 后缀 ∈ 生成物（`Executor` → `ExecutorResponseDto`）；
 *   ③ 生成名剥后缀 == 手写名（`ExecutorResponseDto` 剥 `ResponseDto` → `Executor`）；
 *   ④ 双方各剥一层后缀后相等。
 * 后缀表固定（`SUFFIXES`），**不做模糊相似度匹配**——宁可漏配（计入「未配对」，
 * 只报读数），也不制造假配对把无关类型的字段差算成漂移。
 * 配对成功但任一侧**没有对象字面量体**（alias / union / enum / 函数）⇒ 记
 * `notComparable`，**不参与漂移判定**（诚实边界：没字段集就无从比对）。
 * 配对成功且双方都有 `extends` ⇒ 记 `notComparable`（继承来的字段不在本文件的
 * 字面量体里，静态判读会把它误报成「生成物有、手写无」）。
 *
 * 漂移定义（只这两类，各给方向）：
 *   · `missing`：生成物有、手写版**无** ⇒ 后端新增字段前端读不到（最危险的一类）；
 *   · `extra`  ：手写版有、生成物无 ⇒ 前端仍按旧契约发/收一个已不存在的字段。
 *
 * ## 首版判红策略（刻意的：可见性 + 增长闸，不做一次性红爆）
 *
 * 现状实测（脚本自己算，见 `--report`）：**已漂移字段 = 6**（全部是
 * `Executor` 的 `missing` 方向）。若首版就按「有漂移即红」判，这 6 处会让主干
 * 立刻永久变红——它们不是本轮要修的（修它等于改 `Executor` 的消费面，属下一
 * 迭代的迁移批次，主会话 R11 已裁定不迁存量）。
 *
 * 所以首版判据是**增长闸**：
 *   ① `baseline.drift` 冻结「配对 × 方向 × 字段」三元组集合；
 *      出现基线外的三元组 ⇒ **红**（新增漂移，必须显式登记理由）；
 *      基线里的三元组消失了 ⇒ **红**（收紧是好事，但必须同步删条目，
 *      否则基线会烂成一张没人看的豁免单——与既有守卫同一条纪律）；
 *   ② `baseline.notPairs` 冻结「配对不上的手写类型」集合：**数量不得增长**
 *      （否则「新增手写类型」可以靠取一个配不上的名字绕过字段比对）；
 *   ③ 结构红（不是判绿）：api 目录 / 生成物 / 基线缺失，或扫描面塌到下界
 *      （文件数、声明数、schema 数、配对数低于 `MIN_*`）一律红——
 *      「零条漂移」在扫描面为空时是不可信的。
 *
 * 字段级「一次性全红」延后一迭代：那时先把 6 处 `Executor` 缺口补上或显式
 * 豁免，再把判据从「增长闸」切换到「有漂移即红」。
 *
 * ## 自检（`--selftest`）
 *
 * 用 `scripts/lib/guard-selftest.mjs` 跑**真子进程**，每条用例造一棵临时 fixture
 * 树并断言**退出码 + 关键报错文本**，含正例控制组。核心用例（本守卫的存在理由）：
 *   · 在 fixture 里**构造一处字段漂移** ⇒ 必须红，且报错文本点名那个字段；
 *   · 撤掉那处漂移 ⇒ 必须绿。
 * 即「守卫能防住回归」这件事本身被实证，而不是只声称。
 * 另有：基线陈旧 / 未配对增长 / 生成物缺失（结构红）/ 配对规则各级 /
 * extends 与 alias 的 notComparable 边界。
 *
 * 退出码：0 = 无新增漂移、基线活着、判据可信；1 = 新增漂移 / 基线陈旧 /
 *         未配对增长 / **判据不可信**（结构红）。
 *
 * 用法：
 *   node scripts/check-web-type-field-drift.mjs             # 判红（增长闸）
 *   node scripts/check-web-type-field-drift.mjs --report    # 只报现状，漂移不判红
 *   node scripts/check-web-type-field-drift.mjs --selftest  # 跑自检
 *   node scripts/check-web-type-field-drift.mjs --root <dir>  # selftest 专用
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  classify,
  listApiFiles,
  maskNonCode,
  matchBracket,
  readDeclTail,
  stripComments,
} from "./check-web-type-drift.mjs";
import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** 默认仓库根：脚本位于 `<repo>/scripts/`，由脚本位置推出，不依赖调用方 cwd。 */
export const DEFAULT_ROOT = resolve(HERE, "..");

const API_DIR = "apps/admin-web/src/api";
const GENERATED_REL = "apps/admin-web/src/types/generated/api-types.ts";
const BASELINE_REL = "scripts/web-type-field-drift-baseline.json";

/**
 * 扫描面下界（实测：26 个 api 文件 / 133 处顶层声明 / 244 个生成 schema）。
 * 取实测值的一半左右做「塌方」判据：既不会因正常增减误红，又能在
 * 「扫错目录 / 生成物被清空」时立刻红。
 */
export const MIN_API_FILES = 15;
export const MIN_DECLARATIONS = 60;
export const MIN_GENERATED_SCHEMAS = 100;
export const MIN_PAIRS = 25;

/**
 * 名字后缀表：**固定、可复核**，按从长到短排列（先剥长的，避免
 * `ExecutorResponseDto` 被 `Dto` 先剥成 `ExecutorResponse`）。
 * 刻意不做模糊/编辑距离匹配——假配对会把无关类型的字段差算成漂移。
 */
export const SUFFIXES = [
  "AdminViewDto",
  "ResponseDto",
  "RequestDto",
  "ViewDto",
  "PayloadDto",
  "Response",
  "Request",
  "AdminView",
  "Payload",
  "Result",
  "View",
  "Row",
  "Page",
  "List",
  "Params",
  "Filters",
  "Stats",
  "Dto",
];

// ── 字段提取 ─────────────────────────────────────────────────────────────────

/**
 * 从**对象体**（`{` 与 `}` 之间的原文）提取字段名。
 *
 * 深度 0 才收：嵌套对象/函数签名的参数名不算字段。
 * 排除索引签名 `[key: string]: …`（名字前紧贴 `[`）。
 * 只取 `name:` / `name?:` 形态——方法签名 `name(` 不是数据字段。
 */
export function fieldsOfObjectBody(maskedBody) {
  const fields = new Set();
  let depth = 0;
  for (let i = 0; i < maskedBody.length; i++) {
    const c = maskedBody[i];
    if (c === "{" || c === "(" || c === "[") {
      depth++;
      continue;
    }
    if (c === "}" || c === ")" || c === "]") {
      depth--;
      continue;
    }
    if (depth !== 0) continue;
    const re = /([A-Za-z_$][\w$]*)\s*\??\s*:/y;
    re.lastIndex = i;
    const hit = re.exec(maskedBody);
    if (!hit) continue;
    const prev = i > 0 ? maskedBody[i - 1] : "";
    if (prev !== "[") fields.add(hit[1]);
    i = re.lastIndex - 1;
  }
  return fields;
}

/**
 * 解析生成物的 `components { schemas { … } }`，返回 `Map<schemaName, entry>`。
 * entry = `{ form: "object", fields:Set }` 或 `{ form: "value" }`（alias/union，
 * 无字面量字段集，不参与比对）。
 *
 * 与既有 `parseGeneratedSchemas`（只取名字）的区别：这里要**进每个 schema 的体**。
 */
export function parseGeneratedSchemaFields(text) {
  const masked = maskNonCode(text);
  const m = /(^|\n)\s*schemas\s*:\s*\{/.exec(masked);
  if (!m) return null;
  const braceAt = masked.indexOf("{", m.index + m[1].length);
  if (braceAt < 0) return null;
  const end = matchBracket(masked, braceAt);
  if (end < 0) return null;
  const body = masked.slice(braceAt + 1, end);
  const out = new Map();

  let depth = 0;
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === "{" || c === "(" || c === "[") {
      depth++;
      i++;
      continue;
    }
    if (c === "}" || c === ")" || c === "]") {
      depth--;
      i++;
      continue;
    }
    if (depth !== 0) {
      i++;
      continue;
    }
    const re = /([A-Za-z_$][\w$]*)\s*\??\s*:/y;
    re.lastIndex = i;
    const hit = re.exec(body);
    if (!hit) {
      i++;
      continue;
    }
    const name = hit[1];
    let j = re.lastIndex;
    while (j < body.length && /\s/.test(body[j])) j++;
    if (body[j] === "{") {
      const vEnd = matchBracket(body, j);
      if (vEnd > 0) {
        out.set(name, { form: "object", fields: fieldsOfObjectBody(body.slice(j + 1, vEnd)) });
        i = vEnd + 1;
        continue;
      }
    }
    // 值形态（alias / union / 标量）：吃到深度 0 的 `;` 为止。
    let k = re.lastIndex;
    while (k < body.length && body[k] !== ";") k++;
    out.set(name, { form: "value" });
    i = k + 1;
  }
  return out;
}

/**
 * 扫描 `src/api/*.ts` 的顶层声明，返回每条的字段集与形态。
 * 与既有 `scanApiDeclarations` 同一套定位规则（第 0 列 + stripComments/maskNonCode），
 * 只是额外保留 body 字段集。
 */
export function scanHandwrittenFields(root) {
  const files = listApiFiles(root);
  if (files === null) return null;
  const decls = [];
  const re = /^(?:export\s+)?(interface|type)\s+([A-Za-z_$][\w$]*)/gm;

  for (const file of files) {
    const raw = readFileSync(join(root, API_DIR, file), "utf8");
    const src = stripComments(raw);
    const masked = maskNonCode(src);
    const rel = `${API_DIR}/${file}`;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(masked)) !== null) {
      const kind = m[1];
      const name = m[2];
      const after = m.index + m[0].length;
      const line = src.slice(0, m.index).split("\n").length;

      let fields = null;
      let form = "value";
      let rhs = "";
      let extendsText = "";

      if (kind === "interface") {
        const tail = readDeclTail(src, after, true);
        extendsText = tail.text.trim();
        const braceAt = tail.end;
        if (masked[braceAt] === "{") {
          const endB = matchBracket(masked, braceAt);
          if (endB > 0) {
            fields = fieldsOfObjectBody(masked.slice(braceAt + 1, endB));
            form = "object";
          }
        }
      } else {
        const tail = readDeclTail(src, after, false);
        rhs = tail.text.trim();
        const bodyTxt = rhs.startsWith("=") ? rhs.slice(1).trim() : rhs;
        // 只认**纯对象字面量**：union（`A | B`）与交叉类型的字段集不可静态判定。
        if (bodyTxt.startsWith("{") && !/[|&]/.test(bodyTxt)) {
          let j = after;
          while (j < masked.length && masked[j] !== "{") j++;
          const endB = j < masked.length ? matchBracket(masked, j) : -1;
          if (endB > 0) {
            fields = fieldsOfObjectBody(masked.slice(j + 1, endB));
            form = "object";
          }
        }
      }

      const decl = { file: rel, name, kind, line, rhs, extendsText, form, fields };
      decl.bucket = classify(decl);
      decls.push(decl);
    }
  }
  return decls;
}

// ── 配对 ─────────────────────────────────────────────────────────────────────

/** 剥一层后缀（命中即返回剥后的名字，否则 null）。 */
function stripOneSuffix(name) {
  for (const s of SUFFIXES) {
    if (name.length > s.length && name.endsWith(s)) return name.slice(0, -s.length);
  }
  return null;
}

/**
 * 配对（手写名 → 生成 schema 名），**两段式**：名字提议 + 字段重叠确认。
 *
 * 第一段（名字提议），先严后宽四级，命中即停：
 *   ① 严格同名；
 *   ② 手写名 + 后缀 ∈ 生成物（`Executor` → `ExecutorResponseDto`）；
 *   ③ 生成名剥后缀 == 手写名（`ExecutorResponseDto` 剥 `ResponseDto` → `Executor`）；
 *   ④ 双方各剥一层后缀后相等。
 *
 * 第二段（重叠确认）：**光靠名字会造出假配对**。实测反例（本仓真实数据）：
 * `LoginResult`（响应：accessToken/refreshToken/user/totpRequired）与
 * `LoginDto`（请求：username/password）在规则④下被剥成同一个 `Login` ⇒ 若直接
 * 采信，会把「请求体 vs 响应体」的结构差异算成 6 处字段漂移（纯噪声，且会
 * 淹没真漂移）。故要求两边字段集至少有 `OVERLAP_MIN` 的**包含度**
 * （交集 / 较小一侧），否则判为「名字像但字段不像」的疑似假配对，
 * 归入 `weakPairs` **不参与漂移判定**，并在 `--report` 里显式列出
 * （诚实：排除就写出来，不静默丢）。
 *
 * 阈值取 0.6（实测标定，不是随手取的）：
 *   · `Executor`(29) ↔ `ExecutorResponseDto`(36) 重叠 29 ⇒ **100%** 通过；
 *   · `LoginResult` ↔ `LoginDto`（请求体 vs 响应体）重叠 0 ⇒ 排除；
 *   · `DeployVersionResult`（ok/dispatched/skipped…）↔ `DeployVersionDto`
 *     （executorIds/versionId）重叠恰好 50% ⇒ 0.6 排除（响应信封 vs 载荷，
 *     不是同一概念）。
 *   ⚠️ 关键：包含度的分母是**较小一侧**，所以「手写版陈旧、只缺字段」的真漂移
 *   仍得 100%（手写侧是生成侧的子集），不会被阈值误杀——被挡掉的只会是
 *   「两边各有一堆对方没有的字段」的不同概念。
 */
export const OVERLAP_MIN = 0.6;

/** 包含度：交集 / 较小一侧字段数。空集返回 0（无证据，不确认）。 */
export function overlapRatio(a, b) {
  if (!a || !b || a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const f of a) if (b.has(f)) inter++;
  return inter / Math.min(a.size, b.size);
}

/**
 * 手写名 → 生成 schema 名，四级「先严后宽」。
 * @returns {string|null} 配到的 schema 名
 */
export function pairName(handName, generatedNames) {
  // ① 严格同名
  if (generatedNames.has(handName)) return handName;
  // ② 手写名 + 后缀 ∈ 生成物
  for (const s of SUFFIXES) {
    const cand = `${handName}${s}`;
    if (generatedNames.has(cand)) return cand;
  }
  // ③ 生成名剥后缀 == 手写名
  for (const g of generatedNames) {
    if (stripOneSuffix(g) === handName) return g;
  }
  // ④ 双方各剥一层后相等
  const handStripped = stripOneSuffix(handName);
  if (handStripped) {
    for (const g of generatedNames) {
      if (stripOneSuffix(g) === handStripped) return g;
    }
  }
  return null;
}

// ── 判据核心 ─────────────────────────────────────────────────────────────────

/**
 * 计算一次完整比较结果。**纯函数式**：给定 decls 与 schemas，返回结构化读数。
 * 所有判红/判绿都从这里出来的数字决定，`--report` 与主跑共用同一份。
 */
export function compare(decls, schemas) {
  const generatedNames = new Set(schemas.keys());
  const pairs = [];
  const notPairs = [];
  const notComparable = [];
  const weakPairs = [];
  const drift = [];

  for (const d of decls) {
    if (d.bucket !== "handwritten") continue;
    const schemaName = pairName(d.name, generatedNames);
    if (!schemaName) {
      notPairs.push(d);
      continue;
    }
    const schema = schemas.get(schemaName);
    // 任一侧无字面量体 / 任一侧有 extends ⇒ 静态判读会误报，明确排除。
    if (d.form !== "object" || schema.form !== "object") {
      notComparable.push({ decl: d, schema: schemaName, why: "non-object" });
      continue;
    }
    if (d.extendsText && /^extends\b/.test(d.extendsText)) {
      notComparable.push({ decl: d, schema: schemaName, why: "extends" });
      continue;
    }
    // 第二段：字段重叠确认。名字像但字段完全不像 ⇒ 疑似假配对，排除并列出。
    const ratio = overlapRatio(d.fields, schema.fields);
    if (ratio < OVERLAP_MIN) {
      weakPairs.push({ decl: d, schema: schemaName, ratio });
      continue;
    }
    pairs.push({ decl: d, schema: schemaName, ratio });

    for (const f of schema.fields) {
      if (!d.fields.has(f)) {
        drift.push({ file: d.file, hand: d.name, schema: schemaName, dir: "missing", field: f });
      }
    }
    for (const f of d.fields) {
      if (!schema.fields.has(f)) {
        drift.push({ file: d.file, hand: d.name, schema: schemaName, dir: "extra", field: f });
      }
    }
  }

  return { pairs, notPairs, notComparable, weakPairs, drift };
}

/** 漂移三元组的稳定键（人可复核、可 diff、与 file 解耦顺序无关）。 */
export const driftKey = (x) => `${x.file}\t${x.hand}\t${x.dir}:${x.field}`;

/** 扫全量：结构问题 + 读数。结构问题非空 ⇒ 调用方必须判红。 */
export function scanSurface(root) {
  const problems = [];
  const decls = scanHandwrittenFields(root);
  if (decls === null) {
    problems.push(`api 目录不存在：${API_DIR}`);
    return { problems, decls: [], schemas: new Map(), result: null };
  }
  const genPath = join(root, GENERATED_REL);
  if (!existsSync(genPath)) {
    problems.push(`生成物缺失：${GENERATED_REL}（没有比对对象，拒绝判绿）`);
    return { problems, decls, schemas: new Map(), result: null };
  }
  const schemas = parseGeneratedSchemaFields(readFileSync(genPath, "utf8"));
  if (!schemas || schemas.size === 0) {
    problems.push(`生成物结构不可解析：${GENERATED_REL}（找不到 components.schemas）`);
    return { problems, decls, schemas: new Map(), result: null };
  }

  const handCount = decls.filter((d) => d.bucket === "handwritten").length;
  if (decls.length < MIN_DECLARATIONS) {
    problems.push(`扫描面塌方：顶层声明 ${decls.length} < 下界 ${MIN_DECLARATIONS}`);
  }
  if (schemas.size < MIN_GENERATED_SCHEMAS) {
    problems.push(`扫描面塌方：生成 schema ${schemas.size} < 下界 ${MIN_GENERATED_SCHEMAS}`);
  }
  const result = compare(decls, schemas);
  if (handCount >= MIN_DECLARATIONS && result.pairs.length < MIN_PAIRS) {
    problems.push(`扫描面塌方：配对数 ${result.pairs.length} < 下界 ${MIN_PAIRS}`);
  }
  const files = new Set(decls.map((d) => d.file));
  if (files.size < MIN_API_FILES) {
    problems.push(`扫描面塌方：api 文件 ${files.size} < 下界 ${MIN_API_FILES}`);
  }

  return { problems, decls, schemas, result, handCount };
}

/** 读基线；**结构损坏一律抛错**（由调用方转结构红），绝不把坏基线当空基线。 */
export function loadBaseline(root) {
  const p = join(root, BASELINE_REL);
  if (!existsSync(p)) {
    const err = new Error(`基线文件不存在：${BASELINE_REL}（增长闸没有参照物）`);
    err.structural = true;
    throw err;
  }
  let json;
  try {
    json = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    const err = new Error(`基线不是合法 JSON：${BASELINE_REL}（${e.message}）`);
    err.structural = true;
    throw err;
  }
  if (!Array.isArray(json.drift)) {
    const err = new Error(`基线缺 drift 数组：${BASELINE_REL}`);
    err.structural = true;
    throw err;
  }
  if (!Array.isArray(json.notPairs)) {
    const err = new Error(`基线缺 notPairs 数组：${BASELINE_REL}`);
    err.structural = true;
    throw err;
  }
  return { drift: json.drift.map(String), notPairs: json.notPairs.map(String) };
}

/** 增长闸：把当前读数与基线比对，返回 增/减/未配对增长 三组。 */
export function ratchet(surface, baseline) {
  const cur = new Map();
  for (const d of surface.result.drift) cur.set(driftKey(d), d);
  const base = new Set(baseline.drift);

  const added = [...cur.entries()].filter(([k]) => !base.has(k)).map(([, v]) => v);
  const removed = [...base].filter((k) => !cur.has(k));

  const curNotPairs = new Set(surface.result.notPairs.map((d) => `${d.file}\t${d.name}`));
  const baseNotPairs = new Set(baseline.notPairs);
  const notPairsAdded = [...curNotPairs].filter((k) => !baseNotPairs.has(k));
  const notPairsRemoved = [...baseNotPairs].filter((k) => !curNotPairs.has(k));

  return { added, removed, notPairsAdded, notPairsRemoved, cur, base };
}

// ── 输出 ─────────────────────────────────────────────────────────────────────

function printStructureProblems(problems) {
  console.error("✖ 结构红：判据不可静态判读，拒绝判绿（不是「没有漂移」）：");
  for (const p of problems) console.error(`  · ${p}`);
  console.error("  处置：先修事实源/扫描面（生成物、api 目录、基线文件），再谈增长闸。");
}

function summarizeDir(drift) {
  const missing = drift.filter((d) => d.dir === "missing").length;
  const extra = drift.filter((d) => d.dir === "extra").length;
  return { missing, extra };
}

/** `--report`：只报现状，**漂移不判红**，结构红照判。 */
export function report(opts) {
  const root = opts.root ?? DEFAULT_ROOT;
  const surface = scanSurface(root);
  console.log("── WEB-TYPE-FIELD-DRIFT 现状报告（只读；漂移不判红，结构问题照判）──");
  console.log(`仓库根：${root}\n`);

  if (surface.problems.length > 0) {
    printStructureProblems(surface.problems);
    return 1;
  }

  const { decls, schemas, result } = surface;
  const hand = decls.filter((d) => d.bucket === "handwritten");
  const { missing, extra } = summarizeDir(result.drift);

  console.log("── 判据 ──");
  console.log("扫描面：apps/admin-web/src/api/*.ts（非递归，排除 *.spec/*.test/*.d.ts）");
  console.log("计数对象：第 0 列 interface / type 声明；排除合同派生与字面量镜像");
  console.log("比对：手写类型 ↔ 配对的生成 schema（严格同名 → 加后缀 → 剥后缀 → 双剥）");
  console.log("漂移：missing（生成物有·手写无）/ extra（手写有·生成物无）\n");

  console.log("── 扫描面 ──");
  console.log(`api 文件：${new Set(decls.map((d) => d.file)).size} 个`);
  console.log(`顶层类型声明：${decls.length} 处（其中手写 ${hand.length} 处参与比对）`);
  console.log(`生成物 components['schemas']：${schemas.size} 个\n`);

  console.log("── 配对读数 ──");
  console.log(`已配对（可比字段集）：${result.pairs.length} 处`);
  console.log(`未配对（无同名 schema）：${result.notPairs.length} 处`);
  console.log(`不可比（alias/union/extends 或无字面量体）：${result.notComparable.length} 处`);
  console.log(
    `疑似假配对（名字像但字段重叠 < ${OVERLAP_MIN}，已排除）：${result.weakPairs.length} 处\n`,
  );

  console.log("── 字段级漂移现状 ──");
  console.log(`合计：${result.drift.length} 处字段漂移（missing ${missing} / extra ${extra}）`);
  const byHand = new Map();
  for (const d of result.drift) {
    const k = `${d.file}\t${d.hand} → ${d.schema}`;
    if (!byHand.has(k)) byHand.set(k, []);
    byHand.get(k).push(d);
  }
  for (const [k, list] of [...byHand.entries()].sort()) {
    const miss = list.filter((x) => x.dir === "missing").map((x) => x.field);
    const ext = list.filter((x) => x.dir === "extra").map((x) => x.field);
    console.log(`  ${k}`);
    if (miss.length) console.log(`    missing（生成物有·手写无）：${miss.join(", ")}`);
    if (ext.length) console.log(`    extra  （手写有·生成物无）：${ext.join(", ")}`);
  }

  if (result.notPairs.length > 0) {
    console.log("\n── 未配对明细（只报读数，不判红）──");
    for (const d of result.notPairs) console.log(`  ${d.file}  ${d.name}`);
  }
  if (result.pairs.length > 0) {
    // 配对质量：重叠率越低越可疑（下一迭代收紧 OVERLAP_MIN 的观察面）。
    console.log("\n── 配对质量（按重叠率升序；低重叠 = 下一步该复核的配对）──");
    for (const { decl, schema, ratio } of [...result.pairs].sort((a, b) => a.ratio - b.ratio)) {
      console.log(`  ${(ratio * 100).toFixed(0).padStart(3)}%  ${decl.name} → ${schema}`);
    }
  }
  if (result.notComparable.length > 0) {
    console.log("\n── 不可比明细（诚实边界：无字面量体或 extends）──");
    for (const { decl, schema, why } of result.notComparable) {
      console.log(`  ${decl.file}  ${decl.name} → ${schema}（${why}）`);
    }
  }
  if (result.weakPairs.length > 0) {
    console.log(
      `\n── 疑似假配对明细（名字相近但字段重叠 < ${OVERLAP_MIN}；**不参与漂移判定**）──`,
    );
    console.log("  排除理由：把「请求体 vs 响应体」这类同名不同义算成漂移是纯噪声，会淹没真漂移。");
    for (const { decl, schema, ratio } of result.weakPairs) {
      console.log(`  ${decl.file}  ${decl.name} → ${schema}（重叠 ${(ratio * 100).toFixed(0)}%）`);
    }
  }
  return 0;
}

/** 主跑：增长闸判红。 */
export function run(opts) {
  const root = opts.root ?? DEFAULT_ROOT;
  const surface = scanSurface(root);
  if (surface.problems.length > 0) {
    printStructureProblems(surface.problems);
    return 1;
  }

  let baseline;
  try {
    baseline = loadBaseline(root);
  } catch (e) {
    printStructureProblems([e.message]);
    return 1;
  }

  const r = ratchet(surface, baseline);
  const { missing, extra } = summarizeDir(surface.result.drift);
  const problems = [];

  if (r.added.length > 0) {
    problems.push(
      `新增字段漂移 ${r.added.length} 处（基线外；后端新增字段而手写类型没跟上，或反之）：`,
    );
    for (const d of r.added) {
      problems.push(`    ${d.file}  ${d.hand} → ${d.schema}  ${d.dir}:${d.field}`);
    }
    problems.push(
      "  处置：让手写类型跟上合同（首选），或确实是有意分歧 → 连同 reason 登记进基线。",
    );
  }
  if (r.removed.length > 0) {
    problems.push(
      `基线陈旧 ${r.removed.length} 处（基线登记了、当前已不存在）：收紧是好事，但必须同步删条目，否则基线会烂成豁免单：`,
    );
    for (const k of r.removed) problems.push(`    ${k}`);
  }
  if (r.notPairsAdded.length > 0) {
    problems.push(
      `未配对手写类型增长 ${r.notPairsAdded.length} 处（新增类型取了个配不上生成 schema 的名字，可绕过字段比对）：`,
    );
    for (const k of r.notPairsAdded) problems.push(`    ${k}`);
  }
  if (r.notPairsRemoved.length > 0) {
    problems.push(
      `基线未配对集合陈旧 ${r.notPairsRemoved.length} 处（当前已不存在，请同步删条目）：`,
    );
    for (const k of r.notPairsRemoved) problems.push(`    ${k}`);
  }

  if (problems.length > 0) {
    console.error("✖ WEB-TYPE-FIELD-DRIFT：手写类型 ↔ 生成 schema 的字段层出现增长/陈旧：");
    for (const p of problems) console.error(`  ${p}`);
    console.error(
      `  参照：node scripts/check-web-type-field-drift.mjs --report（现状 missing ${missing} / extra ${extra}）`,
    );
    return 1;
  }

  console.log(
    `✔ WEB-TYPE-FIELD-DRIFT：无新增字段漂移（配对 ${surface.result.pairs.length} 处，` +
      `现状漂移 ${surface.result.drift.length} 处 = 基线冻结：missing ${missing} / extra ${extra}；` +
      `未配对 ${surface.result.notPairs.length} 处）。`,
  );
  return 0;
}

// ── 自检 ─────────────────────────────────────────────────────────────────────

const SCRIPT = fileURLToPath(import.meta.url);

/** 造一棵最小 fixture 树：生成物 + api 文件 + 基线。 */
function fixture({
  generated,
  api = {},
  baseline = { drift: [], notPairs: [] },
  files = {},
}) {
  const tree = {
    [GENERATED_REL]: generated,
    [BASELINE_REL]: baseline,
    ...files,
  };
  for (const [name, body] of Object.entries(api)) {
    tree[`${API_DIR}/${name}`] = body;
  }
  return tree;
}

/**
 * fixture 的**基数**：必须越过结构下界（文件 15 / 声明 60 / schema 100 / 配对 25），
 * 否则每条用例都会先撞结构红，测不到判据本身。
 * 实测仓内真值：26 文件 / 133 声明 / 244 schema / 配对 ~90。
 */
const F_SCHEMAS = 110;
const F_FILES = 24;

/**
 * 合成生成物：`Schema0Dto … Schema109Dto`（各 2 字段）+ `WidgetResponseDto`。
 * 名字取 `XxxDto` 形态，与手写 `SchemaN` 走**配对规则③（剥后缀）**——顺便让
 * 每条用例都复用真实配对路径。
 */
function bigGenerated({ widgetFields = ["id", "name", "status"] } = {}) {
  const names = [];
  for (let i = 0; i < F_SCHEMAS; i++) names.push(`Schema${i}Dto`);
  const block = names
    .map((n) => `        ${n}: {\n            id: string;\n            name: string;\n        };`)
    .join("\n");
  return `export interface components {
    schemas: {
${block}
        WidgetResponseDto: {
${widgetFields.map((f) => `            ${f}: string;`).join("\n")}
        };
    };
}`;
}

/**
 * `F_FILES` 个 api 文件，各 3 个手写声明 `SchemaN`（与生成物 `SchemaNDto` 配对）。
 * ⇒ 声明数 ≈ 72 + 1(Widget)，配对数同量级，均越过下界。
 */
function bigApi({ widgetFields = ["id", "name", "status"] } = {}) {
  const api = {};
  let n = 0;
  for (let f = 0; f < F_FILES; f++) {
    const decls = [];
    for (let k = 0; k < 3 && n < F_SCHEMAS; k++, n++) {
      decls.push(`export interface Schema${n} {\n  id: string;\n  name: string;\n}\n`);
    }
    api[`m${f}.ts`] = decls.join("\n");
  }
  api["widget.ts"] = `export interface Widget {\n${widgetFields
    .map((f) => `  ${f}: string;`)
    .join("\n")}\n}\n`;
  return api;
}

/** 一份与 bigApi/bigGenerated 完全自洽的基线（Widget 三字段对齐、无漂移）。 */
function cleanBaseline() {
  return { drift: [], notPairs: [] };
}

export function selftest() {
  const cases = [];

  // ── 正例控制组：干净树必须绿 ────────────────────────────────────────────
  cases.push({
    name: "正例控制组：干净树 ⇒ 退出码 0",
    fn: () => {
      const { dir, cleanup } = makeFixtureRepo(
        fixture({ generated: bigGenerated(), api: bigApi(), baseline: cleanBaseline() }),
      );
      try {
        const r = runGuard(SCRIPT, { args: ["--root", dir] });
        expectExit(r, { code: 0, contains: ["无新增字段漂移"], label: "干净树" });
      } finally {
        cleanup();
      }
    },
  });

  // ── 核心用例：构造一处漂移 ⇒ 必须红，且点名那个字段 ─────────────────────
  // 这是本守卫存在的理由。**它必须能失败**：把 compare() 里的 missing 分支删掉，
  // 本条立刻变绿 —— 即守卫真的在防回归，而不是只打印。
  cases.push({
    name: "构造漂移（生成物有、手写无）⇒ 红且点名字段",
    fn: () => {
      const { dir, cleanup } = makeFixtureRepo(
        fixture({
          // 生成物多一个 `capabilities`，手写 Widget 没有
          generated: bigGenerated({ widgetFields: ["id", "name", "status", "capabilities"] }),
          api: bigApi({ widgetFields: ["id", "name", "status"] }),
          baseline: cleanBaseline(),
        }),
      );
      try {
        const r = runGuard(SCRIPT, { args: ["--root", dir] });
        expectExit(r, {
          code: 1,
          contains: ["新增字段漂移", "Widget", "missing:capabilities"],
          label: "构造 missing 漂移",
        });
      } finally {
        cleanup();
      }
    },
  });

  cases.push({
    name: "构造漂移（手写有、生成物无）⇒ 红且点名字段",
    fn: () => {
      const { dir, cleanup } = makeFixtureRepo(
        fixture({
          generated: bigGenerated({ widgetFields: ["id", "name"] }),
          api: bigApi({ widgetFields: ["id", "name", "legacyField"] }),
          baseline: cleanBaseline(),
        }),
      );
      try {
        const r = runGuard(SCRIPT, { args: ["--root", dir] });
        expectExit(r, {
          code: 1,
          contains: ["新增字段漂移", "extra:legacyField"],
          label: "构造 extra 漂移",
        });
      } finally {
        cleanup();
      }
    },
  });

  // ── 撤掉漂移 ⇒ 必须恢复绿（证「红是因为那处漂移，不是因为别的原因」）──
  cases.push({
    name: "撤掉漂移 ⇒ 恢复绿（红确实归因于那处漂移）",
    fn: () => {
      const gen = bigGenerated({ widgetFields: ["id", "name", "status", "capabilities"] });
      const hand = bigApi({ widgetFields: ["id", "name", "status"] });
      const red = makeFixtureRepo(fixture({ generated: gen, api: hand, baseline: cleanBaseline() }));
      try {
        expectExit(runGuard(SCRIPT, { args: ["--root", red.dir] }), {
          code: 1,
          label: "先红",
        });
      } finally {
        red.cleanup();
      }
      // 同一棵树，只把两个字段集对齐
      const green = makeFixtureRepo(
        fixture({
          generated: bigGenerated({ widgetFields: ["id", "name", "status", "capabilities"] }),
          api: bigApi({ widgetFields: ["id", "name", "status", "capabilities"] }),
          baseline: cleanBaseline(),
        }),
      );
      try {
        expectExit(runGuard(SCRIPT, { args: ["--root", green.dir] }), {
          code: 0,
          label: "对齐后转绿",
        });
      } finally {
        green.cleanup();
      }
    },
  });

  // ── 增长闸的「冻结」语义：已知漂移登记进基线 ⇒ 不红 ─────────────────────
  cases.push({
    name: "已知漂移登记进基线 ⇒ 不红（增长闸只罚增量）",
    fn: () => {
      const { dir, cleanup } = makeFixtureRepo(
        fixture({
          generated: bigGenerated({ widgetFields: ["id", "name", "status", "capabilities"] }),
          api: bigApi({ widgetFields: ["id", "name", "status"] }),
          baseline: {
            drift: [`${API_DIR}/widget.ts\tWidget\tmissing:capabilities`],
            notPairs: [],
          },
        }),
      );
      try {
        expectExit(runGuard(SCRIPT, { args: ["--root", dir] }), { code: 0, label: "冻结已知漂移" });
      } finally {
        cleanup();
      }
    },
  });

  // ── 基线陈旧 ⇒ 红（收紧必须同步删条目）─────────────────────────────────
  cases.push({
    name: "基线陈旧（登记项已不存在）⇒ 红",
    fn: () => {
      const { dir, cleanup } = makeFixtureRepo(
        fixture({
          generated: bigGenerated(),
          api: bigApi(),
          baseline: {
            drift: [`${API_DIR}/widget.ts\tWidget\tmissing:ghostField`],
            notPairs: [],
          },
        }),
      );
      try {
        expectExit(runGuard(SCRIPT, { args: ["--root", dir] }), {
          code: 1,
          contains: ["基线陈旧", "ghostField"],
          label: "基线陈旧",
        });
      } finally {
        cleanup();
      }
    },
  });

  // ── 未配对增长 ⇒ 红（防止靠改名绕过字段比对）───────────────────────────
  cases.push({
    name: "未配对手写类型增长 ⇒ 红（改名绕过字段比对的通道被堵）",
    fn: () => {
      const api = bigApi();
      api["m0.ts"] = `export interface TotallyUnrelatedThing {\n  x: string;\n}\n`;
      const { dir, cleanup } = makeFixtureRepo(
        fixture({ generated: bigGenerated(), api, baseline: cleanBaseline() }),
      );
      try {
        const r = runGuard(SCRIPT, { args: ["--root", dir] });
        expectExit(r, {
          code: 1,
          contains: ["未配对手写类型增长", "TotallyUnrelatedThing"],
          label: "未配对增长",
        });
      } finally {
        cleanup();
      }
    },
  });

  // ── 结构红：生成物缺失 / 基线缺失 / 基线损坏 ────────────────────────────
  cases.push({
    name: "生成物缺失 ⇒ 结构红（不判绿）",
    fn: () => {
      const tree = fixture({ generated: bigGenerated(), api: bigApi() });
      delete tree[GENERATED_REL];
      const { dir, cleanup } = makeFixtureRepo(tree);
      try {
        expectExit(runGuard(SCRIPT, { args: ["--root", dir] }), {
          code: 1,
          contains: ["结构红", "生成物缺失"],
          label: "生成物缺失",
        });
      } finally {
        cleanup();
      }
    },
  });

  cases.push({
    name: "基线缺失 ⇒ 结构红（增长闸没有参照物）",
    fn: () => {
      const tree = fixture({ generated: bigGenerated(), api: bigApi() });
      delete tree[BASELINE_REL];
      const { dir, cleanup } = makeFixtureRepo(tree);
      try {
        expectExit(runGuard(SCRIPT, { args: ["--root", dir] }), {
          code: 1,
          contains: ["结构红", "基线文件不存在"],
          label: "基线缺失",
        });
      } finally {
        cleanup();
      }
    },
  });

  cases.push({
    name: "基线 JSON 损坏 ⇒ 结构红（坏基线不当空基线）",
    fn: () => {
      const { dir, cleanup } = makeFixtureRepo(
        fixture({ generated: bigGenerated(), api: bigApi(), baseline: "NOT_JSON{" }),
      );
      try {
        expectExit(runGuard(SCRIPT, { args: ["--root", dir] }), {
          code: 1,
          contains: ["结构红", "不是合法 JSON"],
          label: "基线损坏",
        });
      } finally {
        cleanup();
      }
    },
  });

  // ── 配对规则：四级必须各自生效 ─────────────────────────────────────────
  cases.push({
    name: "配对规则②：手写 Executor ↔ 生成 ExecutorResponseDto（加后缀）",
    fn: () => {
      const api = bigApi();
      api["exec.ts"] = `export interface Executor {\n  id: string;\n  appName: string;\n}\n`;
      const gen = bigGenerated().replace(
        "        WidgetResponseDto: {",
        `        ExecutorResponseDto: {\n            id: string;\n            appName: string;\n            capabilities: string[] | null;\n        };\n        WidgetResponseDto: {`,
      );
      const { dir, cleanup } = makeFixtureRepo(
        fixture({
          generated: gen,
          api,
          baseline: { drift: [`${API_DIR}/exec.ts\tExecutor\tmissing:capabilities`], notPairs: [] },
        }),
      );
      try {
        expectExit(runGuard(SCRIPT, { args: ["--root", dir] }), {
          code: 0,
          label: "后缀配对生效（字段已被基线冻结则不红）",
        });
      } finally {
        cleanup();
      }
    },
  });

  cases.push({
    name: "配对规则③：生成名剥后缀 == 手写名",
    fn: () => {
      const api = bigApi();
      api["cfg.ts"] = `export interface Config {\n  id: string;\n}\n`;
      const gen = bigGenerated().replace(
        "        WidgetResponseDto: {",
        `        ConfigDto: {\n            id: string;\n            extraServerField: string;\n        };\n        WidgetResponseDto: {`,
      );
      const { dir, cleanup } = makeFixtureRepo(
        fixture({ generated: gen, api, baseline: cleanBaseline() }),
      );
      try {
        expectExit(runGuard(SCRIPT, { args: ["--root", dir] }), {
          code: 1,
          contains: ["missing:extraServerField"],
          label: "剥后缀配对生效（漂移被检出而不是漏成未配对）",
        });
      } finally {
        cleanup();
      }
    },
  });

  // ── 不可比边界：extends 与 alias 不得被算成漂移 ────────────────────────
  cases.push({
    name: "extends 的手写类型 ⇒ notComparable（不得误报 missing）",
    fn: () => {
      const api = bigApi();
      api["sub.ts"] = `export interface Widget extends Base {\n  id: string;\n}\n`;
      // Widget 手写只有 id，生成有 3 个字段——若不排除 extends，会误报 2 处 missing
      const { dir, cleanup } = makeFixtureRepo(
        fixture({ generated: bigGenerated(), api, baseline: cleanBaseline() }),
      );
      try {
        expectExit(runGuard(SCRIPT, { args: ["--root", dir] }), {
          code: 0,
          contains: ["无新增字段漂移"],
          label: "extends 排除",
        });
      } finally {
        cleanup();
      }
    },
  });

  cases.push({
    name: "生成物侧为 alias（无字面量体）⇒ notComparable",
    fn: () => {
      const api = bigApi();
      api["al.ts"] = `export interface AliasThing {\n  id: string;\n}\n`;
      const gen = bigGenerated().replace(
        "        WidgetResponseDto: {",
        `        AliasThingResponseDto: components["schemas"]["Schema0Dto"];\n        WidgetResponseDto: {`,
      );
      const { dir, cleanup } = makeFixtureRepo(
        fixture({ generated: gen, api, baseline: cleanBaseline() }),
      );
      try {
        expectExit(runGuard(SCRIPT, { args: ["--root", dir] }), {
          code: 0,
          label: "alias 排除",
        });
      } finally {
        cleanup();
      }
    },
  });

  // ── 合同派生 / 字面量镜像不进比较面（与既有守卫边界一致）───────────────
  cases.push({
    name: "合同派生类型（components['schemas']）不进比较面",
    fn: () => {
      const api = bigApi();
      api["derived.ts"] =
        `export type WidgetDerived = components["schemas"]["WidgetResponseDto"];\n`;
      const { dir, cleanup } = makeFixtureRepo(
        fixture({ generated: bigGenerated(), api, baseline: cleanBaseline() }),
      );
      try {
        expectExit(runGuard(SCRIPT, { args: ["--root", dir] }), { code: 0, label: "合同派生出局" });
      } finally {
        cleanup();
      }
    },
  });

  // ── --report 模式：漂移不判红 ──────────────────────────────────────────
  cases.push({
    name: "--report：有新漂移仍退出 0（可见性模式，不判红）",
    fn: () => {
      const { dir, cleanup } = makeFixtureRepo(
        fixture({
          generated: bigGenerated({ widgetFields: ["id", "name", "status", "capabilities"] }),
          api: bigApi({ widgetFields: ["id", "name", "status"] }),
          baseline: cleanBaseline(),
        }),
      );
      try {
        const r = runGuard(SCRIPT, { args: ["--root", dir, "--report"] });
        expectExit(r, {
          code: 0,
          contains: ["字段级漂移现状", "missing（生成物有·手写无）：capabilities"],
          label: "report 不判红",
        });
      } finally {
        cleanup();
      }
    },
  });

  // ── 结构红在 --report 下照判 ───────────────────────────────────────────
  cases.push({
    name: "--report 仍判结构红（生成物缺失时不得判绿）",
    fn: () => {
      const tree = fixture({ generated: bigGenerated(), api: bigApi() });
      delete tree[GENERATED_REL];
      const { dir, cleanup } = makeFixtureRepo(tree);
      try {
        expectExit(runGuard(SCRIPT, { args: ["--root", dir, "--report"] }), {
          code: 1,
          contains: ["结构红", "生成物缺失"],
          label: "report 结构红",
        });
      } finally {
        cleanup();
      }
    },
  });

  const failed = reportCases(cases, { title: "check-web-type-field-drift selftest" });
  if (failed > 0) process.exit(1);
}

/* ─────────────────────────── 入口 ─────────────────────────── */

function parseArgs(argv) {
  const opts = { root: DEFAULT_ROOT, report: false, selftest: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--selftest") opts.selftest = true;
    else if (a === "--report") opts.report = true;
    else if (a === "--root") opts.root = argv[++i] ?? "";
    else if (a.startsWith("--root=")) opts.root = a.slice("--root=".length);
  }
  if (!opts.root) {
    console.error("✖ --root 需要一个目录参数");
    process.exit(2);
  }
  return opts;
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.selftest) selftest();
  else process.exit(opts.report ? report(opts) : run(opts));
}

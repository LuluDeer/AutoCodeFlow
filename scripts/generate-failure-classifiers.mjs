#!/usr/bin/env node
/**
 * failureReason 分类器的**三端生成**（P1-b）。
 *
 * 单一事实源 = `packages/executor-protocol/protocol.json` 的
 * `failureReason.classifiers` 段。生成物：
 *
 *   - packages/contract-fixtures/generated/failure-classifier.mjs
 *       （语言无关的**向量求值器**：node 侧与「跨语言一致性探针」共用）
 *   - packages/contract-fixtures/generated/failure-classifier.py
 *       （python 侧求值器）
 *   - packages/contract-fixtures/generated/failure-classifier.ts
 *       （TS 侧类型/常量导出：admin-web / executor-node 落地时的单一入口）
 *
 * ## 为什么生成物落在 packages/contract-fixtures 而不是各 app
 *
 * 三端分类器是**同一个判据的三种语言实现**，它们必须**逐字等价**才有意义。
 * 若分别生成到 `apps/executor-node/src/`、`apps/executor-python/`、
 * `apps/admin-api/src/`，则：
 *   ① 那三个路径**都是他人的写域**（本轮并行会话正在改 admin-api / admin-web）；
 *   ② 三份生成物各自漂移时，**没有任何一个地方能同时看到三份**⇒ 跨语言一致性
 *      无法被机械验证（只能在 CI 里把三份拉到一起比，那还是三份）。
 * 故本轮把生成物落在**契约包**里（三端共同依赖、单一写域），各 app 的落地
 * 退化为「引入这份生成物」的一行 import——落点清单见
 * docs/archive/audits/2026-11-03-round1/contract-source.md §2。
 *
 * ## 为什么「只生成，不改运行时消费方」
 *
 * 本轮**不改**三端运行时（admin-api / executor-node / executor-python 都在他人
 * 或下一轮的写域内）。生成物 + 守卫先落地，把「目标态」固定下来并**可验证**；
 * 运行时切换是下一轮的事（双轨 → 单轨）。因此本脚本是**纯生成 + 自校验**，
 * 不触碰任何 app 目录。
 *
 * ## 关键纪律：生成物必须**真等价**，不是「看起来像」
 *
 * 跨语言正则不等价的根因是**用到了两侧语义不同的构造**（`\b` / `$` / lookbehind /
 * `\d\w\s` / `.` / `{n,m}` 计数单位）。契约段的 `matcherSubset` 把这些**逐条禁掉**，
 * 只允许「展开后两语言逐字相同」的形态：
 *
 *   · token（`{{WORD}}` 等）→ 展开成**显式 ASCII 字符类**（不是 `\w`、不是 `\b`）；
 *   · 词边界 → 用 `sentinel`（首尾各补 U+0001）+ `{{NONWORD}}` 表达；
 *   · `.` / `.*` → 改写成 `{{ANY_ONE_LINE}}` / `{{ANY_ONE_LINE}}*`；
 *   · 大小写 → 由 `normalize.caseFold`（小写化）统一做，生成物**不带** `i` 标志。
 *
 * 本脚本在生成后**自校验**：用 node 侧生成物与 python 侧生成物对
 * `packages/contract-fixtures/contract.json` 的 `failureClassification` 向量
 * 真跑一遍，两侧结果必须逐条相等（不等即退出码 1）。这让「跨语言等价」不是
 * 注释里的承诺，而是每次生成都会验证的事实。
 *
 * 用法：node scripts/generate-failure-classifiers.mjs [--check]
 *   --check：只校验生成物与契约一致（不写盘）；CI 的 drift job 用它。
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROTOCOL = resolve(ROOT, "packages/executor-protocol/protocol.json");
const OUT_DIR = resolve(ROOT, "packages/contract-fixtures/generated");
const OUT_MJS = resolve(OUT_DIR, "failure-classifier.mjs");
const OUT_PY = resolve(OUT_DIR, "failure-classifier.py");
const OUT_TS = resolve(OUT_DIR, "failure-classifier.ts");
const FIXTURES = resolve(ROOT, "packages/contract-fixtures/contract.json");

const protocol = JSON.parse(readFileSync(PROTOCOL, "utf8"));
const clf = protocol?.failureReason?.classifiers;
if (!clf) throw new Error("protocol.json 缺 failureReason.classifiers 段");

// ── 受控子集校验（碰子集外构造必须报错退出，绝不静默放行）─────────────────

/**
 * 契约 token → 两语言逐字相同的字符类。
 *
 * `matcherSubset.tokens` 是契约里的**唯一**字符类来源；生成器**不得**自己发明
 * 字符类（那等于把「这里刻意用 ASCII 而不是 Unicode」的决定藏进生成器里）。
 */
const tokens = clf.matcherSubset?.tokens ?? {};
for (const key of Object.keys(tokens)) {
  if (key === "$comment") continue;
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
    throw new Error(`classifiers 生成器：token 名 "${key}" 形态不受支持（须全大写下划线）`);
  }
}

/**
 * 契约里**禁止**的正则构造。逐条检出即报错退出。
 *
 * 为什么不靠「生成后跑向量」兜底：向量只覆盖**已知**文本；一个坏构造可能对
 * 全部向量都恰好等价，却对未见文本不等价（例如 `\d` 在 ASCII 文本上与 `[0-9]`
 * 等价、在含全角数字的文本上不等价）。**结构禁令是唯一能覆盖未见输入的判据**。
 *
 * 检查时机：**在 token 展开之前**对 alternative 原文做。
 *
 * **字符类内的成员不算构造**：`[.]` 里的句点是**字面量**（两语言逐字相同），
 * `[A-Z]` 里的连字符同理。故检查前先剥掉字符类——否则会把安全写法误判成违规
 * （反向误差同样是误红，守卫一旦有误红就没人信它）。
 */
const FORBIDDEN = [
  { re: /\\b/, why: "\\b —— JS 是 ASCII 词边界、Python 默认 Unicode 词边界" },
  { re: /\\B/, why: "\\B —— 同上（反向）" },
  { re: /\$$/, why: "$ —— Python 的 $ 还匹配末尾换行之前" },
  { re: /\\A|\\Z|\\z/, why: "\\A / \\Z / \\z —— 两语言不对称" },
  { re: /\(\?<[=!]/, why: "lookbehind —— JS 无长度限制，Python <3.11 不支持、>=3.11 只接定长" },
  { re: /\\[dDsSwW]/, why: "\\d \\D \\s \\S \\w \\W —— JS 默认 ASCII、Python 默认 Unicode" },
  { re: /\\[pP]\{/, why: "\\p{…} —— JS 需 u flag、Python 不支持" },
  { re: /\\/, why: "反斜杠转义（\\d/\\w/\\b/\\1…）—— 两语言语义有差异，一律改用 token" },
  { re: /\(\?[=!]/, why: "lookahead —— 用 rule 顺序表达优先级，不用前瞻" },
  { re: /\./, why: "`.` —— JS 还排除 \\r 与 U+2028/U+2029、Python 只排除 \\n；改用 {{ANY_ONE_LINE}}" },
];

/**
 * 剥掉字符类 `[...]`（保留其它内容）。
 *
 * 只为「构造检查」服务——字符类内的成员在两语言里都是字面量，逐字相同。
 * `]` 若作为字符类**首字符**（`[]abc]`）按字面量处理；`[^]...]` 的 `^` 是取反。
 */
function stripCharClasses(alt) {
  let out = "";
  let i = 0;
  while (i < alt.length) {
    if (alt[i] === "[" && alt[i + 1] !== "]") {
      i += 1;
      if (alt[i] === "^") i += 1;
      if (alt[i] === "]") i += 1;
      while (i < alt.length && alt[i] !== "]") i += 1;
      i += 1; // 跳过收尾的 ]
      out += "[]";
      continue;
    }
    out += alt[i];
    i += 1;
  }
  return out;
}

/** 把契约里的一个 alternative（正则**片段**）翻译成可编译的正则体。 */
function translateAlternative(alt) {
  if (typeof alt !== "string" || alt.length === 0) {
    throw new Error(`classifiers 生成器：alternative 必须是非空字符串，实际 ${JSON.stringify(alt)}`);
  }
  // ① 结构禁令（在 token 展开**之前**、剥掉字符类之后做）
  const bare = stripCharClasses(alt);
  for (const f of FORBIDDEN) {
    if (f.re.test(bare)) {
      throw new Error(
        `classifiers 生成器：alternative "${alt}" 使用了受控子集外的构造 —— ${f.why}。` +
          `请改用 matcherSubset.tokens 里的 token（见 matcherSubset.forbidden 的替代建议）。`,
      );
    }
  }
  // ② token 展开：{{TOKEN}} → 字符类
  let out = alt.replace(/\{\{([A-Z][A-Z0-9_]*)\}\}/g, (whole, name) => {
    const value = tokens[name];
    if (value === undefined) {
      throw new Error(
        `classifiers 生成器：alternative 用了未登记的 token "${name}"（${whole}）—— ` +
          `token 必须在 matcherSubset.tokens 里登记，否则两语言的字符类无从对齐。`,
      );
    }
    return value;
  });
  // ③ 残留的 {{ }} → 结构错
  if (/\{\{|\}\}/.test(out)) {
    throw new Error(`classifiers 生成器：alternative "${alt}" 里有无法解析的 token 占位。`);
  }
  return out;
}

/** 把一组 alternative 合成一个「任一命中即真」的判定体。 */
function compileBody(alternatives) {
  const parts = alternatives.map(translateAlternative);
  if (parts.length === 0) throw new Error("classifiers 生成器：alternative 列表为空");
  return parts.join("|");
}

const rules = clf.rules?.items ?? [];
if (!Array.isArray(rules) || rules.length === 0) {
  throw new Error("classifiers 生成器：classifiers.rules.items 为空");
}
const codes = new Set((protocol.failureReason.all ?? []).map((e) => e.code));
for (const r of rules) {
  // `code: null` = 「本阶段主动让位」（返回 null = 我不知道，交给中台）——合法。
  if (r.code !== null && !codes.has(r.code)) {
    throw new Error(`classifiers 生成器：规则 "${r.id}" 的 code "${r.code}" 不在 failureReason.all 里`);
  }
  if (r.code === null && !(r.appliesTo ?? []).includes("executor")) {
    throw new Error(
      `classifiers 生成器：规则 "${r.id}" 的 code 为 null（让位），但它没挂在 executor 阶段 —— ` +
        `admin 阶段必须永远返回一个码，让位语义只在 executor 阶段成立。`,
    );
  }
  for (const stage of r.appliesTo ?? []) {
    if (!["executor", "admin"].includes(stage)) {
      throw new Error(`classifiers 生成器：规则 "${r.id}" 的 appliesTo 含未知阶段 "${stage}"`);
    }
  }
  compileBody(r.alternatives ?? []);
}
// order 唯一（顺序即规格，重复 order = 歧义）
const orders = rules.map((r) => r.order);
if (new Set(orders).size !== orders.length) {
  throw new Error(`classifiers 生成器：rules.items 的 order 有重复（${orders.join(",")}）—— 顺序即规格，不允许歧义`);
}

const compiled = rules.map((r) => ({
  id: r.id,
  order: r.order,
  code: r.code,
  appliesTo: r.appliesTo ?? [],
  body: compileBody(r.alternatives),
}));

const normalize = {
  joinWith: clf.normalize?.joinWith ?? "\n",
  dropFalsyParts: clf.normalize?.dropFalsyParts ?? true,
  caseFold: clf.normalize?.caseFold ?? "ascii-lower",
  astralFold: clf.normalize?.astralFold ?? "replace-with-U+FFFD",
};
const sentinelPad = clf.sentinel?.pad ?? "\u0001";
const fallback = { executor: clf.fallbacks?.executor ?? null, admin: clf.fallbacks?.admin ?? "unknown" };

if (normalize.caseFold !== "ascii-lower") {
  throw new Error(
    `classifiers 生成器：normalize.caseFold = "${normalize.caseFold}" 不受支持 —— ` +
      `只有 "ascii-lower" 是两语言逐字相同的（A-Z → a-z，不改长度、不引入 Unicode 折叠差异）。`,
  );
}
if (normalize.astralFold !== "replace-with-U+FFFD") {
  throw new Error(
    `classifiers 生成器：normalize.astralFold = "${normalize.astralFold}" 不受支持 —— ` +
      `只有 "replace-with-U+FFFD" 是两语言同法的（码点 > U+FFFF → U+FFFD：单码点、单 UTF-16 code unit）。`,
  );
}

// ── 发射：语言无关求值器（mjs）────────────────────────────────────────────

const mjs = `/**
 * GENERATED — DO NOT EDIT.
 *
 * 来源：\`packages/executor-protocol/protocol.json\` 的 \`failureReason.classifiers\` 段。
 * 由 \`node scripts/generate-failure-classifiers.mjs\` 生成。
 *
 * 用途：failureReason 分类器在 **node / TS 侧**的求值器（admin 与 executor-node
 * 落地的共同入口）。python 侧对等物是同目录的 \`failure-classifier.py\`。
 *
 * ## 契约不变式
 *
 *   ① **归一**：文本先按 \`normalize\` 拼接 + 小写化，再判定（大小写折叠由归一做，
 *      生成物**不带** \`i\` 标志——带标志就等于把两语言的 Unicode 大小写折叠差异
 *      藏进标志里）。
 *   ② **sentinel**：判定前在文本首尾各补一个 U+0001，于是 \`{{NONWORD}}\` 在串边界
 *      处也成立（\`\\b\` 的合法替代）。
 *   ③ **顺序即规格**：规则按 \`order\` 升序求值，首个命中者给出码。
 *   ④ **阶段不同**：\`executor\` 阶段答 \`null\` 表示「我不知道，交给中台」；
 *      \`admin\` 阶段永远返回一个码（兜底 \`${fallback.admin}\`）。
 *
 * 手改本文件会在下次生成时被覆盖，且不会让契约生效——要改请改 protocol.json。
 */

/** 契约 token 表（字符类；**不用** \\w/\\b/\\d —— 那是两语言语义不同的构造）。 */
export const TOKENS = ${JSON.stringify(
  Object.fromEntries(Object.entries(tokens).filter(([k]) => k !== "$comment")),
  null,
  2,
)};

/** 归一参数（拼接 + 大小写折叠）。 */
export const NORMALIZE = ${JSON.stringify(normalize)};

/** 规则表：\`body\` 是**已翻译**的正则体（token 已展开、禁令已规避）。 */
export const RULES = ${JSON.stringify(
  compiled.map((r) => ({ id: r.id, order: r.order, code: r.code, appliesTo: r.appliesTo, body: r.body })),
  null,
  2,
)};

/** 归一 + sentinel。 */
export function normalizeText(parts) {
  const kept = NORMALIZE.dropFalsyParts
    ? parts.filter((p) => p !== null && p !== undefined && p !== "")
    : parts;
  const joined = kept.join(NORMALIZE.joinWith);
  return foldAstral(asciiLower(joined));
}

/**
 * **ASCII** 小写化（只 A-Z → a-z）。
 *
 * 刻意**不用** \`toLowerCase()\`：JS 的 toLowerCase 与 Python 的 str.lower 都按
 * Unicode Default Case Conversion，但**不是**逐字同义（实测 ſ→s、K(U+212A)→k
 * 在两侧不同），且 Unicode 小写化会**改变长度**——长度一变，与 \`{n,m}\` 的
 * 计数耦合就又成了跨语言不等价的入口。只做 ASCII 折叠：两侧逐字相同、不改长度。
 */
export function asciiLower(text) {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0);
    out += code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 32) : ch;
  }
  return out;
}

/**
 * astral 折叠（码点 > U+FFFF → U+FFFD）。
 *
 * 存在的唯一理由：JS 的 \`{n,m}\` 按 **UTF-16 code unit** 计数、Python 按
 * **code point** 计数。实测 \`a[^\\n]{0,3}b\` 对 \`a😀😀b\` 在 JS 不命中、在
 * Python 命中 ⇒ 同一 \`{0,N}\` 在两侧覆盖不同长度。折叠成单码点的 U+FFFD 后，
 * 两侧的计数单位一致（1 code unit = 1 code point）。
 */
export function foldAstral(text) {
  let out = "";
  for (const ch of text) {
    out += ch.codePointAt(0) > 0xffff ? "\\ufffd" : ch;
  }
  return out;
}

/** 判定前的补齐：首尾各一个 sentinel，于是词边界在串边界处也成立。 */
export function pad(text) {
  return ${JSON.stringify(sentinelPad)} + text + ${JSON.stringify(sentinelPad)};
}

const COMPILED = RULES.map((r) => ({ ...r, re: new RegExp(r.body, "u") }));
const BY_STAGE = { executor: [], admin: [] };
for (const r of COMPILED) {
  for (const stage of r.appliesTo) BY_STAGE[stage].push(r);
}
for (const stage of Object.keys(BY_STAGE)) {
  BY_STAGE[stage].sort((a, b) => a.order - b.order);
}

/**
 * 分类。stage = 'executor' | 'admin'。
 *
 * @param {string[]} parts 参与判定的文本片段（错误文案 + 日志）
 * @param {"executor"|"admin"} stage
 * @returns {string|null} 命中的码；executor 阶段不命中时返回 null
 */
export function classify(parts, stage = "executor") {
  const text = pad(normalizeText(parts));
  for (const rule of BY_STAGE[stage] ?? []) {
    if (rule.re.test(text)) return rule.code;
  }
  return stage === "admin" ? ${JSON.stringify(fallback.admin)} : ${JSON.stringify(fallback.executor)};
}

/** 规则明细（供守卫比对「生成物 ↔ 契约」）。 */
export function ruleIds(stage) {
  return (BY_STAGE[stage] ?? []).map((r) => r.id);
}

export const FALLBACKS = ${JSON.stringify(fallback)};
export const SENTINEL_PAD = ${JSON.stringify(sentinelPad)};
`;

// ── 发射：python 求值器 ──────────────────────────────────────────────────

/** python 字面量（JSON 的 null/true/false 在 Python 里必须写 None/True/False）。 */
const pyLit = (v) => (v === null ? "None" : v === true ? "True" : v === false ? "False" : JSON.stringify(v));
const pyStr = (s) => JSON.stringify(s);

const py = `r"""
GENERATED — DO NOT EDIT.

来源：packages/executor-protocol/protocol.json 的 failureReason.classifiers 段。
由 node scripts/generate-failure-classifiers.mjs 生成。

python 侧对等物是同目录的 failure-classifier.mjs（node/TS 侧）。

## 为什么两侧逐字等价（不是「看起来像」）

契约的 matcherSubset 禁掉了所有**两语言语义不同**的构造：
\\b（JS ASCII / Python Unicode）、$、lookbehind、\\d\\w\\s、Unicode 属性、
反向引用。留下的形态里：token 展开成**显式 ASCII 字符类**（两语言逐字相同）、
词边界用 **sentinel + {{NONWORD}}** 表达、句点归一成 {{ANY_ONE_LINE}}、
大小写折叠由**归一**（小写化）统一做（生成物**不带** re.IGNORECASE——
带标志就等于把 Unicode 大小写折叠差异藏进标志里）。

⚠️ 归一的小写化本身：Python str.lower() 与 JS toLowerCase() 都按 Unicode
Default Case Conversion，但**不是**逐字同义（例如 'İ'）。契约把这点记为
caseFoldEquivalence: measured-by-guard——由守卫在向量上**真执行两侧**并断言
相等，而不是靠本文档承诺。

手改本文件会在下次生成时被覆盖，且不会让契约生效——要改请改 protocol.json。
"""

from __future__ import annotations

import json
import re
from typing import Iterable, Optional

#: 契约 token 表（字符类；**不用** \\w/\\b/\\d —— 那是两语言语义不同的构造）。
TOKENS = json.loads(${pyStr(JSON.stringify(Object.fromEntries(Object.entries(tokens).filter(([k]) => k !== "$comment"))))})

#: 规则表：body 是**已翻译**的正则体（token 已展开、禁令已规避）。
RULES = json.loads(${pyStr(
  JSON.stringify(
    compiled.map((r) => ({ id: r.id, order: r.order, code: r.code, appliesTo: r.appliesTo, body: r.body })),
    null,
    2,
  ),
)})

#: 归一参数。
JOIN_WITH = ${pyStr(normalize.joinWith)}
DROP_FALSY = ${pyLit(normalize.dropFalsyParts)}
CASE_FOLD = ${pyStr(normalize.caseFold)}

#: sentinel（词边界的合法替代）。
SENTINEL_PAD = ${pyStr(sentinelPad)}

#: 兜底（executor 阶段为 None = 「我不知道，交给中台」）。
FALLBACKS = {"executor": ${pyLit(fallback.executor)}, "admin": ${pyLit(fallback.admin)}}

_COMPILED = []
for _rule in RULES:
    _COMPILED.append({**_rule, "re": re.compile(_rule["body"])})

_BY_STAGE: dict[str, list] = {"executor": [], "admin": []}
for _rule in _COMPILED:
    for _stage in _rule["appliesTo"]:
        _BY_STAGE.setdefault(_stage, []).append(_rule)
for _stage in _BY_STAGE:
    _BY_STAGE[_stage].sort(key=lambda r: r["order"])


def normalize_text(parts: Iterable[Optional[str]]) -> str:
    """拼接 → ASCII 小写化 → astral 折叠（两侧逐字同构）。"""
    kept = [p for p in parts if p is not None and p != ""] if DROP_FALSY else list(parts)
    joined = JOIN_WITH.join(kept)
    return fold_astral(ascii_lower(joined))


def ascii_lower(text: str) -> str:
    """**ASCII** 小写化（只 A-Z → a-z）。

    刻意**不用** str.lower()：JS 的 toLowerCase 与 Python 的 str.lower 都按
    Unicode Default Case Conversion，但**不是**逐字同义（实测 ſ→s、K(U+212A)→k
    在两侧不同），且 Unicode 小写化会**改变长度**——长度一变，与 {n,m} 的
    计数耦合就又成了跨语言不等价的入口。只做 ASCII 折叠：两侧逐字相同、不改长度。
    """
    out = []
    for ch in text:
        code = ord(ch)
        out.append(chr(code + 32) if 0x41 <= code <= 0x5A else ch)
    return "".join(out)


def fold_astral(text: str) -> str:
    """astral 折叠（码点 > U+FFFF → U+FFFD）。

    存在的唯一理由：JS 的 {n,m} 按 **UTF-16 code unit** 计数、Python 按
    **code point** 计数。实测 a[^\\n]{0,3}b 对 a😀😀b 在 JS 不命中、在
    Python 命中 ⇒ 同一 {0,N} 在两侧覆盖不同长度。折叠成单码点的 U+FFFD 后，
    两侧的计数单位一致（1 code unit = 1 code point）。
    """
    return "".join("\\ufffd" if ord(ch) > 0xFFFF else ch for ch in text)


def pad(text: str) -> str:
    """首尾各补一个 sentinel，于是词边界在串边界处也成立。"""
    return SENTINEL_PAD + text + SENTINEL_PAD


def classify(parts: Iterable[Optional[str]], stage: str = "executor") -> Optional[str]:
    """分类。stage = 'executor' | 'admin'。不命中时 executor 返 None、admin 返兜底码。"""
    text = pad(normalize_text(parts))
    for rule in _BY_STAGE.get(stage, []):
        if rule["re"].search(text):
            return rule["code"]
    return FALLBACKS["admin"] if stage == "admin" else FALLBACKS["executor"]


def rule_ids(stage: str) -> list:
    """规则明细（供守卫比对「生成物 ↔ 契约」）。"""
    return [r["id"] for r in _BY_STAGE.get(stage, [])]
`;

// ── 发射：TS 侧类型/常量导出 ─────────────────────────────────────────────

const ts = `/**
 * GENERATED — DO NOT EDIT.
 *
 * 来源：\`packages/executor-protocol/protocol.json\` 的 \`failureReason.classifiers\` 段。
 * 由 \`node scripts/generate-failure-classifiers.mjs\` 生成。
 *
 * 用途：failureReason 分类器的 **TS 侧**类型与常量导出。求值逻辑在
 * \`failure-classifier.mjs\`（同目录）——它同时被 node 侧的 admin / executor
 * 落地与跨语言一致性探针复用，故 TS 侧只导出**类型 + 规则表**，不重复实现
 * 判定（避免又一份「看起来一样但行为不同」的判定）。
 *
 * 手改本文件会在下次生成时被覆盖，且不会让契约生效——要改请改 protocol.json。
 */

/** 分类阶段。executor = 执行器在失败发生地做细粒度归因；admin = 中台对文本兜底裁决。 */
export type FailureClassifyStage = "executor" | "admin";

/** 契约里的码（取自 failureReason.all，**逐字**）。 */
export type ContractFailureCode =
${(protocol.failureReason.all ?? []).map((e) => `  | ${JSON.stringify(e.code)}`).join("\n")};

/** 分类器返回的码：executor 阶段可能返回 null（「我不知道，交给中台」）。 */
export type ClassifiedFailureCode = ContractFailureCode | null;

/** 一条契约规则（\`body\` 是已翻译的正则体：token 已展开、禁令已规避）。 */
export interface FailureClassifierRule {
  readonly id: string;
  readonly order: number;
  readonly code: ContractFailureCode;
  readonly appliesTo: readonly FailureClassifyStage[];
  readonly body: string;
}

/** 契约 token 表（字符类；**不用** \\w/\\b/\\d —— 那是两语言语义不同的构造）。 */
export const FAILURE_CLASSIFIER_TOKENS = ${JSON.stringify(
  Object.fromEntries(Object.entries(tokens).filter(([k]) => k !== "$comment")),
  null,
  2,
)} as const;

/** 规则表（按 \`order\` 升序 —— 顺序即规格）。 */
export const FAILURE_CLASSIFIER_RULES: readonly FailureClassifierRule[] = ${JSON.stringify(
  compiled.map((r) => ({ id: r.id, order: r.order, code: r.code, appliesTo: r.appliesTo, body: r.body })),
  null,
  2,
)};

/** 兜底（executor 阶段为 null = 「我不知道，交给中台」）。 */
export const FAILURE_CLASSIFIER_FALLBACKS = ${JSON.stringify(fallback)} as const;

/** sentinel（词边界的合法替代）。 */
export const FAILURE_CLASSIFIER_SENTINEL_PAD = ${JSON.stringify(sentinelPad)};
`;

// ── 落盘 ──────────────────────────────────────────────────────────────────

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  console.log(`classifiers 生成：${path.replace(ROOT + "/", "")}`);
}

const outputs = [
  [OUT_MJS, mjs],
  [OUT_PY, py],
  [OUT_TS, ts],
];

if (process.argv.includes("--check")) {
  let drifted = 0;
  for (const [path, content] of outputs) {
    let current = null;
    try {
      current = readFileSync(path, "utf8");
    } catch {
      /* 文件不存在 = 漂移 */
    }
    if (current !== content) {
      console.error(`✖ 生成物漂移：${path.replace(ROOT + "/", "")}（重跑 node scripts/generate-failure-classifiers.mjs）`);
      drifted += 1;
    }
  }
  if (drifted > 0) process.exit(1);
  console.log(`classifiers 生成物无漂移（${outputs.length} 个文件）`);
} else {
  for (const [path, content] of outputs) write(path, content);
  console.log(
    `classifiers 生成完成：${rules.length} 条规则（executor ${compiled.filter((r) => r.appliesTo.includes("executor")).length} / admin ${compiled.filter((r) => r.appliesTo.includes("admin")).length}）`,
  );
}

// ── 自校验：两侧求值器对共享向量必须逐条相等 ─────────────────────────────

const fixtures = JSON.parse(readFileSync(FIXTURES, "utf8"));
const vectors = fixtures?.failureClassification?.vectors ?? [];
if (vectors.length === 0) {
  console.error("✖ packages/contract-fixtures/contract.json 缺 failureClassification.vectors —— 没有向量可验证跨语言等价。");
  process.exit(1);
}

async function evaluateBoth() {
  const mjsMod = await import(`file://${OUT_MJS}?t=${Date.now()}`);
  const pyText = readFileSync(OUT_PY, "utf8");
  const pyFile = resolve(OUT_DIR, `.__probe_${process.pid}.py`);
  writeFileSync(
    pyFile,
    `${pyText}\n\nimport json, sys\n_VECTORS = json.loads(${pyStr(JSON.stringify(vectors))})\n_out = []\nfor _v in _VECTORS:\n    _out.append({"id": _v["id"], "executor": classify(_v["parts"], "executor"), "admin": classify(_v["parts"], "admin")})\nprint(json.dumps(_out, ensure_ascii=False))\n`,
    "utf8",
  );
  const res = spawnSync("python3", [pyFile], { encoding: "utf8" });
  try {
    require("node:fs").unlinkSync(pyFile);
  } catch {
    /* ignore */
  }
  if (res.status !== 0) {
    throw new Error(`python 侧求值失败：\n${res.stderr}`);
  }
  const pyOut = JSON.parse(res.stdout.trim().split("\n").pop());
  const jsOut = vectors.map((v) => ({
    id: v.id,
    executor: mjsMod.classify(v.parts, "executor"),
    admin: mjsMod.classify(v.parts, "admin"),
  }));
  return { jsOut, pyOut };
}

if (!process.argv.includes("--no-selfcheck")) {
  evaluateBoth()
    .then(({ jsOut, pyOut }) => {
      let bad = 0;
      for (let i = 0; i < jsOut.length; i += 1) {
        const j = jsOut[i];
        const p = pyOut[i];
        const same = j.executor === p.executor && j.admin === p.admin;
        const expected = vectors[i].expected ?? {};
        const okExpect =
          (expected.executor === undefined || expected.executor === j.executor) &&
          (expected.admin === undefined || expected.admin === j.admin);
        if (!same || !okExpect) {
          bad += 1;
          console.error(`✖ 向量 "${j.id}"：node=(${j.executor}/${j.admin}) python=(${p.executor}/${p.admin}) 期望=${JSON.stringify(expected)}`);
        }
      }
      if (bad > 0) {
        console.error(`✖ 跨语言一致性自校验失败：${bad}/${jsOut.length} 条向量不一致`);
        process.exit(1);
      }
      console.log(`✔ 跨语言一致性自校验通过：${jsOut.length} 条向量，node 与 python 逐条相等且符合契约期望`);
    })
    .catch((error) => {
      console.error(`✖ 生成器自校验失败：${error.message}`);
      process.exit(1);
    });
}

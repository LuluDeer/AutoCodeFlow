/**
 * ratchet-baseline —— 「只减不增」基线的共用件。
 *
 * ## 为什么有它
 *
 * 本仓有一批守卫共用同一条纪律：**例外必须登记、登记必须有主有期限、登记只许变瘦**。
 * 在接入本模块之前，这条纪律在 9 个守卫里各写了一遍（读基线 + 逐条比对 + 只减不增 + 报错），
 * 每处 17-39 行、≈250 行重复。重复本身的代价不是行数，而是**不变量只在部分守卫里成立**：
 * `check-publishable-wiring.mjs` 实现了「`review_by` 过期即红」，另外 8 个基线仍是无限期豁免
 * ——同一条不变量成立率 1/9。共用件的作用是让「有期限」这件事只实现一次，接进来的守卫自动获得。
 *
 * ## 它只做四件事
 *
 *   ① **读基线 + 结构校验**：`readRatchetBaseline()` —— 文件缺失 / JSON 不可解析 / 形状非法 /
 *      条目数越界，一律当**结构红**返回（读不到 ≠ 没有问题，这条是本仓反复踩过的假绿）。
 *   ② **逐条比对**：`compareEntry()` —— 调用方算好「当前值」再传进来；本模块只负责
 *      必填字段（owner / review_by / disposition…）、理由长度、`review_by` 形态与期限、
 *      以及可选的数值上限。**「怎么量」不在这里**：每个守卫的度量方式不同（版本号相等 /
 *      字面量集合相等 / 是否有 consumer 证据），那是调用方的事。
 *   ③ **棘轮语义**：三条判定 —— 新违规未登记 ⇒ 红（`超过上限`）；条目已无对应违规 ⇒ 红
 *      （`该删条目了`，不许变成永久豁免）；条目指向的东西不存在 ⇒ 红（基线腐烂）。
 *      集合型的「反向清扫」由 `sweepBaseline()` 一次做完。
 *   ④ **统一报错文案**：`WORDING` + `renderOverLimit / renderStale / renderRot / renderExpired`。
 *      「超过上限」与「该删条目了」这两句只在这里定义一次 —— 否则 9 个守卫会给出 9 种说法，
 *      复核的人得先学会 9 套措辞才知道自己看到的是不是同一条纪律。
 *
 * ## 它**不**做的事
 *
 *   · 不读源码、不扫目录、不解析 package.json —— 度量是调用方的判据，不是基线的判据。
 *   · 不自动改写基线文件（基线只由人维护）。
 *   · 不替调用方决定「结构红」还是「漂移红」放在哪个数组里（各守卫的退出码语义不同），
 *     只返回**分类好的**结论（`incomplete` / `badDate` / `expired` / `overCeiling`）。
 *
 * ## 形态兼容性（2026-11-04 三个试点 + 后续扩面实测）
 *
 * 基线 `entries` 的两种形态都支持：`kind: "map"`（`{ "<键>": {...} }`，version-lines /
 * package-kinds / source-size-baseline）与 `kind: "array"`（`[{ id, ... }]` 或
 * `[{ key, ... }]`）。**不能**统一的是条目**内部**的形状：数组型条目允许任意深度的
 * 领域字段（targets / scope / pattern），那部分校验留在原守卫里，本模块不接管。
 *
 * ## 一张文件里有两张表怎么办（`raw`）
 *
 * 不少基线文件里有**第二张表**与主表同处一份文件（`knownGaps` / `allowlist` /
 * `notPairs` / `violations`+`irreversible` / `signoffs`）。共用件一次只校验一张表的
 * 形态 ⇒ 调用方要么调两次（各拿一个 `entriesKey`），要么调一次拿 `raw` 再自己取
 * 第二张表。**`raw` = 解析出来的整个文档**（形状已校验过），它存在就是为了让
 * 「读一次文件」不需要重复 —— 但**第二张表怎么用**仍是调用方的事。
 *
 * ## 数值型 ceiling（`signoffs` 那张表的由来）
 *
 * 有些基线的核心是一条**裸数字上限**（`maxKnown: 35`），不是一组条目 —— 挂不上
 * `owner`/`review_by`。本模块**不**为此扩职责：调用方自己在同一文件里加一张
 * `signoffs` 表（`{ "<上限名>": { owner, review_by } }`），用本模块的
 * `compareEntry` 判它的字段/期限 —— 这与「条目级校验」同一条纪律，只是载体不同。
 *
 * ## 期限校验比旧实现更严（一处**收紧**）
 *
 * 旧实现多用 `Date.parse("${review_by}T00:00:00Z")` —— `2026-02-31`（格式对、
 * 日期不存在）会被**归一成 2026-03-03** 而不报错。本模块的 `parseDay()` 做**严格
 * 日历校验** ⇒ 那种值判非法。这是收紧方向（只可能把绿变红，不会把红变绿）。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** ④ 统一报错文案：棘轮判定的措辞只在这里定义一次。 */
export const WORDING = {
  overLimit: "超过上限",
  staleEntry: "该删条目了",
  expired: "复核期限已过",
};

const DAY_MS = 86_400_000;
const REVIEW_BY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * `YYYY-MM-DD` → UTC 日序号；非法（含 `2026-02-31` 这种格式对但日期不存在）返回 null。
 *
 * @param {unknown} value
 * @returns {number|null}
 */
export function parseDay(value) {
  if (typeof value !== "string") return null;
  const m = REVIEW_BY_RE.exec(value.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    return null;
  }
  return Math.floor(ms / DAY_MS);
}

/** 今天的 UTC 日序号（与 `review_by` 同一口径，可直接比较）。 */
export function utcDay(now = new Date()) {
  return Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / DAY_MS);
}

/** 日序号 → `YYYY-MM-DD`（报错文案里点名「今天」用）。 */
export function isoDay(day) {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

// ── ① 读基线 + 结构校验 ───────────────────────────────────────────────────

/**
 * 读一张棘轮基线并做结构校验。
 *
 * @param {object} options
 * @param {string} options.root 仓库根（绝对路径）
 * @param {string} options.rel 基线文件的仓库相对路径
 * @param {"map"|"array"} [options.kind] `entries` 形态：映射（键 → 条目）或数组（条目自带 id）
 * @param {string} [options.label] 报错文案里对这张表的称呼（「登记表」/「基线」）
 * @param {string} [options.entriesKey] 条目所在字段名（缺省 `entries`）
 * @param {number} [options.minEntries] 条目数下界：表被清空 = 判据退化成死条文
 * @param {number} [options.maxEntries] 条目数上界：基线不许变成关灯键
 * @returns {{map: Record<string, object>|null, list: Array<{key: string, entry: object, index: number}>,
 *            raw: object|null, error: string|null}}
 *   `error` 非 null ⇒ **结构红**（调用方按自己的口径塞进 errors/structure 并早退）。
 *   `raw` = 解析出来的整个文档（**已通过形状校验**）。它存在是因为一张基线文件里
 *   常有**第二张表**（`knownGaps` / `allowlist` / `notPairs`）与主表共享一份文件 ——
 *   「怎么读这张文件」是共用件的事（读一次、判一次形状），但「第二张表怎么用」是调用方的事。
 */
export function readRatchetBaseline({
  root,
  rel,
  kind = "map",
  label = "基线",
  entriesKey = "entries",
  minEntries = 0,
  maxEntries = Number.POSITIVE_INFINITY,
} = {}) {
  const empty = { map: null, list: [], raw: null };
  const abs = join(root, rel);
  if (!existsSync(abs)) {
    return { ...empty, error: `读不到 ${rel} —— ${label}缺失时「0 处违规」与「一条判据都没有」是同一件事，判结构红。` };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(abs, "utf8"));
  } catch (error) {
    return { ...empty, error: `${rel} 不可解析（${String(error.message).split("\n")[0]}）—— 解析不出来必须结构红（同 check-publishable-wiring 的「清单坏了被静默降级」教训）。` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ...empty, error: `${rel} 顶层必须是对象（收到 ${Array.isArray(parsed) ? "数组" : typeof parsed}）。` };
  }
  const raw = parsed[entriesKey];
  let list;
  if (kind === "map") {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return {
        ...empty,
        error: `${rel} 缺少 ${entriesKey} 对象 —— ${label}形状非法（应为 { ${entriesKey}: { "<键>": {...} } }）。`,
      };
    }
    list = Object.entries(raw).map(([key, entry]) => ({ key, entry, index: -1 }));
  } else {
    if (!Array.isArray(raw)) {
      return { ...empty, error: `${rel} 的 ${entriesKey} 必须是数组（收到 ${typeof raw}）` };
    }
    list = raw.map((entry, index) => ({
      key: typeof entry?.id === "string" && entry.id.trim() !== "" ? entry.id : `[${index}]`,
      entry,
      index,
    }));
  }
  if (list.length < minEntries) {
    return {
      map: kind === "map" ? raw : null,
      list,
      raw: parsed,
      error: `${label} ${rel} 只有 ${list.length} 条 < 下界 ${minEntries} —— 判据正在退化成空表死条文（「0 处违规」此时不代表合规）。`,
    };
  }
  if (list.length > maxEntries) {
    return {
      map: kind === "map" ? raw : null,
      list,
      raw: parsed,
      error: `${label} ${rel} 有 ${list.length} 条 > 上限 ${maxEntries} —— ${WORDING.overLimit}，基线正在变成「把所有东西都签字」的关灯键。`,
    };
  }
  return { map: kind === "map" ? raw : null, list, raw: parsed, error: null };
}

// ── ② 逐条比对（当前值 vs ceiling）─────────────────────────────────────────

/**
 * 比对一条基线条目。**当前值由调用方算**，这里只判「这条登记还合法吗」。
 *
 * @param {object} options
 * @param {string} options.at 报错里的定位（`packages/x` / `knownGaps[0]` / `[protocol-version]`）
 * @param {string} [options.noun] 条目称呼（「登记」/「条目」/「字段」）
 * @param {object} options.entry 条目本身
 * @param {string} [options.rel] 基线文件路径（仅文案用）
 * @param {string} [options.label] 表名（仅文案用）
 * @param {string[]} [options.requiredFields] 必填字段
 * @param {Record<string, number>} [options.minLength] 字符串字段的最小长度
 * @param {number} [options.today] 今天的 UTC 日序号
 * @param {boolean} [options.live] 这条例外**当前是否仍然成立**。只有仍然成立时才判期限：
 *        已经不需要的条目要走 `sweepBaseline()` 的「该删条目了」，而不是「期限到了」。
 * @param {number} [options.value] 调用方实测的当前值（数值型基线）
 * @param {number} [options.ceiling] 该条目的上限（数值型基线）
 * @returns {{findings: string[], incomplete: string|null, badDate: string|null,
 *            expired: boolean, overCeiling: boolean, reviewDay: number|null,
 *            missing: string[], value: number|undefined, ceiling: number|undefined}}
 */
export function compareEntry({
  at,
  noun = "条目",
  entry,
  rel = "",
  label = "基线",
  requiredFields = [],
  minLength = {},
  today = utcDay(),
  live = true,
  value,
  ceiling,
} = {}) {
  const findings = [];
  const result = {
    findings,
    incomplete: null,
    badDate: null,
    expired: false,
    overCeiling: false,
    reviewDay: null,
    missing: [],
    value,
    ceiling,
  };
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    findings.push(`${at} 不是对象 —— ${label}${rel ? ` ${rel} ` : ""}腐烂了（条目必须能逐字段复核）。`);
    return result;
  }

  const missing = requiredFields.filter(
    (field) => entry[field] === undefined || entry[field] === null || String(entry[field]).trim() === "",
  );
  result.missing = missing;
  if (missing.length > 0) {
    result.incomplete = `${at} 的${noun}不完整（缺 ${missing.join("、")}）—— 一条不完整的${noun}等于没人负责、没有复核期限，也就等于无限期豁免。`;
    findings.push(result.incomplete);
  }

  for (const [field, min] of Object.entries(minLength)) {
    const text = typeof entry[field] === "string" ? entry[field].trim() : "";
    if (text === "") continue; // 字段缺失已由 incomplete 点名，不再重复报「太短」
    if (text.length < min) {
      findings.push(`${at} 的 ${field} 太短（${text.length} < ${min} 字符）—— 短理由等于没有理由。`);
    }
  }

  // `review_by` 缺失已经由 `incomplete` 点名了，这里只判「写了但不可解析」——
  // 同一条毛病报两遍会让真正的第一条被淹掉。
  const reviewByText =
    entry.review_by === undefined || entry.review_by === null ? "" : String(entry.review_by).trim();
  if (reviewByText !== "") {
    result.reviewDay = parseDay(entry.review_by);
    if (result.reviewDay === null) {
      result.badDate = `${at} 的 review_by 不是合法 YYYY-MM-DD（收到 ${JSON.stringify(entry.review_by)}）—— 没有可判定的复核期限，就等于无限期豁免。`;
      findings.push(result.badDate);
    }
  }

  result.expired = live && result.reviewDay !== null && result.reviewDay < today;
  result.overCeiling = typeof value === "number" && typeof ceiling === "number" && value > ceiling;
  return result;
}

// ── ③ 棘轮语义 ─────────────────────────────────────────────────────────────

/**
 * 反向清扫：基线里每一条都必须在「当前仍然成立」或「已经指向空气」之间，否则就是永久豁免。
 *
 * @param {object} options
 * @param {Array<{key: string}>} options.list 基线条目（`readRatchetBaseline().list`）
 * @param {Map<string, "live"|"satisfied"|"missing">} [options.state] 调用方实测的条目状态：
 *        `live` 仍然成立（不收问题，交给 `compareEntry` 判期限）、
 *        `satisfied` 已经不需要了（⇒ 该删条目了）、`missing` 指向的东西不存在（⇒ 基线腐烂）。
 *        缺省视为 `live`。
 * @param {string} options.rel 基线文件路径
 * @param {string} [options.label] 表名
 * @param {(key: string, state: string) => string} options.detailOf 「但……」句式的事实描述
 * @param {(key: string, state: string) => string|undefined} [options.fixOf] 「修法」补充
 * @returns {string[]} problems（空数组 = 这条不变量成立）
 */
export function sweepBaseline({ list, state = new Map(), rel, label = "登记表", detailOf, fixOf } = {}) {
  const problems = [];
  for (const { key } of list) {
    const status = state.get(key) ?? "live";
    if (status === "live") continue;
    const detail = detailOf ? detailOf(key, status) : "";
    const fix = fixOf ? fixOf(key, status) : undefined;
    problems.push(
      status === "missing"
        ? renderRot({ rel, label, key, detail, fix })
        : renderStale({ rel, label, key, detail, fix }),
    );
  }
  return problems;
}

// ── ④ 统一报错文案 ─────────────────────────────────────────────────────────

/** 新违规未登记 ⇒ 「超过上限」（基线只减不增）。 */
export function renderOverLimit({ key, detail = "", rel, label = "基线", fix }) {
  return (
    `${key}${detail ? ` ${detail}` : ""}` +
    `\n      ${WORDING.overLimit}（${rel} 只减不增：新增例外必须显式登记 —— 写清 owner、review_by 与「为什么它必须例外」）。` +
    (fix ? `\n      ${fix}` : "")
  );
}

/** 条目已经不需要了 ⇒ 「该删条目了」（否则基线会变成永久豁免名单）。 */
export function renderStale({ rel, label = "登记表", key, detail = "", fix }) {
  return (
    `${label} ${rel} 里登记了 "${key}"，${detail || "但它已经不需要了"}` +
    ` —— ${WORDING.staleEntry}（${label}只减不增：留在里面的条目必须仍然是「当前需要」的；留着就是永久豁免）。` +
    (fix ? `\n      ${fix}` : "")
  );
}

/** 条目指向的东西不存在 ⇒ 基线腐烂（点名，让人删得掉）。 */
export function renderRot({ rel, label = "登记表", key, detail = "", fix }) {
  return (
    `${label} ${rel} 里登记了 "${key}"，${detail || "但它指向的东西已不存在"}` +
    ` —— ${label}腐烂了（指向空气的条目会让整张表失去意义，删掉它）。` +
    (fix ? `\n      ${fix}` : "")
  );
}

/** `review_by` 到期 ⇒ 红：过期的意思是「当初答应复核的人没有复核」，不是「继续躺着」。 */
export function renderExpired({ at, noun = "登记", entry, today = utcDay() }) {
  return (
    `${at} 的${WORDING.expired}（review_by = ${entry?.review_by}，今天 ${isoDay(today)}）` +
    ` —— 这条${noun}已过期：owner = ${entry?.owner ?? "（未写）"}。\n` +
    `      过期不代表判据错了，代表当初答应复核的人没有复核：复核后续期，或者把这条${noun}删掉。`
  );
}

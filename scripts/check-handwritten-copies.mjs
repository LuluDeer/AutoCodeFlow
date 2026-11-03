#!/usr/bin/env node
/**
 * 「手抄副本漂移」守卫（跨实现漂移）。
 *
 * ## 治的是什么
 *
 * `packages/executor-protocol/protocol.json` 是执行器协议的**单一事实源**。但其中有些
 * 常量**运行时零消费**——没有任何一行代码 `import` 它、也没有任何运行时分支读它：
 *
 *   · `versioning.currentProtocolVersion` / `versioning.supportedMinProtocolVersion`
 *     —— protocol.json 自己就写着 `xConsumption: "guard-only"`；
 *   · `schemas.HealthReadyResponse.properties.status.enum` —— 只有「生成的 schema」
 *     被运行时消费，enum 的**取值集合**在各实现里又是手写一遍。
 *
 * 于是每个实现文件各自**手抄**一份，抄错没有任何机器兜底。这不是理论风险：协议版本号
 * 决定中台是否下发 `commands`，上报值与门槛一旦错位，就会出现「中台认为对方认识
 * commands、对方静默忽略」——那正是 ADR-016 要消灭的静默丢命令。
 *
 * 本守卫把「登记的这几份手抄副本必须与源值**字面相等**」变成红在 CI。
 *
 * ## 判据
 *
 * 对 `scripts/handwritten-copies.json` 里登记的每一条：
 *   ① 从 `source.file` 的 `source.pointer`（JSON Pointer `/a/b/0/c`）取出**源值**；
 *   ② 在每条 `targets[].file` 里用该条的 `pattern`（**必须恰好一个捕获组**）抽出
 *      **值字面量**（捕获组捕获的是字面量本身；目标写的是字符串时捕获组要带上引号）；
 *   ③ 抽出值必须与源值**字面相等**——类型也必须是同一个：数字 `9` ≠ 字符串 `"9"`
 *      （见 `parseLiteral` / `literalsEqual`）；
 *   ④ `mode: "set"` 的条目（枚举类）：抽到的**去重集合**必须等于源数组的集合，
 *      顺序无关；
 *   ⑤ 可选 `scope: { start, end }`：只在该范围（字面量子串界定）内抽取——同一个文件
 *      里往往还有**别的**状态字面量（`/health` 的 `'ok'`、`'healthy'`），不界定范围
 *      就会把无关字面量算进集合，判据变成噪音。
 *
 * ## 最重要的一条：**抽不到 ⇒ 结构红，绝不静默跳过**
 *
 * `scripts/check-publishable-wiring.mjs:29-31`（文件头与 T4 段的教训）记的正是这个失效
 * 模式：「清单坏了被静默降级」——`package.json` 解析失败时旧实现 `return false`，于是那个
 * 包从判据里**消失**（既不判接线、也不进基线），而没有任何别的东西校验清单。同一族在
 * `check-image-pinned.mjs` 里是 `catch { continue }`（「读不到 = 跳过」）。
 *
 * 手抄守卫这里它更贵：**抽不到锚点 = 源码被重构了（改成 import 共享包、加了 `as const`、
 * 换了变量名）**。若那条路被静默跳过，守卫就会对着一个空集合报绿——恰恰在「已经没人手抄
 * 了」或「已经抄成另一个形状了」的时候最绿。因此下列全部是**结构红**（点名 file:line）：
 *
 *   · 目标文件不存在（登记表腐烂：指向的包/文件已经没了）；
 *   · 正则不匹配（0 次命中）；
 *   · 命中多次且**互相冲突**（同一条锚点抽出两个不同的值）；
 *   · 命中到的字面量无法识别（`9 as const`、`process.env.X`、模板串——静态判不出类型）；
 *   · `scope.start` / `scope.end` 找不到（范围标记失效 = 函数被改名搬走了）；
 *   · 源文件/登记表读不到或不可解析、pointer 取不到、捕获组不是恰好 1 个。
 *
 * 反方向同样红（防登记表腐烂 / 空表死条文）：
 *
 *   · 登记项 < `MIN_ENTRIES`（3 条）⇒ 结构红——判据不能变成一张空表；
 *   · 条目缺 `id` / `why` / `source` / `targets`、`id` 重复 ⇒ 结构红；
 *   · `sourcePackage` 指向的文件已不存在 ⇒ 结构红。
 *
 * ## 为什么源值只能来自 `source`
 *
 * 登记表里**不许写期望值**。写死期望值 = 守卫退化成「抄一份期望」，与源文件脱钩：改了
 * protocol.json 之后守卫仍按旧期望报绿（或反过来永远红）。所以每条只能给「去哪儿取」，
 * 值一律现取现用。
 *
 * ## 与既有 `protocol-version-consistency.spec.ts` 的关系
 *
 * `apps/admin-api/src/modules/executor/__tests__/protocol-version-consistency.spec.ts`
 * 已经把 `PROTOCOL_VERSION`（node/py）与 `PROTOCOL_SUPPORTED_MIN`（admin）钉在
 * protocol.json 上，但它是**一条 jest 用例**、路径与正则硬编码在那一个文件里，只覆盖
 * 「版本号」这一族，且不进 `test:guards:repo`。本守卫把同一立场推广成**登记表驱动**：
 * 新增一条手抄副本 = 加一条 JSON，不改守卫代码；且覆盖到 jest 完全没碰的
 * `HealthReadyResponse.status` 枚举。
 *
 * 用法：
 *   node scripts/check-handwritten-copies.mjs [--report] [--selftest] [--root <dir>]
 *   --report  ：打印全表（每条 anchor 的 file:line 与抽取值），随后**仍**按判据退出
 *   --selftest：在临时 fixture 树里跑真脚本（真子进程 + 退出码 + 报错文本）
 *   --root    ：只给 selftest 用：把 fixture 树当仓库根（默认 `process.cwd()`）
 *
 * 退出码：0 = 全部登记项字面相等且结构完好；1 = 任一漂移 / 任一结构红（**报告模式也不吞**）。
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";

/** 登记表相对仓库根的路径。 */
export const REGISTRY_REL = "scripts/handwritten-copies.json";

/**
 * 登记项下界。当前 3 条（协议版本 / 支持下限 / 健康状态枚举）。
 *
 * 这条钉的是「判据还在不在」：表被清空或只剩 1 条时，「0 处漂移」不是「一致」，
 * 而是「几乎什么都没判」。3 而不是 5——新增登记项不该因为下界没改而误红，
 * 但塌到 1~2 条必须红。
 */
export const MIN_ENTRIES = 3;

/** 值字面量的合法数字形态（拒绝 `09` / `1_000` / `9.` 这类不是字面量本身的形态）。 */
const NUMBER_LITERAL_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/**
 * 把一个「值字面量」文本解析成带类型的值。
 *
 * 这是「字面严格比较」的地基：**类型是值的一部分**。`9`（number）与 `"9"`（string）
 * 解析成不同 `kind`，于是永远不会互相通过——同款纪律见 protocol.json 的
 * `runtimeVersion-not-a-string` 向量（数字形态必须拒，因为 `3.10` 会被 IEEE754 吃掉）。
 *
 * `unknown` 不是「等于失败」而是**结构红**：抽到 `9 as const` / `process.env.PROTOCOL_VERSION`
 * 时静态判不出值，必须由人把锚点正则收紧或把写法改回字面量，不许猜。
 */
export function parseLiteral(raw) {
  const text = String(raw ?? "").trim();
  if (text.length >= 2) {
    const q = text[0];
    if ((q === "'" || q === '"') && text.endsWith(q)) {
      return { kind: "string", value: text.slice(1, -1), text };
    }
  }
  if (NUMBER_LITERAL_RE.test(text)) return { kind: "number", value: Number(text), text };
  if (text === "true") return { kind: "boolean", value: true, text };
  if (text === "false") return { kind: "boolean", value: false, text };
  if (text === "null") return { kind: "null", value: null, text };
  return { kind: "unknown", value: text, text };
}

/** 把 JSON 源值转成同一套 `{ kind, value, text }` 形态。 */
export function sourceLiteralOf(value) {
  if (typeof value === "number") return { kind: "number", value, text: String(value) };
  if (typeof value === "string") return { kind: "string", value, text: JSON.stringify(value) };
  if (typeof value === "boolean") return { kind: "boolean", value, text: String(value) };
  return { kind: "unsupported", value, text: JSON.stringify(value) };
}

/** 人读的类型名（报错文案里要能一眼看出「数字 9」与「字符串 "9"」的区别）。 */
function kindLabel(kind) {
  return (
    { number: "数字", string: "字符串", boolean: "布尔", null: "null", unknown: "无法识别的字面量" }[kind] ??
    kind
  );
}

/** `{kind,value}` → `数字 9` / `字符串 "9"`。 */
export function describeLiteral(lit) {
  if (!lit) return "(无)";
  if (lit.kind === "string") return `${kindLabel(lit.kind)} ${JSON.stringify(lit.value)}`;
  return `${kindLabel(lit.kind)} ${lit.text ?? String(lit.value)}`;
}

/**
 * 字面严格相等：**类型相同**且值相同。
 *
 * 刻意不用 `String(a) === String(b)` 或 `Number(a) === Number(b)`——那正是
 * 「`9` 与 `"9"` 相等」这种把类型擦掉的比较。
 */
export function literalsEqual(a, b) {
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  return a.value === b.value;
}

/** JSON Pointer（RFC 6901 子集：只支持 `/a/b/0`，含 `~0`/`~1` 转义）。 */
export function resolvePointer(doc, pointer) {
  if (typeof pointer !== "string" || !pointer.startsWith("/")) {
    return {
      ok: false,
      error: `pointer 必须是以 "/" 开头的 JSON Pointer（收到 ${JSON.stringify(pointer)}）`,
    };
  }
  const segments = pointer
    .slice(1)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  let cur = doc;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const sofar = "/" + segments.slice(0, i).join("/");
    if (cur === null || typeof cur !== "object") {
      return {
        ok: false,
        error: `pointer ${pointer}：走到 ${sofar || "/"} 时已是 ${cur === null ? "null" : typeof cur}，取不到 "${seg}"`,
      };
    }
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(seg) || Number(seg) >= cur.length) {
        return {
          ok: false,
          error: `pointer ${pointer}：数组下标 "${seg}" 不存在（${sofar || "/"} 长度 ${cur.length}）`,
        };
      }
      cur = cur[Number(seg)];
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) {
      const keys = Object.keys(cur);
      return {
        ok: false,
        error:
          `pointer ${pointer}：${sofar || "/"} 下没有键 "${seg}"` +
          `（现有键：${keys.slice(0, 8).join(", ") || "(空)"}${keys.length > 8 ? " …" : ""}）`,
      };
    }
    cur = cur[seg];
  }
  return { ok: true, value: cur };
}

/** 捕获组个数（`new RegExp(src + "|")` 的经典数法，不依赖正则库）。 */
function countGroups(source) {
  return new RegExp(`${source}|`).exec("").length - 1;
}

const lineAt = (text, index) => text.slice(0, index).split("\n").length;

/**
 * 按 `scope: { start, end }` 切出抽取范围；标记找不到 ⇒ 返回 null 并记结构红。
 *
 * 用**字面量子串**而不是正则，是为了让登记表里的范围标记可读、可 review
 * （`async def _readiness()` 比一条带转义的正则更容易看出指向什么）。
 */
function sliceByScope(text, scope) {
  if (!scope || (scope.start === undefined && scope.end === undefined)) {
    return { text, offset: 0 };
  }
  let start = 0;
  if (scope.start !== undefined) {
    const at = text.indexOf(scope.start);
    if (at === -1) {
      return { error: `找不到范围起点 ${JSON.stringify(scope.start)}——函数被改名/搬家了？范围标记失效则判据无从成立` };
    }
    start = at;
  }
  let end = text.length;
  if (scope.end !== undefined) {
    const at = text.indexOf(scope.end, start + (scope.start ? String(scope.start).length : 0));
    if (at === -1) {
      return { error: `找不到范围终点 ${JSON.stringify(scope.end)}——范围标记失效则判据无从成立` };
    }
    end = at;
  }
  return { text: text.slice(start, end), offset: start };
}

/** 收集一次正则的全部命中（强制 `g`），返回 `{ index, captures }`。 */
function execAll(re, haystack) {
  const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
  const rx = new RegExp(re.source, flags);
  const out = [];
  let m;
  let spins = 0;
  while ((m = rx.exec(haystack)) !== null) {
    out.push({ index: m.index, captures: m.slice(1) });
    if (m[0] === "") rx.lastIndex += 1;
    if (++spins > 100_000) break; // 防病态正则把 CI 挂住
  }
  return out;
}

function readText(abs) {
  try {
    return { text: readFileSync(abs, "utf8"), error: null };
  } catch (error) {
    return { text: null, error: error?.code ?? error?.message ?? String(error) };
  }
}

function readJson(abs) {
  const { text, error } = readText(abs);
  if (text === null) return { doc: null, error: `读不到（${error}）` };
  try {
    return { doc: JSON.parse(text), error: null };
  } catch (parseError) {
    return { doc: null, error: `不可解析（${String(parseError.message).split("\n")[0]}）` };
  }
}

/**
 * 校验一条登记项的形状。返回问题文本数组（空数组 = 合规）。
 *
 * 抽成纯函数便于 selftest 直接断言「形状退化会不会被抓」，而不必每次都造整棵树。
 */
export function entryProblems(entry, index) {
  const at = `entries[${index}]`;
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return [`${at} 必须是对象（收到 ${JSON.stringify(entry)}）`];
  }
  const out = [];
  if (typeof entry.id !== "string" || entry.id.trim() === "") {
    out.push(`${at}.id 缺失——没有 id 的条目在报告里点名不清`);
  }
  if (typeof entry.why !== "string" || entry.why.trim().length < 20) {
    out.push(
      `${at}.why 至少 20 字：说清「为什么这条必须字面相等」与「为什么运行时零消费」——` +
        "否则下一个人无法判断这条还该不该在表里",
    );
  }
  if (entry.mode !== undefined && entry.mode !== "literal" && entry.mode !== "set") {
    out.push(`${at}.mode 只能是 "literal" 或 "set"（收到 ${JSON.stringify(entry.mode)}）`);
  }
  const src = entry.source;
  if (src === null || typeof src !== "object" || Array.isArray(src)) {
    out.push(`${at}.source 必须是 { file, pointer }`);
  } else {
    if (typeof src.file !== "string" || src.file.trim() === "") {
      out.push(`${at}.source.file 缺失——源值必须来自文件，不许在登记表里写死期望值`);
    }
    if (typeof src.pointer !== "string" || !src.pointer.startsWith("/")) {
      out.push(`${at}.source.pointer 必须是以 "/" 开头的 JSON Pointer（收到 ${JSON.stringify(src.pointer)}）`);
    }
  }
  if (!Array.isArray(entry.targets) || entry.targets.length === 0) {
    out.push(`${at}.targets 必须是非空数组（一条锚点都没有的登记项等于没判）`);
  } else {
    entry.targets.forEach((t, i) => {
      const tat = `${at}.targets[${i}]`;
      if (t === null || typeof t !== "object" || Array.isArray(t)) {
        out.push(`${tat} 必须是 { file, pattern }`);
        return;
      }
      if (typeof t.file !== "string" || t.file.trim() === "") out.push(`${tat}.file 缺失`);
      if (typeof t.pattern !== "string" || t.pattern.trim() === "") {
        out.push(`${tat}.pattern 缺失`);
        return;
      }
      let re;
      try {
        re = new RegExp(t.pattern, "m");
      } catch (error) {
        out.push(`${tat}.pattern 不是合法正则（${String(error.message).split("\n")[0]}）`);
        return;
      }
      const groups = countGroups(re.source);
      if (groups !== 1) {
        out.push(
          `${tat}.pattern 必须**恰好一个捕获组**（收到 ${groups} 个）——` +
            "捕获组就是被比较的值字面量；0 个捕获组等于「抽出 undefined」，必然假绿",
        );
      }
      const scope = t.scope;
      if (scope !== undefined) {
        if (scope === null || typeof scope !== "object" || Array.isArray(scope)) {
          out.push(`${tat}.scope 必须是 { start?, end? }`);
        } else {
          for (const key of ["start", "end"]) {
            if (scope[key] !== undefined && (typeof scope[key] !== "string" || scope[key] === "")) {
              out.push(`${tat}.scope.${key} 必须是非空字符串`);
            }
          }
        }
      }
    });
  }
  return out;
}

/**
 * 判据本体。返回 `{ structure, drifts, rows, counts }`：
 *   · `structure` = 「判据本身不可信」（读不到 / 抽不到 / 类型不可识别 / 表太小）；
 *   · `drifts`    = 真的字面不等（跨实现漂移）；
 *   · `rows`      = 每条 anchor 的抽取明细（`--report` 用）。
 */
export function check({ root = process.cwd() } = {}) {
  const structure = [];
  const drifts = [];
  const rows = [];
  const counts = { entries: 0, anchors: 0, matched: 0, root };

  const registryAbs = join(root, REGISTRY_REL);
  if (!existsSync(registryAbs)) {
    structure.push(
      `读不到登记表 ${REGISTRY_REL} —— 登记表缺失时「没有漂移」与「一条判据都没有」是同一件事，判结构红`,
    );
    return { structure, drifts, rows, counts };
  }
  const { doc: registry, error: registryError } = readJson(registryAbs);
  if (registry === null) {
    // 这一条是本守卫的立场所在：解析失败**绝不**降级成「空表 = 无漂移」。
    structure.push(
      `登记表 ${REGISTRY_REL} ${registryError} —— 解析不出来必须结构红（同 check-publishable-wiring 的「清单坏了被静默降级」教训）`,
    );
    return { structure, drifts, rows, counts };
  }
  if (registry === null || typeof registry !== "object" || Array.isArray(registry)) {
    structure.push(`登记表 ${REGISTRY_REL} 顶层必须是对象 { sourcePackage, entries }`);
    return { structure, drifts, rows, counts };
  }

  // ── 反向判据：sourcePackage 指向的文件必须还在 ──────────────────────────
  if (typeof registry.sourcePackage !== "string" || registry.sourcePackage.trim() === "") {
    structure.push(`登记表缺 sourcePackage（事实源路径）——没有它，读者无法判断源值来自哪份协议`);
  } else if (!existsSync(join(root, registry.sourcePackage))) {
    structure.push(
      `sourcePackage 指向的文件已不存在：${registry.sourcePackage} —— 登记表腐烂（协议被搬家/改名了）`,
    );
  }

  // ── knownGaps（已知盲区登记）：缺 owner / 过期 ⇒ 结构红 ────────────────
  const knownGaps = registry.knownGaps;
  if (knownGaps !== undefined) {
    if (!Array.isArray(knownGaps)) {
      structure.push(`登记表 ${REGISTRY_REL} 的 knownGaps 必须是数组（收到 ${typeof knownGaps}）`);
    } else {
      for (const [index, gap] of knownGaps.entries()) {
        const at = `knownGaps[${index}]`;
        if (!gap || typeof gap !== "object" || Array.isArray(gap)) {
          structure.push(`${at} 不是对象 —— 登记腐烂了。`);
          continue;
        }
        if (typeof gap.id !== "string" || gap.id.trim() === "") {
          structure.push(`${at} 缺 id —— 缺口必须能点名。`);
        }
        if (typeof gap.owner !== "string" || gap.owner.trim() === "") {
          structure.push(`${at} 缺 owner —— 没有责任人的缺口等于没有记录（它会被遗忘）。`);
        }
        if (typeof gap.why !== "string" || gap.why.trim().length < 20) {
          structure.push(`${at} 的 why 太短 —— 缺口必须写清「为什么现在没人管它」。`);
        }
        if (typeof gap.review_by !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(gap.review_by)) {
          structure.push(`${at} 的 review_by 必须是 YYYY-MM-DD（收到 ${JSON.stringify(gap.review_by)}）。`);
          continue;
        }
        const day = Math.floor(Date.parse(`${gap.review_by}T00:00:00Z`) / 86_400_000);
        if (!Number.isFinite(day)) {
          structure.push(`${at} 的 review_by 不是合法日期：${gap.review_by}。`);
          continue;
        }
        if (day < todayDay()) {
          structure.push(
            `${at}（${gap.id}）的复核期限已过（review_by=${gap.review_by}）—— 缺口还在，但已经没人打算管它了。`,
          );
        }
      }
    }
  }

  const entries = registry.entries;
  if (!Array.isArray(entries)) {
    structure.push(`登记表 entries 必须是数组（收到 ${typeof entries}）`);
    return { structure, drifts, rows, counts };
  }
  counts.entries = entries.length;
  if (entries.length < MIN_ENTRIES) {
    structure.push(
      `登记项只有 ${entries.length} 条 < 下界 ${MIN_ENTRIES} —— 判据正在退化成空表死条文（「0 处漂移」此时不代表一致）`,
    );
  }

  const seenIds = new Map();
  for (const [index, entry] of entries.entries()) {
    const problems = entryProblems(entry, index);
    if (problems.length > 0) {
      for (const p of problems) structure.push(`条目形状不合法：${p}`);
      continue;
    }
    if (seenIds.has(entry.id)) {
      structure.push(`条目 id 重复："${entry.id}"（entries[${seenIds.get(entry.id)}] 与 entries[${index}]）`);
      continue;
    }
    seenIds.set(entry.id, index);

    const mode = entry.mode ?? "literal";
    const sourceAbs = join(root, entry.source.file);
    if (!existsSync(sourceAbs)) {
      structure.push(`[${entry.id}] 源文件不存在：${entry.source.file} —— 事实源路径变了，判据无从成立`);
      continue;
    }
    const { doc: sourceDoc, error: sourceError } = readJson(sourceAbs);
    if (sourceDoc === null) {
      structure.push(`[${entry.id}] 源文件 ${entry.source.file} ${sourceError} —— 解析失败必须结构红，不许当成「没有源值」`);
      continue;
    }
    const pointed = resolvePointer(sourceDoc, entry.source.pointer);
    if (!pointed.ok) {
      structure.push(`[${entry.id}] 源值取不到：${entry.source.file} ${pointed.error}`);
      continue;
    }

    // 源值归一化（literal：标量；set：字符串数组）
    let sourceLit = null;
    let sourceSet = null;
    if (mode === "set") {
      if (!Array.isArray(pointed.value) || pointed.value.length === 0) {
        structure.push(
          `[${entry.id}] mode:"set" 但 ${entry.source.pointer} 不是非空数组（收到 ${JSON.stringify(pointed.value)?.slice(0, 80)}）`,
        );
        continue;
      }
      const bad = pointed.value.filter((v) => typeof v !== "string");
      if (bad.length > 0) {
        structure.push(`[${entry.id}] 源集合里必须全是字符串（发现 ${JSON.stringify(bad).slice(0, 80)}）`);
        continue;
      }
      sourceSet = new Set(pointed.value);
    } else {
      sourceLit = sourceLiteralOf(pointed.value);
      if (sourceLit.kind === "unsupported") {
        structure.push(
          `[${entry.id}] 源值类型不受支持（${typeof pointed.value}，pointer ${entry.source.pointer}）——` +
            "literal 模式只比标量；数组/对象请用 mode:\"set\"",
        );
        continue;
      }
    }

    const sourceWhere = `${entry.source.file} ${entry.source.pointer}`;
    const sourceDesc = mode === "set" ? `集合 {${[...sourceSet].join(", ")}}` : describeLiteral(sourceLit);

    for (const target of entry.targets) {
      counts.anchors += 1;
      const targetAbs = join(root, target.file);
      const row = { id: entry.id, file: target.file, line: null, mode, note: null, ok: false };
      rows.push(row);

      // ① 表腐烂：登记的文件已经不存在
      if (!existsSync(targetAbs)) {
        row.note = "文件不存在";
        structure.push(
          `[${entry.id}] 表腐烂：登记的实现文件已不存在 ${target.file} —— 指向一个不存在的文件等于这条锚点一直在空转`,
        );
        continue;
      }
      const { text, error } = readText(targetAbs);
      if (text === null) {
        row.note = "读不到";
        structure.push(`[${entry.id}] 实现文件读不到 ${target.file}（${error}）—— 读不到 = 结构红，绝不静默跳过`);
        continue;
      }

      // ② 范围界定
      const scoped = sliceByScope(text, target.scope);
      if (scoped.error) {
        row.note = "范围标记失效";
        structure.push(`[${entry.id}] ${target.file}：${scoped.error}`);
        continue;
      }

      // ③ 抽取
      const re = new RegExp(target.pattern, "m");
      const hits = execAll(re, scoped.text);
      if (hits.length === 0) {
        row.note = "抽不到锚点";
        structure.push(
          `[${entry.id}] 抽不到锚点：${target.file} 里没有一处匹配 ${JSON.stringify(target.pattern)}` +
            `${target.scope ? `（范围 ${JSON.stringify(target.scope)}）` : ""} —— ` +
            "源码被重构（改成 import / 加了 as const / 换名）不会让这条变绿，它必须红并重新登记",
        );
        continue;
      }
      counts.matched += hits.length;

      const parsed = hits.map((h) => ({
        line: lineAt(text, scoped.offset + h.index),
        lit: parseLiteral(h.captures[0]),
      }));
      row.line = parsed[0].line;

      const unknown = parsed.filter((p) => p.lit.kind === "unknown");
      if (unknown.length > 0) {
        row.note = "字面量无法识别";
        structure.push(
          `[${entry.id}] ${target.file}:${unknown[0].line} 抽到 ${JSON.stringify(unknown[0].lit.text)}，` +
            "不是可静态判定的字面量（`9 as const` / `process.env.X` / 模板串 / 表达式）—— " +
            "判不出就不许猜，收紧锚点正则或把写法改回字面量",
        );
        continue;
      }

      if (mode === "set") {
        const got = new Set(parsed.map((p) => (p.lit.kind === "string" ? p.lit.value : p.lit.text)));
        const missing = [...sourceSet].filter((v) => !got.has(v));
        const extra = [...got].filter((v) => !sourceSet.has(v));
        row.got = [...got].sort();
        row.expected = [...sourceSet].sort();
        if (missing.length === 0 && extra.length === 0) {
          row.ok = true;
          continue;
        }
        row.note = "状态集合不等";
        drifts.push({
          id: entry.id,
          file: target.file,
          line: parsed[0].line,
          got: [...got].sort(),
          expected: [...sourceSet].sort(),
          sourceWhere,
          sourceDesc,
          kind: "set",
        });
        continue;
      }

      // literal：命中多次且互相冲突 ⇒ 结构红（不许「取第一个就过」）
      const distinct = new Map(parsed.map((p) => [p.lit.text, p]));
      if (distinct.size > 1) {
        row.note = "抽到互相冲突的值";
        structure.push(
          `[${entry.id}] ${target.file} 抽到 ${distinct.size} 个互相冲突的字面量：` +
            `${[...distinct.values()].map((p) => `第 ${p.line} 行 ${JSON.stringify(p.lit.text)}`).join(" / ")} —— ` +
            "同一锚点必须只有一个值，多个取值说明正则太宽（或真的改成了两处常量）",
        );
        continue;
      }
      const got = [...distinct.values()][0];
      row.got = describeLiteral(got.lit);
      row.expected = describeLiteral(sourceLit);
      if (literalsEqual(sourceLit, got.lit)) {
        row.ok = true;
        continue;
      }
      row.note = "字面不等";
      drifts.push({
        id: entry.id,
        file: target.file,
        line: got.line,
        got: describeLiteral(got.lit),
        expected: describeLiteral(sourceLit),
        sourceWhere,
        sourceDesc: describeLiteral(sourceLit),
        kind: "literal",
        typeMismatch: sourceLit.kind !== got.lit.kind && String(sourceLit.value) === String(got.lit.value),
      });
    }
  }

  return { structure, drifts, rows, counts };
}

/** 一条锚点的 `file:line` 展示文本。 */
function where(row) {
  return `${row.file}${row.line ? `:${row.line}` : ""}`;
}

function runCli(root, { report = false } = {}) {
  const { structure, drifts, rows, counts } = check({ root });

  if (report) {
    for (const row of rows) {
      const status = row.ok ? "✅ 相等" : `✘ ${row.note ?? "未判定"}`;
      const detail =
        row.mode === "set"
          ? `{${(row.got ?? []).join(", ")}} vs 源 {${(row.expected ?? []).join(", ")}}`
          : `${row.got ?? "(未抽到)"} vs 源 ${row.expected ?? "(未取到)"}`;
      console.log(`  ${String(row.id).padEnd(24)} ${where(row).padEnd(62)} ${status.padEnd(22)} ${detail}`);
    }
    console.log("");
  }

  if (structure.length > 0) {
    console.error(`✖ 结构：判据本身不可信（${structure.length} 条）——这里的「0 处漂移」不算绿：`);
    for (const s of structure) console.error(`  ✖ ${s}`);
    console.error("");
  }

  if (drifts.length > 0) {
    console.error(`✖ 跨实现漂移：${drifts.length} 处手抄副本与协议单一事实源**字面不等**：`);
    for (const d of drifts) {
      if (d.kind === "set") {
        console.error(
          `  ✘ [${d.id}] ${d.file}:${d.line} 状态集合 {${d.got.join(", ")}} ≠ 源 ${d.sourceDesc}` +
            `（${d.sourceWhere}；多出 ${JSON.stringify(d.got.filter((v) => !d.expected.includes(v)))}、` +
            `缺少 ${JSON.stringify(d.expected.filter((v) => !d.got.includes(v)))}）`,
        );
      } else {
        console.error(
          `  ✘ [${d.id}] ${d.file}:${d.line} 抽到 ${d.got}，源 ${d.sourceWhere} 是 ${d.expected}`,
        );
        if (d.typeMismatch) {
          console.error(
            `      类型不严格：数值相等但类型不同（源 ${d.expected}，目标 ${d.got}）——` +
              "字面严格比较要求同类型，`9` 与 `\"9\"` 不相等",
          );
        }
      }
    }
    console.error(
      "\n修法二选一：① 把实现文件里的手抄值改成与协议一致；② 若这是**有意的**分叉（例如实现刻意停在旧协议），" +
        "\n        先改 packages/executor-protocol 的源值并登记新协议版本，再同步实现——不许只改一侧。",
    );
    console.error("");
  }

  if (structure.length === 0 && drifts.length === 0) {
    console.log(
      `✔ 手抄常量一致：${counts.entries} 条登记 / ${counts.anchors} 个实现锚点全部与 ` +
        `packages/executor-protocol/protocol.json 字面相等（类型严格、结构完好）`,
    );
  }

  return structure.length > 0 || drifts.length > 0 ? 1 : 0;
}

// ── 自检（真子进程 + 退出码 + 报错文本）─────────────────────────────────────
const SELF = fileURLToPath(import.meta.url);

/** 判「今天」用的 UTC 日序号（与 review_by 的 YYYY-MM-DD 同形）。 */
function todayDay() {
  const now = new Date();
  return Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86_400_000);
}

function argValue(argv, flag) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const at = argv.indexOf(flag);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1];
  return null;
}

// ——fixture 事实源：与真实协议同形的最小 protocol.json——
const SOURCE_DOC = {
  versioning: { currentProtocolVersion: 9, supportedMinProtocolVersion: 1 },
  schemas: {
    HealthReadyResponse: {
      type: "object",
      properties: { status: { enum: ["ready", "not_ready"] } },
    },
  },
};

const NODE_CONFIG = "export const PROTOCOL_VERSION = 9;\n";
const PY_CONFIG = "PROTOCOL_VERSION = 9\n";
const ADMIN_COMPAT = "export const PROTOCOL_SUPPORTED_MIN = 1;\n";

/**
 * node 健康路由 fixture：`/health` 里刻意放一个**范围外**的 `status: 'healthy'`。
 *
 * 这是本文件里最容易被写松的一处：一个「扫全文件的 status 字面量」实现会把它算进集合，
 * 于是正例当场红——用例 ① 因此同时钉住了「scope 真的生效」。
 */
const NODE_HEALTH = [
  "export const healthRouter = Router();",
  "",
  "healthRouter.get('/health', (_req, res) => {",
  "  res.json({ status: 'healthy' });",
  "});",
  "",
  "healthRouter.get('/health/ready', async (_req, res) => {",
  "  if (!reachable) {",
  "    sendReady(res, 503, { status: 'not_ready', reason: 'admin-api 不可达' });",
  "    return;",
  "  }",
  "  sendReady(res, 200, { status: 'ready' });",
  "});",
  "",
].join("\n");

/** python 健康路由 fixture：同样带一个范围外的 `'status': 'ok'`（同 node 的理由）。 */
const PY_HEALTH = [
  "@router.get('/health')",
  "async def health():",
  "    return {'status': 'ok'}",
  "",
  "",
  "async def _readiness():",
  "    if not reachable:",
  "        return _ready_json(503, {'status': 'not_ready'})",
  "    return _ready_json(200, {'status': 'ready'})",
  "",
  "",
  "async def readiness_alias():",
  "    return await _readiness()",
  "",
].join("\n");

const PROTOCOL_FIXTURE_REL = "packages/executor-protocol/protocol.json";

const BASE_ENTRIES = () => [
  {
    id: "protocol-version",
    why: "协议版本号决定中台是否下发 commands；node/py 两份手抄必须与 currentProtocolVersion 字面相等。",
    source: { file: PROTOCOL_FIXTURE_REL, pointer: "/versioning/currentProtocolVersion" },
    targets: [
      { file: "apps/executor-node/src/config.ts", pattern: "^\\s*export const PROTOCOL_VERSION = ([^;\\n]+);" },
      { file: "apps/executor-python/config.py", pattern: "^PROTOCOL_VERSION = ([^\\s#]+)" },
    ],
  },
  {
    id: "protocol-supported-min",
    why: "兼容性红线的下限；admin 手抄一份用于判定是否 warn，必须与 supportedMinProtocolVersion 同值。",
    source: { file: PROTOCOL_FIXTURE_REL, pointer: "/versioning/supportedMinProtocolVersion" },
    targets: [
      {
        file: "apps/admin-api/src/modules/executor/protocol-compat.util.ts",
        pattern: "^\\s*export const PROTOCOL_SUPPORTED_MIN = ([^;\\n]+);",
      },
    ],
  },
  {
    id: "health-status-enum",
    why: "就绪探针的状态字面量两端必须同集；LB/K8s 只认这两个值，多一个少一个都让探针语义漂移。",
    mode: "set",
    source: { file: PROTOCOL_FIXTURE_REL, pointer: "/schemas/HealthReadyResponse/properties/status/enum" },
    targets: [
      {
        file: "apps/executor-node/src/routes/health.ts",
        scope: { start: "healthRouter.get('/health/ready'" },
        pattern: "status:\\s*(['\"][A-Za-z_]+['\"])",
      },
      {
        file: "apps/executor-python/routers/health.py",
        scope: { start: "async def _readiness()", end: "async def readiness_alias" },
        pattern: "'status':\\s*(['\"][A-Za-z_]+['\"])",
      },
    ],
  },
];

function registryDoc(mutate) {
  const entries = BASE_ENTRIES();
  if (typeof mutate === "function") mutate(entries);
  return {
    $comment: "fixture 登记表（selftest 专用）",
    sourcePackage: PROTOCOL_FIXTURE_REL,
    entries,
  };
}

/**
 * 造一棵最小 fixture 树；`overrides` 覆盖/新增文件，`drop` 删除文件。
 *
 * 默认树必须能过三条下界（3 条登记 / 5 个锚点 / 源文件与 5 个目标文件都在），
 * 否则每个「该绿」的用例都会被结构红顶掉，绿的那一半再也测不到。
 */
function tree({ overrides = {}, drop = [], mutate } = {}) {
  const files = {
    [PROTOCOL_FIXTURE_REL]: SOURCE_DOC,
    "apps/executor-node/src/config.ts": NODE_CONFIG,
    "apps/executor-python/config.py": PY_CONFIG,
    "apps/admin-api/src/modules/executor/protocol-compat.util.ts": ADMIN_COMPAT,
    "apps/executor-node/src/routes/health.ts": NODE_HEALTH,
    "apps/executor-python/routers/health.py": PY_HEALTH,
    [REGISTRY_REL]: registryDoc(mutate),
    ...overrides,
  };
  for (const rel of drop) delete files[rel];
  return files;
}

/** 改一条 fixture 条目的某个 target 字段（就地）。 */
function patchTarget(entries, id, file, patch) {
  const entry = entries.find((e) => e.id === id);
  const target = entry.targets.find((t) => t.file === file);
  Object.assign(target, patch);
}

/**
 * 自检：10 条用例，全部 `spawn` 真脚本（`--root` 指向 fixture 树）。
 *
 * 每条都**有本事失败**：把 CLI 的 exitCode 删掉 → ①③⑤⑥⑦⑧⑨⑩ 全红；把「抽不到」
 * 降级成 continue → ③⑦ 变绿而失败；把字面比较换成 `Number(a) === Number(b)` → ⑥ 变绿
 * 而失败；把 scope 去掉 → ① 因 `'healthy'` / `'ok'` 混进集合而失败。
 */
export function selftest() {
  const cases = [];
  const subprocess = (name, files, expect, extraArgs = []) => {
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(files, { prefix: "handwritten-copies-selftest-" });
        try {
          expectExit(runGuard(SELF, { args: ["--root", repo.dir, ...extraArgs] }), {
            ...expect,
            withinMs: 2000,
            label: name,
          });
        } finally {
          repo.cleanup();
        }
      },
    });
  };

  // ① 正例：源=9、两个目标都=9（健康枚举两端同集）→ 绿
  subprocess("① 干净树：3 条登记 / 5 个锚点全部字面相等 → 退出 0", tree(), {
    code: 0,
    contains: ["✔ 手抄常量一致", "3 条登记", "5 个实现锚点"],
    absent: ["✖", "✘"],
  });

  // ② 反例（真漂移）：源=9、py 目标=8 → 红，点名文件与两个值
  subprocess(
    "② 【反证·真漂移】源=9 而 py 目标是 8 → 退出 1，点名文件与两个值",
    tree({ overrides: { "apps/executor-python/config.py": "PROTOCOL_VERSION = 8\n" } }),
    {
      code: 1,
      contains: [
        "跨实现漂移",
        "apps/executor-python/config.py:1",
        "数字 8",
        "数字 9",
        "/versioning/currentProtocolVersion",
      ],
      absent: ["✔ 手抄常量一致"],
    },
  );

  // ③ 结构塌陷：文件在、但正则完全不匹配（被重构成 re-export）→ 红
  subprocess(
    "③ 【反证·抽不到】目标被重构成 re-export（正则 0 命中）→ 退出 1，含「抽不到」「结构」",
    tree({
      overrides: {
        "apps/executor-node/src/config.ts":
          '// 改为从共享包导入，本地不再手抄字面量\nexport { PROTOCOL_VERSION } from "@acf/protocol";\n',
      },
    }),
    {
      code: 1,
      contains: ["✖ 结构", "抽不到锚点", "apps/executor-node/src/config.ts"],
      absent: ["✔ 手抄常量一致"],
    },
  );

  // ④ 表腐烂：登记的目标文件被删 → 红并点名文件
  subprocess(
    "④ 【反证·表腐烂】登记的目标文件被删 → 退出 1，点名该文件",
    tree({ drop: ["apps/admin-api/src/modules/executor/protocol-compat.util.ts"] }),
    {
      code: 1,
      contains: ["表腐烂", "apps/admin-api/src/modules/executor/protocol-compat.util.ts", "✖ 结构"],
      absent: ["✔ 手抄常量一致"],
    },
  );

  // ⑤ 空表/表太小：只留 1 条 → 结构红
  subprocess(
    "⑤ 【反证·空表】登记项只剩 1 条 → 退出 1，结构红（表太小 = 判据退化成死条文）",
    tree({ mutate: (entries) => entries.splice(1) }),
    { code: 1, contains: ["✖ 结构", `下界 ${MIN_ENTRIES}`, "登记项只有 1 条"], absent: ["✔ 手抄常量一致"] },
  );

  // ⑥ 类型不严格：源是数字 9，目标是字符串 "9" → 红（数值相等不算相等）
  subprocess(
    "⑥ 【反证·类型】源是数字 9、目标是字符串 \"9\" → 退出 1（字面严格比较）",
    tree({
      overrides: { "apps/executor-node/src/config.ts": 'export const PROTOCOL_VERSION = "9";\n' },
      mutate: (entries) =>
        patchTarget(entries, "protocol-version", "apps/executor-node/src/config.ts", {
          pattern: '^export const PROTOCOL_VERSION = (["\\\']?[^;\\n]+?["\\\']?);',
        }),
    }),
    {
      code: 1,
      contains: ["apps/executor-node/src/config.ts:1", "数字 9", '字符串 "9"', "类型不严格"],
      absent: ["✔ 手抄常量一致"],
    },
  );

  // ⑦ 字面量无法识别：`9 as const` 抽得到但判不出类型 → 结构红（不许猜）
  subprocess(
    "⑦ 【反证·不可识别】目标改写成 `9 as const` → 退出 1，结构红（判不出就不许猜）",
    tree({ overrides: { "apps/executor-node/src/config.ts": "export const PROTOCOL_VERSION = 9 as const;\n" } }),
    {
      code: 1,
      contains: ["✖ 结构", "as const", "不是可静态判定的字面量"],
      absent: ["✔ 手抄常量一致"],
    },
  );

  // ⑧ 源 pointer 取不到（协议段被改名）→ 结构红，点名 pointer
  subprocess(
    "⑧ 【反证·源指针】pointer 指向不存在的键 → 退出 1，结构红并点名 pointer",
    tree({
      mutate: (entries) => {
        entries[0].source.pointer = "/versioning/PROTOCOL_VERSION";
      },
    }),
    { code: 1, contains: ["✖ 结构", "/versioning/PROTOCOL_VERSION", "没有键"], absent: ["✔ 手抄常量一致"] },
  );

  // ⑨ 健康状态集合少一个：python 只剩 ready → 红（集合必须等于源 enum）
  subprocess(
    "⑨ 【反证·集合】py 的就绪集合缺 not_ready → 退出 1，报出多出/缺少",
    tree({
      overrides: {
        "apps/executor-python/routers/health.py": [
          "async def _readiness():",
          "    return _ready_json(200, {'status': 'ready'})",
          "",
          "",
          "async def readiness_alias():",
          "    return await _readiness()",
          "",
        ].join("\n"),
      },
    }),
    {
      code: 1,
      contains: ["集合", "not_ready", "apps/executor-python/routers/health.py:2"],
      absent: ["✔ 手抄常量一致"],
    },
  );

  // ⑩ 报告模式不吞红灯：表照打，退出码仍 1
  subprocess(
    "⑩ 【反证·--report】报告模式遇到漂移仍退出 1（先打印全表，再红）",
    tree({ overrides: { "apps/executor-python/config.py": "PROTOCOL_VERSION = 8\n" } }),
    {
      code: 1,
      contains: ["protocol-version", "health-status-enum", "跨实现漂移"],
      absent: ["✔ 手抄常量一致"],
    },
    ["--report"],
  );

  // ⑪ 登记表本身不可解析 → 结构红（「解析不出来 = 没问题」是头号假绿）
  subprocess(
    "⑪ 【反证·坏登记表】登记表 JSON 不可解析 → 退出 1，结构红",
    tree({ overrides: { [REGISTRY_REL]: '{\n  "entries": [\n' } }),
    { code: 1, contains: ["✖ 结构", "不可解析", REGISTRY_REL], absent: ["✔ 手抄常量一致"] },
  );

  // ⑫ knownGaps（已知盲区登记）：过期 ⇒ 结构红（缺口没主人 / 没人管）
  subprocess(
    "⑫ 【反证·盲区无主】knownGaps 复核期限已过 → 退出 1，结构红",
    tree({
      overrides: {
        [REGISTRY_REL]: JSON.stringify({
          ...registryDoc(),
          knownGaps: [
            {
              id: "protocol-json-supported-min-consumption-note-is-wrong",
              file: "packages/executor-protocol/protocol.json",
              why: "protocol.json 的 versioning 段自述 node/py 各手抄一份 PROTOCOL_SUPPORTED_MIN，实测只有 admin 一处。",
              owner: "executor-parity",
              review_by: "2000-01-01",
            },
          ],
        }),
      },
    }),
    { code: 1, contains: ["✖ 结构", "knownGaps", "复核期限已过"], absent: ["✔ 手抄常量一致"] },
  );

  // ⑬ knownGaps 缺 owner ⇒ 结构红（没主人的缺口会被遗忘）
  subprocess(
    "⑬ 【反证·盲区无主】knownGaps 缺 owner → 退出 1，结构红",
    tree({
      overrides: {
        [REGISTRY_REL]: JSON.stringify({
          ...registryDoc(),
          knownGaps: [
            {
              id: "gap-without-owner",
              why: "这条缺口没有写责任人（fixture 反例）",
              review_by: "2099-01-01",
            },
          ],
        }),
      },
    }),
    { code: 1, contains: ["✖ 结构", "knownGaps", "缺 owner"], absent: ["✔ 手抄常量一致"] },
  );

  const failed = reportCases(cases, { title: "check-handwritten-copies selftest" });
  if (failed > 0) process.exit(1);
}

// ── CLI ────────────────────────────────────────────────────────────────────
const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  if (process.argv.includes("--selftest")) {
    selftest();
  } else {
    const root = resolve(argValue(process.argv, "--root") ?? process.cwd());
    const report = process.argv.includes("--report");
    const code = runCli(root, { report });
    process.exitCode = code;
  }
}

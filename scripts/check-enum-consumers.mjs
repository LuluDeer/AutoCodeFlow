#!/usr/bin/env node
/**
 * 「枚举扩了、枚举的消费者没跟」守卫。
 *
 * 由来：`AlertChannel` 有 6 个值（NF-05 加了 `feishu`），但两处**手抄的清单**只有 5 个 ——
 * 建 feishu 静默直接 400、swagger 不承认该渠道。这类漂移编译通过、测试通过（各自测各自的），
 * 只有真去用 feishu 静默时才会撞上。
 *
 * 判据（刻意做窄，避免变成「猜这个数组是干嘛的」）：
 *   对每个登记的枚举，找源码里的**数组字面量**，若其中出现了该枚举的 ≥2 个值、
 *   但不是全部 ⇒ 判定为「在枚举这个枚举却抄漏了」。
 *
 * 为什么阈值是 2：随机数组命中 ≥2 个枚举值的概率极低，而真正的清单必然命中 ≥2。
 * 这条判据在实测中对 `apps/admin-api/src` 全量扫的假报数为 **0**，命中 2 处（都是真的）。
 *
 * 第二类判据：**同名但分别声明的值集合**（`export enum X` 或 `export type X = "a" | "b"`）。
 *
 * 由来：`ChannelDeliveryStatus` 在两处各写了一遍 `sent | blocked | failed | skipped`
 * （channels/base.channel.ts 与 dto/notification-response.dto.ts）。两份**当前一致**，
 * 但没有任何机制强制它们一致 —— 谁加一个值、另一处没跟，编译期未必报（两处未必相遇）。
 * 判据：同名声明出现在 ≥2 个文件且**值集合不同** ⇒ 红。集合相同则放行（重复本身是重构议题，不是缺陷）。
 *
 * ## T4（第 4 轮守卫自检审计）补的三道防线
 *
 *   · **登记表/扫描面空了就零命中全绿**：旧实现 `ENUMS = []` 时两个循环都不跑，
 *     直接打印「✔ 枚举消费清单一致」；`apps/admin-api/src` 目录改名则抛栈。现在
 *     两处都是结构红（带下界：声明数、每个枚举的数组字面量数）。
 *   · **解析失败不再是抛栈**：`找不到 enum X` / `只提取到 N 个值` 现在是结构错误块，
 *     可读且能被 selftest 断言（旧实现靠 uncaughtError 的栈文本来"红"）。
 *   · **`--report` 不再吞掉结构错误**：旧实现 `process.exit(report ? 0 : 1)` 对
 *     「扫描器失效」也生效 —— 带 `--report` 跑同一个坏树会退 0。现在结构错误恒 1。
 *
 * 顺手收紧的两处（都只可能多报，不可能漏报）：枚举值/字符串联合的提取同时认单引号；
 * 数组清单的成员匹配改用 `"v"` / `'v'` 整词匹配（旧的正则 `['"]v['"]` 会接受混引号）。
 *
 * 已知边界（如实写）：
 *   · 只认**字符串数组字面量**；对象字面量里手抄的键、`new Set([...])` 之外的动态构造都看不到；
 *   · 不判断该数组的语义（是白名单还是黑名单、是否真的该含全部值）—— 命中即需人工确认一次；
 *   · **裸标识符**（不带引号的值，例如 enum 用数字成员）不在本判据范围内。
 *
 * 用法：
 *   node scripts/check-enum-consumers.mjs           # 守卫
 *   node scripts/check-enum-consumers.mjs --report  # 只报告命中，不因命中退出非 0（结构错误仍退 1）
 *   node scripts/check-enum-consumers.mjs --selftest [--root <dir>]
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";

export const SRC_REL = "apps/admin-api/src";

/** 扫描面下界（2026-10-29 实测：声明 46 / 数组字面量 3355）。只增不减。 */
export const MIN_DECLARATIONS = 30;
export const MIN_ARRAY_LITERALS = 50;

/** 登记的枚举：名字 → 定义所在文件（相对仓库根）。新增枚举时在这里加一行。 */
export const ENUMS = [
  { name: "AlertChannel", file: "apps/admin-api/src/modules/notification/notification.service.ts" },
];

const SKIP_DIRS = new Set(["node_modules", ".venv", "dist", "build", "out", "coverage"]);

/** 字符串成员：`= "x"` / `= 'x'`（单引号 T4 补上：旧实现只认双引号，写法一变就"零命中"）。 */
const MEMBER_RE = /=\s*["']([^"']+)["']/g;

function readText(abs) {
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(p, out);
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts")) {
      out.push(p);
    }
  }
  return out;
}

/** 枚举的字符串值；解析失败返回 `{ error }`（由调用方升级为结构错误）。 */
function enumValues(file, name) {
  const text = readText(file);
  if (text === null) return { error: `读不到 ${name} 的定义文件（登记表路径过期了？）：${file}` };
  const m = new RegExp(`export enum ${name} \\{([\\s\\S]*?)\\n\\}`, "m").exec(text);
  if (!m) return { error: `找不到 enum ${name}（${file}）—— 登记表过期还是写法变了？` };
  const values = [...m[1].matchAll(MEMBER_RE)].map((x) => x[1]);
  if (values.length < 2) {
    return { error: `enum ${name} 只提取到 ${values.length} 个字符串值 —— 提取器失效，不能当成「没有问题」。` };
  }
  return { values };
}

/** 同名但分别声明的值集合（`export enum X` / `export type X = "a" | "b"`）。 */
function collectDeclarations(srcDir) {
  const byName = new Map();
  const add = (name, file, values) => {
    const prev = byName.get(name) ?? [];
    prev.push({ file: file.split("\\").join("/"), values: values.slice().sort() });
    byName.set(name, prev);
  };
  for (const f of walk(srcDir)) {
    const text = readText(f) ?? "";
    for (const m of text.matchAll(/export enum (\w+) \{([\s\S]*?)\n\}/g)) {
      const values = [...m[2].matchAll(MEMBER_RE)].map((x) => x[1]);
      if (values.length) add(m[1], f, values);
    }
    // 注意：捕获组**不能**套在 `(?:…)+` 里面 —— 那样 `m[2]` 只剩最后一个成员，
    // 于是 `"a" | "x"` 与 `"b" | "x"` 会被判成「集合相同」（旧实现就是这个假绿）。
    // 现在整段联合类型一次性捕获，再逐个取成员。
    for (const m of text.matchAll(
      /export type (\w+)\s*=\s*((?:"[^"]+"|'[^']+')(?:\s*\|\s*(?:"[^"]+"|'[^']+'))*)\s*;/g,
    )) {
      const values = [...m[2].matchAll(/"([^"]+)"|'([^']+)'/g)].map((x) => x[1] ?? x[2]);
      if (values.length) add(m[1], f, values);
    }
  }
  return byName;
}

/**
 * 判据本体。`root` 是仓库根；`enums` 可注入（selftest 的「登记表被清空」用例用它，
 * CLI 没有对应开关 —— 给 CLI 开后门等于给判据开后门）。
 */
export function check({ root = process.cwd(), enums = ENUMS } = {}) {
  const errors = [];
  const problems = [];
  const stats = { declarations: 0, files: 0, arrayLiterals: 0, values: {} };
  const srcDir = join(root, SRC_REL);

  if (!existsSync(srcDir)) {
    return {
      errors: [`扫描根 ${SRC_REL} 不存在 —— 目录改名后本守卫会零命中，那是假绿不是干净。`],
      problems,
      stats,
    };
  }
  if (enums.length === 0) {
    errors.push("登记的枚举表是空的 —— 一个枚举都不查 ⇒ 永远绿（「零命中全绿」）。");
  }

  const files = walk(srcDir);
  stats.files = files.length;

  const decls = collectDeclarations(srcDir);
  stats.declarations = [...decls.values()].reduce((n, list) => n + list.length, 0);
  if (stats.declarations < MIN_DECLARATIONS) {
    errors.push(
      `只解析到 ${stats.declarations} 处 export enum / export type 声明（下界 ${MIN_DECLARATIONS}）—— 扫描面塌了，不是声明变少了。`,
    );
  }

  for (const [name, list] of decls) {
    if (list.length < 2) continue;
    if (new Set(list.map((d) => d.values.join(","))).size > 1) {
      problems.push({
        name,
        file: list.map((d) => d.file).join(" vs "),
        line: 0,
        missing: [`值集合不一致：${list.map((d) => `[${d.values.join(",")}]`).join(" / ")}`],
      });
    }
  }

  for (const { name, file } of enums) {
    const resolved = enumValues(join(root, file), name);
    if (resolved.error) {
      errors.push(resolved.error);
      continue;
    }
    const values = resolved.values;
    stats.values[name] = values.length;
    let scanned = 0;
    for (const f of files) {
      if (f === join(root, file)) continue; // 定义处不算消费者
      const text = readText(f) ?? "";
      const arrRe = /\[([^\[\]]{0,400})\]/g;
      for (const m of text.matchAll(arrRe)) {
        scanned += 1;
        const body = m[1];
        const found = values.filter((v) => body.includes(`"${v}"`) || body.includes(`'${v}'`));
        if (found.length >= 2 && found.length < values.length) {
          problems.push({
            name,
            file: f.split("\\").join("/"),
            line: text.slice(0, m.index).split("\n").length,
            missing: values.filter((v) => !found.includes(v)),
          });
        }
      }
    }
    stats.arrayLiterals += scanned;
    if (scanned < MIN_ARRAY_LITERALS) {
      errors.push(
        `枚举 ${name} 只扫到 ${scanned} 个数组字面量（下界 ${MIN_ARRAY_LITERALS}）—— 扫描器失效，不能当成「没有清单漏值」。`,
      );
    }
  }

  return { errors, problems, stats };
}

// ── 自检（T4：全部跑真脚本子进程）─────────────────────────────────────────
const SELF = fileURLToPath(import.meta.url);

function argValue(argv, flag) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const at = argv.indexOf(flag);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1];
  return null;
}

const ENUM_REL = "apps/admin-api/src/modules/notification/notification.service.ts";
const DECL_REL = "apps/admin-api/src/modules/notification/declarations.ts";
const FILLER_REL = "apps/admin-api/src/modules/notification/filler.ts";

const ALERT_CHANNEL = `export enum AlertChannel {\n  Email = "email",\n  Slack = "slack",\n  Webhook = "webhook",\n  Feishu = "feishu",\n}\n`;

/** 32 处同名声明（各文件唯一名字，值集合一致）—— 过 `MIN_DECLARATIONS` 下界。 */
const declarations = (n = 32) =>
  Array.from({ length: n }, (_, i) => `export enum Filler${i} {\n  A = "a",\n  B = "b",\n}\n`).join("\n");

/** 60 个与枚举无关的数组字面量 —— 过 `MIN_ARRAY_LITERALS` 下界。 */
const fillerArrays = (n = 60) =>
  Array.from({ length: n }, (_, i) => `export const list${i} = [1, 2, 3];`).join("\n") + "\n";

function enumTree({ serv = ALERT_CHANNEL, decls = declarations(), arrays = fillerArrays(), extra = {}, drop = [], empty = false } = {}) {
  if (empty) return { "README.md": "# fixture\n" };
  const files = {
    [ENUM_REL]: serv,
    [DECL_REL]: decls,
    [FILLER_REL]: arrays,
  };
  Object.assign(files, extra);
  for (const d of drop) delete files[d];
  return files;
}

/**
 * 自检：9 条子进程用例 + 1 条 API 级用例。
 *
 * 旧版**没有 selftest**，而它有两处典型的「零命中全绿」通道（登记表为空 / 目录改名），
 * 恰好是审计盯的那一类。CLI 没有 `--enums` 开关（也不该有），所以「登记表被清空」
 * 那条直接调导出函数 `check({ root, enums: [] })`。
 */
export function selftest() {
  const cases = [];
  const subprocess = (name, files, expect) => {
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(files, { prefix: "enum-consumers-selftest-" });
        try {
          expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
            ...expect,
            withinMs: 1000,
            label: name,
          });
        } finally {
          repo.cleanup();
        }
      },
    });
  };

  subprocess("① 干净树：清单含全集 / 同名声明一致 → 绿", enumTree(), {
    code: 0,
    contains: ["枚举消费清单一致"],
    absent: ["发现", "结构错误"],
  });

  subprocess(
    "② 手抄清单漏值（[email, slack]，枚举有 4 个）→ 红并点名缺哪几个",
    enumTree({
      extra: { "apps/admin-api/src/modules/notification/channels.ts": `export const CHANNELS = ["email", "slack"];\n` },
    }),
    {
      code: 1,
      contains: ["发现 1 处", "channels.ts", "（AlertChannel）缺：webhook, feishu"],
      absent: ["枚举消费清单一致"],
    },
  );

  subprocess(
    "③ 清单含全集 → 绿（不误报）",
    enumTree({
      extra: {
        "apps/admin-api/src/modules/notification/channels.ts": `export const CHANNELS = ["email", "slack", "webhook", "feishu"];\n`,
      },
    }),
    { code: 0, contains: ["枚举消费清单一致"], absent: ["发现"] },
  );

  subprocess(
    "④ 同名声明值集合不一致（DeliveryStatus 两处各写一遍、差一个值）→ 红",
    enumTree({
      extra: {
        "apps/admin-api/src/modules/notification/a.ts": `export type DeliveryStatus = "sent" | "blocked" | "failed";\n`,
        "apps/admin-api/src/modules/notification/b.ts": `export type DeliveryStatus = "sent" | "blocked" | "skipped";\n`,
      },
    }),
    { code: 1, contains: ["发现 1 处", "（DeliveryStatus）缺：值集合不一致"], absent: ["枚举消费清单一致"] },
  );

  // ⑤b 修掉的假绿：`((?:…)+)` 里的捕获组只保留最后一次迭代，旧实现只比较**尾成员**
  //     （"a" | "x" 与 "b" | "x" 被当成「集合相同」⇒ 绿）
  subprocess(
    "⑤b 【反证·只比尾成员】两个联合类型尾成员相同、其余不同 → 红",
    enumTree({
      extra: {
        "apps/admin-api/src/modules/notification/c.ts": `export type DeliveryStatus = "a" | "x";\n`,
        "apps/admin-api/src/modules/notification/d.ts": `export type DeliveryStatus = "b" | "x";\n`,
      },
    }),
    { code: 1, contains: ["（DeliveryStatus）缺：值集合不一致", "[a,x]", "[b,x]"], absent: ["枚举消费清单一致"] },
  );

  subprocess(
    "⑤ 同名声明值集合一致 → 绿（重复本身不是缺陷）",
    enumTree({
      extra: {
        "apps/admin-api/src/modules/notification/a.ts": `export type DeliveryStatus = "sent" | "blocked";\n`,
        "apps/admin-api/src/modules/notification/b.ts": `export type DeliveryStatus ='blocked' | 'sent';\n`,
      },
    }),
    { code: 0, contains: ["枚举消费清单一致"], absent: ["发现"] },
  );

  // ⑥ 事实源被清空：定义文件还在、enum 没了 → 结构红（不是「零命中」）
  subprocess(
    "⑥ 事实源被清空（定义文件里 enum 不见了）→ 结构红，不许零命中全绿",
    enumTree({ serv: `export const ALERT_CHANNEL_LEGACY = true;\n` }),
    { code: 1, contains: ["结构错误", "找不到 enum AlertChannel", "登记表过期还是写法变了"], absent: ["枚举消费清单一致"] },
  );

  // ⑦ 解析失败：成员写成非字面量 → 提取器失效必须红（旧实现抛栈，文本不可断言）
  subprocess(
    "⑦ 解析失败（enum 成员不是字符串字面量，只提取到 0 个值）→ 结构红",
    enumTree({ serv: `export enum AlertChannel {\n  Email = make("email"),\n  Slack = make("slack"),\n}\n` }),
    { code: 1, contains: ["结构错误", "只提取到 0 个字符串值", "提取器失效"], absent: ["枚举消费清单一致"] },
  );

  subprocess(
    "⑧ 扫描面下界：全树只有 1 个数组字面量 → 结构红",
    enumTree({ arrays: `export const only = [1];\n` }),
    { code: 1, contains: ["结构错误", `下界 ${MIN_ARRAY_LITERALS}`, "数组字面量"], absent: ["枚举消费清单一致"] },
  );

  subprocess(
    "⑨ 目录改名（apps/admin-api/src 整个不见了）→ 结构红，不是崩栈也不是绿",
    enumTree({ empty: true }),
    { code: 1, contains: ["结构错误", `扫描根 ${SRC_REL} 不存在`], absent: ["枚举消费清单一致", "Error:"] },
  );

  cases.push({
    name: "⑩ 【反证·零命中全绿】登记表被清空（ENUMS = []）→ 结构红",
    fn: () => {
      const repo = makeFixtureRepo(enumTree(), { prefix: "enum-consumers-selftest-" });
      try {
        const r = check({ root: repo.dir, enums: [] });
        const joined = r.errors.join("\n");
        if (!joined.includes("登记的枚举表是空的")) {
          throw new Error(`预期「登记表为空」结构错误，实际 errors=${JSON.stringify(r.errors)}`);
        }
      } finally {
        repo.cleanup();
      }
    },
  });

  const failed = reportCases(cases, { title: "check-enum-consumers selftest" });
  if (failed > 0) process.exit(1);
}

// ── CLI ────────────────────────────────────────────────────────────────────
const isMain =
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (isMain) {
  if (process.argv.includes("--selftest")) {
    selftest();
  } else {
    const root = resolve(argValue(process.argv, "--root") ?? process.cwd());
    const report = process.argv.includes("--report");
    const { errors, problems, stats } = check({ root });

    if (errors.length > 0) {
      console.error("");
      console.error("✖ 枚举消费守卫结构错误（分母不可信；--report 也不放行）：");
      for (const e of errors) console.error("  · " + e);
      console.error("");
      process.exit(1);
    }

    if (problems.length === 0) {
      console.log(
        "✔ 枚举消费清单一致：登记枚举的每个数组字面量要么是全集，要么占比 <2（不视为清单）；" +
          `同名声明值集合一致（${stats.declarations} 处声明 / ${stats.arrayLiterals} 个数组字面量）。`,
      );
      process.exit(0);
    }

    console.error("");
    console.error(`✖ 发现 ${problems.length} 处「枚举了某个枚举但抄漏了值」：`);
    for (const p of problems) {
      console.error(`  · ${p.file}:${p.line}  （${p.name}）缺：${p.missing.join(", ") || "（扫描器失效）"}`);
    }
    console.error("");
    console.error("修法：让该清单直接引用枚举值（`Object.values(AlertChannel)`），不要手抄。");
    console.error("      若这个数组**确实**不该含全部值（例如它就是「除 X 以外」的黑名单），请改写成本文件的 ALLOWLIST 并写明理由。");
    console.error("");
    process.exit(report ? 0 : 1);
  }
}

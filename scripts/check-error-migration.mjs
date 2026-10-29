#!/usr/bin/env node
/**
 * LANG-ERR-01 回退守卫：admin-api 生产代码不得再出现裸内置异常 throw。
 *
 * 为什么需要：throw new BadRequestException("中文…") 照样返回 400，只是响应体
 * 少了 errorCode 字段，前端只能回落服务端中文兜底文案 —— 英文用户于是看到
 * 「英文外壳 + 中文报错」，正是「用户配了哪个语言就展示哪个语言」要消灭的形态。
 * 这类回退不报错、不红测试、只会在跨语言组合处显形，故必须由守卫拦。
 *
 * 既有 check-error-i18n.mjs 拦不到它：那道闸验「码表 ↔ 前端词条 ↔ 生成物」三者
 * 一致，不扫描调用点。
 *
 * 判据：扫 apps/admin-api/src 生产代码（排除 spec/.test/.d.ts 与产物目录），
 * 去掉注释与字符串后匹配 `throw new <XxxException>(`；AppError 是唯一允许形态
 * （构造后挂回内置原型，instanceof 仍成立）。目标态恒为 0，不留基线余量。
 *
 * ## T4（第 4 轮守卫自检审计）修掉的假绿
 *
 *   · **`--report` 吞结构错**：旧实现在 `scanReal()` 里 `process.exit(1)` ——
 *     看起来没问题，但结构判据（扫不到文件）与业务判据（真违规）挤在同一个
 *     出口，`--report` 又只负责「打印」；一旦有人把 `--report` 接成「只报告」
 *     的 script，结构错就只剩一行 stderr。现在 `check()` 分两栏返回
 *     `{structure, violations}`，CLI **先判结构**（任何模式都 exit 1）。
 *   · **读不到的目录被静默吞掉**：`walk()` 的 `catch { return out; }` 让 EACCES /
 *     挂载失败 / 符号链接环变成「这个目录里的文件不存在」——扫描面少了几十个
 *     文件也照样报「裸 throw = 0」。现在读不到的子目录进 `structure`。
 *   · **扫描面只有「0 个文件」一个下界**：目录改名成 507 → 5 个文件时，
 *     「5 个文件 0 处违规」是永真断言。现在有 MIN_PROD_FILES 下界（结构红）。
 *   · **陈旧豁免**：ALLOWLIST 里的路径若已不存在，那条豁免永远不该再被信任
 *     （同 check-guards-wired 的 `must-exist` 规则），进 `structure`。
 *   · `--root` + 导出 `check()`：模块级 `process.cwd()` 收成参数，`import` 时
 *     不实扫、不 `process.exit`。
 *   · `--selftest`：从「函数级 + 手搓 ok 布尔」改为**跑真脚本的子进程**，逐条断言
 *     退出码 + 关键文本 + 行号（旧版把 `process.exit(1)` 删掉照样全绿；两条用例
 *     还共用同一个 `vCm`，等于一条）。
 *
 * 已知边界（文本判据，如实写出）：`throw` 后不经 `new`、或 `new` 的类名不以
 * `Exception` 结尾（含 `import { X as Y }` 别名）都不在判据内——本闸拦的是
 * 「新增调用点又用了内置异常」，不是「所有异常都规范化」。
 *
 * 用法：`node scripts/check-error-migration.mjs [--selftest|--report] [--root <dir>]`
 *   --report：把命中逐条打印（**不改变退出码**；结构错永远 exit 1）。
 *   --root  ：把该目录当仓库根（默认 process.cwd()）；selftest 专用。
 *
 * 退出码：0=通过；1=违规或结构性失败。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";

export const SRC_REL = "apps/admin-api/src";

/**
 * 扫描面下界（2026-10-29 实测 507 个生产 .ts）。
 * 「5 个文件 0 处违规」是永真断言，所以塌到下界以下判**结构红**，不是判绿。
 */
export const MIN_PROD_FILES = 200;

export const ALLOWLIST = new Set([]);
export const SKIP_DIR_NAMES = new Set(["__tests__", "node_modules", "dist", "generated"]);

const BT = String.fromCharCode(96);
const DQ = String.fromCharCode(34);
const SQ = String.fromCharCode(39);
const BS = String.fromCharCode(92);
const NL = String.fromCharCode(10);

export function isProdTs(name) {
  if (!name.endsWith(".ts")) return false;
  if (name.endsWith(".spec.ts") || name.endsWith(".test.ts") || name.endsWith(".d.ts")) return false;
  return true;
}

/**
 * 把注释与字符串字面量抹成空格（保留换行，行号不漂）。
 *
 * 为什么不用正则剥注释：本仓字符串里有大量 URL，其中的双斜杠会被当成注释起点，
 * 把后面真正的代码整段吃掉（假绿）。故用状态机区分代码/行注释/块注释/三种引号。
 * 已知取舍：模板串的插值不当作代码，整串视作字面量（selftest 钉住）。
 */
export function stripNonCode(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  let state = "code";
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (state === "code") {
      if (c === "/" && c2 === "/") {
        state = "line";
        out.push(" ", " ");
        i += 2;
        continue;
      }
      if (c === "/" && c2 === "*") {
        state = "block";
        out.push(" ", " ");
        i += 2;
        continue;
      }
      if (c === SQ) {
        state = "sq";
        out.push(" ");
        i += 1;
        continue;
      }
      if (c === DQ) {
        state = "dq";
        out.push(" ");
        i += 1;
        continue;
      }
      if (c === BT) {
        state = "tpl";
        out.push(" ");
        i += 1;
        continue;
      }
      out.push(c);
      i += 1;
      continue;
    }
    if (state === "line") {
      if (c === NL) {
        state = "code";
        out.push(NL);
      } else {
        out.push(" ");
      }
      i += 1;
      continue;
    }
    if (state === "block") {
      if (c === "*" && c2 === "/") {
        state = "code";
        out.push(" ", " ");
        i += 2;
        continue;
      }
      out.push(c === NL ? NL : " ");
      i += 1;
      continue;
    }
    if (c === BS) {
      out.push(" ", " ");
      i += 2;
      continue;
    }
    const closer = state === "sq" ? SQ : state === "dq" ? DQ : BT;
    if (c === closer) {
      state = "code";
      out.push(" ");
      i += 1;
      continue;
    }
    out.push(c === NL ? NL : " ");
    i += 1;
  }
  return out.join("");
}

const THROW_RE = /\bthrow\s+new\s+([A-Za-z_$][\w$]*)\s*\(/g;

/**
 * 找出源文本里的裸内置异常 throw。
 *
 * @param {string} src 源文本
 * @returns {{line: number, cls: string}[]}
 */
export function findViolations(src) {
  const stripped = stripNonCode(src);
  const lineStarts = [0];
  for (let i = 0; i < stripped.length; i += 1) if (stripped[i] === NL) lineStarts.push(i + 1);
  const lineOf = (idx) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= idx) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const hits = [];
  THROW_RE.lastIndex = 0;
  let m;
  while ((m = THROW_RE.exec(stripped)) !== null) {
    const cls = m[1];
    if (!cls.endsWith("Exception")) continue;
    if (cls === "AppError") continue;
    hits.push({ line: lineOf(m.index), cls });
  }
  return hits;
}

/** 递归收集生产 .ts；读不到的子目录记进 `unreadable`（不许静默吞）。 */
export function walk(dir, out = [], unreadable = [], root = dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    unreadable.push({
      path: dir,
      rel: relative(root, dir).split(sep).join("/"),
      code: error?.code ?? "EUNKNOWN",
    });
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIR_NAMES.has(e.name)) continue;
      walk(join(dir, e.name), out, unreadable, root);
    } else if (isProdTs(e.name)) {
      out.push(join(dir, e.name));
    }
  }
  return out;
}

/**
 * 全量判据。
 *
 * @param {string} [root] 仓库根
 * @param {{allowlist?: Set<string>, minFiles?: number}} [options]
 * @returns {{structure: string[], violations: {file: string, line: number, cls: string}[],
 *            files: number}}
 *   `structure` = **判据本身不可信**（扫描根不在、目录读不到、扫描面塌方、陈旧豁免）；
 *   `violations` = 真的写了裸 throw。两者修法完全不同，必须分栏。
 */
export function check(root = process.cwd(), options = {}) {
  const { allowlist = ALLOWLIST, minFiles = MIN_PROD_FILES } = options;
  const structure = [];
  const violations = [];

  const srcAbs = join(root, SRC_REL);
  if (!existsSync(srcAbs)) {
    structure.push(
      `扫描根不存在：${SRC_REL} —— 目录改名/在子目录跑都会这样，不是「0 处违规」。`,
    );
    return { structure, violations, files: 0 };
  }

  const unreadable = [];
  const files = walk(srcAbs, [], unreadable);
  if (unreadable.length > 0) {
    structure.push(
      `${unreadable.length} 个子目录读不到（旧实现在 catch 里静默 return）—— 它们里的违规看不见：` +
        unreadable.map((u) => `${u.rel}（${u.code}）`).join("、"),
    );
  }

  const relFiles = files.map((f) => relative(root, f).split(sep).join("/"));
  for (const f of files) {
    const rel = relative(root, f).split(sep).join("/");
    if (allowlist.has(rel)) continue;
    for (const v of findViolations(readFileSync(f, "utf8"))) {
      violations.push({ file: rel, line: v.line, cls: v.cls });
    }
  }

  for (const rel of allowlist) {
    if (!relFiles.includes(rel)) {
      structure.push(`陈旧豁免：${rel} —— 目录里已没有这个文件，豁免必须回收（同 check-guards-wired）。`);
    }
  }

  if (files.length < minFiles) {
    structure.push(
      `只扫到 ${files.length} 个生产文件（下界 ${minFiles}）—— 扫描面塌方/过滤器写宽了，` +
        "「这么多文件里 0 处违规」是永真断言，不能当绿。",
    );
  }

  return { structure, violations, files: files.length };
}

// ── 自检（T4：真子进程 + 退出码 + 关键文本 + <1s）────────────────────────────
const SELF = fileURLToPath(import.meta.url);

function argValue(argv, flag) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const at = argv.indexOf(flag);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1];
  return null;
}

/** 205 个无语义生产文件，把扫描面顶到 MIN_PROD_FILES=200 之上。 */
const FILLER_COUNT = 205;
const CASE_REL = `${SRC_REL}/modules/case/bad-case.ts`;

const fillerFiles = (n = FILLER_COUNT) => {
  const out = {};
  for (let i = 0; i < n; i += 1) {
    out[`${SRC_REL}/modules/filler/f${String(i).padStart(3, "0")}.ts`] =
      `export const value${i} = ${i};\n`;
  }
  return out;
};

/**
 * 造一棵 fixture 树：205 个 filler + 若干 case 文件（相对路径 → 内容）。
 * `total` 会随 case 文件数变化，用例断言里按实际数写。
 */
const tree = (caseFiles = {}) => ({ ...fillerFiles(), ...caseFiles });

const GOOD_CASE = [
  "export function f() {",
  '  throw new AppError("VALIDATION_FAILED");',
  "}",
].join(NL);

const fileCount = (caseFiles) => FILLER_COUNT + Object.keys(caseFiles).length;

/**
 * 自检：10 条子进程用例。
 *
 * 每条都断言退出码 + 关键文本（行号一律钉死）：本脚本的历史事故形态在 CLI 层
 * （`process.exit` 是否真的执行、`--report` 是否把结构错变成「只是打印」）与
 * 判据边界层（注释、字符串、URL 里的双斜杠），旧版 selftest 对这两层都盲。
 */
export function selftest() {
  const cases = [];
  const subprocess = (name, files, args, expect) => {
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(files, { prefix: "err-migration-selftest-" });
        try {
          expectExit(runGuard(SELF, { args: ["--root", repo.dir, ...args] }), {
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

  subprocess(
    "① 干净树：206 个生产文件、只有 AppError → 绿",
    tree({ [CASE_REL]: GOOD_CASE }),
    [],
    {
      code: 0,
      contains: ["裸内置异常 throw = 0", `${fileCount({ [CASE_REL]: GOOD_CASE })} 个生产文件`],
      absent: ["✖", "回退：", "结构错误"],
    },
  );

  subprocess(
    "② 裸 BadRequestException → 红（file:line 逐条点名）",
    tree({
      [CASE_REL]: [
        "export function f() {",
        '  throw new BadRequestException("参数有误");',
        "}",
      ].join(NL),
    }),
    [],
    {
      code: 1,
      contains: [
        `${CASE_REL}:2  throw new BadRequestException(`,
        "回退：1 处裸内置异常 throw",
        `扫了 ${fileCount({ [CASE_REL]: 1 })} 个生产文件`,
        "AppError",
      ],
      absent: ["throw = 0"],
    },
  );

  subprocess(
    "③ 【反证·注释算数】行注释与块注释里的 throw → 绿",
    tree({
      [CASE_REL]: [
        "// throw new BadRequestException('注释里的不算')",
        "/*",
        " throw new ForbiddenException('块注释也不算')",
        "*/",
        "export const ok = 1;",
      ].join(NL),
    }),
    [],
    { code: 0, contains: ["throw = 0"], absent: ["回退："] },
  );

  subprocess(
    "④ 【反证·字符串算数】字符串里的 throw new … → 绿",
    tree({
      [CASE_REL]: [
        "export const msg = 'throw new NotFoundException(1)';",
        'export const doc = "throw new ConflictException(2)";',
      ].join(NL),
    }),
    [],
    { code: 0, contains: ["throw = 0"], absent: ["回退："] },
  );

  subprocess(
    "⑤ 【反证·URL 双斜杠】字符串里的 `//` 不得吃掉后文 → 仍命中第 4 行",
    tree({
      [CASE_REL]: [
        "// throw new ConflictException('c')",
        "const u = 'https://a//b';",
        "export function g() {",
        "  throw new InternalServerErrorException('x');",
        "}",
      ].join(NL),
    }),
    [],
    {
      code: 1,
      contains: [`${CASE_REL}:4  throw new InternalServerErrorException(`],
      absent: ["throw = 0"],
    },
  );

  subprocess(
    "⑥ spec / test / d.ts 不进生产扫描面 → 绿（且总数不多算）",
    tree({
      [`${SRC_REL}/modules/case/bad-case.spec.ts`]: [
        "it('x', () => {",
        '  throw new BadRequestException("测试里允许");',
        "});",
      ].join(NL),
      [`${SRC_REL}/modules/case/types.d.ts`]: 'declare const x: "throw new XException(";\n',
      [CASE_REL]: GOOD_CASE,
    }),
    [],
    {
      code: 0,
      contains: ["throw = 0", `${fileCount({ [CASE_REL]: GOOD_CASE })} 个生产文件`],
      absent: ["回退："],
    },
  );

  subprocess(
    "⑦ 事实源缺失（apps/admin-api/src 整棵不在）→ 结构红，不是崩栈也不是绿",
    { "package.json": { name: "empty", private: true } },
    [],
    {
      code: 1,
      contains: ["结构错误", `扫描根不存在：${SRC_REL}`],
      absent: ["throw = 0", "Error:", "ENOENT"],
    },
  );

  subprocess(
    "⑧ 【反证·扫描面】只剩 5 个生产文件 → 结构红（不是「0 处违规」）",
    {
      [`${SRC_REL}/modules/filler/a.ts`]: "export const a = 1;\n",
      [`${SRC_REL}/modules/filler/b.ts`]: "export const b = 1;\n",
      [`${SRC_REL}/modules/filler/c.ts`]: "export const c = 1;\n",
      [`${SRC_REL}/modules/filler/d.ts`]: "export const d = 1;\n",
      [`${SRC_REL}/modules/filler/e.ts`]: "export const e = 1;\n",
    },
    [],
    {
      code: 1,
      contains: ["结构错误", "只扫到 5 个生产文件", `下界 ${MIN_PROD_FILES}`],
      absent: ["throw = 0"],
    },
  );

  subprocess(
    "⑨ 【反证·--report 吞结构错】空树 + --report → 仍结构红（不是「只打印」）",
    { "package.json": { name: "empty", private: true } },
    ["--report"],
    {
      code: 1,
      contains: ["结构错误", `扫描根不存在：${SRC_REL}`],
      absent: ["throw = 0"],
    },
  );

  subprocess(
    "⑩ --report 不放行真违规：仍逐条打印并 exit 1",
    tree({
      [CASE_REL]: ["export function f() {", '  throw new BadRequestException("x");', "}"].join(NL),
    }),
    ["--report"],
    {
      code: 1,
      contains: ["--report", `${CASE_REL}:2  throw new BadRequestException(`, "回退：1 处"],
      absent: ["throw = 0"],
    },
  );

  const failed = reportCases(cases, { title: "check-error-migration selftest" });
  if (failed > 0) process.exit(1);
}

// ── CLI ────────────────────────────────────────────────────────────────────
const invoked = process.argv[1]?.replace(/\\/g, "/").split("/").pop();

if (invoked === "check-error-migration.mjs") {
  const argv = process.argv.slice(2);
  if (argv.includes("--selftest")) {
    selftest();
  } else {
    const root = resolve(argValue(argv, "--root") ?? process.cwd());
    const report = argv.includes("--report");
    const { structure, violations, files } = check(root);

    // 结构错**先判**、任何模式都 exit 1：`--report` 只是多打印，不是「只报告」。
    if (structure.length > 0) {
      console.error("");
      console.error("✖ LANG-ERR-01 守卫结构错误（判据本身不可信，先修扫描面）：");
      for (const e of structure) console.error("  · " + e);
      console.error("");
      process.exit(1);
    }

    if (violations.length > 0) {
      if (report) console.log(`（--report：逐条打印，不改判定；共 ${violations.length} 处）`);
      for (const v of violations) {
        console.log("  " + v.file + ":" + v.line + "  throw new " + v.cls + "(");
      }
      console.error(
        `✖ LANG-ERR-01 回退：${violations.length} 处裸内置异常 throw（扫了 ${files} 个生产文件）。`,
      );
      console.error("  裸 throw 的响应体没有 errorCode，前端只能渲染服务端中文兜底文案。");
      console.error(
        "  修法：在 apps/admin-api/src/common/errors/catalog/<域>.ts 加码，改用 new AppError(<CODE>, params)。",
      );
      process.exit(1);
    }

    console.log(
      `✔ LANG-ERR-01 回退守卫通过：${files} 个生产文件中裸内置异常 throw = 0（目标态，不留基线）。`,
    );
  }
}

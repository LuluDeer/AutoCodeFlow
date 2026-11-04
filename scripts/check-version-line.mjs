#!/usr/bin/env node
/**
 * 「包必须在发布线上」守卫 —— 治「**不在发布线的包谁也不管**」这一**类**。
 *
 * ## 由来（不是假想的风险，是本仓的实测事实）
 *
 * `version.txt` 是平台主线，当前 = **2.1.0**（2026-11-04 实测，1 行文件）。
 * `packages/` 下 11 个包目录里有 **4 个 Python 包**（`autocodeflow-{ai,db,http,notify}`）
 * 的 `pyproject.toml` 版本停在 **0.3.2** —— 一条**独立的 semver 线**，落后主线 5 个
 * minor；`git tag --list` 里 `autocodeflow-{ai,db,http,notify}-v0.3.2` 四个 tag
 * **真实存在**（2026-10-26），说明它们**曾经**发布过、之后就再没人管过。
 *
 * 这已经不是「某个包忘了 bump 版本」的个案，而是一个**结构缺口**：
 *
 *   判据族里所有「版本一致性」的闸（release.yml 的 version-guard、release-please
 *   的 manifest、`check:release-config`）**只认识发布线上的包**。一个包一旦**不在**
 *   那条线上，它就同时从**所有**版本判据里消失了 —— 不是被豁免，是**没人见过它**。
 *   「文件存在 ≠ 在链路里」的最后一格：连「在不在链路里」本身都没有判据。
 *
 * 所以本守卫的立场是：**「不在主线上」可以是合法状态，但必须是登记过、有人负责、
 * 有复核期限的状态**。不许用「安静」实现豁免。
 *
 * ## 判据
 *
 *   ① 扫描面：`packages/*` 下的包目录（跳过 `.` 开头）与根 `version.txt` 都读得到，
 *      且包目录数 ≥ `MIN_PACKAGES`（8，2026-11-04 实测 11）。**不足即结构红**：
 *      「0 个包 = 全部合规」是把「查不出」当「没有病」。
 *   ② 每个包声明版本的方式（`package.json` 的 `version` / `pyproject.toml` 的
 *      `version = "…"`）：
 *        · 一个都没声明 → `undeclared`（只报告，不判红：`executor-protocol` /
 *          `contract-fixtures` 是数据包，本来就没有版本；它们的「有没有人用」由
 *          `check-package-adoption.mjs` 管）；
 *        · 声明了多个且**互不相等** → 结构红（同一个包两份版本号，先修清单）；
 *        · 只有一个值 V：
 *            - V == 主线 → 合规（`mainline`）；
 *            - 否则必须进 `scripts/version-lines.json` 登记：
 *              `{ owner, review_by, disposition }`，三字段缺一即红；
 *              `review_by` 必须是可解析的 `YYYY-MM-DD` 且 **≥ 今天**，过期即红；
 *              未登记即红（点名包名 + 实际版本 + 主线版本）。
 *   ③ 反向（防登记表腐烂）：登记表里的包目录**已不存在** ⇒ 红；登记表里的包
 *      **已回到主线** ⇒ 红（登记该删了 —— 否则「豁免名单」会只增不减）。
 *
 * ## 为什么过期要红而不是 warn
 *
 * 「review_by 过期」的意思是：**当初答应复核这件事的人，没有复核**。这不是格式问题，
 * 是「这个豁免现在没有任何人在看」的直接证据。把它降成 warn，等于让时间自动把豁免
 * 变成永久豁免 —— 那正是本守卫存在要防的事。
 *
 * ## 为什么不用「读不到就当合规」
 *
 * `check-publishable-wiring.mjs` 已经踩过一次（`package.json` 解析失败被吞成
 * `publishable: false` ⇒ 那个包从判据里**消失**）。这里同款位置（清单解析失败、
 * 登记表解析失败、`version.txt` 读不到）一律**结构红**，并点名是哪个包。
 *
 * ## 用法
 *
 *   node scripts/check-version-line.mjs [--report] [--selftest] [--root <dir>]
 *   --report  ：打印每个包的版本与归属（随后仍按判据退出，红灯不会被报告吞掉）
 *   --selftest：在临时 fixture 树里跑**真子进程**，断言退出码 + 关键文本
 *   --root    ：只给 selftest 用（把 fixture 树当仓库根；默认 `process.cwd()`）
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";
import {
  compareEntry,
  parseDay,
  renderExpired,
  renderOverLimit,
  readRatchetBaseline,
  sweepBaseline,
  utcDay,
} from "./lib/ratchet-baseline.mjs";

/** 平台主线版本文件（仓库根，单行）。 */
export const MAINLINE_REL = "version.txt";
/** 被扫描的包目录。**只到 `packages/`** —— `apps/` 是部署单元，版本由 release.yml 管。 */
export const PKGS_REL = "packages";
/** 离线登记表。 */
export const REGISTRY_REL = "scripts/version-lines.json";

/** 扫描面下界（2026-11-04 实测 11 个包目录）。只许增，防「分母塌了」。 */
export const MIN_PACKAGES = 8;

/** 登记条目必填字段。缺一即红 —— 一条缺 owner 的登记等于没人负责。 */
export const REQUIRED_FIELDS = ["owner", "review_by", "disposition"];

/** 版本号形状（宽松：接受 `0.3.2`、`2.1.0-rc.1`；只用来区分「明显不是版本」的垃圾值）。 */
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function readText(abs) {
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

/**
 * 读主线版本。
 *
 * @returns {{version: string|null, error: string|null}}
 */
export function readMainline(root) {
  const raw = readText(join(root, MAINLINE_REL));
  if (raw === null) {
    return {
      version: null,
      error: `读不到 ${MAINLINE_REL} —— 主线版本无从判定（路径改名了？），这不是「所有包都合规」。`,
    };
  }
  const version = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  if (!VERSION_RE.test(version)) {
    return {
      version: null,
      error: `${MAINLINE_REL} 的内容不是合法版本号：${JSON.stringify(version)} —— 主线本身坏了，判定无意义。`,
    };
  }
  return { version, error: null };
}

/**
 * 读一个包声明的版本（可能 0、1 或多个来源）。
 *
 * `pyproject.toml` 只看 `^version = "…"` 形式的**字面量**写法；`dynamic = ["version"]`
 * 的包（版本由构建后端算）按「未声明」处理并在 `note` 里说明 —— 猜版本比不判更糟。
 *
 * @param {string} pkgDir 包目录绝对路径
 * @param {string} name 包目录名（报错点名用）
 * @returns {{declared: Array<{source: string, version: string}>, errors: string[], notes: string[]}}
 */
export function readDeclaredVersions(pkgDir, name) {
  const declared = [];
  const errors = [];
  const notes = [];

  const pkgJson = join(pkgDir, "package.json");
  if (existsSync(pkgJson)) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(pkgJson, "utf8"));
    } catch (error) {
      errors.push(
        `packages/${name}/package.json 不可解析（${String(error.message).split("\n")[0]}）—— 版本状态无法判定，按结构红处理。`,
      );
      parsed = null;
    }
    if (parsed) {
      if (typeof parsed.version === "string" && parsed.version.trim() !== "") {
        declared.push({ source: "package.json", version: parsed.version.trim() });
      } else if (parsed.private === true) {
        notes.push(`packages/${name}：package.json 是 private 且没有 version（视为未声明）。`);
      }
    }
  }

  const pyproject = join(pkgDir, "pyproject.toml");
  if (existsSync(pyproject)) {
    const raw = readText(pyproject) ?? "";
    const match = /^[ \t]*version[ \t]*=[ \t]*["']([^"']+)["']/m.exec(raw);
    if (match) {
      declared.push({ source: "pyproject.toml", version: match[1].trim() });
    } else if (/^[ \t]*dynamic[ \t]*=[ \t]*\[[^\]]*["']version["']/m.test(raw)) {
      notes.push(`packages/${name}：pyproject.toml 声明 dynamic=["version"]，版本由构建后端推导（未声明）。`);
    }
  }

  return { declared, errors, notes };
}

/**
 * 读登记表。
 *
 * @returns {{entries: Record<string, object>|null, error: string|null}}
 */
export function readRegistry(root) {
  // 读文件 / JSON 不可解析 / 形状非法 / 条目数越界 —— 四种「判据不可信」都由共用件判。
  const { map, error } = readRatchetBaseline({
    root,
    rel: REGISTRY_REL,
    kind: "map",
    label: "登记表",
  });
  return { entries: map, error };
}

export { parseDay };

const todayDay = () => utcDay();

/**
 * 判据本体。
 *
 * @param {{root?: string, today?: number}} [options]
 * @returns {{errors: string[], problems: string[], warnings: string[], rows: object[], counts: object}}
 */
export function check({ root = process.cwd(), today = todayDay() } = {}) {
  const errors = [];
  const problems = [];
  const warnings = [];
  const rows = [];
  const counts = {
    packages: 0,
    declared: 0,
    onMainline: 0,
    registered: 0,
    undeclared: 0,
    registryEntries: 0,
    root,
  };

  const mainline = readMainline(root);
  if (mainline.error) {
    errors.push(mainline.error);
    return { errors, problems, warnings, rows, counts };
  }

  let dirents;
  try {
    dirents = readdirSync(join(root, PKGS_REL), { withFileTypes: true });
  } catch (error) {
    errors.push(
      `读不到目录 ${PKGS_REL}/（${error.code ?? error.message}）—— 扫描面为 0，不是「所有包都在主线上」。`,
    );
    return { errors, problems, warnings, rows, counts };
  }
  const all = dirents
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => d.name)
    .sort();
  counts.packages = all.length;
  if (all.length < MIN_PACKAGES) {
    errors.push(
      `只扫到 ${all.length} 个包目录（下界 ${MIN_PACKAGES}）—— 扫描器/路径失效了，不是包变少了。` +
        `分母塌了的时候「全部合规」是个假象。`,
    );
    return { errors, problems, warnings, rows, counts };
  }

  const registry = readRegistry(root);
  if (registry.error) {
    errors.push(registry.error);
    return { errors, problems, warnings, rows, counts };
  }
  const entries = registry.entries;
  counts.registryEntries = Object.keys(entries).length;
  const seen = new Set();

  for (const name of all) {
    const { declared, errors: declErrors, notes } = readDeclaredVersions(
      join(root, PKGS_REL, name),
      name,
    );
    for (const e of declErrors) errors.push(e);
    for (const n of notes) warnings.push(n);
    if (declErrors.length > 0) continue;

    if (declared.length === 0) {
      counts.undeclared += 1;
      rows.push({ name, status: "undeclared", versions: [], registered: null });
      continue;
    }

    counts.declared += 1;
    const distinct = [...new Set(declared.map((d) => d.version))];
    if (distinct.length > 1) {
      errors.push(
        `packages/${name} 声明了**互不相等**的版本：` +
          declared.map((d) => `${d.source}=${d.version}`).join("、") +
          " —— 两份清单各说一套，先修清单（否则「在不在主线上」没有唯一答案）。",
      );
      continue;
    }
    const version = distinct[0];

    if (version === mainline.version) {
      counts.onMainline += 1;
      rows.push({ name, status: "mainline", versions: declared, registered: null });
      seen.add(name);
      continue;
    }

    const entry = entries[name];
    if (!entry) {
      rows.push({ name, status: "off-line-unregistered", version, versions: declared });
      problems.push(
        renderOverLimit({
          key: `packages/${name}`,
          rel: REGISTRY_REL,
          detail:
            `的版本 ${version} 不在平台主线（version.txt = ${mainline.version}）上，且没有登记进 ${REGISTRY_REL}。\n` +
            `      不在发布线上的包会同时从**所有**版本判据里消失（release.yml 的 version-guard、` +
            `release-please 的 manifest、check:release-config 都不认识它）。`,
          fix:
            `修法：要么把版本对齐主线（${mainline.version}），要么在 ${REGISTRY_REL} 里加\n` +
            `        "${name}": { "owner": "<负责人>", "review_by": "<YYYY-MM-DD>", "disposition": "<为什么允许它独立>" }`,
        }),
      );
      continue;
    }

    // 已登记：字段 + 期限（判据在共用件里，这里只决定它算「结构」还是「漂移」）
    seen.add(name);
    counts.registered += 1;
    const shape = compareEntry({
      at: `packages/${name}`,
      noun: "登记条目",
      entry,
      rel: REGISTRY_REL,
      label: "登记表",
      requiredFields: REQUIRED_FIELDS,
      today,
    });
    if (shape.incomplete !== null) {
      rows.push({ name, status: "registry-incomplete", version, versions: declared, registered: entry });
      problems.push(shape.incomplete + `登记必须能回答「谁负责、什么时候复核、为什么允许独立」。`);
      continue;
    }
    if (shape.badDate !== null) {
      rows.push({ name, status: "registry-bad-date", version, versions: declared, registered: entry });
      problems.push(shape.badDate);
      continue;
    }
    if (shape.expired) {
      rows.push({ name, status: "registry-expired", version, versions: declared, registered: entry });
      problems.push(renderExpired({ at: `packages/${name}`, noun: "登记条目", entry, today }));
      continue;
    }

    rows.push({ name, status: "off-line-registered", version, versions: declared, registered: entry });
    warnings.push(
      `packages/${name} 在独立版本线 ${version} 上（主线 ${mainline.version}），已登记，` +
        `owner=${entry.owner}，复核期限 ${entry.review_by}。`,
    );
  }

  // ── 反向：登记表不许腐烂（已不存在 ⇒ 腐烂；已回到主线 ⇒ 该删条目了）────────
  const state = new Map();
  for (const name of Object.keys(entries)) {
    if (!all.includes(name)) state.set(name, "missing");
    else if (rows.find((r) => r.name === name)?.status === "mainline") state.set(name, "satisfied");
  }
  problems.push(
    ...sweepBaseline({
      list: Object.keys(entries).map((key) => ({ key })),
      state,
      rel: REGISTRY_REL,
      label: "登记表",
      detailOf: (key, status) =>
        status === "missing" ? `但 packages/${key}/ **已不存在**` : "但该包的版本已回到主线",
      fixOf: (_key, status) =>
        status === "missing"
          ? "删掉这条登记（豁免必须可证，指向空气的条目会让整张表失去意义）。"
          : `否则「离线登记」会只增不减，最终变成一张没人看的名单。`,
    }),
  );

  return { errors, problems, warnings, rows, counts };
}

// ── CLI ────────────────────────────────────────────────────────────────
const SELF = fileURLToPath(import.meta.url);

function argValue(argv, flag) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const at = argv.indexOf(flag);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1];
  return null;
}

const STATUS_LABEL = {
  mainline: "主线",
  undeclared: "未声明版本",
  "off-line-registered": "独立线（已登记）",
  "off-line-unregistered": "独立线（未登记）",
  "registry-incomplete": "登记不完整",
  "registry-bad-date": "日期非法",
  "registry-expired": "登记已过期",
};

function printReport({ rows, counts }, mainlineVersion) {
  console.log(`平台主线（${MAINLINE_REL}）= ${mainlineVersion}`);
  console.log(
    `包目录 ${counts.packages} 个：主线 ${counts.onMainline}、独立线已登记 ${counts.registered}、` +
      `未声明版本 ${counts.undeclared}（登记表 ${counts.registryEntries} 条）`,
  );
  for (const row of rows) {
    const versions = row.versions?.length
      ? row.versions.map((d) => `${d.source}=${d.version}`).join(",")
      : "-";
    console.log(
      `  · packages/${row.name.padEnd(22)} ${String(row.version ?? "-").padEnd(10)} ` +
        `${STATUS_LABEL[row.status] ?? row.status}  [${versions}]`,
    );
  }
}

function runCli(root, { report }) {
  const { errors, problems, warnings, rows, counts } = check({ root });
  const mainline = readMainline(root);

  if (report) printReport({ rows, counts }, mainline.version ?? "(读不到)");

  if (errors.length > 0) {
    console.error("");
    console.error("✖ 版本线自检结构错误（判据本身不可信）：");
    for (const e of errors) console.error("  · " + e);
    process.exit(1);
  }

  if (problems.length > 0) {
    console.error("");
    console.error(`✖ ${problems.length} 个包「不在发布线上」且没有合法的登记/登记已腐烂：`);
    for (const p of problems) console.error("  · " + p);
    console.error("");
    console.error(
      "  修法通则：① 把版本对齐 version.txt 里的主线版本；或 ② 在 scripts/version-lines.json 登记 " +
        "{ owner, review_by, disposition } 且 review_by 未过期。",
    );
    process.exit(1);
  }

  if (warnings.length > 0 && !report) {
    for (const w of warnings) console.log(`  ⚠ ${w}`);
  }
  console.log(
    `✔ 版本线自检通过：${counts.packages} 个包目录全部「在主线（${mainline.version}）上」或「已登记且未过期的独立线」` +
      `（主线 ${counts.onMainline}、已登记独立线 ${counts.registered}、未声明版本 ${counts.undeclared}）。`,
  );
}

// ── 自检（真子进程：退出码 + 关键文本）────────────────────────────────────
/** fixture 用的最小包目录集合（8 个，刚好过下界）。 */
const FIXTURE_PKGS = [
  "pkg-alpha",
  "pkg-beta",
  "pkg-gamma",
  "pkg-delta",
  "pkg-epsilon",
  "pkg-zeta",
  "pkg-eta",
  "pkg-theta",
];

/**
 * 造一棵 fixture 仓库树。
 *
 * @param {object} opts
 * @param {string} [opts.mainline] version.txt 内容
 * @param {Record<string,string|string[]>} [opts.versions] 包名 → 版本
 *        （string → package.json；string[] → [package.json, pyproject.toml]）
 * @param {Record<string,object>} [opts.entries] 登记表 entries
 * @param {string[]} [opts.extraPkgs] 追加的空包目录
 * @param {boolean} [opts.noRegistry] 不写登记表
 * @param {string} [opts.registryRaw] 用原文写登记表（造「解析不了」）
 */
function fixtureTree({
  mainline = "2.1.0\n",
  versions = {},
  entries = {},
  extraPkgs = [],
  noRegistry = false,
  registryRaw = null,
} = {}) {
  const files = { "version.txt": mainline };
  const pkgs = [...FIXTURE_PKGS, ...extraPkgs];
  for (const name of pkgs) {
    const v = versions[name];
    const list = v === undefined ? [] : Array.isArray(v) ? v : [v];
    const [pkgVersion, pyVersion] = list;
    files[`packages/${name}/package.json`] = {
      name,
      version: pkgVersion ?? mainline.trim(),
      ...(pkgVersion === undefined ? { private: true } : {}),
    };
    if (pyVersion !== undefined) {
      files[`packages/${name}/pyproject.toml`] = `[project]\nname = "${name}"\nversion = "${pyVersion}"\n`;
    }
  }
  if (registryRaw !== null) {
    files[REGISTRY_REL] = registryRaw;
  } else if (!noRegistry) {
    files[REGISTRY_REL] = { $comment: "fixture", entries };
  }
  return files;
}

function runSelftest() {
  const cases = [];
  const subprocess = (name, files, expect) => {
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(files, { prefix: "version-line-selftest-" });
        try {
          expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
            ...expect,
            withinMs: 1500,
            label: name,
          });
        } finally {
          repo.cleanup();
        }
      },
    });
  };

  // ① 正例：全部在主线 → 绿
  subprocess(
    "① 正例：8 个包全在主线 2.1.0 → 绿",
    fixtureTree({}),
    {
      code: 0,
      contains: ["版本线自检通过", "8 个包目录", "主线 8"],
      absent: ["不在平台主线", "结构错误", "登记已**过期**"],
    },
  );

  // ② 反例：离线且未登记 → 红，点名包名 / 实际版本 / 主线版本
  subprocess(
    "② 反例：包版本 0.3.2 不在主线且未登记 → 红（点名包/版本/主线）",
    fixtureTree({ versions: { "pkg-beta": "0.3.2" } }),
    {
      code: 1,
      contains: ["pkg-beta", "0.3.2", "2.1.0", "不在平台主线", "没有登记"],
      absent: ["版本线自检通过"],
    },
  );

  // ③ 反例的合法面：离线但登记合法（review_by 在未来）→ 绿
  subprocess(
    "③ 离线包已登记且 review_by 未过期 → 绿（登记不是关灯键，是有期限的豁免）",
    fixtureTree({
      versions: { "pkg-beta": "0.3.2" },
      entries: {
        "pkg-beta": { owner: "@someone", review_by: "2099-12-31", disposition: "独立线，留给 SDK 化" },
      },
    }),
    {
      code: 0,
      contains: ["版本线自检通过", "已登记独立线 1"],
      absent: ["不在发布线上"],
    },
  );

  // ④ 登记过期 → 红（这是「复核没人做」的证据，不许降级成 warn）
  subprocess(
    "④ 登记已过期（review_by 在过去）→ 红",
    fixtureTree({
      versions: { "pkg-beta": "0.3.2" },
      entries: {
        "pkg-beta": { owner: "@someone", review_by: "2000-01-01", disposition: "独立线" },
      },
    }),
    {
      code: 1,
      contains: ["pkg-beta", "过期", "2000-01-01", "复核"],
      absent: ["版本线自检通过"],
    },
  );

  // ⑤ 结构塌陷反永真：包目录太少 → 结构红
  subprocess(
    "⑤ 结构塌陷：只扫到 3 个包目录 → 结构红（分母塌了不是「全合规」）",
    (() => {
      const files = fixtureTree({});
      for (const name of FIXTURE_PKGS.slice(3)) delete files[`packages/${name}/package.json`];
      return files;
    })(),
    {
      code: 1,
      contains: ["结构错误", "只扫到 3 个包目录", "下界 8"],
      absent: ["版本线自检通过"],
    },
  );

  // ⑥ 登记表腐烂：登记了已不存在的包 → 红
  subprocess(
    "⑥ 登记表腐烂：登记了已不存在的包 → 红",
    fixtureTree({
      entries: {
        "pkg-deleted-long-ago": { owner: "@x", review_by: "2099-01-01", disposition: "早已删除" },
      },
    }),
    {
      code: 1,
      contains: ["pkg-deleted-long-ago", "已不存在", "登记表腐烂"],
      absent: ["版本线自检通过"],
    },
  );

  // ⑦ 陈旧登记：包已回到主线 → 红（登记该删）
  subprocess(
    "⑦ 陈旧登记：登记的包已回到主线 → 红（豁免该回收）",
    fixtureTree({
      entries: {
        "pkg-gamma": { owner: "@x", review_by: "2099-01-01", disposition: "已对齐主线" },
      },
    }),
    {
      code: 1,
      contains: ["pkg-gamma", "已回到主线", "该删条目了"],
      absent: ["版本线自检通过"],
    },
  );

  // ⑧ 清单坏了不许静默降级：package.json 解析失败 → 结构红
  subprocess(
    "⑧ package.json 不可解析 → 结构红（不许静默当成「没版本」）",
    {
      ...fixtureTree({}),
      "packages/pkg-delta/package.json": "{ 这不是 JSON",
    },
    {
      code: 1,
      contains: ["结构错误", "pkg-delta", "不可解析"],
      absent: ["版本线自检通过"],
    },
  );

  // ⑨ 登记条目缺字段 → 红
  subprocess(
    "⑨ 登记条目缺 owner → 红（缺负责人的登记等于没人负责）",
    fixtureTree({
      versions: { "pkg-beta": "0.3.2" },
      entries: { "pkg-beta": { review_by: "2099-01-01", disposition: "独立线" } },
    }),
    {
      code: 1,
      contains: ["pkg-beta", "登记条目不完整", "owner"],
      absent: ["版本线自检通过"],
    },
  );

  // ⑩ 同一个包两份清单互相打架 → 结构红
  subprocess(
    "⑩ package.json 与 pyproject.toml 版本不一致 → 结构红",
    fixtureTree({ versions: { "pkg-gamma": ["2.1.0", "0.3.2"] } }),
    {
      code: 1,
      contains: ["结构错误", "pkg-gamma", "互不相等"],
      absent: ["版本线自检通过"],
    },
  );

  // ⑪ 登记表不可解析 → 结构红（不是「没有离线包」）
  subprocess(
    "⑪ 登记表不可解析 → 结构红（读不到 ≠ 没问题）",
    fixtureTree({ registryRaw: "{ 坏掉的登记表" }),
    {
      code: 1,
      contains: ["结构错误", "不可解析"],
      absent: ["版本线自检通过"],
    },
  );

  // ⑫ 主线文件缺失 → 结构红
  subprocess(
    "⑫ 缺 version.txt → 结构红",
    (() => {
      const files = fixtureTree({});
      delete files["version.txt"];
      return files;
    })(),
    {
      code: 1,
      contains: ["结构错误", "读不到 version.txt"],
      absent: ["版本线自检通过"],
    },
  );

  // ⑬ --report 不吞红灯（报告模式 + 未登记 ⇒ 仍然 exit 1）
  {
    const name = "⑬ --report 打印全表但不吞红灯（未登记仍 exit 1）";
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(fixtureTree({ versions: { "pkg-beta": "0.3.2" } }), {
          prefix: "version-line-selftest-",
        });
        try {
          expectExit(runGuard(SELF, { args: ["--root", repo.dir, "--report"] }), {
            code: 1,
            contains: ["平台主线", "packages/pkg-beta", "不在平台主线"],
            withinMs: 1500,
            label: name,
          });
        } finally {
          repo.cleanup();
        }
      },
    });
  }

  const failed = reportCases(cases, { title: "check-version-line selftest" });
  if (failed > 0) process.exit(1);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  if (process.argv.includes("--selftest")) {
    runSelftest();
  } else {
    runCli(resolve(argValue(process.argv, "--root") ?? process.cwd()), {
      report: process.argv.includes("--report"),
    });
  }
}

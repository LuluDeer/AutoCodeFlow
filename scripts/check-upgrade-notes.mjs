#!/usr/bin/env node
/**
 * R06（2026-11-05）：**破坏性变更公告**判据 —— 升级段必须存在、必须可操作、必须与实现同源。
 *
 * ## 背景（为什么「文档」也需要判据）
 *
 * R05 把 admin 的执行器出站姿态按契约收口，产生一条**破坏性变更**：
 *   · 内网执行器必须显式 `EXECUTOR_ALLOW_PRIVATE_NETWORK=true`；
 *   · 同机 `127.0.0.1` 执行器**永远不可用**（契约：回环恒拒）。
 * 而 `docs/UPGRADING.md` 的 §9 当时还写着「破坏性变更 — **无**」⇒
 * 已存在的自托管部署升级后会**静默**失去全部派发能力。这条不是「写篇文档」，
 * 是**升级路径的正确性**：没有公告 = 破坏性变更没有交付完成。
 *
 * ## 判据（四条，全部机读）
 *
 *   ① **段落存在**：`docs/UPGRADING.md` 有「执行器出站姿态」升级段；
 *   ② **症状是实测的**：段里必须出现**真机实测过的那一行**（`failureReason=script_error`
 *      与 `已拒绝对外请求` 同现），不许写成「可能失败」这类模糊话；
 *   ③ **两条修法 + 回滚**：必须同时出现 `EXECUTOR_ALLOW_PRIVATE_NETWORK`、
 *      对 `127.0.0.1` 的「不可用」表述、以及 `git revert`；
 *   ④ **实现侧告警在**：`apps/admin-api/src/config/executor-posture.ts` 存在，
 *      且 `main.ts` 真的调用了 `executorPostureWarning(`（否则「启动期可操作告警」
 *      只活在文档里 ⇒ 又一条「写了没人跑」）。
 *
 * ## 自检（黑盒 CLI，有牙）
 *
 * `--selftest` 在临时目录里造 6 份 fixture（完整 / 缺段 / 症状模糊 / §9 矛盾 / 没接线 / 缺模块），
 * 每条都起**真子进程**跑本脚本 CLI（`runGuard(SELF, { args: [`--root=<夹具>`] })` + `expectExit`），
 * 断言退出码 0/1 与关键输出。正例控制组必须 exit 0，五条判据反例必须 exit 1 —— 把 `main()`
 * 的失败 `return 1` 与 `--root=` 解析纳入覆盖面，堵住「判据算对了但退出码恒 0、CI 假绿」的缺口。
 *
 * 用法：`node scripts/check-upgrade-notes.mjs [--selftest] [--root=<dir>]`
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expectExit, reportCases, runGuard } from "./lib/guard-selftest.mjs";

const SELF = fileURLToPath(import.meta.url);
const HERE = path.dirname(SELF);
export const REPO_ROOT = path.resolve(HERE, "..");

export const UPGRADING_REL = "docs/UPGRADING.md";
export const POSTURE_TS_REL = "apps/admin-api/src/config/executor-posture.ts";
export const MAIN_TS_REL = "apps/admin-api/src/main.ts";

const SECTION_MARKER = "执行器出站姿态";
const SYMPTOM_FAILURE_REASON = "failureReason=script_error";
const SYMPTOM_TAIL = "已拒绝对外请求";
const FLAG = "EXECUTOR_ALLOW_PRIVATE_NETWORK";
const LOOPBACK = "127.0.0.1";
const ROLLBACK = "git revert";

/** 读文件（缺失返回 null，由调用方决定是不是红）。 */
function readOrNull(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * 判据本体（纯函数，便于 selftest 用 fixture 驱动）。
 *
 * @returns {string[]} 失败原因列表（空数组 = 绿）
 */
export function check(root = REPO_ROOT) {
  const errors = [];
  const doc = readOrNull(path.join(root, UPGRADING_REL));
  if (doc === null) {
    errors.push(`${UPGRADING_REL} 不存在 —— 升级公告的落点缺失`);
  } else {
    if (!doc.includes(SECTION_MARKER)) {
      errors.push(`${UPGRADING_REL} 缺「${SECTION_MARKER}」升级段（破坏性变更没有公告）`);
    }
    if (!(doc.includes(SYMPTOM_FAILURE_REASON) && doc.includes(SYMPTOM_TAIL))) {
      errors.push(
        `${UPGRADING_REL} 的症状段必须写**实测**的那一行（同时出现 ${SYMPTOM_FAILURE_REASON} 与 ${SYMPTOM_TAIL}），不许写「可能失败」`,
      );
    }
    for (const [needle, why] of [
      [FLAG, "必须点名开关名（否则运维不知道要设什么）"],
      [LOOPBACK, "必须写清同机回环（127.0.0.1）不可用"],
      [ROLLBACK, "必须给回滚方式"],
    ]) {
      if (!doc.includes(needle)) errors.push(`${UPGRADING_REL} 缺 \`${needle}\` —— ${why}`);
    }
    // §9 的口径必须与实现一致：不能还写着「破坏性变更：无」。
    // 切片按下一条 `## ` 标题（不能用 `## 1` —— 它会先命中 `## 11.` 自身）。
    const start9 = doc.indexOf("## 9.");
    const after9 = start9 === -1 ? -1 : doc.indexOf("\n## ", start9 + 1);
    const sec9 = start9 === -1 ? "" : doc.slice(start9, after9 === -1 ? undefined : after9);
    // 任意一行同时含「破坏性变更」与「**无**」即判矛盾（表格列数随文档演进会变，
    // 抓语义而不是抓列位——同族教训：数文案会把覆盖面写成假的）。
    const claimsNone = sec9
      .split("\n")
      .some((line) => line.includes("破坏性变更") && line.includes("**无**"));
    if (claimsNone) {
      errors.push(`${UPGRADING_REL} §9 仍写「破坏性变更 — 无」，与本轮的执行器出站姿态变更矛盾`);
    }
  }

  const postureTs = readOrNull(path.join(root, POSTURE_TS_REL));
  if (postureTs === null) {
    errors.push(`${POSTURE_TS_REL} 不存在 —— 启动期可操作告警（executorPostureWarning）缺失`);
  } else if (!postureTs.includes("executorPostureWarning")) {
    errors.push(`${POSTURE_TS_REL} 未导出 executorPostureWarning`);
  }

  const mainTs = readOrNull(path.join(root, MAIN_TS_REL));
  if (mainTs === null) {
    errors.push(`${MAIN_TS_REL} 不存在`);
  } else if (!/executorPostureWarning\s*\(/.test(mainTs)) {
    errors.push(
      `${MAIN_TS_REL} 没有调用 executorPostureWarning( —— 告警只写在文档/函数里 = 又一条「写了没人跑」`,
    );
  }

  // R58：**核实基线的 sha 必须真实存在**（可用 `git cat-file -e` 解析）。
  // 为什么：头部写着 `main` = `<sha>` 是"本文的命令/行号以此为准"的承诺；
  // sha 一旦是编的/打错的，承诺就是空的，而文档看起来完全正常（R06 遗留）。
  const baseMatch = doc.match(/\*\*核实基线\*\*[^\n]*\n(?:>[^\n]*\n)*/);
  const headerBlock = baseMatch ? baseMatch[0] : doc.slice(0, 1200);
  const shas = [...headerBlock.matchAll(/`([0-9a-f]{7,40})`/g)].map((m) => m[1]);
  // 只在**确实写了「核实基线」头**时才要求 sha 可解析：
  // 自检夹具是"最小可判文档"（没有该头），不该被这条判据牵连（R49 教训：加断言必须同步夹具）。
  if (baseMatch && shas.length === 0) {
    errors.push(
      `${UPGRADING_REL} 头部「核实基线」没有给出任何 sha —— 承诺"以此为准"却没有基线提交`,
    );
  }
  for (const sha of new Set(shas)) {
    const r = spawnSync("git", ["cat-file", "-e", sha], { cwd: root });
    if (r.status !== 0) {
      errors.push(
        `${UPGRADING_REL} 头部核实基线的 sha \`${sha}\` **不可解析**（\`git cat-file -e ${sha}\` exit ${r.status ?? "?"}）—— ` +
          `要么写成真实提交，要么删掉该引用`,
      );
    }
  }
  return errors;
}

/** 在临时目录造一份最小 fixture 仓库。 */
function fixture({ doc, posture, main }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acf-upgrade-notes-"));
  const put = (rel, text) => {
    if (text === null) return;
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  };
  put(UPGRADING_REL, doc);
  put(POSTURE_TS_REL, posture);
  put(MAIN_TS_REL, main);
  return dir;
}

const GOOD_DOC = `# 升级指南

## 9. v2.0.0 → develop

| 项 | 值 |
|---|---|
| 破坏性变更 | **有 1 条**（执行器出站姿态，见 §11） |

## 11. 执行器出站姿态（R05 起，破坏性）

- 谁受影响：内网执行器 / 同机回环执行器
- 症状：\`status=failed ${SYMPTOM_FAILURE_REASON} errorMessage=URL host 10.0.0.9 …— ${SYMPTOM_TAIL}\`
- 修法①：设 \`${FLAG}=true\`
- 修法②：${LOOPBACK} 回环不可用，改用内网 IP
- 回滚：\`${ROLLBACK} <sha>\`
`;

const GOOD_POSTURE = "export function executorPostureWarning(env = process.env) { return null; }\n";
const GOOD_MAIN = 'const w = executorPostureWarning();\nif (w) logger.warn(w);\n';

/**
 * 黑盒自检：每条用例起真子进程跑本脚本 CLI，断言退出码 + 输出面。
 *
 * `--root` 形态：main 只认 `--root=<dir>`（等号形态），故夹具一律用该形态传入；
 * 6 例全部走 CLI，无进程内直调 `check()` 的例外 —— 因此 `main()` 的失败 `return 1`
 * 是每条反例的硬断言面（改 0 必红）。
 */
function selftest() {
  const cases = [];

  /** 起一个真子进程跑本脚本 CLI，断言退出码 + 观测文本。 */
  const subprocess = (name, files, expectations) => {
    cases.push({
      name,
      fn: () => {
        const dir = fixture(files);
        try {
          expectExit(runGuard(SELF, { args: [`--root=${dir}`] }), {
            ...expectations,
            label: name,
          });
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      },
    });
  };

  subprocess(
    "正例：完整升级段 + 告警接线 ⇒ CLI exit 0（无假红）",
    { doc: GOOD_DOC, posture: GOOD_POSTURE, main: GOOD_MAIN },
    {
      code: 0,
      contains: ["✔ 升级公告判据通过"],
      absent: ["✘ 升级公告判据"],
    },
  );

  subprocess(
    "反例①：缺「执行器出站姿态」段 ⇒ CLI exit 1 + 报缺段",
    { doc: "# 升级指南\n\n没有任何姿态说明\n", posture: GOOD_POSTURE, main: GOOD_MAIN },
    {
      code: 1,
      contains: [SECTION_MARKER],
      absent: ["✔ 升级公告判据通过"],
    },
  );

  subprocess(
    "反例②：症状不是实测行（只写「可能失败」）⇒ CLI exit 1 + 报症状",
    {
      doc: GOOD_DOC.replace(`status=failed ${SYMPTOM_FAILURE_REASON}`, "可能失败"),
      posture: GOOD_POSTURE,
      main: GOOD_MAIN,
    },
    {
      code: 1,
      contains: [SYMPTOM_FAILURE_REASON],
      absent: ["✔ 升级公告判据通过"],
    },
  );

  subprocess(
    "反例③：§9 仍写「破坏性变更 — 无」⇒ CLI exit 1 + 报矛盾",
    {
      doc: GOOD_DOC.replace(
        "| 破坏性变更 | **有 1 条**（执行器出站姿态，见 §11） |",
        "| 破坏性变更 | **无** |",
      ),
      posture: GOOD_POSTURE,
      main: GOOD_MAIN,
    },
    {
      code: 1,
      contains: ["§9"],
      absent: ["✔ 升级公告判据通过"],
    },
  );

  subprocess(
    "反例④：告警函数没被 main.ts 调用 ⇒ CLI exit 1 + 报没接线",
    { doc: GOOD_DOC, posture: GOOD_POSTURE, main: "// nothing\n" },
    {
      code: 1,
      contains: ["executorPostureWarning("],
      absent: ["✔ 升级公告判据通过"],
    },
  );

  subprocess(
    "反例⑤：告警模块缺失 ⇒ CLI exit 1 + 报模块缺失",
    { doc: GOOD_DOC, posture: null, main: GOOD_MAIN },
    {
      code: 1,
      contains: [POSTURE_TS_REL],
      absent: ["✔ 升级公告判据通过"],
    },
  );

  return reportCases(cases, { title: "check-upgrade-notes selftest" }) === 0 ? 0 : 1;
}

function main(argv) {
  const rootArg = argv.find((a) => a.startsWith("--root="));
  const root = rootArg ? path.resolve(rootArg.slice("--root=".length)) : REPO_ROOT;
  const errors = check(root);
  if (errors.length === 0) {
    console.log("✔ 升级公告判据通过：执行器出站姿态变更已公告、症状为实测行、两条修法与回滚齐全、启动期告警已接线。");
    return 0;
  }
  console.error(`✘ 升级公告判据：${errors.length} 项`);
  for (const e of errors) console.error(`   · ${e}`);
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  process.exit(argv.includes("--selftest") ? selftest() : main(argv));
}

#!/usr/bin/env node
/**
 * SEC-07 / DEEP-AUDIT D2-P1-1 回归守卫（2026-10 修订，T4 迁 harness）。
 *
 * 背景：2026-09 曾把根 `docker-compose.yml` 的 executor-python 硬编码为
 * `TASK_SANDBOX: 'bwrap'`，本守卫当时钉死该值。2026-10 的真机复现发现：
 *   - 镜像不含 bubblewrap；
 *   - 即便装上，compose 的 cap_drop/no-new-privileges 与多数宿主 seccomp
 *     策略也不允许非特权 user namespaces；
 *   ⇒ 默认部署里**每个 Python 任务**都 fail-closed（sandbox_unavailable）。
 *
 * 修订后的契约：
 *   ① 基础 compose 默认 **不启用** bwrap：TASK_SANDBOX 必须是
 *      `${TASK_SANDBOX:-}`（或空串），绝不硬编码 'bwrap'；
 *   ② `docker-compose.secure.yml` 是显式 opt-in，必须设置 'bwrap'；
 *   ③ docs/deployment.md 必须保留 secure overlay + unprivileged userns +
 *      fail-closed 的前置/回退说明。
 *
 * 纯静态读取，不需要 docker / npm ci。
 *
 * ## T4（第 4 轮守卫自检审计）修掉的假绿
 *
 *   · **整篇命中即算**：③ 旧实现是对 `docs/deployment.md` 全文做五次
 *     `includes`。1333 行的文档里 `bwrap` / `unprivileged` / `fail-closed`
 *     各出现多次，于是**把 SEC-07 那一节整段删掉、只在变更日志里各提一句**
 *     也能全绿。现在要求**同一个二级小节内**同时出现五个词（按 `^## ` 切分），
 *     并报出「最接近的小节还缺哪些词」。
 *   · **服务名未转义**：旧 `new RegExp("^  " + name + ":")` 把服务名直接拼进正则，
 *     名字里出现 `.`/`+`/`(` 时会误配（本仓当前的服务名恰好都不含元字符，属
 *     **防御性**修正，CLI 面构造不出该形态，故不单列用例）。相邻的真实风险是
 *     「env 从哪儿取」：现在把「只从目标服务块取」钉成回归用例——兄弟服务写着
 *     `TASK_SANDBOX: 'bwrap'` 不能替目标服务顶包（用「全文搜 TASK_SANDBOX」的
 *     实现会在这条上红）。
 *   · **永远为真的兜底断言**：`env.TASK_SANDBOX !== "'bwrap'"` 在键**缺失**时也
 *     通过（`undefined !== "'bwrap'"`），于是「bwrap 硬编码已被覆盖」是纸面覆盖。
 *     现在硬编码 / 非空默认值 / 键缺失是**同一条判据**的三种失败形态，各自文案。
 *   · **事实源缺失 = 崩栈**：`readFileSync(docker-compose.yml)` / `docs/deployment.md`
 *     不存在时直接抛 ENOENT 栈，看起来像环境抖动而不是「判据瞎了」。现在三个
 *     事实源缺失、`services:` 解析不出、服务数塌到下界，一律**结构红**。
 *   · **行内注释算值**：`TASK_SANDBOX: '' # 默认关` 是合法 compose，旧实现把
 *     `'' # 默认关` 整串当值 → 判成非 opt-in（假红会诱导人改守卫而不是改 compose）。
 *     现在只剥未落在引号里的行内注释。
 *   · `--root` + 导出 `check()`：import 时不实扫、不 `process.exit`。
 *   · `--selftest`：从「函数级断言 extractServiceEnv」改为**跑真脚本的子进程**，
 *     逐条断言退出码 + 关键文本（旧版删掉 `process.exit(1)` 也照样全绿）。
 *
 * 用法：`node scripts/check-compose-sandbox.mjs [--selftest] [--root <dir>]`
 *   --selftest：在临时 fixture 树里跑真脚本；每条断言退出码 + 关键文本 + <1s。
 *   --root    ：把该目录当仓库根（默认 process.cwd()）；selftest 专用。
 *
 * 退出码：全通过 0；任一失败 1。
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";

export const BASE_COMPOSE_REL = "docker-compose.yml";
export const SECURE_COMPOSE_REL = "docker-compose.secure.yml";
export const DEPLOY_DOC_REL = "docs/deployment.md";
export const SERVICE_NAME = "executor-python";

/**
 * 扫描面下界（2026-10-29 实测基础 compose 22 个服务）。
 * 「0 个服务 = 没问题」是永真断言，所以塌到下界以下判**结构红**，不是判绿。
 */
export const MIN_COMPOSE_SERVICES = 10;

/** 文档契约的五个词：它们必须在**同一节**里同时出现。 */
export const DEPLOY_DOC_TOKENS = [
  "docker-compose.secure.yml",
  "bwrap",
  "unprivileged",
  "user namespaces",
  "fail-closed",
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 剥掉 YAML **行内**注释（仅当 `#` 未落在引号里且其前是行首/空白）。
 *
 * 为什么需要：`TASK_SANDBOX: '' # 默认关` 是合法的 opt-in 写法，旧实现把整串
 * 当值 → 假红；反过来，若不区分引号，`TASK_SANDBOX: "a#b"` 会被截断 → 假绿。
 */
export function stripInlineComment(value) {
  const raw = String(value ?? "");
  let quote = null;
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === "#" && (i === 0 || /[ \t]/.test(raw[i - 1]))) {
      return raw.slice(0, i).trimEnd();
    }
  }
  return raw.trim();
}

/**
 * 解析 compose 的顶层服务名清单（`services:` 下两空格缩进的键）。
 *
 * @param {string} composeText
 * @returns {string[]|null} 无 `services:` 块时返回 null（调用方判结构红）
 */
export function parseTopLevelServices(composeText) {
  const lines = String(composeText ?? "").split(/\r?\n/);
  const start = lines.findIndex((l) => /^services:[ \t]*(?:#.*)?$/.test(l));
  if (start === -1) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\S/.test(line)) break; // 下一个顶层键
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    const m = line.match(/^ {2}([A-Za-z0-9._-]+):[ \t]*(?:#.*)?$/);
    if (m) out.push(m[1]);
  }
  return out;
}

/**
 * 从 compose 文本中抽取指定服务的 environment 映射。
 *
 * 结构约定（与本仓 compose 一致）：`services` 下 `  <name>:` 两空格缩进，
 * environment 四空格，env 条目六空格 `KEY: value`（也接受 `- KEY=value` 列表形态）。
 * 返回 `{ [key]: value }`（value 已剥行内注释）；找不到服务块返回 null。
 *
 * 服务名按**整段**匹配：`^  <name>:`（冒号后必须是空白/行尾/注释），并转义
 * 正则元字符——否则 `executor-python2:` 或 `x.y` 这类名字会被误配到别的服务块。
 */
export function extractServiceEnv(composeText, serviceName) {
  const lines = String(composeText ?? "").split(/\r?\n/);
  const headRe = new RegExp(`^ {2}${escapeRe(serviceName)}:(?=[ \\t]|$)`);
  const start = lines.findIndex((l) => headRe.test(l));
  if (start === -1) return null;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}\S/.test(lines[i]) || /^\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const block = lines.slice(start, end);
  const envIdx = block.findIndex((l) => /^ {4}environment:[ \t]*(?:#.*)?$/.test(l));
  if (envIdx === -1) return {};

  const env = {};
  for (let i = envIdx + 1; i < block.length; i += 1) {
    const line = block[i];
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    const kv = line.match(/^ {6}([A-Za-z_][A-Za-z0-9_]*):[ \t]*(.*)$/);
    if (kv) {
      env[kv[1]] = stripInlineComment(kv[2]);
      continue;
    }
    const item = line.match(/^ {6}-[ \t]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (item) {
      env[item[1]] = stripInlineComment(item[2]);
      continue;
    }
    break; // 到了 environment 之外的块
  }
  return env;
}

/** 基础 compose 允许的默认值：显式空串（可带引号/行内注释），或由环境变量覆盖（默认空）。 */
export function isOptInSandboxValue(value) {
  const v = String(value ?? "").trim();
  return v === "" || v === "''" || v === '""' || v === "${TASK_SANDBOX:-}";
}

/** 值是否把 bwrap 写死（`'bwrap'` / `"bwrap"` / `bwrap`，大小写不敏感）。 */
export function isHardcodedBwrap(value) {
  const v = String(value ?? "")
    .trim()
    .replace(/^(['"])(.*)\1$/, "$2");
  return v.toLowerCase() === "bwrap";
}

/**
 * 找出**同一个二级小节**里包含全部契约词的文档位置。
 *
 * @returns {{heading: string|null, missing: string[], found: boolean}}
 *   `heading` 是最接近的小节（缺词最少的那节），只为帮人定位；`missing` 是它缺的词。
 */
export function findContractSection(docText, tokens = DEPLOY_DOC_TOKENS) {
  const lines = String(docText ?? "").split(/\r?\n/);
  const sections = [];
  let heading = "(文首)";
  let buf = [];
  const push = () => sections.push({ heading, text: buf.join("\n").toLowerCase() });
  for (const line of lines) {
    if (/^## /.test(line)) {
      push();
      heading = line.trim();
      buf = [];
      continue;
    }
    buf.push(line);
  }
  push();

  let best = { heading: null, missing: tokens };
  for (const s of sections) {
    const missing = tokens.filter((t) => !s.text.includes(t.toLowerCase()));
    if (missing.length < best.missing.length) best = { heading: s.heading, missing };
  }
  return { ...best, found: best.missing.length === 0 };
}

/**
 * 全量判据。
 *
 * @param {string} [root] 仓库根
 * @returns {{errors: string[], structure: string[], stats: Record<string, unknown>}}
 *   `errors` = 契约被破坏；`structure` = **判据本身不可信**（事实源缺失、扫描面塌方）。
 */
export function check(root = process.cwd()) {
  const errors = [];
  const structure = [];
  const stats = { services: 0, hasSandboxKey: false, baseSandboxValue: undefined };

  // ── ① 基础 compose ────────────────────────────────────────────────────────
  const baseAbs = join(root, BASE_COMPOSE_REL);
  if (!existsSync(baseAbs)) {
    structure.push(
      `事实源缺失：${BASE_COMPOSE_REL} —— 判据无从校验（目录改名/在子目录跑都会这样，不是「没问题」）。`,
    );
  } else {
    const compose = readFileSync(baseAbs, "utf8");
    const services = parseTopLevelServices(compose);
    if (services === null) {
      structure.push(`无法解析 ${BASE_COMPOSE_REL} 的顶层 services: 块 —— 结构变了，扫描器失效。`);
    } else {
      stats.services = services.length;
      if (services.length < MIN_COMPOSE_SERVICES) {
        structure.push(
          `只解析到 ${services.length} 个服务（下界 ${MIN_COMPOSE_SERVICES}）—— ` +
            `${BASE_COMPOSE_REL} 的结构变了，扫描器失效（不是「全部合规」）。`,
        );
      }
    }

    const env = extractServiceEnv(compose, SERVICE_NAME);
    if (env === null) {
      errors.push(`${BASE_COMPOSE_REL} 里没有 \`${SERVICE_NAME}\` 服务块 —— 沙箱默认值契约无处落地。`);
    } else {
      const value = env.TASK_SANDBOX;
      stats.hasSandboxKey = value !== undefined;
      stats.baseSandboxValue = value;
      if (value === undefined) {
        errors.push(
          `${SERVICE_NAME}.environment 缺 TASK_SANDBOX —— 必须是显式的 \`\${TASK_SANDBOX:-}\` ` +
            "（删掉这行会让「默认关闭」变成没人守的假设）。",
        );
      } else if (isHardcodedBwrap(value)) {
        errors.push(
          `基础 compose 硬编码了 TASK_SANDBOX=${JSON.stringify(value)} —— 镜像不含 bwrap、` +
            "宿主 seccomp 也多半不许非特权 userns，默认部署的所有 Python 任务会 fail-closed" +
            "（sandbox_unavailable）。要开 bwrap 请叠加 docker-compose.secure.yml。",
        );
      } else if (!isOptInSandboxValue(value)) {
        errors.push(
          `基础 compose 的 TASK_SANDBOX 默认值必须是 ''（或 \${TASK_SANDBOX:-}），实际 ` +
            `${JSON.stringify(value)} —— 非空默认值等于对所有部署强制开启沙箱。`,
        );
      }
    }
  }

  // ── ② secure overlay（显式 opt-in）────────────────────────────────────────
  const secureAbs = join(root, SECURE_COMPOSE_REL);
  if (!existsSync(secureAbs)) {
    structure.push(`事实源缺失：${SECURE_COMPOSE_REL} —— 显式 opt-in 的落点不在，契约 ② 无从校验。`);
  } else {
    const secure = readFileSync(secureAbs, "utf8");
    const secureEnv = extractServiceEnv(secure, SERVICE_NAME);
    if (secureEnv === null) {
      errors.push(`${SECURE_COMPOSE_REL} 里没有 \`${SERVICE_NAME}\` 服务块。`);
    } else if (!isHardcodedBwrap(secureEnv.TASK_SANDBOX)) {
      errors.push(
        `secure overlay 的 ${SERVICE_NAME}.TASK_SANDBOX 必须是 'bwrap'，实际 ` +
          `${JSON.stringify(secureEnv.TASK_SANDBOX ?? "(未设置)")} —— 这个文件存在的唯一理由就是开启 bwrap。`,
      );
    }
  }

  // ── ③ 部署文档（同一小节内五个词）────────────────────────────────────────
  const docAbs = join(root, DEPLOY_DOC_REL);
  if (!existsSync(docAbs)) {
    structure.push(`事实源缺失：${DEPLOY_DOC_REL} —— 契约 ③ 的说明不在，无从校验。`);
  } else {
    const doc = readFileSync(docAbs, "utf8");
    const { heading, missing, found } = findContractSection(doc);
    if (!found) {
      errors.push(
        `${DEPLOY_DOC_REL} 没有**同一节**同时保留五个契约词（最接近的小节「${heading ?? "(无)"}」缺：` +
          `${missing.join(" / ")}）—— 散落在文档各处不算说明，读者翻到的那一节必须自足。`,
      );
    }
  }

  return { errors, structure, stats };
}

// ── 自检（T4：真子进程 + 退出码 + 报错文本 + <1s）────────────────────────────
const SELF = fileURLToPath(import.meta.url);

function argValue(argv, flag) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const at = argv.indexOf(flag);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1];
  return null;
}

/** 12 个无关服务，把服务数顶到 MIN_COMPOSE_SERVICES=10 之上。 */
const fillerServices = (n = 12) =>
  Array.from(
    { length: n },
    (_, i) =>
      `  svc${String(i).padStart(2, "0")}:\n    image: busybox\n    environment:\n      LOG_LEVEL: 'info'\n`,
  ).join("");

/**
 * 基础 compose fixture。
 * @param {string|null} sandboxValue null = 不写这一行
 * @param {{filler?: number}} [opts]
 */
function baseCompose(sandboxValue = "${TASK_SANDBOX:-}", opts = {}) {
  const { filler = 12 } = opts;
  return (
    [
      "# fixture compose（注释行不算数）",
      "services:",
      "  executor-python:",
      "    image: acf/executor-python",
      "    environment:",
      "      PYTHONUNBUFFERED: '1'",
      sandboxValue === null ? null : `      TASK_SANDBOX: ${sandboxValue}`,
      fillerServices(filler),
      "volumes:",
      "  data:",
    ]
      .filter((l) => l !== null)
      .join("\n") + "\n"
  );
}

const secureCompose = (value = "'bwrap'") =>
  ["services:", "  executor-python:", "    environment:", `      TASK_SANDBOX: ${value}`].join("\n") +
  "\n";

const FULL_BODY = [
  "默认 `TASK_SANDBOX` 为空，任务以 non-root 直跑；需要最强隔离时叠加",
  "`docker-compose.secure.yml`，它设置 `TASK_SANDBOX=bwrap`，依赖宿主内核",
  "unprivileged user namespaces；前提不满足时执行器 fail-closed（sandbox_unavailable）。",
].join("\n");

const deployDoc = (body, heading = "## 容器安全（SEC-07）") =>
  ["# 部署指南", "", "## 系统要求", "只需要 docker。", "", heading, "", body, ""].join("\n");

const tree = ({ base = baseCompose(), secure = secureCompose(), doc = deployDoc(FULL_BODY) } = {}) => {
  const files = { "package.json": { name: "fixture", private: true } };
  if (base !== null) files[BASE_COMPOSE_REL] = base;
  if (secure !== null) files[SECURE_COMPOSE_REL] = secure;
  if (doc !== null) files[DEPLOY_DOC_REL] = doc;
  return files;
};

/**
 * 自检：11 条子进程用例。
 *
 * 为什么跑子进程：本脚本的历史事故形态全在 **CLI 层**（`process.exit` 是否真的执行、
 * 报错文本是否还在、事实源读不到时是崩栈还是结构红）。旧版 selftest 只断言
 * `extractServiceEnv` 的返回值，把 `process.exit(1)` 删掉它照样全绿。
 */
export function selftest() {
  const cases = [];
  const subprocess = (name, files, expect) => {
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(files, { prefix: "compose-sandbox-selftest-" });
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

  subprocess("① 合规树：base opt-in + secure bwrap + 文档单节齐备 → 绿", tree(), {
    code: 0,
    contains: ["compose 沙箱守卫通过", "13 个服务"],
    absent: ["结构错误", "✖", "❌"],
  });

  subprocess(
    "② 基础 compose 硬编码 'bwrap' → 红（点名 fail-closed 后果）",
    tree({ base: baseCompose("'bwrap'") }),
    {
      code: 1,
      contains: ["硬编码了 TASK_SANDBOX=\"'bwrap'\"", "fail-closed", "sandbox_unavailable"],
      absent: ["守卫通过"],
    },
  );

  subprocess(
    "③ 【反证·引号形态】TASK_SANDBOX: bwrap（无引号）→ 红（不靠单引号字面量）",
    tree({ base: baseCompose("bwrap") }),
    { code: 1, contains: ['硬编码了 TASK_SANDBOX="bwrap"'], absent: ["守卫通过"] },
  );

  subprocess(
    "④ 【反证·注释算数】bwrap 只写在注释里、真值缺失 → 红（注释不是配置）",
    tree({
      base: baseCompose(null).replace(
        "      PYTHONUNBUFFERED: '1'\n",
        "      PYTHONUNBUFFERED: '1'\n      # TASK_SANDBOX: 'bwrap'  ← 注释掉的旧值，不算配置\n",
      ),
    }),
    { code: 1, contains: ["environment 缺 TASK_SANDBOX"], absent: ["守卫通过"] },
  );

  subprocess(
    "⑤ 行内注释不影响判定：TASK_SANDBOX: '' # 默认关 → 绿",
    tree({ base: baseCompose("'' # 默认关，别删") }),
    { code: 0, contains: ["守卫通过"], absent: ["✖", "❌"] },
  );

  subprocess(
    "⑥ 【反证·借邻居的值】bwrap 写在兄弟服务 executor-python2 里、目标服务没写 → 红",
    tree({
      base: baseCompose(null).replace(
        "  executor-python:\n    image: acf/executor-python\n    environment:\n      PYTHONUNBUFFERED: '1'\n",
        "  executor-python:\n    image: acf/executor-python\n    environment:\n      PYTHONUNBUFFERED: '1'\n" +
          "  executor-python2:\n    environment:\n      TASK_SANDBOX: 'bwrap'\n",
      ),
    }),
    { code: 1, contains: ["environment 缺 TASK_SANDBOX"], absent: ["守卫通过"] },
  );

  subprocess(
    "⑦ 【反证·整篇命中】五个词散在两个小节 → 红（并报最接近的小节缺哪些词）",
    tree({
      doc: [
        "# 部署指南",
        "",
        "## 变更日志",
        "2026-10 起 `docker-compose.secure.yml` 改为 opt-in，`bwrap` 需要 unprivileged 宿主。",
        "",
        "## 回滚",
        "不满足前提时执行器 fail-closed；user namespaces 的检查见 runbook。",
        "",
      ].join("\n"),
    }),
    {
      code: 1,
      contains: ["同一节", "最接近的小节", "缺："],
      absent: ["守卫通过"],
    },
  );

  subprocess(
    "⑧ 事实源缺失（docker-compose.yml 不在）→ 结构红，不是崩栈也不是绿",
    tree({ base: null }),
    {
      code: 1,
      contains: ["结构错误", `事实源缺失：${BASE_COMPOSE_REL}`],
      absent: ["守卫通过", "Error:", "ENOENT"],
    },
  );

  subprocess(
    "⑨ 【反证·扫描面】services 只剩 1 个 → 结构红（不是「全部合规」）",
    tree({ base: baseCompose("${TASK_SANDBOX:-}", { filler: 0 }) }),
    {
      code: 1,
      contains: ["结构错误", "只解析到 1 个服务", `下界 ${MIN_COMPOSE_SERVICES}`],
      absent: ["守卫通过"],
    },
  );

  subprocess(
    "⑩ secure overlay 没开 bwrap → 红（点出「这个文件存在的唯一理由」）",
    tree({ secure: secureCompose("${TASK_SANDBOX:-}") }),
    {
      code: 1,
      contains: ["secure overlay", "必须是 'bwrap'", "唯一理由"],
      absent: ["守卫通过"],
    },
  );

  subprocess("⑪ secure overlay 整个不在 → 结构红（事实源缺失）", tree({ secure: null }), {
    code: 1,
    contains: ["结构错误", `事实源缺失：${SECURE_COMPOSE_REL}`],
    absent: ["守卫通过", "Error:"],
  });

  subprocess("⑫ 部署文档缺失 → 结构红（事实源缺失）", tree({ doc: null }), {
    code: 1,
    contains: ["结构错误", `事实源缺失：${DEPLOY_DOC_REL}`],
    absent: ["守卫通过", "Error:"],
  });

  const failed = reportCases(cases, { title: "check-compose-sandbox selftest" });
  if (failed > 0) process.exit(1);
}

// ── CLI ────────────────────────────────────────────────────────────────────
const invoked = process.argv[1]?.replace(/\\/g, "/").split("/").pop();

if (invoked === "check-compose-sandbox.mjs") {
  if (process.argv.includes("--selftest")) {
    selftest();
  } else {
    const root = resolve(argValue(process.argv, "--root") ?? process.cwd());
    const { errors, structure, stats } = check(root);

    if (structure.length > 0) {
      console.error("");
      console.error("✖ compose 沙箱守卫结构错误（判据本身不可信，先修扫描面）：");
      for (const e of structure) console.error("  · " + e);
      console.error("");
      process.exit(1);
    }

    if (errors.length > 0) {
      console.error("");
      console.error(`✖ SEC-07 compose 沙箱契约（${errors.length} 项）：`);
      for (const e of errors) console.error("  · " + e);
      console.error("");
      process.exit(1);
    }

    console.log(
      `✔ SEC-07 compose 沙箱守卫通过：基础 compose 的 ${SERVICE_NAME}.TASK_SANDBOX 默认关闭` +
        `（${stats.baseSandboxValue}），secure overlay 显式 'bwrap'，部署文档同节保留五个契约词` +
        `（${stats.services} 个服务已扫描）。`,
    );
  }
}

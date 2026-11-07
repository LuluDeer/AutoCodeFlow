#!/usr/bin/env node
/**
 * R23（2026-11-05）：**executor-node 侧的 `.env` hermeticity 守卫**。
 *
 * ## 为什么
 *
 * R04 在 admin-api 侧收掉三个 `.env` 入口并加 `SELFTEST_SKIP_ENV_FILE=1`（自检跑在干净环境里）。
 * executor-node 侧一直**没有**同等约束：`src/main.ts` 顶部是无条件 `dotenv.config(...)`。
 * 之所以"看起来没事"，只是因为 jest 恰好不碰 main.ts（`collectCoverageFrom` 排除它、
 * 且没有 spec 导入它）——**这是巧合，不是判据**：谁在一行 spec 里 `import "../main"`，
 * 测试就会静默读进开发者 `.env`（真实发生过的形态见 R04 台账）。
 *
 * ## 判据（四条，任一条不满足即红）
 *
 * ① **dotenv 只在 main.ts 出现**：`apps/executor-node/src` 的非测试源码里，`dotenv.config(` 只允许出现在 `main.ts`；
 * ② **main.ts 的加载必须受开关约束**：`main.ts` 里必须同时出现 `shouldLoadEnvFile(` 且 `dotenv.config` 在其 `if` 内
 *    （用「`dotenv.config` 出现位置晚于 `if (shouldLoadEnvFile`」这一可读的文本序做判据）；
 * ③ **开关语义文件在位**：`src/config/env-file.ts` 存在且只认 `"1"`（`=== "1"` 必须出现）；
 * ④ **测试路径不碰 main**：`src/**\/*.spec.ts` 里不得 `import`/`require` `main`（否则测试即读 `.env`）。
 *
 * ## 反向验证
 *
 * `--selftest`：正例 + 三个反例（新增一处未受约束的 dotenv / main.ts 去掉开关 / spec 导入 main），
 * 逐个断言 exit 1 且点名。
 *
 * 用法：`node scripts/check-executor-node-env-hermetic.mjs [--selftest] [--root=<dir>]`
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";
import { printCoverageBanner } from "./lib/agent-coverage.mjs";

printCoverageBanner(import.meta.url, "push");

const HERE = fileURLToPath(import.meta.url);
export const REPO_ROOT = resolve(HERE, "..", "..");
export const SRC = "apps/executor-node/src";
export const MAIN = `${SRC}/main.ts`;
export const ENV_FILE_MODULE = `${SRC}/config/env-file.ts`;


/**
 * 剥注释后再匹配：本守卫的判据是"代码里有没有加载点"，**注释里提到 `dotenv.config(` 不算**
 * （本轮实测：`env-file.ts` 的文档注释里写了这个词，裸子串匹配立刻误报）。
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*\/\//.test(line))
    .map((line) => line.replace(/\s+\/\/.*$/, ""))
    .join("\n");
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) {
      if (name === "node_modules") continue;
      walk(abs, out);
    } else if (name.endsWith(".ts")) {
      out.push(abs);
    }
  }
  return out;
}

export function check(root = REPO_ROOT) {
  const errors = [];
  const srcAbs = join(root, SRC);
  if (!existsSync(srcAbs)) return [`读不到 ${SRC} —— 扫描面缺失（守卫瞎了）`];
  const files = walk(srcAbs);
  const isSpec = (abs) => /\.spec\.ts$/.test(abs);

  // ① dotenv.config 只允许在 main.ts
  let dotenvHits = 0;
  for (const abs of files) {
    const rel = relative(root, abs).split("\\").join("/");
    if (isSpec(abs)) continue;
    const text = stripComments(readFileSync(abs, "utf8"));
    if (!text.includes("dotenv.config(")) continue;
    dotenvHits += 1;
    if (rel !== MAIN) {
      errors.push(
        `${rel} 出现 dotenv.config( —— executor-node 侧只允许 ${MAIN} 在自检开关约束下加载 .env；` +
          `新增加载点必须先接 SELFTEST_SKIP_ENV_FILE（见 src/config/env-file.ts）`,
      );
    }
  }
  if (dotenvHits === 0) {
    errors.push(
      `全仓零命中 dotenv.config( —— 扫描器失效或加载点被删（此时"没有 hermeticity 问题"是空断言）`,
    );
  }

  // ② main.ts 的加载必须受开关约束
  const mainAbs = join(root, MAIN);
  if (!existsSync(mainAbs)) errors.push(`读不到 ${MAIN}`);
  else {
    const main = stripComments(readFileSync(mainAbs, "utf8"));
    const gateAt = main.indexOf("if (shouldLoadEnvFile(");
    const dotenvAt = main.indexOf("dotenv.config(");
    if (gateAt < 0) {
      errors.push(`${MAIN} 里没有 \`if (shouldLoadEnvFile(...))\` —— .env 加载未受自检开关约束`);
    } else if (dotenvAt >= 0 && dotenvAt < gateAt) {
      errors.push(
        `${MAIN} 的 \`dotenv.config(\` 出现在 \`if (shouldLoadEnvFile(\` **之前** —— 等于无条件加载`,
      );
    }
  }

  // ③ 开关语义文件在位且只认 "1"
  const envAbs = join(root, ENV_FILE_MODULE);
  if (!existsSync(envAbs)) errors.push(`读不到 ${ENV_FILE_MODULE}（开关语义文件）`);
  else {
    const env = stripComments(readFileSync(envAbs, "utf8"));
    if (!env.includes('=== "1"')) {
      errors.push(`${ENV_FILE_MODULE} 不再只认字符串 "1" —— 开关语义漂移（会变成"看起来关了其实开着"）`);
    }
    if (!env.includes("SELFTEST_SKIP_ENV_FILE")) {
      errors.push(`${ENV_FILE_MODULE} 没有引用 SELFTEST_SKIP_ENV_FILE —— 与 admin-api 的 R04 开关脱钩`);
    }
  }

  // ④ 测试路径不碰 main
  for (const abs of files) {
    if (!isSpec(abs)) continue;
    const rel = relative(root, abs).split("\\").join("/");
    const text = stripComments(readFileSync(abs, "utf8"));
    // 三种形态都算"碰 main"：`from '.../main'`、副作用导入 `import '.../main'`、`require('.../main')`
    const importsMain = /from\s+["'][^"']*\/main["']|import\s+["'][^"']*\/main["']|require\(\s*["'][^"']*\/main["']\s*\)/.test(text);
    if (importsMain) {
      errors.push(
        `${rel} 导入了 main —— 一旦测试导入 main，就会在测试进程里执行 dotenv 加载（自检不再 hermetic）`,
      );
    }
  }

  return errors;
}

// ── 自检：正例 + 三个反例 ────────────────────────────────────────────────
const SELF = fileURLToPath(import.meta.url);

const GATED_MAIN = `import { shouldLoadEnvFile } from './config/env-file';
if (shouldLoadEnvFile()) {
  dotenv.config({ path: 'x' });
}
`;
const ENV_MODULE = `export const KEY = "SELFTEST_SKIP_ENV_FILE";
export const shouldSkip = (env) => env[KEY] === "1";
`;

function fixtureTree(over = {}) {
  return {
    [MAIN]: over.main ?? GATED_MAIN,
    [ENV_FILE_MODULE]: over.envModule ?? ENV_MODULE,
    [`${SRC}/routes/execute.ts`]: "export const x = 1;\n",
    [`${SRC}/routes/execute.spec.ts`]: over.spec ?? "import { x } from './execute';\nexport const y = x;\n",
  };
}

function runSelftest() {
  const cases = [];
  const push = (name, fn) => cases.push({ name, fn });

  push("正例控制组：加载只在 main 且受开关约束、env-file 只认 \"1\"、spec 不碰 main ⇒ exit 0", () => {
    const repo = makeFixtureRepo(fixtureTree());
    try {
      expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), { code: 0, withinMs: 20000, label: "正例" });
    } finally {
      repo.cleanup();
    }
  });

  push("反例①：新增一处未受约束的 dotenv 加载 ⇒ exit 1 且点名该文件", () => {
    const repo = makeFixtureRepo({
      ...fixtureTree(),
      [`${SRC}/routes/boot.ts`]: "import * as dotenv from 'dotenv';\ndotenv.config();\n",
    });
    try {
      expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
        code: 1, contains: ["routes/boot.ts", "dotenv.config("], withinMs: 20000, label: "新增加载点",
      });
    } finally {
      repo.cleanup();
    }
  });

  push("反例②：main.ts 去掉开关（无条件加载）⇒ exit 1", () => {
    const repo = makeFixtureRepo(fixtureTree({ main: "dotenv.config({ path: 'x' });\n" }));
    try {
      expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
        code: 1, contains: ["shouldLoadEnvFile"], withinMs: 20000, label: "无条件加载",
      });
    } finally {
      repo.cleanup();
    }
  });

  push("反例③：spec 导入 main ⇒ exit 1", () => {
    const repo = makeFixtureRepo(
      fixtureTree({ spec: "import '../main';\nexport const y = 1;\n" }),
    );
    try {
      expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
        code: 1, contains: ["导入了 main"], withinMs: 20000, label: "spec 碰 main",
      });
    } finally {
      repo.cleanup();
    }
  });

  push("反例④：开关不再只认 \"1\"（宽松真值）⇒ exit 1", () => {
    const repo = makeFixtureRepo(
      fixtureTree({ envModule: 'export const KEY = "SELFTEST_SKIP_ENV_FILE";\nexport const s = (env) => Boolean(env[KEY]);\n' }),
    );
    try {
      expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
        code: 1, contains: ['只认字符串 "1"'], withinMs: 20000, label: "语义漂移",
      });
    } finally {
      repo.cleanup();
    }
  });

  const failed = reportCases(cases, { title: "check-executor-node-env-hermetic selftest" });
  process.exit(failed === 0 ? 0 : 1);
}

function main(argv) {
  const eq = argv.find((a) => a.startsWith("--root="));
  const at = argv.indexOf("--root");
  const rootArg = eq ? eq.slice("--root=".length) : at >= 0 && at + 1 < argv.length ? argv[at + 1] : null;
  const errors = check(resolve(rootArg ?? REPO_ROOT));
  if (errors.length === 0) {
    console.log(
      "✔ executor-node .env hermeticity 守卫通过：dotenv 加载只在 main.ts 且受 SELFTEST_SKIP_ENV_FILE 约束，" +
        "开关只认 \"1\"，测试路径不导入 main。",
    );
    return 0;
  }
  console.error(`✘ executor-node .env hermeticity 守卫：${errors.length} 项`);
  for (const e of errors) console.error(`   · ${e}`);
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === HERE) {
  process.exit(process.argv.includes("--selftest") ? runSelftest() : main(process.argv.slice(2)));
}

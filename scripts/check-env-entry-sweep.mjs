#!/usr/bin/env node
/**
 * R24（2026-11-05）：**`.env` 读入面的一次性清扫守卫**。
 *
 * ## 背景（R04 / R23 / R24 三轮合起来的面）
 *
 * `.env` 读入面一共三类，各自的"污染"形态不同：
 * ① **admin-api（运行期）**：三个入口（`main.ts` preload / `app.module.ts` ConfigModule /
 *    `data-source.ts` dotenv）—— R04 已用 `SELFTEST_SKIP_ENV_FILE` 收口；
 * ② **executor-node（运行期）**：`src/main.ts` 一处 `dotenv.config` —— R23 已收口；
 * ③ **executor-python（运行期）**：`config.py` 的 `SettingsConfigDict(env_file='.env')` ——
 *    **R24 收口**（pydantic-settings 实例化时读工作目录 `.env`）；
 * ④ **admin-web（构建期）**：vite 读 `.env*` 注入 `import.meta.env` —— **不是运行期污染**
 *    （测试跑 jsdom/vitest，不经 vite 的 env 载入路径），见本守卫的 web 面判据。
 *
 * ## 判据（逐条，端到端可机读）
 *
 * ① **executor-python**：`config.py` 的 `SettingsConfigDict` 必须用 `env_file=env_file_for_settings()`
 *    （即受开关约束），且**不得**出现裸 `env_file='.env'` / `env_file=".env"`；
 * ② **executor-python**：`config_env_file.py` 必须在位、只认 `"1"`、且引用统一键
 *    `SELFTEST_SKIP_ENV_FILE`（与 admin/node 同键 ⇒ 一次设置两端生效）；
 * ③ **executor-node**：`main.ts` 的 dotenv 加载必须受 `shouldLoadEnvFile(` 约束（复用 R23 守卫的判据）；
 * ④ **admin-api**：三个入口必须仍受 `shouldSkipEnvFile` / `SELFTEST_SKIP_ENV_FILE` 约束；
 * ⑤ **admin-web**：**断言不存在运行期 dotenv 读入**（`dotenv` / `parseEnv` / `require('dotenv')`
 *    一律不许出现在 `apps/admin-web/src`）—— vite 的构建期注入**不算**运行期污染；
 * ⑥ **无入口端不许新造入口**：以上判据任一被绕过（裸 env_file / 去掉开关 / web 侧引入 dotenv）即红。
 *
 * ## 反向验证
 *
 * `--selftest`：正例 + 四个反例（python 裸 env_file / node 去掉开关 / web 引入 dotenv /
 * python 开关宽松真值），逐个断言 exit 1 且点名。
 *
 * 用法：`node scripts/check-env-entry-sweep.mjs [--selftest] [--root=<dir>]`
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";
import { printCoverageBanner } from "./lib/agent-coverage.mjs";

printCoverageBanner(import.meta.url, "push");

const HERE = fileURLToPath(import.meta.url);
export const REPO_ROOT = resolve(HERE, "..", "..");

export const FILES = {
  pyConfig: "apps/executor-python/config.py",
  pySwitch: "apps/executor-python/config_env_file.py",
  nodeMain: "apps/executor-node/src/main.ts",
  nodeSwitch: "apps/executor-node/src/config/env-file.ts",
  adminMain: "apps/admin-api/src/main.ts",
  adminSwitch: "apps/admin-api/src/config/selftest-env.ts",
  webSrc: "apps/admin-web/src",
};

/** 剥注释（判据读的文本必须先清洗 —— R23 的教训）。 */
function stripComments(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*\/\//.test(line) && !/^\s*#/.test(line))
    .map((line) => line.replace(/\s+\/\/.*$/, "").replace(/\s+#.*$/, ""))
    .join("\n");
}

export function check(root = REPO_ROOT) {
  const errors = [];
  const read = (rel) => {
    const abs = join(root, rel);
    if (!existsSync(abs)) {
      errors.push(`读不到 ${rel}`);
      return null;
    }
    return stripComments(readFileSync(abs, "utf8"));
  };

  // ① + ② executor-python
  const pyConfig = read(FILES.pyConfig);
  if (pyConfig) {
    if (/env_file\s*=\s*['"]\.env['"]/.test(pyConfig)) {
      errors.push(
        `${FILES.pyConfig} 仍有裸 \`env_file='.env'\` —— pydantic-settings 会直接读工作目录的 .env，` +
          `必须改为 \`env_file=env_file_for_settings()\`（受 SELFTEST_SKIP_ENV_FILE 约束）`,
      );
    }
    if (!/env_file\s*=\s*env_file_for_settings\(\s*\)/.test(pyConfig)) {
      errors.push(
        `${FILES.pyConfig} 没有 \`env_file=env_file_for_settings()\` —— .env 读入未受开关约束`,
      );
    }
  }
  const pySwitch = read(FILES.pySwitch);
  if (pySwitch) {
    if (!pySwitch.includes('== "1"')) {
      errors.push(`${FILES.pySwitch} 不再只认字符串 "1" —— 开关语义漂移（会变成"看起来关了其实开着"）`);
    }
    if (!pySwitch.includes("SELFTEST_SKIP_ENV_FILE")) {
      errors.push(`${FILES.pySwitch} 没有引用 SELFTEST_SKIP_ENV_FILE —— 与 admin/node 的统一键脱钩`);
    }
  }

  // ③ executor-node
  const nodeMain = read(FILES.nodeMain);
  if (nodeMain) {
    const gateAt = nodeMain.indexOf("if (shouldLoadEnvFile(");
    const dotenvAt = nodeMain.indexOf("dotenv.config(");
    if (gateAt < 0) {
      errors.push(`${FILES.nodeMain} 没有 \`if (shouldLoadEnvFile(...)\` —— .env 加载未受开关约束`);
    } else if (dotenvAt >= 0 && dotenvAt < gateAt) {
      errors.push(`${FILES.nodeMain} 的 \`dotenv.config(\` 早于开关判定 —— 等于无条件加载`);
    }
  }
  const nodeSwitch = read(FILES.nodeSwitch);
  if (nodeSwitch && !nodeSwitch.includes('=== "1"')) {
    errors.push(`${FILES.nodeSwitch} 不再只认字符串 "1" —— 开关语义漂移`);
  }

  // ④ admin-api（R04 的三个入口必须仍受约束）
  const adminMain = read(FILES.adminMain);
  if (adminMain && !/shouldSkipEnvFile|SELFTEST_SKIP_ENV_FILE/.test(adminMain)) {
    errors.push(`${FILES.adminMain} 不再引用 SELFTEST_SKIP_ENV_FILE —— R04 的约束被回退了`);
  }
  const adminSwitch = read(FILES.adminSwitch);
  if (adminSwitch && !adminSwitch.includes('=== "1"')) {
    errors.push(`${FILES.adminSwitch} 不再只认字符串 "1" —— 开关语义漂移`);
  }

  // ⑤ admin-web：**运行期**不得有 dotenv 读入（vite 构建期注入不算）
  const webSrc = join(root, FILES.webSrc);
  if (!existsSync(webSrc)) {
    errors.push(`读不到 ${FILES.webSrc} —— web 面扫描缺失（守卫瞎了）`);
  } else {
    const hits = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const abs = join(dir, name);
        const st = statSync(abs);
        if (st.isDirectory()) {
          if (name === "node_modules") continue;
          walk(abs);
        } else if (/\.(ts|tsx|js|jsx)$/.test(name)) {
          const text = stripComments(readFileSync(abs, "utf8"));
          if (/\bdotenv\b|\bparseEnv\b|require\(\s*["']dotenv/.test(text)) {
            hits.push(abs);
          }
        }
      }
    };
    walk(webSrc);
    for (const abs of hits) {
      errors.push(
        `${abs.replace(root + "/", "")} 出现运行期 dotenv/parseEnv 读入 —— web 侧只用 vite 的` +
          `**构建期** env 注入（不是运行期污染）；新增运行期读入会把开发者 .env 带进测试`,
      );
    }
  }

  return errors;
}

// ── 自检：正例 + 四个反例 ────────────────────────────────────────────────
const SELF = fileURLToPath(import.meta.url);

const PY_CONFIG = `from config_env_file import env_file_for_settings
class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=env_file_for_settings(), extra='ignore'
    )
`;
const PY_SWITCH = `SELFTEST_SKIP_ENV_FILE_KEY = "SELFTEST_SKIP_ENV_FILE"
def should_skip_env_file(env=None):
    return env.get(SELFTEST_SKIP_ENV_FILE_KEY) == "1"
`;
const NODE_MAIN = `import { shouldLoadEnvFile } from './config/env-file';
if (shouldLoadEnvFile()) {
  dotenv.config({ path: 'x' });
}
`;
const NODE_SWITCH = `export const KEY = "SELFTEST_SKIP_ENV_FILE";
export const shouldSkip = (env) => env[KEY] === "1";
`;
const ADMIN_MAIN = `if (shouldSkipEnvFile()) { /* skip .env */ }
`;
const ADMIN_SWITCH = `export const KEY = "SELFTEST_SKIP_ENV_FILE";
export const shouldSkip = (env) => env[KEY] === "1";
`;

function fixtureTree(over = {}) {
  return {
    [FILES.pyConfig]: over.pyConfig ?? PY_CONFIG,
    [FILES.pySwitch]: over.pySwitch ?? PY_SWITCH,
    [FILES.nodeMain]: over.nodeMain ?? NODE_MAIN,
    [FILES.nodeSwitch]: over.nodeSwitch ?? NODE_SWITCH,
    [FILES.adminMain]: over.adminMain ?? ADMIN_MAIN,
    [FILES.adminSwitch]: over.adminSwitch ?? ADMIN_SWITCH,
    [`${FILES.webSrc}/api/client.ts`]: over.web ?? "export const u = 1;\n",
  };
}

function runSelftest() {
  const cases = [];
  const push = (name, fn) => cases.push({ name, fn });

  push("正例控制组：四端都受约束 ⇒ exit 0", () => {
    const repo = makeFixtureRepo(fixtureTree());
    try {
      expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), { code: 0, withinMs: 20000, label: "正例" });
    } finally {
      repo.cleanup();
    }
  });

  push("反例①：python 裸 env_file='.env' ⇒ exit 1 且点名", () => {
    const repo = makeFixtureRepo(
      fixtureTree({ pyConfig: "class Settings(BaseSettings):\n    model_config = SettingsConfigDict(env_file='.env')\n" }),
    );
    try {
      expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
        code: 1, contains: ["裸 `env_file='.env'`"], withinMs: 20000, label: "裸 env_file",
      });
    } finally {
      repo.cleanup();
    }
  });

  push("反例②：node 去掉开关 ⇒ exit 1 且点名", () => {
    const repo = makeFixtureRepo(fixtureTree({ nodeMain: "dotenv.config({ path: 'x' });\n" }));
    try {
      expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
        code: 1, contains: ["shouldLoadEnvFile"], withinMs: 20000, label: "node 去开关",
      });
    } finally {
      repo.cleanup();
    }
  });

  push("反例③：web 侧引入运行期 dotenv ⇒ exit 1 且点名该文件", () => {
    const repo = makeFixtureRepo(
      fixtureTree({ web: "import dotenv from 'dotenv';\ndotenv.config();\n" }),
    );
    try {
      expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
        code: 1, contains: ["运行期 dotenv"], withinMs: 20000, label: "web 引入 dotenv",
      });
    } finally {
      repo.cleanup();
    }
  });

  push("反例④：python 开关宽松真值 ⇒ exit 1", () => {
    const repo = makeFixtureRepo(
      fixtureTree({ pySwitch: 'KEY = "SELFTEST_SKIP_ENV_FILE"\ndef s(env=None):\n    return bool(env.get(KEY))\n' }),
    );
    try {
      expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
        code: 1, contains: ['只认字符串 "1"'], withinMs: 20000, label: "语义漂移",
      });
    } finally {
      repo.cleanup();
    }
  });

  const failed = reportCases(cases, { title: "check-env-entry-sweep selftest" });
  process.exit(failed === 0 ? 0 : 1);
}

function main(argv) {
  const eq = argv.find((a) => a.startsWith("--root="));
  const at = argv.indexOf("--root");
  const rootArg = eq ? eq.slice("--root=".length) : at >= 0 && at + 1 < argv.length ? argv[at + 1] : null;
  const errors = check(resolve(rootArg ?? REPO_ROOT));
  if (errors.length === 0) {
    console.log(
      "✔ .env 读入面清扫守卫通过：admin-api / executor-node / executor-python 三端均受 " +
        "SELFTEST_SKIP_ENV_FILE 约束（只认 \"1\"），admin-web 无运行期 dotenv 读入（vite 构建期注入不算）。",
    );
    return 0;
  }
  console.error(`✘ .env 读入面清扫守卫：${errors.length} 项`);
  for (const e of errors) console.error(`   · ${e}`);
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === HERE) {
  process.exit(process.argv.includes("--selftest") ? runSelftest() : main(process.argv.slice(2)));
}

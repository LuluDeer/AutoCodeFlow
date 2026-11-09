#!/usr/bin/env node
/**
 * 自检 **hermeticity** 的注入面（R04，2026-11-05）。
 *
 * ## 它解决的问题（真机实测，不是推理）
 *
 * 自检以 `cwd = apps/admin-api` 起 `node dist/main.js`。而开发态约定是
 * `apps/admin-api/.env` **符号链接到仓库根 `.env`**（gitignored），app 的
 * `ConfigModule.forRoot({ envFilePath: ".env" })` 按 cwd 解析它，Nest 的
 * `assignVariablesToProcess` 只跳过 `process.env` 里已有的键 ⇒ 夹具没显式给的键
 * **全部从开发者 `.env` 注入**（实测 147 键 vs 夹具 18 键 ⇒ **133 键泄漏**）。
 *
 * 后果：`test:pull-dispatch` 断言 ④⑤ 全红（执行器 `fetchToken`/心跳/回调 401），
 * 而 CI（无该符号链接）是绿的 ⇒ **本地门禁 ≠ CI**，且红点离改动很远。
 *
 * ## 用法（9 个起 admin-api 子进程的自检都必须这样接）
 *
 * ```js
 * import { hermeticEnv } from "./lib/selftest-hermetic.mjs";
 * const child = spawn("node", ["dist/main.js"], {
 *   cwd: API_DIR,
 *   env: hermeticEnv(baseEnv(PORT)),   // ← 只包 admin-api 的 env
 * });
 * ```
 *
 * `hermeticEnv` 只做一件事：把 `SELFTEST_SKIP_ENV_FILE=1` 放进子进程环境，app 侧
 * （`apps/admin-api/src/config/selftest-env.ts`）据此 `ignoreEnvFile: true`。
 * **未设置时 app 行为逐字节不变** ⇒ 生产 / CI / compose 零影响。
 *
 * ## 为什么不用「把 .env 藏起来」
 *
 * 删/改开发者 `.env`、或把它 `.gitignore` 掉，都只是让本机"看起来绿"——CI 上本来就没有
 * 这个文件，问题会被藏而不是被修；而下一个 clone 的人会再中一次。开关式注入把差异
 * 变成**显式**的：要么自检声明 hermetic，要么它就得自己承担读到本机环境的后果。
 */

import fs from "node:fs";
import path from "node:path";

/**
 * 开关键名。**必须**与 `apps/admin-api/src/config/selftest-env.ts` 的
 * `SELFTEST_SKIP_ENV_FILE_KEY` 同一字面量（漂移由 `check:guard-harness` 的接线判据钉住）。
 */
export const SELFTEST_SKIP_ENV_FILE_KEY = "SELFTEST_SKIP_ENV_FILE";

/** 自检子进程需要注入的固定 env 片段（冻结：防止调用方误改）。 */
export const HERMETIC_ENV = Object.freeze({
  [SELFTEST_SKIP_ENV_FILE_KEY]: "1",
});

/**
 * 把 hermetic 开关合进子进程 env。
 *
 * 纯函数、不改入参；`base` 为 `null`/`undefined` 时按空对象处理（自检里常见
 * `env: hermeticEnv()` 的写法）。
 */
export function hermeticEnv(base) {
  return { ...(base ?? {}), ...HERMETIC_ENV };
}

/**
 * 读 `.env` 文本里某个键的值（零依赖、不执行、不展开变量）。
 *
 * 用途只有一个：**证明夹具密钥 ≠ 开发者密钥**——若两者相同，那条「本轮绿 ⇒ 没读 .env」
 * 的推理就失去牙齿（有人把 .env 改成夹具值，或反过来）。返回 `null` 表示文件不存在
 * 或键不存在；这两者在自检里是**好消息**（没有可泄漏的东西），不要当错误。
 */
export function readEnvFileValue(filePath, key) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const re = new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*(.*)$`, "m");
  const m = re.exec(text);
  if (!m) return null;
  let value = m[1].trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value;
}

/**
 * 扫描 `scripts/*.mjs`：**凡 spawn `dist/main.js` 的自检，必须引用 `hermeticEnv(`**。
 *
 * 为什么需要它：这是"写了没人接"的经典形态——本轮修了 9 个脚本，下一个人新增自检时
 * 99% 不会记得包一层；等他遇到"本机红 CI 绿"时，没人会想到是 `.env`。接线判据把
 * 这件事变成 CI 会回答的问题。
 *
 * @returns {{ offenders: string[], scanned: number, wired: string[] }}
 */
export function scanAdminSpawns(scriptsDir) {
  const offenders = [];
  const wired = [];
  let scanned = 0;
  let names = [];
  try {
    names = fs.readdirSync(scriptsDir).filter((f) => f.endsWith(".mjs")).sort();
  } catch {
    return { offenders: [], wired: [], scanned: 0, missingDir: true };
  }
  for (const name of names) {
    const abs = path.join(scriptsDir, name);
    let text = "";
    try {
      text = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    // 只看**起 admin-api** 的自检：executor-node 的 dist/main.js 是另一套配置加载
    // （它自己的 apps/executor-node/.env，R03 实验证明与本缺陷无关），不在此判据面内。
    if (!/dist\/main\.js/.test(text)) continue;
    if (!/API_DIR|apps\/admin-api/.test(text)) continue;
    scanned++;
    if (/hermeticEnv\s*\(/.test(text)) wired.push(name);
    else offenders.push(name);
  }
  return { offenders, wired, scanned };
}

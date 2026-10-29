#!/usr/bin/env node
/**
 * 「compose 里的服务地址必须真的被注入」守卫（2026-10-23 真机缺陷的钉子；T4 迁 harness）。
 *
 * ## 缺陷现场
 *
 * 「包注册中心」页面的 PyPI / npm 列表在**所有 Docker 部署下必然 502**：
 * `registry.controller` 读 `PYPI_REGISTRY_URL` / `NPM_REGISTRY_URL`，
 * 但 `docker-compose.yml` 的 **admin-api 服务块从未注入过这两个键** ——
 * 容器内回落到 `http://localhost:8003` / `http://localhost:4873`，
 * 而那指向 admin-api **自己**（两个 registry 是别的容器）。同时
 * `REGISTRY_USER` / `REGISTRY_PASS` 也没注入，私有仓要求 Basic 认证，
 * 匿名必然 401（列表代理把它透出成 502）。
 *
 * 为什么单测没抓到：`registry.controller.spec.ts` 显式构造 ConfigService
 * 并注入 `PYPI_REGISTRY_URL: http://127.0.0.1:<port>`——**测的是代码逻辑，
 * 不是部署可达性**。「mock 不等于能跑」又一次。
 *
 * ## 判据
 *
 * A. `docker-compose.yml` 的 admin-api 服务块必须**注入** REQUIRED 列出的键，
 *    并且**值解析后非空**（空串 / `${X:-}` 这类空默认值 = 容器里回落 localhost，
 *    与「没有这个键」在生产上等价）。
 * B. 反向：`registry.controller.ts` 里 `config.get("<KEY>")` 读到的 registry
 *    裸键，必须在 admin-api environment 里有出处：自身注入，或经显式登记的
 *    派生键（`BARE_KEY_EXEMPTIONS.coveredBy`）覆盖——**派生源本身也要在**，
 *    否则这条豁免不成立。
 *
 * 判据刻意**不做**「值对不对」的检查（拓扑会变），只钉「键在、值非空、有出处」——
 * 这一类漏接是静默的，而且只在真机上炸。
 *
 * ## T4（第 4 轮守卫自检审计）修掉的假绿
 *
 *   · **兄弟服务顶包（`continue` 跳块）**：旧 `parseServiceEnvKeys` 用
 *     `/^(\s*)([A-Za-z0-9._-]+):\s*$/` 判「服务头」，只有**裸 `name:`** 才算数。
 *     于是 `  registry-pypi: # 上游`、`  registry-pypi: &anchor` 这种带尾注/锚点的
 *     服务头**结束不了** admin-api 的块，随后兄弟服务的 `environment:` 被当成
 *     admin-api 的（`inEnv` 再次置真）——兄弟服务有键，admin-api 一个没注入，
 *     守卫照样绿。现在块边界只看**缩进**（任何 ≤2 缩进的行都结束块），不看行的形态。
 *   · **空值算注入**：旧判据只有 `keys.has(k)`。`NPM_REGISTRY_URL: ""` /
 *     `ADMIN_PYPI_REGISTRY_URL: ${ADMIN_PYPI_REGISTRY_URL:-}` 是「键在、值为空」，
 *     容器里回落到 localhost —— 生产等价于没注入，守卫却是绿的。现在按
 *     `${VAR-default}` / `${VAR:-default}` / `${VAR:?msg}` 语义解析后判非空。
 *   · **注释算数**：旧 `parseControllerConfigKeys` 直接对源码跑正则，一行
 *     `// this.config.get<string>("REGISTRY_PASS")`（注释掉的读取）也算数，
 *     让判据 B 去要求一个代码里已经不读的键（假红），也掩盖真读到的键（假绿）。
 *     现在先剥行/块注释再扫。
 *   · **豁免是一条无校验的假设**：旧实现用 `continue` 跳过 4 个裸键，
 *     其中 `PYPI_REGISTRY_URL` 的「由 ADMIN_PYPI_* 派生」**从不验证派生源存在**。
 *     现在豁免登记在 `BARE_KEY_EXEMPTIONS` 里，`coveredBy` 的键必须真的在
 *     admin-api environment 中且非空，否则报错。
 *   · **只数条数**：旧 selftest 只有 `assert(missing.length === 4)` 两条，
 *     删掉 CLI 的 `process.exit(1)` 它照样全绿。现在跑**真子进程**，逐条断言
 *     退出码 + 关键文本（11 条）。
 *   · **事实源缺失 = 崩栈**：compose / controller 读不到时旧实现直接抛 ENOENT。
 *     现在事实源缺失、`services:` 解析不出、服务数/admin-api env 键数/controller
 *     键数塌到下界，一律**结构红**（判据失效 ≠ 全部合规）。
 *   · `--root` + import 无副作用：import 不实扫、不 `process.exit`。
 *
 * 用法：`node scripts/check-compose-service-env.mjs [--selftest] [--root <dir>]`
 *   --selftest：在临时 fixture 树里跑真脚本；每条断言退出码 + 关键文本 + <1s。
 *   --root    ：把该目录当仓库根（默认 process.cwd()）；selftest 专用。
 *
 * 退出码：全通过 0；任一失败 1。
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";

export const COMPOSE_REL = "docker-compose.yml";
export const CONTROLLER_REL =
  "apps/admin-api/src/modules/registry/registry.controller.ts";
export const SERVICE_NAME = "admin-api";

/**
 * admin-api 消费 registry 上游所必需的 env 键。
 *
 * 为什么手写这一份而不是从 controller 自动推导全部：controller 里既有
 * `registry.pypi.url`（配置节）也有 `PYPI_REGISTRY_URL`（裸键回退），
 * 自动推导会把回退键当成必需项。这里列**部署必须提供**的那几个，
 * 并配注释说明为什么（新增 registry 上游时同步登记）。
 */
export const REQUIRED_ADMIN_API_REGISTRY_KEYS = [
  // PyPI 列表/上传代理的基址（controller 自己拼 /simple/，故不带后缀）
  "ADMIN_PYPI_REGISTRY_URL",
  // npm（Verdaccio）基址
  "NPM_REGISTRY_URL",
  // 私有仓 Basic 凭据：缺了必然 401 → 列表代理 502
  "REGISTRY_USER",
  "REGISTRY_PASS",
];

/** 扫描面下界（2026-10-29 实测：compose 20 个服务 / admin-api 38 个 env 键 / controller 12 个 config.get 键）。 */
export const MIN_COMPOSE_SERVICES = 10;
export const MIN_ADMIN_ENV_KEYS = 15;
export const MIN_CONTROLLER_KEYS = 6;

/**
 * controller 里读取、但**不需要** admin-api 直接注入的裸键。
 *
 * 每条必须给出「由谁覆盖」或「为什么不影响可达性」——旧实现用 `continue`
 * 跳过它们却不校验理由，等于开了 4 个无证据的后门。
 */
export const BARE_KEY_EXEMPTIONS = {
  PYPI_REGISTRY_URL: {
    coveredBy: "ADMIN_PYPI_REGISTRY_URL",
    why:
      "映射节 registry.pypi.url 由 ADMIN_PYPI_REGISTRY_URL 派生（controller 自己拼 /simple/，故不复用执行器侧带 /simple/ 的那个变量）",
  },
  NPM_REGISTRY_USER: {
    optional: true,
    why: "npm 私有仓可选服务账号：不配时匿名访问，401 会如实透出为 502（不影响「能不能连上」）",
  },
  NPM_REGISTRY_PASS: {
    optional: true,
    why: "同上：匿名 401 是明确的失败，不是静默回落 localhost",
  },
  NPM_REGISTRY_TOKEN: {
    optional: true,
    why: "同上：Verdaccio token 是可选凭据",
  },
  REGISTRY_UPLOAD_TIMEOUT_MS: {
    optional: true,
    why: "可选调优键：controller 内有 60s 缺省，不注入不改变可达性",
  },
};

/**
 * 剥掉一个值里的 **YAML 行内注释**（仅当 `#` 未落在引号里且其前是行首/空白）。
 *
 * `TASK_SANDBOX: '' # 默认关` 式的尾注是合法 compose；把注释当值会让
 * 「必须有值」判成空值（假红），反过来不区分引号会截断 `"a#b"`（假绿）。
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
 * 把 compose 环境变量的**原始字面量**解析成「容器里实际拿到的值」。
 *
 *   `""` / `''` / `${X:-}` / `${X:-''}`  → 空串（= 没注入，回落 localhost）
 *   `${X-default}` / `${X:-default}`      → default（非空则算注入）
 *   `${X:?msg}` / `${X?msg}`              → 非空或 compose 直接报错 ⇒ 算注入
 *   `${X}`                                → 由宿主提供，值未知但存在 ⇒ 算注入
 *   `http://registry-pypi:8003`           → 原值
 *
 * 这不是「值对不对」（拓扑会变），只是回答「这个键到底注入了什么」。
 */
export function resolveEnvLiteral(raw) {
  let v = stripInlineComment(raw).trim();
  const unquote = (s) =>
    (s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))
      ? s.slice(1, -1)
      : s;
  v = unquote(v);
  const m = /^\$\{([A-Za-z_][A-Za-z0-9_]*)(:?[-?])([^}]*)\}$/.exec(v);
  if (m) {
    const [, , op, rest] = m;
    if (op === ":-" || op === "-") return unquote(rest.trim()).trim();
    return "(由宿主环境提供)";
  }
  return v;
}

/**
 * 解析 compose 的 `services:` 块 → `Map<服务名, Map<envKey, 有效值>>`。
 *
 * 结构约定（与本仓 compose 一致）：顶层 `services:`，服务头两空格缩进，
 * `environment:` 四空格，每个键再深一层；也接受 `- KEY=value` 列表形态。
 *
 * **块边界只看缩进**：任何缩进 ≤2 的非注释行都结束当前服务块。旧实现要求
 * 服务头是「裸 `name:`」，`name: # 尾注` / `name: &anchor` 结束不了块，
 * 于是兄弟服务的 environment 被算进当前服务（T4 修掉的假绿）。
 *
 * @param {string} yamlText
 * @returns {Map<string, Map<string,string>>|null} 无 `services:` 块时返回 null（调用方判结构红）
 */
export function parseComposeServices(yamlText) {
  const lines = String(yamlText ?? "").split(/\r?\n/);
  const start = lines.findIndex((l) => /^services:[ \t]*(?:#.*)?$/.test(l));
  if (start === -1) return null;

  /** @type {Map<string, Map<string,string>>} */
  const services = new Map();
  let current = null; // Map<key, value> | null
  let envIndent = -1;

  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    if (/^\S/.test(line)) break; // 下一个顶层键（volumes:/networks:…）结束 services

    const indent = line.length - line.trimStart().length;

    if (indent <= 2) {
      // 新的服务头（不管它尾巴上跟着注释还是锚点）
      const m = /^ {2}([A-Za-z0-9._-]+):/.exec(line);
      current = m ? new Map() : null;
      if (m && !services.has(m[1])) services.set(m[1], current);
      envIndent = -1;
      continue;
    }
    if (current === null) continue;

    if (envIndent < 0) {
      if (/^\s+environment:[ \t]*(?:#.*)?$/.test(line)) {
        envIndent = indent;
      }
      continue;
    }
    if (indent <= envIndent) {
      envIndent = -1; // environment 块结束（depends_on: / healthcheck: …）
      continue;
    }

    const kv = /^\s*([A-Za-z_][A-Za-z0-9_]*):[ \t]*(.*)$/.exec(line);
    if (kv) {
      current.set(kv[1], resolveEnvLiteral(kv[2]));
      continue;
    }
    const item = /^\s*-[ \t]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (item) {
      current.set(item[1], resolveEnvLiteral(item[2]));
    }
  }
  return services;
}

/** 兼容旧签名：返回指定服务 environment 的**键集合**（不判空值，判据请用 parseComposeServices）。 */
export function parseServiceEnvKeys(yamlText, serviceName) {
  const services = parseComposeServices(yamlText);
  return new Set(services?.get(serviceName)?.keys() ?? []);
}

/**
 * 剥掉 JS/TS 源码里的注释（保留字符串字面量、保留长度与换行）。
 *
 * 为什么需要：`// this.config.get<string>("REGISTRY_PASS")` 是注释掉的读取，
 * 旧实现当成「代码里读了这个键」，判据 B 于是要求一个已经不需要的键（假红），
 * 同时把真正读到的键（写成注释示例后）当成不存在（假绿）。
 *
 * 长度/换行保持不变，所以行号仍然对得上；手写状态机而不是正则，避免
 * `"http://x"` 里的 `//` 把后文整段吃掉。
 */
export function stripJsComments(src) {
  const s = String(src ?? "");
  let out = "";
  let quote = null;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    const n = s[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") {
        if (n !== undefined) {
          out += n;
          i += 1;
        }
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      out += c;
      continue;
    }
    if (c === "/" && n === "/") {
      while (i < s.length && s[i] !== "\n") {
        out += " ";
        i += 1;
      }
      if (i < s.length) out += "\n";
      continue;
    }
    if (c === "/" && n === "*") {
      out += "  ";
      i += 2;
      while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) {
        out += s[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      if (i < s.length) {
        out += "  ";
        i += 1;
      }
      continue;
    }
    out += c;
  }
  return out;
}

/** 从 controller 源码里抽 `config.get("<KEY>")` 的键名（注释先剥掉）。 */
export function parseControllerConfigKeys(src) {
  const keys = new Set();
  const re = /config\.get<[^>]*>\(\s*"([A-Za-z0-9_.]+)"\s*\)/g;
  let m;
  const clean = stripJsComments(src);
  while ((m = re.exec(clean)) !== null) keys.add(m[1]);
  return keys;
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
  const stats = {
    services: 0,
    adminEnvKeys: 0,
    controllerKeys: 0,
    required: REQUIRED_ADMIN_API_REGISTRY_KEYS.length,
    bareKeys: 0,
  };

  /** @type {Map<string,string>|null} */
  let adminEnv = null;

  // ── ① compose：必需键 + 非空值 ────────────────────────────────────────────
  const composeAbs = join(root, COMPOSE_REL);
  if (!existsSync(composeAbs)) {
    structure.push(
      `事实源缺失：${COMPOSE_REL} —— 判据无从校验（目录改名/在子目录跑都会这样，不是「没问题」）。`,
    );
  } else {
    const services = parseComposeServices(readFileSync(composeAbs, "utf8"));
    if (services === null) {
      structure.push(
        `无法解析 ${COMPOSE_REL} 的顶层 services: 块 —— 结构变了，扫描器失效。`,
      );
    } else {
      stats.services = services.size;
      if (services.size < MIN_COMPOSE_SERVICES) {
        structure.push(
          `只解析到 ${services.size} 个服务（下界 ${MIN_COMPOSE_SERVICES}）—— ` +
            `${COMPOSE_REL} 的结构变了，扫描器失效（不是「全部合规」）。`,
        );
      }
      adminEnv = services.get(SERVICE_NAME) ?? null;
      if (adminEnv === null) {
        structure.push(
          `${COMPOSE_REL} 里没有 \`${SERVICE_NAME}\` 服务块 —— 注入契约无处落地，判据失效。`,
        );
      } else {
        stats.adminEnvKeys = adminEnv.size;
        if (adminEnv.size < MIN_ADMIN_ENV_KEYS) {
          structure.push(
            `${SERVICE_NAME} 的 environment 只解析到 ${adminEnv.size} 个键（下界 ${MIN_ADMIN_ENV_KEYS}）—— ` +
              "YAML 结构变了（列表形态？缩进变了？），扫描器失效。",
          );
        }
        for (const key of REQUIRED_ADMIN_API_REGISTRY_KEYS) {
          if (!adminEnv.has(key)) {
            errors.push(
              `${COMPOSE_REL} 的 ${SERVICE_NAME} 服务块缺少 ${key}（registry 上游将不可达 → 列表代理 502）`,
            );
          } else if (!adminEnv.get(key)) {
            errors.push(
              `${COMPOSE_REL} 的 ${SERVICE_NAME}.${key} 解析后是**空值**（原始值 ${JSON.stringify(
                String(adminEnv.get(key)),
              )}）—— 容器内会回落到 localhost，与「没注入」在生产上等价`,
            );
          }
        }
      }
    }
  }

  // ── ② controller：读到的裸键必须有出处 ────────────────────────────────────
  const controllerAbs = join(root, CONTROLLER_REL);
  if (!existsSync(controllerAbs)) {
    structure.push(
      `事实源缺失：${CONTROLLER_REL} —— 判据 ② 的读取面不在，无从校验（改路径/移动模块都会这样）。`,
    );
  } else {
    const keys = parseControllerConfigKeys(readFileSync(controllerAbs, "utf8"));
    stats.controllerKeys = keys.size;
    if (keys.size < MIN_CONTROLLER_KEYS) {
      structure.push(
        `只从 ${CONTROLLER_REL} 解析到 ${keys.size} 个 config.get 键（下界 ${MIN_CONTROLLER_KEYS}）—— ` +
          "扫描器失效，判据会变成永真。",
      );
    }
    const bareKeys = [...keys].filter((k) => /REGISTRY/.test(k) && !k.includes("."));
    stats.bareKeys = bareKeys.length;
    if (bareKeys.length === 0) {
      structure.push(
        `${CONTROLLER_REL} 里没有解析到任何 registry 裸键 —— 扫描器失效（判据会变成永真）。`,
      );
    } else if (adminEnv !== null) {
      for (const key of bareKeys) {
        const ex = BARE_KEY_EXEMPTIONS[key];
        if (ex?.optional) continue;
        if (ex?.coveredBy) {
          if (!adminEnv.has(ex.coveredBy)) {
            errors.push(
              `registry.controller.ts 读取 ${key}，约定由 ${ex.coveredBy} 派生（${ex.why}），` +
                `但 ${COMPOSE_REL} 的 ${SERVICE_NAME} 没有 ${ex.coveredBy} —— 这条豁免不成立`,
            );
          } else if (!adminEnv.get(ex.coveredBy)) {
            errors.push(
              `registry.controller.ts 读取 ${key}，派生源 ${ex.coveredBy} 解析后是空值 —— 等于没注入`,
            );
          }
          continue;
        }
        if (!adminEnv.has(key)) {
          errors.push(
            `registry.controller.ts 读取 ${key}，但 ${COMPOSE_REL} 的 ${SERVICE_NAME} 未注入该键`,
          );
        } else if (!adminEnv.get(key)) {
          errors.push(
            `registry.controller.ts 读取 ${key}，${SERVICE_NAME}.${key} 解析后是空值 —— 等于没注入`,
          );
        }
      }
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

/** admin-api 的默认 env 行（4 个必需键 + 16 个填充键 = 20 > MIN_ADMIN_ENV_KEYS）。 */
const DEFAULT_ADMIN_ENV = [
  `ADMIN_PYPI_REGISTRY_URL: \${ADMIN_PYPI_REGISTRY_URL-http://registry-pypi:8003}`,
  `NPM_REGISTRY_URL: \${NPM_REGISTRY_URL-http://registry-npm:4873}`,
  `REGISTRY_USER: \${REGISTRY_USER:-admin}`,
  `REGISTRY_PASS: \${REGISTRY_PASS:?set REGISTRY_PASS in .env}`,
  ...Array.from({ length: 16 }, (_, i) => `FILL_${String(i).padStart(2, "0")}: 'x'`),
];

/**
 * compose fixture。
 * @param {{adminEnv?: string[]|null, adminHeader?: string, sibling?: string, filler?: number}} [opts]
 *   adminEnv=null → 不写 environment 块；adminHeader → 服务头原文（可带尾注/锚点）。
 */
function composeFixture(opts = {}) {
  const { adminEnv = DEFAULT_ADMIN_ENV, adminHeader = `  ${SERVICE_NAME}:`, sibling = "", filler = 12 } = opts;
  const envBlock = adminEnv === null ? [] : ["    environment:", ...adminEnv.map((l) => "      " + l)];
  return (
    [
      "# fixture compose（注释行不算配置）",
      "services:",
      adminHeader,
      "    image: acf/admin-api",
      ...envBlock,
      "    depends_on:",
      "      postgres:",
      "        condition: service_healthy",
      sibling,
      fillerServices(filler),
      "volumes:",
      "  data:",
    ]
      .filter((l) => l !== "")
      .join("\n") + "\n"
  );
}

/** controller fixture：12 个 config.get 键（> MIN_CONTROLLER_KEYS=6），含 6 个 registry 裸键。 */
const CONTROLLER_SRC = [
  "export class RegistryController {",
  "  private base() {",
  '    const pypi = this.config.get<string>("registry.pypi.url");',
  '    const npm = this.config.get<string>("registry.npm.url");',
  '    const u = this.config.get<string>("registry.pypi.user");',
  '    const n = this.config.get<string>("registry.npm.user");',
  '    const fb = this.config.get<string>("PYPI_REGISTRY_URL");',
  '    const nurl = this.config.get<string>("NPM_REGISTRY_URL");',
  '    const user = this.config.get<string>("REGISTRY_USER");',
  '    const pass = this.config.get<string>("REGISTRY_PASS");',
  '    const t = this.config.get<string>("REGISTRY_UPLOAD_TIMEOUT_MS");',
  '    const nu = this.config.get<string>("NPM_REGISTRY_USER");',
  "    return { pypi, npm, u, n, fb, nurl, user, pass, t, nu };",
  "  }",
  "}",
].join("\n") + "\n";

const tree = ({ compose: c = composeFixture(), controller = CONTROLLER_SRC } = {}) => {
  const files = { "package.json": { name: "fixture", private: true } };
  if (c !== null) files[COMPOSE_REL] = c;
  if (controller !== null) files[CONTROLLER_REL] = controller;
  return files;
};

/**
 * 自检：11 条子进程用例。
 *
 * 每条都断言退出码 + 关键文本：本脚本的历史事故形态全在 **CLI/解析层**
 * （`process.exit` 是否执行、兄弟服务顶包、空值算注入、注释算数、事实源缺失时
 * 崩栈还是结构红）。旧版 selftest 只数 `missing.length`，对这些全盲。
 */
export function selftest() {
  const cases = [];
  const subprocess = (name, files, expect) => {
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(files, { prefix: "compose-service-env-selftest-" });
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

  subprocess("① 合规树：4 个必需键非空 + controller 裸键均有出处 → 绿", tree(), {
    code: 0,
    contains: ["守卫通过", "已注入 4 个必需", "扫了 13 个服务", "6 个裸键"],
    absent: ["✖", "结构错误", "缺少"],
  });

  subprocess(
    "② 缺键：admin-api 没有 NPM_REGISTRY_URL → 红（点名 502）",
    tree({
      compose: composeFixture({
        adminEnv: DEFAULT_ADMIN_ENV.filter((l) => !l.startsWith("NPM_REGISTRY_URL")),
      }),
    }),
    {
      code: 1,
      contains: ["缺少 NPM_REGISTRY_URL", "列表代理 502"],
      absent: ["守卫通过"],
    },
  );

  subprocess(
    "③ 【反证·兄弟服务顶包】admin-api 缺 4 键、兄弟服务头带尾注并带全 4 键 → 仍红",
    tree({
      compose: composeFixture({
        adminEnv: DEFAULT_ADMIN_ENV.filter(
          (l) => !/^(ADMIN_PYPI_REGISTRY_URL|NPM_REGISTRY_URL|REGISTRY_USER|REGISTRY_PASS):/.test(l),
        ),
        sibling: [
          "  registry-pypi: # 上游仓库（尾注让旧解析器结束不了 admin-api 的块）",
          "    image: registry",
          "    environment:",
          "      ADMIN_PYPI_REGISTRY_URL: http://registry-pypi:8003",
          "      NPM_REGISTRY_URL: http://registry-npm:4873",
          "      REGISTRY_USER: admin",
          "      REGISTRY_PASS: secret",
          "",
        ].join("\n"),
      }),
    }),
    {
      code: 1,
      contains: ["缺少 ADMIN_PYPI_REGISTRY_URL", "缺少 NPM_REGISTRY_URL", "缺少 REGISTRY_USER"],
      absent: ["守卫通过"],
    },
  );

  subprocess(
    "④ 【反证·注释算数】必需键只写在注释里 → 红（注释不是配置）",
    tree({
      compose: composeFixture({
        adminEnv: [
          "      # ADMIN_PYPI_REGISTRY_URL: http://registry-pypi:8003  ← 注释掉的旧值",
          "      # NPM_REGISTRY_URL: http://registry-npm:4873",
          "      # REGISTRY_USER: admin",
          "      # REGISTRY_PASS: secret",
          ...DEFAULT_ADMIN_ENV.filter((l) => l.startsWith("FILL_")),
        ],
      }),
    }),
    {
      code: 1,
      contains: ["缺少 ADMIN_PYPI_REGISTRY_URL", "缺少 REGISTRY_PASS"],
      absent: ["守卫通过"],
    },
  );

  subprocess(
    "⑤ 【反证·空值算注入】NPM_REGISTRY_URL: \"\" → 红（键在、值为空 = 没注入）",
    tree({
      compose: composeFixture({
        adminEnv: DEFAULT_ADMIN_ENV.map((l) =>
          l.startsWith("NPM_REGISTRY_URL") ? 'NPM_REGISTRY_URL: ""' : l,
        ),
      }),
    }),
    {
      code: 1,
      contains: ["NPM_REGISTRY_URL 解析后是**空值**", "回落到 localhost"],
      absent: ["守卫通过"],
    },
  );

  subprocess(
    "⑥ 【反证·空默认值】ADMIN_PYPI_REGISTRY_URL: ${ADMIN_PYPI_REGISTRY_URL:-} → 红",
    tree({
      compose: composeFixture({
        adminEnv: DEFAULT_ADMIN_ENV.map((l) =>
          l.startsWith("ADMIN_PYPI_REGISTRY_URL")
            ? "ADMIN_PYPI_REGISTRY_URL: ${ADMIN_PYPI_REGISTRY_URL:-}"
            : l,
        ),
      }),
    }),
    {
      code: 1,
      contains: ["ADMIN_PYPI_REGISTRY_URL 解析后是**空值**"],
      absent: ["守卫通过"],
    },
  );

  subprocess(
    "⑦ 列表形态 `- KEY=value` 也能识别 → 绿（不误红）",
    tree({
      compose: composeFixture({
        adminEnv: [
          "- ADMIN_PYPI_REGISTRY_URL=http://registry-pypi:8003",
          "- NPM_REGISTRY_URL=http://registry-npm:4873",
          "- REGISTRY_USER=admin",
          "- REGISTRY_PASS=secret # 行内注释",
          ...Array.from({ length: 16 }, (_, i) => `FILL_${String(i).padStart(2, "0")}: 'x'`),
        ],
      }),
    }),
    { code: 0, contains: ["守卫通过"], absent: ["结构错误", "缺少"] },
  );

  subprocess(
    "⑧ 事实源缺失（docker-compose.yml 不在）→ 结构红，不是崩栈也不是绿",
    tree({ compose: null }),
    {
      code: 1,
      contains: ["结构错误", `事实源缺失：${COMPOSE_REL}`],
      absent: ["守卫通过", "Error:", "ENOENT"],
    },
  );

  subprocess(
    "⑨ 事实源缺失（controller 不在）→ 结构红",
    tree({ controller: null }),
    {
      code: 1,
      contains: ["结构错误", `事实源缺失：${CONTROLLER_REL}`],
      absent: ["守卫通过", "Error:"],
    },
  );

  subprocess(
    "⑩ 【反证·扫描面】services 只剩 2 个 → 结构红（不是「全部合规」）",
    tree({ compose: composeFixture({ filler: 1 }) }),
    {
      code: 1,
      contains: ["结构错误", "只解析到 2 个服务", `下界 ${MIN_COMPOSE_SERVICES}`],
      absent: ["守卫通过"],
    },
  );

  subprocess(
    "⑪ 【反证·扫描面】controller 的 config.get 全被注释 → 结构红（判据会永真）",
    tree({
      controller: [
        "// this.config.get<string>(\"registry.pypi.url\");",
        "// this.config.get<string>(\"NPM_REGISTRY_URL\");",
        "// this.config.get<string>(\"REGISTRY_USER\");",
        "export const nothing = 1;",
      ].join("\n") + "\n",
    }),
    {
      code: 1,
      contains: ["结构错误", "解析到 0 个 config.get 键", `下界 ${MIN_CONTROLLER_KEYS}`],
      absent: ["守卫通过"],
    },
  );

  const failed = reportCases(cases, { title: "check-compose-service-env selftest" });
  if (failed > 0) process.exit(1);
}

// ── CLI ────────────────────────────────────────────────────────────────────
const invoked = process.argv[1]?.replace(/\\/g, "/").split("/").pop();

if (invoked === "check-compose-service-env.mjs") {
  if (process.argv.includes("--selftest")) {
    selftest();
  } else {
    const root = resolve(argValue(process.argv, "--root") ?? process.cwd());
    const { errors, structure, stats } = check(root);

    if (structure.length > 0) {
      console.error("");
      console.error("✖ compose 服务地址注入守卫结构错误（判据本身不可信，先修扫描面）：");
      for (const e of structure) console.error("  · " + e);
      console.error("");
      process.exit(1);
    }

    if (errors.length > 0) {
      console.error("");
      console.error(`✖ compose 服务地址注入守卫发现 ${errors.length} 个问题：`);
      for (const e of errors) console.error("  · " + e);
      console.error("");
      console.error(
        "  修法：在 docker-compose.yml 的 admin-api environment 里补上这些键（值指向 compose 服务名），",
      );
      console.error("  并同步 .env.example 文档。");
      process.exit(1);
    }

    console.log(
      `✔ compose 服务地址注入守卫通过（admin-api 已注入 ${stats.required} 个必需 registry 键且值非空；` +
        `controller 读取的 ${stats.bareKeys} 个裸键均有出处；` +
        `扫了 ${stats.services} 个服务 / admin-api ${stats.adminEnvKeys} 个 env 键）`,
    );
  }
}

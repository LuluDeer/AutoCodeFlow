#!/usr/bin/env node
/**
 * 「compose 里的服务地址必须真的被注入」守卫（2026-10-23 真机缺陷的钉子）。
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
 * ## 判据（只判确定能判的）
 *
 * A. 服务块互引：compose 里**任何**服务的 environment 值若引用了
 *    `registry-pypi` / `registry-npm` 的服务名，则该引用的变量名必须也出现在
 *    消费它的服务的 environment 里——这里简化为：admin-api 块必须包含
 *    该服务所需的 registry 键（下面 REQUIRED 列出的）。
 * B. 反向：`registry.controller.ts` 里 `config.get("<KEY>")` 读取的
 *    registry 键，必须能在 compose 的 admin-api environment 里找到
 *    （或其映射节由同名 env 派生）。
 *
 * 判据刻意**不做**「值对不对」的检查（拓扑会变），只钉「键在不在」——
 * 这一类漏接是静默的，而且只在真机上炸。
 *
 * 用法：node scripts/check-compose-service-env.mjs [--selftest]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const COMPOSE = join(ROOT, "docker-compose.yml");
const CONTROLLER = join(
  ROOT,
  "apps",
  "admin-api",
  "src",
  "modules",
  "registry",
  "registry.controller.ts",
);

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

/** 极简 compose 解析：只取 `services.<name>.environment` 的键集合。 */
export function parseServiceEnvKeys(yamlText, serviceName) {
  const lines = yamlText.split("\n");
  const keys = new Set();
  let inService = false;
  let serviceIndent = 0;
  let inEnv = false;
  let envIndent = 0;

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;

    // 进入目标服务块
    const svcMatch = /^(\s*)([A-Za-z0-9._-]+):\s*$/.exec(line);
    if (svcMatch && indent === 2 && !inService) {
      if (svcMatch[2] === serviceName) {
        inService = true;
        serviceIndent = indent;
        continue;
      }
    }
    if (inService && svcMatch && indent <= serviceIndent) {
      // 同级或更外层的新键 = 服务块结束
      inService = false;
      inEnv = false;
      continue;
    }
    if (!inService) continue;

    if (/^\s*environment:\s*$/.test(line)) {
      inEnv = true;
      envIndent = indent;
      continue;
    }
    if (inEnv) {
      if (indent <= envIndent) {
        inEnv = false;
        continue;
      }
      const m = /^\s*([A-Z][A-Z0-9_]*):/.exec(line);
      if (m) keys.add(m[1]);
    }
  }
  return keys;
}

/** 从 controller 源码里抽 `config.get("<KEY>")` 的键名。 */
export function parseControllerConfigKeys(src) {
  const keys = new Set();
  const re = /config\.get<[^>]*>\(\s*"([A-Za-z0-9_.]+)"\s*\)/g;
  let m;
  while ((m = re.exec(src)) !== null) keys.add(m[1]);
  return keys;
}

// ── 反例夹具 ────────────────────────────────────────────────────────────────
const FIXTURES = {
  /** 缺键：admin-api 没有 registry 键 → 必须红。 */
  missing: `services:
  admin-api:
    environment:
      NODE_ENV: production
    depends_on:
      postgres:
        condition: service_healthy
  registry-pypi:
    environment:
      REGISTRY_USER: admin
`,
  /** 齐全 → 必须绿。 */
  complete: `services:
  admin-api:
    environment:
      ADMIN_PYPI_REGISTRY_URL: http://registry-pypi:8003
      NPM_REGISTRY_URL: http://registry-npm:4873
      REGISTRY_USER: admin
      REGISTRY_PASS: secret
  registry-pypi:
    environment:
      REGISTRY_USER: admin
`,
};

function auditCompose(yamlText, required) {
  const keys = parseServiceEnvKeys(yamlText, "admin-api");
  return required.filter((k) => !keys.has(k));
}

function runSelftest() {
  const checks = [
    ["missing", 4],
    ["complete", 0],
  ];
  let failures = 0;
  for (const [name, expected] of checks) {
    const missing = auditCompose(FIXTURES[name], REQUIRED_ADMIN_API_REGISTRY_KEYS);
    const ok = missing.length === expected;
    if (ok) {
      console.log(
        `✅ 有齿：${name} → 缺 ${missing.length} 个键（期望 ${expected}）`,
      );
    } else {
      failures++;
      console.error(
        `✗ 失齿：${name} → 缺 ${missing.length} 个键（期望 ${expected}）：${missing.join(", ")}`,
      );
    }
  }

  // controller 键解析也要有齿：正则失效会让判据变成永真。
  const sample = `this.config.get<string>("registry.pypi.url"); this.config.get<string>("PYPI_REGISTRY_URL");`;
  const parsed = parseControllerConfigKeys(sample);
  if (parsed.size === 2) {
    console.log("✅ 有齿：controller 键解析抓到 2 个键");
  } else {
    failures++;
    console.error(`✗ 失齿：controller 键解析只抓到 ${parsed.size} 个键`);
  }

  if (failures > 0) {
    console.error(`\n${failures} 项反例测试失败\n`);
    process.exit(1);
  }
  console.log("\n反例测试全部通过\n");
}

function main() {
  const yamlText = readFileSync(COMPOSE, "utf8");
  const controllerSrc = readFileSync(CONTROLLER, "utf8");

  const problems = [];

  // 判据 A：必需的部署键
  const missing = auditCompose(yamlText, REQUIRED_ADMIN_API_REGISTRY_KEYS);
  for (const k of missing) {
    problems.push(
      `docker-compose.yml 的 admin-api 服务块缺少 ${k}（registry 上游将不可达 → 列表代理 502）`,
    );
  }

  // 判据 B：controller 读的裸 registry 键必须在 compose 里有出处
  const controllerKeys = parseControllerConfigKeys(controllerSrc);
  const adminEnv = parseServiceEnvKeys(yamlText, "admin-api");
  const registryBareKeys = [...controllerKeys].filter((k) =>
    /REGISTRY/.test(k) && !k.includes("."),
  );
  if (registryBareKeys.length === 0) {
    problems.push(
      "registry.controller.ts 里没有解析到任何 registry 相关 config.get 键——扫描器可能失效（判据会变成永真）",
    );
  }
  for (const k of registryBareKeys) {
    // 映射节（registry.pypi.url / registry.npm.url）由 ADMIN_PYPI_* / NPM_REGISTRY_URL 派生，
    // 裸键本身可以不出现；这里只要求「至少有一个出处」，故跳过映射节派生键。
    if (k === "PYPI_REGISTRY_URL") continue;
    if (k === "NPM_REGISTRY_USER" || k === "NPM_REGISTRY_PASS" || k === "NPM_REGISTRY_TOKEN") {
      // 可选服务账号：不配也能跑（匿名 401 会如实 502），不列为必需
      continue;
    }
    if (k === "REGISTRY_UPLOAD_TIMEOUT_MS") {
      // 可选调优键：controller 有 60s 缺省，不注入不改变可达性
      continue;
    }
    if (!adminEnv.has(k)) {
      problems.push(
        `registry.controller.ts 读取 ${k}，但 docker-compose.yml 的 admin-api 未注入该键`,
      );
    }
  }

  if (problems.length > 0) {
    console.error("");
    console.error(`✖ compose 服务地址注入守卫发现 ${problems.length} 个问题：`);
    for (const p of problems) console.error("  · " + p);
    console.error("");
    console.error(
      "  修法：在 docker-compose.yml 的 admin-api environment 里补上这些键（值指向 compose 服务名），",
      "并同步 .env.example 文档。",
    );
    process.exit(1);
  }

  console.log(
    `✔ compose 服务地址注入守卫通过（admin-api 已注入 ${REQUIRED_ADMIN_API_REGISTRY_KEYS.length} 个必需 registry 键；controller 读取的 ${registryBareKeys.length} 个裸键均有出处）`,
  );
}

if (process.argv.includes("--selftest")) {
  runSelftest();
} else {
  main();
}

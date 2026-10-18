#!/usr/bin/env node
// VSCode 调试配置生成器（PLAN-DEVELOPER-EXPERIENCE §5.3）
//
// 为什么是「生成」而不是「直接入库 .vscode/launch.json」：
// 本仓 .gitignore:31 刻意忽略 `.vscode/`（与 .idea/ 等并列，属「编辑器/IDE
// 个人配置不入库」的既有策略）。直接改 .gitignore 去入库个人 IDE 配置，
// 与该策略冲突，且会给所有人强推同一份 launch.json（每个人本地的端口、
// 附加进程习惯不同）。因此模板入库到 docs/，本脚本把它复制到 .vscode/。
//
// 纪律：模板里的每条配置必须与**仓库真实脚本**逐字对应（command /
// program / cwd）。脚本名改了而模板没改，调试会静默失效——所以本脚本带
// 一个校验：模板里出现的 `npm run <script>` 必须在对应 app 的 package.json
// 里真实存在，否则直接报错退出。
//
// 退出码：0 = 生成成功且校验通过；1 = 校验失败。
//
// 用法：
//   node scripts/gen-vscode-launch.mjs           # 生成 .vscode/launch.json
//   node scripts/gen-vscode-launch.mjs --check   # 只校验模板与真实脚本是否同步

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const TEMPLATE = join(ROOT, "docs", "vscode-launch.template.json");
const TARGET = join(ROOT, ".vscode", "launch.json");

// 模板里引用到的 app → 其 package.json 必须真的定义了对应 script。
const APP_PACKAGE_JSON = {
  "apps/admin-api": join(ROOT, "apps", "admin-api", "package.json"),
  "apps/admin-web": join(ROOT, "apps", "admin-web", "package.json"),
  "apps/executor-desktop": join(ROOT, "apps", "executor-desktop", "package.json"),
  "apps/executor-node": join(ROOT, "apps", "executor-node", "package.json"),
};

/** 去掉 // 行注释，把 JSONC 变成可解析的 JSON。 */
function stripLineComments(text) {
  return text.replace(/^\s*\/\/.*$/gm, "");
}

function loadTemplate() {
  const raw = readFileSync(TEMPLATE, "utf8");
  return { raw, parsed: JSON.parse(stripLineComments(raw)) };
}

/**
 * 校验模板里的每个 `npm run <script>` 都真实存在。
 *
 * 只校验 `npm run X` 形态（模板里所有 npm 调用都是这个形态）；`npx` 调用
 * 指向的是包内可执行文件，由下面的 program 存在性检查覆盖。
 */
export function validateScripts(configs) {
  const errors = [];
  const pkgCache = new Map();

  for (const cfg of configs) {
    const cwd = cfg.cwd ?? "";
    const runtimeExecutable = cfg.runtimeExecutable ?? "";
    const runtimeArgs = cfg.runtimeArgs ?? [];
    if (runtimeExecutable !== "npm") continue;
    if (runtimeArgs[0] !== "run") continue;
    const scriptName = runtimeArgs[1];
    if (typeof scriptName !== "string") continue;

    // 从 ${workspaceFolder}/apps/xxx 还原出相对路径
    const relApp = String(cwd).replace("${workspaceFolder}/", "");
    const pkgPath = APP_PACKAGE_JSON[relApp];
    if (!pkgPath) {
      errors.push(
        `配置「${cfg.name}」的 cwd=${relApp} 不在已知 app 列表内，无法校验 script「${scriptName}」`,
      );
      continue;
    }

    if (!pkgCache.has(pkgPath)) {
      if (!existsSync(pkgPath)) {
        errors.push(`找不到 ${pkgPath}（配置「${cfg.name}」）`);
        continue;
      }
      pkgCache.set(pkgPath, JSON.parse(readFileSync(pkgPath, "utf8")));
    }
    const scripts = pkgCache.get(pkgPath)?.scripts ?? {};
    if (!(scriptName in scripts)) {
      errors.push(
        `配置「${cfg.name}」引用了不存在的 script：${relApp} 的 package.json 里没有「${scriptName}」` +
          `（现有：${Object.keys(scripts).join(", ")}）`,
      );
    }
  }
  return errors;
}

/**
 * 校验 `program` 指向的入口文件在**构建产物**层面是否合理。
 *
 * 这里只校验「路径形态」而非文件是否存在：dist/ 是构建产物，全新 clone
 * 里本来就不存在，强制存在性会让生成器在干净环境下必红。改为校验
 * program 与对应 app 的 package.json `main` 字段一致（若该 app 声明了 main）。
 */
export function validatePrograms(configs) {
  const errors = [];
  for (const cfg of configs) {
    const program = cfg.program;
    if (typeof program !== "string") continue;
    const rel = program.replace("${workspaceFolder}/", "");
    // 只校验落在某个已知 app 下的 program
    const appKey = Object.keys(APP_PACKAGE_JSON).find((app) => rel.startsWith(`${app}/`));
    if (!appKey) continue;
    const pkgPath = APP_PACKAGE_JSON[appKey];
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (typeof pkg.main !== "string") continue;
    const expected = `${appKey}/${pkg.main}`.replace(/\\/g, "/");
    if (rel !== expected) {
      errors.push(
        `配置「${cfg.name}」的 program 是 ${rel}，但 ${appKey} 的 package.json main 是 ${pkg.main}` +
          `（应为 ${expected}）——两者漂移时调试会启动到错误入口`,
      );
    }
  }
  return errors;
}

function main() {
  let template;
  try {
    template = loadTemplate();
  } catch (error) {
    console.error(`✗ 无法解析模板 ${TEMPLATE}：${error.message}`);
    return 1;
  }

  const configs = template.parsed.configurations ?? [];
  if (configs.length === 0) {
    console.error("✗ 模板里没有任何调试配置");
    return 1;
  }

  const errors = [...validateScripts(configs), ...validatePrograms(configs)];
  if (errors.length > 0) {
    console.error("✗ VSCode 调试模板与真实脚本不同步：");
    for (const error of errors) console.error(`  - ${error}`);
    return 1;
  }

  if (process.argv.includes("--check")) {
    console.log(
      `✓ VSCode 调试模板校验通过（${configs.length} 条配置，script / program 与各 app 真实入口一致）`,
    );
    return 0;
  }

  mkdirSync(dirname(TARGET), { recursive: true });
  writeFileSync(TARGET, template.raw, "utf8");
  console.log(
    `✓ 已生成 .vscode/launch.json（${configs.length} 条配置）。` +
      `该目录被 .gitignore 忽略，属个人本地配置；模板在 docs/vscode-launch.template.json 受版本控制。`,
  );
  return 0;
}

process.exit(main());

#!/usr/bin/env node
/**
 * R235：**统一的 Python 解释器探测** —— 让 `test:python` 等脚本在任何发行版上都能跑。
 *
 * ## 背景（真实可移植性缺陷）
 *
 * 7 个 `test:*` 脚本硬编码了 `python -m pytest`。而：
 * - **Ubuntu ≥ 20.04 不再提供 `python` 别名**（本机 26.04 实测 `/usr/bin/python` 不存在）
 *   ⇒ 这些脚本在较新发行版上**全部 `exit 127`**（`sh: python: not found`）。
 * - CI（GitHub `ubuntu-latest`）**恰好自带 `python` 别名** ⇒ 这个缺陷在 CI 上**从未暴露**。
 *
 * 单纯把 `python` 换成 `python3` **不够**：本仓库的 Python 测试需要**项目自己的依赖**
 * （fastapi / httpx / sqlalchemy / respx / tenacity …），而系统 `python3` 通常没有
 * ⇒ 换成 `python3` 后仍会 `Interrupted: 51 errors during collection`（实测）。
 *
 * ## 探测顺序（与仓内既有约定 `scripts/e2e-full.sh:377` **同一顺序**）
 *
 *  ① `<project>/.venv/bin/python`（POSIX venv）
 *  ② `<project>/.venv/Scripts/python.exe`（Windows venv）
 *  ③ `python3`（系统，需能 import 项目依赖）
 *  ④ `python`（老发行版 / CI 别名）
 *
 * ## 用法
 *
 * ```bash
 * node scripts/py.mjs apps/executor-python -m pytest -q
 * ```
 * 第一个参数是**项目目录**（用于找它的 `.venv`），其余原样传给解释器。
 *
 * ## 为什么失败要显式报错并给修法
 *
 * 「找不到解释器」与「测试失败」是**两件不同的事**。若这里静默退回某个裸 `python3`，
 * 用户会看到 51 条 collection error，而真正的原因（缺依赖）被埋在下面
 * （本仓主导缺陷类：**把「环境没准备好」渲染成「代码坏了」**）。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

/**
 * 探测某个项目可用的 Python 解释器。
 *
 * @param {string} projectDir 项目目录（相对仓库根或绝对）
 * @param {string[]} probeImports 需要能 import 的模块（用于验证候选解释器真的可用）
 * @returns {{ ok: true, python: string, source: string } | { ok: false, reason: string }}
 */
export function detectPython(projectDir = "apps/executor-python", probeImports = []) {
  const abs = resolve(ROOT, projectDir);
  const candidates = [];
  const posixVenv = join(abs, ".venv", "bin", "python");
  const winVenv = join(abs, ".venv", "Scripts", "python.exe");
  if (existsSync(posixVenv)) candidates.push({ python: posixVenv, source: "项目 .venv (POSIX)" });
  if (existsSync(winVenv)) candidates.push({ python: winVenv, source: "项目 .venv (Windows)" });
  candidates.push({ python: "python3", source: "系统 python3" });
  candidates.push({ python: "python", source: "系统 python（旧发行版/CI 别名）" });

  const importCheck =
    probeImports.length > 0
      ? `import ${probeImports.join(", ")}`
      : null;

  for (const c of candidates) {
    // ① 解释器存在且能跑
    const ver = spawnSync(c.python, ["--version"], { encoding: "utf8" });
    if (ver.error || ver.status !== 0) continue;
    // ② 能 import 项目依赖（没给 probe 就跳过这一检）
    if (importCheck) {
      const imp = spawnSync(c.python, ["-c", importCheck], { encoding: "utf8" });
      if (imp.status !== 0) continue;
    }
    return { ok: true, python: c.python, source: c.source };
  }

  return {
    ok: false,
    reason:
      `在 ${projectDir} 找不到可用的 Python 解释器` +
      (probeImports.length
        ? `（已尝试的候选都无法 import：${probeImports.join(", ")}）`
        : "（python3 / python 都不存在）"),
  };
}

/** 从该项目的 requirements-dev.txt 里推断「应该能 import 什么」（仅用于诊断提示）。 */
function hintFor(projectDir) {
  const dev = join(ROOT, projectDir, "requirements-dev.txt");
  if (existsSync(dev)) {
    return `补依赖：cd ${projectDir} && .venv/bin/python -m pip install -r requirements-dev.txt`;
  }
  return `补依赖：见 .github/workflows/ci.yml 里该项目 job 的 pip install 行`;
}

function main() {
  const [projectDir, ...rest] = process.argv.slice(2);
  if (!projectDir || rest.length === 0) {
    console.error(
      "用法：node scripts/py.mjs <项目目录> <python 参数...>\n" +
        "例：  node scripts/py.mjs apps/executor-python -m pytest -q",
    );
    process.exit(2);
  }

  // 探测时**不**强制 import 检查（不同项目依赖不同），只在失败时把提示写清楚。
  const found = detectPython(projectDir, []);
  if (!found.ok) {
    console.error(`✘ ${found.reason}`);
    console.error(`  修法：${hintFor(projectDir)}`);
    console.error(
      "  ⚠️ 这不等于「测试失败」——是**环境没准备好**（R235）。",
    );
    process.exit(127);
  }

  // ⚠️ `cwd` 必须是**该项目目录**：pytest 的相对路径（`tests`）与 rootdir（`pytest.ini`）
  //    都以它为基准。首版写成 `ROOT` ⇒ `test:python` 会去收集**仓库根**的测试
  //    （实测 50 个 collection error）、`lib-http` 直接报 `file or directory not found: tests`。
  const projectAbs = resolve(ROOT, projectDir);
  const r = spawnSync(found.python, rest, { stdio: "inherit", cwd: projectAbs });
  if (r.error) {
    console.error(`✘ 启动 ${found.source}（${found.python}）失败：${r.error.message}`);
    process.exit(127);
  }
  process.exit(r.status ?? 1);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
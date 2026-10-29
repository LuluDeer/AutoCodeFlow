/**
 * turbo 缓存键 ↔ admin-web 实际消费的 VITE_* 变量（漂移守卫）。
 *
 * 为什么需要它：`turbo.json` 的 `build:web.env` 是**缓存键的一部分**。变量没被
 * 声明时，turbo 只按 inputs 的哈希判缓存命中——改了 `VITE_REGISTRY_BASE_URL`
 * 或 `VITE_API_PROXY_TARGET` 仍然命中旧缓存，产出的是**指向旧地址的前端包**
 * （构建产物错误，而不是"只是慢"）。历史配置只声明了 `VITE_API_URL` 一个键，
 * 而源码实际读 7 个。
 *
 * 判据是双向的：源码里出现的每个 `VITE_*` 都必须在 env 列表里；列表里也不该
 * 留已经被删掉的变量（否则缓存键无谓地失效，热缓存永远命中不了）。
 *
 * 注意 turbo 目前**没有接线**（根 package.json 无 `turbo run` 调用）：本守卫
 * 保护的是"将来有人真的接上"那一天不踩坑，而不是声称它已在跑。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(process.cwd(), "../..");
const APP_ROOT = process.cwd();

/** 递归收集 src 下所有源码文本（跳过 node_modules/dist）。 */
function collectSourceText(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    // 只扫**生产**代码：测试文件里常有 `VITE_API_URL_*` 这类注释/前缀字符串，
    // 它们不是构建期真实消费的键，纳入比对会制造假红。
    if (
      entry === "node_modules" ||
      entry === "dist" ||
      entry === ".vite" ||
      entry === "__tests__"
    ) {
      continue;
    }
    if (/\\.test\\.|\\.spec\\./.test(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      collectSourceText(full, acc);
      continue;
    }
    if (/\.(ts|tsx|js|jsx|html|css)$/.test(entry)) {
      acc.push(readFileSync(full, "utf8"));
    }
  }
  return acc;
}

/**
 * 去掉注释再扫：`vite.config.ts` 的注释里写着 `process.env.VITE_API_URL_*`
 * （说明某段 define 已被删除），那是解释文本不是消费点。
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function usedViteVars(): Set<string> {
  const texts = [
    ...collectSourceText(join(APP_ROOT, "src")),
    readFileSync(join(APP_ROOT, "vite.config.ts"), "utf8"),
    readFileSync(join(APP_ROOT, "index.html"), "utf8"),
  ];
  const found = new Set<string>();
  for (const raw of texts) {
    for (const m of stripComments(raw).matchAll(/\bVITE_[A-Z0-9_]+\b/g)) {
      found.add(m[0]);
    }
  }
  return found;
}

describe("turbo.json build:web 缓存键覆盖 admin-web 的 VITE_* 变量", () => {
  it("源码消费的每个 VITE_* 都声明在 build:web.env 里", () => {
    const turbo = JSON.parse(readFileSync(join(REPO_ROOT, "turbo.json"), "utf8"));
    const declared = new Set<string>(turbo.tasks["build:web"].env ?? []);
    const used = [...usedViteVars()].sort();

    expect(used.length).toBeGreaterThan(0);
    expect([...declared].sort()).toEqual(used);
  });
});

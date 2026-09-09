#!/usr/bin/env node
// scripts/check-migrations.mjs 自检：临时目录构造迁移/注册表矩阵，断言全部判据。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanMigrations, parseRegistry, check } from "./check-migrations.mjs";

let failures = 0;
function assert(name, cond) {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.error(`  ✘ ${name}`);
  }
}

const tmp = mkdtempSync(join(tmpdir(), "acf-check-mig-"));
const migDir = join(tmp, "migrations");
mkdirSync(migDir);
writeFileSync(join(migDir, "1789500000000-A.ts"), "export class A {}");
writeFileSync(join(migDir, "1789500000000-B.ts"), "export class B {}"); // 撞号
writeFileSync(join(migDir, "1789600000000-C.ts"), "export class C {}");
writeFileSync(join(migDir, "1789600000000-C.spec.ts"), "spec 不计入");
writeFileSync(join(migDir, "NotAMigration.ts"), "辅助文件不计入");

const registry = `# 板

## 迁移时间戳分配表

| 时间戳 | 迁移 | 任务 | 备注 |
|---|---|---|---|
| 1789500000000 | A | CORE-04 | 已落盘 |
| 1789500000000 | B | CORE-04 | 同号双行=注册表内重复 |
| 1789700000000 | X | 预留 | 未落盘允许 |

## 变更日志
`;
const registryClean = registry.replace("| 1789500000000 | B | CORE-04 | 同号双行=注册表内重复 |\n", "");
const registryMissingC = registryClean.replace("| 1789600000000 | C |\n", ""); // C 未注册（fixture 本就没有 C 行，直接用 clean 也缺）

try {
  const scanned = scanMigrations(migDir);
  assert("scan 只计迁移本体（排除 spec/非迁移文件）", scanned.length === 3);

  const parsed = parseRegistry(registry);
  assert("注册表解析到 3 行", parsed.found && parsed.rows.length === 3);
  assert("无注册表段返回 found=false", parseRegistry("# 空\n## 其他\n").found === false);

  const dupResult = check({ migrationsDir: migDir, registryText: registry });
  assert("撞号被拦截（代码级 1789500000000）", dupResult.errors.some((e) => e.includes("撞号") && e.includes("1789500000000")));
  assert("注册表内重复登记被拦截（1789500000000 双行）", dupResult.errors.some((e) => e.includes("注册表内重复登记") && e.includes("1789500000000")));
  assert("在盘未注册 1789600000000 被拦截", dupResult.errors.some((e) => e.includes("在盘迁移未注册") && e.includes("1789600000000")));
  assert("预留未落盘（1789700000000）不报错", !dupResult.errors.some((e) => e.includes("1789700000000")));
  assert("nextSuggestion = 在盘最大+1（预留不计）", dupResult.nextSuggestion === "1789600000001");

  const noSection = check({ migrationsDir: migDir, registryText: "# 无分配表段" });
  assert("注册表缺段被拦截", noSection.errors.some((e) => e.includes("缺少")));

  const missing = check({ migrationsDir: migDir, registryText: registryMissingC });
  assert("在盘迁移缺注册行被单独拦截", missing.errors.some((e) => e.includes("在盘迁移未注册") && e.includes("1789600000000")));

  // 干净矩阵：去撞号文件 + 分配表节内补 C 注册行后应通过（追加在下一节标题之前）
  rmSync(join(migDir, "1789500000000-B.ts"));
  const ok = check({
    migrationsDir: migDir,
    registryText: registryClean.replace("## 变更日志", "| 1789600000000 | C | FEAT-XX | 补注册 |\n\n## 变更日志"),
  });
  assert("去撞号+补注册后通过", ok.errors.length === 0);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`selftest 失败：${failures} 例`);
  process.exit(1);
}
console.log("✔ check-migrations selftest 全部通过");

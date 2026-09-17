#!/usr/bin/env node
// PK-26（DEEP_REVIEW 0ef3bbe / A8）：TS 枚举 ⊆ PG 枚举 静态守卫
//
// N2 教训结构性复演——scheduler 写路径枚举（BlockStrategy、ExecutionStatus、
// FailureReason 等）零真机校验。单测全程 mock，e2e 零命中，TS 枚举与 PG enum
// 漂移只能在生产踩坑（PK-01 已是第三次重演）。本脚本落地 A8 静态守卫最小切片：
//
//   扫描 apps/admin-api/src/migrations/*.ts 中所有 CREATE TYPE / ALTER TYPE ADD VALUE
//   与 TS 源码中的 export enum 字符串值，校验 TS 枚举值 ⊆ PG enum 值。
//
// 退出码：0 = 无漂移；1 = TS 枚举包含 PG enum 中不存在的值（漂移）。
//
// 用法：node scripts/check-enum-drift.mjs [--selftest]
//   --selftest：用内置 fixture 验证判据本身（不扫真实代码库）。
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const MIGRATIONS_DIR = "apps/admin-api/src/migrations";
const SRC_DIR = "apps/admin-api/src";

// ── TS enum → PG enum name 映射（手维护，新增 PG enum 时同步）─────────────────
// 键 = TS enum 类名；值 = PG enum 名称。
// TaskPriority 是数字枚举（1-4），PG label 是字符串——不在本守卫覆盖面。
// ExecutionFailureReason 列是 varchar（非 PG enum），不检查。
// DeploymentApprovalStatus / RolloutState / DeploymentTriggerType 列也是 varchar。
const TS_TO_PG = {
  UserRole: "user_role_enum",
  TaskStatus: "task_status_enum",
  TaskTriggerType: "task_triggertype_enum",
  TaskRuntime: "task_runtime_enum",
  BlockStrategy: "task_blockstrategy_enum",
  MisfireStrategy: "task_misfirestrategy_enum",
  ExecutorStatus: "executor_status_enum",
  ExecutorType: "executor_type_enum",
  ExecutionStatus: "execution_status_enum",
  ApplicationStatus: "application_status_enum",
  ExecuteMode: "task_execute_mode_enum",
  DeploymentStatus: "app_deployments_status_enum",
  RunMode: "app_deployments_run_mode_enum",
};

// ── 扫描 PG 迁移：收集每个 enum type 的所有取值 ──────────────────────────────
export function scanPgEnums(migrationsDir) {
  const enums = {}; // { enumName: Set<string> }
  if (!existsSync(migrationsDir)) return enums;

  for (const file of readdirSync(migrationsDir)) {
    if (!file.endsWith(".ts") || file.endsWith(".spec.ts")) continue;
    const text = readFileSync(join(migrationsDir, file), "utf8");

    // CREATE TYPE "name" AS ENUM ('v1', 'v2', ...)  — 单行或跨行
    // 匹配 CREATE TYPE "xxx" AS ENUM ( ... ) 块（跨多行直到右括号）
    const createRe = /CREATE\s+TYPE\s+"?(\w+)"?\s+AS\s+ENUM\s*\(([^)]*)\)/gis;
    let m;
    while ((m = createRe.exec(text)) !== null) {
      const name = m[1];
      const vals = extractEnumValues(m[2]);
      if (!enums[name]) enums[name] = new Set();
      for (const v of vals) enums[name].add(v);
    }

    // ALTER TYPE "name" ADD VALUE [IF NOT EXISTS] 'val'
    const alterRe = /ALTER\s+TYPE\s+"?(\w+)"?\s+ADD\s+VALUE\s+(?:IF\s+NOT\s+EXISTS\s+)?'([^']+)'/gi;
    while ((m = alterRe.exec(text)) !== null) {
      const name = m[1];
      if (!enums[name]) enums[name] = new Set();
      enums[name].add(m[2]);
    }
  }
  return enums;
}

function extractEnumValues(block) {
  // 从 ENUM (...) 块中提取所有 'value' 字符串
  const vals = [];
  const re = /'([^']+)'/g;
  let m;
  while ((m = re.exec(block)) !== null) vals.push(m[1]);
  return vals;
}

// ── 扫描 TS 源码：收集 export enum 的字符串值 ────────────────────────────────
export function scanTsEnums(srcDir) {
  const enums = {}; // { EnumName: Set<string> }
  walkDir(srcDir, (file) => {
    if (!file.endsWith(".ts") || file.endsWith(".spec.ts") || file.endsWith(".d.ts")) return;
    const text = readFileSync(file, "utf8");
    // export enum Name { KEY = "value", ... }
    const re = /export\s+enum\s+(\w+)\s*\{([^}]*)\}/gs;
    let m;
    while ((m = re.exec(text)) !== null) {
      const name = m[1];
      const body = m[2];
      const vals = new Set();
      // 匹配 KEY = "string_value"（仅字符串枚举；数字枚举跳过）
      const valRe = /\w+\s*=\s*"([^"]+)"/g;
      let vm;
      while ((vm = valRe.exec(body)) !== null) vals.add(vm[1]);
      if (vals.size > 0) enums[name] = vals;
    }
  });
  return enums;
}

function walkDir(dir, fn) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkDir(full, fn);
    else fn(full);
  }
}

// ── 核心校验：TS enum 值 ⊆ PG enum 值 ───────────────────────────────────────
export function check({ pgEnums, tsEnums, mapping = TS_TO_PG }) {
  const errors = [];
  for (const [tsName, pgName] of Object.entries(mapping)) {
    const tsVals = tsEnums[tsName];
    const pgVals = pgEnums[pgName];
    if (!tsVals) {
      errors.push(`TS enum ${tsName} 未找到（源码扫描为空）`);
      continue;
    }
    if (!pgVals) {
      errors.push(`PG enum "${pgName}" 未找到（迁移扫描为空）——${tsName} 的 PG 类型缺失？`);
      continue;
    }
    const extra = [...tsVals].filter((v) => !pgVals.has(v));
    if (extra.length > 0) {
      errors.push(
        `漂移：TS enum ${tsName} 包含 PG enum "${pgName}" 中不存在的值: ${extra.join(", ")}` +
          `（PG 仅有: ${[...pgVals].join(", ")}）`
      );
    }
  }
  return errors;
}

// ── selftest：用 fixture 验证判据本身 ────────────────────────────────────────
// ── Frontend literal scan (P2-4 guard extension) ─────────────────────────
// The TS-enum ⊆ PG-enum check above only covers admin-api. admin-web hand-
// writes its API interfaces and asserts them via `client.get(...) as
// Promise<T>`, so a status literal the backend can never produce (the dead
// 'busy' executor filter option, P2-4) is invisible to tsc AND to this guard.
// Each entry below anchors ONE user-facing options block in the web client
// and asserts its `value: '...'` literals are a subset of the corresponding
// PG enum. Add an entry when the web client gains another status filter.
const FRONTEND_STATUS_SCANS = [
  {
    pgEnum: "executor_status_enum",
    file: "apps/admin-web/src/pages/ExecutorListPage.tsx",
    // The status-filter Select: from value={statusFilter} through its
    // options={[ ... ]} array. Anchored (not a whole-file scan) so that
    // unrelated literals such as i18n keys can never trip the guard.
    blockRe: /value=\{statusFilter\}[\s\S]*?options=\{\[([\s\S]*?)\]\}/,
  },
];

/** Extract `value: 'x'` (or double-quoted) literals from an options block. */
export function scanFrontendStatusOptions(fileText, blockRe) {
  const m = blockRe.exec(fileText);
  if (!m) return null; // anchor missing → caller treats this as a failure
  const vals = new Set();
  const re = /value:\s*['"]([^'"]+)['"]/g;
  let vm;
  while ((vm = re.exec(m[1])) !== null) vals.add(vm[1]);
  return vals;
}

/** Assert every anchored frontend options block ⊆ its PG enum. */
export function checkFrontend({
  pgEnums,
  scans = FRONTEND_STATUS_SCANS,
  read = (f) => readFileSync(f, "utf8"),
}) {
  const errors = [];
  for (const scan of scans) {
    if (!existsSync(scan.file)) {
      errors.push(`frontend guard target missing: ${scan.file}`);
      continue;
    }
    const pgVals = pgEnums[scan.pgEnum];
    if (!pgVals) {
      errors.push(
        `PG enum "${scan.pgEnum}" not found (migration scan empty) — frontend guard for ${scan.file} cannot run`,
      );
      continue;
    }
    const vals = scanFrontendStatusOptions(read(scan.file), scan.blockRe);
    if (vals === null) {
      errors.push(
        `${scan.file}: status-filter anchor not found (value={statusFilter} ... options={[ ... ]}) — guard is blind, update check-enum-drift.mjs`,
      );
      continue;
    }
    const extra = [...vals].filter((v) => !pgVals.has(v));
    if (extra.length > 0) {
      errors.push(
        `frontend drift: ${scan.file} filter offers value(s) ${extra.join(", ")} that do not exist in PG enum "${scan.pgEnum}" (PG only has: ${[...pgVals].join(", ")})`,
      );
    }
  }
  return errors;
}

export function selftestFrontend() {
  const pg = { executor_status_enum: new Set(["online", "offline"]) };
  const blockRe = FRONTEND_STATUS_SCANS[0].blockRe;

  const good = `
    <Select
      value={statusFilter}
      onChange={(v) => setStatusFilter(v)}
      options={[
        { value: 'online', label: 'Online' },
        { value: 'offline', label: 'Offline' },
      ]}
    />`;
  const goodVals = scanFrontendStatusOptions(good, blockRe);
  if (!(goodVals && goodVals.has("online") && goodVals.has("offline"))) {
    console.error("selftest FAIL: frontend scanner did not extract online/offline options");
    process.exit(1);
  }

  // Point the scan at this very script (which exists) while the reader
  // returns the in-memory fixture — exercises the drift branch end to end.
  const drifted = good.replace("'offline'", "'busy'");
  const inlineScan = {
    pgEnum: "executor_status_enum",
    file: "scripts/check-enum-drift.mjs",
    blockRe,
  };
  const inlineErrors = checkFrontend({
    pgEnums: pg,
    read: () => drifted,
    scans: [inlineScan],
  });
  if (inlineErrors.length !== 1 || !inlineErrors[0].includes("busy")) {
    console.error(`selftest FAIL: expected one busy-drift error, got: ${inlineErrors.join("; ")}`);
    process.exit(1);
  }

  const anchorErrors = checkFrontend({
    pgEnums: pg,
    read: () => "<Select />",
    scans: [
      {
        pgEnum: "executor_status_enum",
        file: "scripts/check-enum-drift.mjs",
        blockRe: /value=\{statusFilter\}[\s\S]*?options=\{\[([\s\S]*?)\]\}/,
      },
    ],
  });
  if (anchorErrors.length !== 1 || !anchorErrors[0].includes("anchor not found")) {
    console.error(`selftest FAIL: expected anchor-missing error, got: ${anchorErrors.join("; ")}`);
    process.exit(1);
  }
  console.log("selftest OK: frontend literal drift detector works (busy rejected, anchor loss detected)");
}

export function selftest() {
  const fixturePg = {
    test_enum: new Set(["a", "b", "c"]),
  };
  const fixtureTs = {
    GoodEnum: new Set(["a", "b"]), // ⊆ OK
    BadEnum: new Set(["a", "d"]), // d not in PG → drift
  };
  const errors = check({
    pgEnums: fixturePg,
    tsEnums: fixtureTs,
    mapping: { GoodEnum: "test_enum", BadEnum: "test_enum" },
  });
  if (errors.length !== 1) {
    console.error(`selftest FAIL: 期望 1 个 drift 错误，实际 ${errors.length}：${errors.join("; ")}`);
    process.exit(1);
  }
  if (!errors[0].includes("BadEnum")) {
    console.error(`selftest FAIL: 错误信息未包含 BadEnum：${errors[0]}`);
    process.exit(1);
  }
  console.log("selftest OK: drift 检测判据正确（GoodEnum 无漂移，BadEnum 检出 1 处）");
}

// ── main ────────────────────────────────────────────────────────────────────
if (process.argv.includes("--selftest")) {
  selftest();
  selftestFrontend();
} else {
  const pgEnums = scanPgEnums(MIGRATIONS_DIR);
  const tsEnums = scanTsEnums(SRC_DIR);
  const errors = check({ pgEnums, tsEnums });
  // P2-4 guard extension: also assert web-client status literals ⊆ PG enums.
  errors.push(...checkFrontend({ pgEnums }));
  if (errors.length > 0) {
    console.error("PK-26 enum drift guard FAIL:");
    for (const e of errors) console.error("  ✗ " + e);
    process.exit(1);
  }
  console.log(
    `PK-26 enum drift guard OK: ${Object.keys(TS_TO_PG).length} 个 TS enum 全部 ⊆ 对应 PG enum`
  );
}

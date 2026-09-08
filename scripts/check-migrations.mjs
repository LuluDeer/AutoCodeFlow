#!/usr/bin/env node
// ARCH-29：迁移时间戳分配表一致性校验（撞号拦截）
// 规则：
//  1. apps/admin-api/src/migrations/*.ts（排除 spec/目录）中每个文件名时间戳必须全局唯一；
//  2. 每个在盘时间戳必须在 docs/PLAN-CLAIMS.md「## 迁移时间戳分配表」注册（行内出现该时间戳）；
//  3. 注册表中「预留段」允许尚未落盘（预留即占号），但在盘必须已注册。
// 退出码：0=通过，1=违规（CI 拦截）。
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

const DEFAULT_MIGRATIONS_DIR = "apps/admin-api/src/migrations";
const DEFAULT_REGISTRY_FILE = "docs/PLAN-CLAIMS.md";
const REGISTRY_HEADING = "## 迁移时间戳分配表";

export function scanMigrations(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".spec.ts") && !f.endsWith(".d.ts"))
    .map((f) => {
      const m = /^(\d{13})-/.exec(basename(f));
      return m ? { timestamp: m[1], file: basename(f) } : null;
    })
    .filter(Boolean);
}

export function parseRegistry(text) {
  const idx = text.indexOf(REGISTRY_HEADING);
  if (idx === -1) return { found: false, rows: [] };
  const section = text.slice(idx);
  const rows = [];
  // 表行形如 | 1789500000000 | AddTaskTimeoutPolicy | CORE-04 | ... |
  for (const line of section.split("\n")) {
    if (line.startsWith("## ") && !line.startsWith(REGISTRY_HEADING)) break; // 进入下一节
    const m = /^\s*\|\s*(\d{13})\s*\|/.exec(line);
    if (m) rows.push({ timestamp: m[1], line: line.trim() });
  }
  return { found: true, rows };
}

export function check({ migrationsDir = DEFAULT_MIGRATIONS_DIR, registryText } = {}) {
  const errors = [];
  const onDisk = scanMigrations(migrationsDir);
  if (onDisk.length === 0) errors.push(`迁移目录无可用迁移文件：${migrationsDir}`);

  const seen = new Map();
  for (const { timestamp, file } of onDisk) {
    if (seen.has(timestamp)) {
      errors.push(`撞号：${timestamp} 同时被 ${seen.get(timestamp)} 与 ${file} 使用`);
    } else {
      seen.set(timestamp, file);
    }
  }

  if (registryText == null) {
    if (existsSync(DEFAULT_REGISTRY_FILE)) registryText = readFileSync(DEFAULT_REGISTRY_FILE, "utf8");
    else errors.push(`认领板不存在：${DEFAULT_REGISTRY_FILE}`);
  }
  if (registryText != null) {
    const { found, rows } = parseRegistry(registryText);
    if (!found) {
      errors.push(`认领板缺少「${REGISTRY_HEADING}」常设段`);
    } else {
      const registered = new Set();
      for (const r of rows) {
        if (registered.has(r.timestamp)) errors.push(`注册表内重复登记：${r.timestamp}`);
        registered.add(r.timestamp);
      }
      for (const { timestamp, file } of onDisk) {
        if (found && !registered.has(timestamp)) {
          errors.push(`在盘迁移未注册：${timestamp}（${file}）——请在 docs/PLAN-CLAIMS.md「${REGISTRY_HEADING}」补一行`);
        }
      }
    }
  }

  const maxOnDisk = onDisk.reduce((a, b) => (b.timestamp > a ? b.timestamp : a), "0");
  return { errors, onDiskCount: onDisk.length, nextSuggestion: String(Number(maxOnDisk) + 1) };
}

function main() {
  const { errors, onDiskCount, nextSuggestion } = check();
  if (errors.length) {
    console.error(`✘ 迁移注册校验失败（${errors.length} 项）：`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(`✔ 迁移注册校验通过：${onDiskCount} 个迁移全部唯一且已注册；下一可用时间戳 ${nextSuggestion}`);
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) main();

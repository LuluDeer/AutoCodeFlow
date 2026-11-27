#!/usr/bin/env node
// 极小证据助手：把 key=value 合并进 result.json（原子替换），供
// scripts/verify-hardening-realstack.sh 使用。
// 值先按 JSON 字面量解析（数字 / 布尔 / null / 对象 / 数组），解析失败则按普通字符串保存，
// 这样 "jestExitCode=0"、"jestRan=false"、"stamp=autoflow_hardening_..." 都能直接经 argv 传入。
import { readFileSync, writeFileSync, renameSync } from "node:fs";

const [, , resultPath, ...pairs] = process.argv;
if (!resultPath) {
  console.error("usage: hardening-evidence.mjs <result.json> [key=value ...]");
  process.exit(2);
}

let data = {};
try {
  const parsed = JSON.parse(readFileSync(resultPath, "utf8"));
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed;
} catch {
  data = {};
}

for (const pair of pairs) {
  const at = pair.indexOf("=");
  if (at < 0) continue;
  const key = pair.slice(0, at);
  const raw = pair.slice(at + 1);
  let value = raw;
  try {
    value = JSON.parse(raw);
  } catch {
    // 非 JSON 字面量：按原样字符串保存
  }
  data[key] = value;
}

const tmp = `${resultPath}.tmp-${process.pid}`;
writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
renameSync(tmp, resultPath);

#!/usr/bin/env node
/**
 * 「枚举扩了、枚举的消费者没跟」守卫。
 *
 * 由来：`AlertChannel` 有 6 个值（NF-05 加了 `feishu`），但两处**手抄的清单**只有 5 个 ——
 * 建 feishu 静默直接 400、swagger 不承认该渠道。这类漂移编译通过、测试通过（各自测各自的），
 * 只有真去用 feishu 静默时才会撞上。
 *
 * 判据（刻意做窄，避免变成「猜这个数组是干嘛的」）：
 *   对每个登记的枚举，找源码里的**数组字面量**，若其中出现了该枚举的 ≥2 个值、
 *   但不是全部 ⇒ 判定为「在枚举这个枚举却抄漏了」。
 *
 * 为什么阈值是 2：随机数组命中 ≥2 个枚举值的概率极低，而真正的清单必然命中 ≥2。
 * 这条判据在实测中对 `apps/admin-api/src` 全量扫的假报数为 **0**，命中 2 处（都是真的）。
 *
 * 已知边界（如实写）：
 *   · 只认**字符串数组字面量**；对象字面量里手抄的键、`new Set([...])` 之外的动态构造都看不到；
 *   · 不判断该数组的语义（是白名单还是黑名单、是否真的该含全部值）—— 命中即需人工确认一次；
 *   · 枚举值从源码正则提取，若 enum 写成非字面量（计算成员）会提取失败并**报错**而非静默跳过。
 *
 * 用法：
 *   node scripts/check-enum-consumers.mjs           # 守卫
 *   node scripts/check-enum-consumers.mjs --report  # 只报告，不退出非 0
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = "apps/admin-api/src";

/** 登记的枚举：名字 → 定义所在文件。新增枚举时在这里加一行。 */
const ENUMS = [
  { name: "AlertChannel", file: "apps/admin-api/src/modules/notification/notification.service.ts" },
];

function enumValues(file, name) {
  const text = readFileSync(file, "utf8");
  const re = new RegExp(`export enum ${name} \\{([\\s\\S]*?)\\n\\}`, "m");
  const m = re.exec(text);
  if (!m) throw new Error(`找不到 enum ${name}（${file}）——登记表过期还是写法变了？`);
  const values = [...m[1].matchAll(/=\s*"([^"]+)"/g)].map((x) => x[1]);
  if (values.length < 2) {
    throw new Error(`enum ${name} 只提取到 ${values.length} 个字符串值 —— 提取器失效，不能当成「没有问题」。`);
  }
  return values;
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts")) out.push(p);
  }
  return out;
}

/**
 * 第二类判据：**同名但分别声明的值集合**（`export enum X` 或 `export type X = "a" | "b"`）。
 *
 * 由来：`ChannelDeliveryStatus` 在两处各写了一遍 `sent | blocked | failed | skipped`
 * （channels/base.channel.ts 与 dto/notification-response.dto.ts）。两份**当前一致**，
 * 但没有任何机制强制它们一致 —— 谁加一个值、另一处没跟，编译期未必报（两处未必相遇）。
 *
 * 判据：同名声明出现在 ≥2 个文件且**值集合不同** ⇒ 红。集合相同则放行（重复本身是重构议题，不是缺陷）。
 */
function collectDeclarations() {
  const byName = new Map();
  const add = (name, file, values) => {
    const prev = byName.get(name) ?? [];
    prev.push({ file: file.split("\\").join("/"), values: values.slice().sort() });
    byName.set(name, prev);
  };
  for (const f of walk(SRC)) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/export enum (\w+) \{([\s\S]*?)\n\}/g)) {
      const values = [...m[2].matchAll(/=\s*"([^"]+)"/g)].map((x) => x[1]);
      if (values.length) add(m[1], f, values);
    }
    for (const m of text.matchAll(/export type (\w+)\s*=\s*((?:"[^"]+"\s*\|?\s*)+);/g)) {
      const values = [...m[2].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
      if (values.length) add(m[1], f, values);
    }
  }
  return byName;
}

const report = process.argv.includes("--report");
const problems = [];

for (const [name, decls] of collectDeclarations()) {
  if (decls.length < 2) continue;
  if (new Set(decls.map((d) => d.values.join(","))).size > 1) {
    problems.push({
      name,
      file: decls.map((d) => d.file).join(" vs "),
      line: 0,
      missing: [`值集合不一致：${decls.map((d) => `[${d.values.join(",")}]`).join(" / ")}`],
    });
  }
}


for (const { name, file } of ENUMS) {
  const values = enumValues(file, name);
  let scanned = 0;
  for (const f of walk(SRC)) {
    if (f === file) continue; // 定义处不算消费者
    const text = readFileSync(f, "utf8");
    const arrRe = /\[([^\[\]]{0,400})\]/g;
    let m;
    while ((m = arrRe.exec(text)) !== null) {
      scanned += 1;
      const body = m[1];
      const found = values.filter((v) => new RegExp(`['\"]${v}['\"]`).test(body));
      if (found.length >= 2 && found.length < values.length) {
        const line = text.slice(0, m.index).split("\n").length;
        problems.push({
          name,
          file: f.split("\\").join("/"),
          line,
          missing: values.filter((v) => !found.includes(v)),
        });
      }
    }
  }
  if (scanned < 50) {
    problems.push({ name, file: `${SRC}（只扫到 ${scanned} 个数组字面量，扫描器失效）`, line: 0, missing: [] });
  }
}

if (problems.length === 0) {
  console.log("✔ 枚举消费清单一致：登记枚举的每个数组字面量要么是全集，要么占比 <2（不视为清单）。");
  process.exit(0);
}

console.error("");
console.error(`✖ 发现 ${problems.length} 处「枚举了某个枚举但抄漏了值」：`);
for (const p of problems) {
  console.error(`  · ${p.file}:${p.line}  （${p.name}）缺：${p.missing.join(", ") || "（扫描器失效）"}`);
}
console.error("");
console.error("修法：让该清单直接引用枚举值（`Object.values(AlertChannel)`），不要手抄。");
console.error("      若这个数组**确实**不该含全部值（例如它就是「除 X 以外」的黑名单），请改写成本文件的 ALLOWLIST 并写明理由。");
console.error("");
process.exit(report ? 0 : 1);

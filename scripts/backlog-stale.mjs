#!/usr/bin/env node
/**
 * R36（2026-11-05）：**口径④「30 天未立项自动入池」的机械判定工具**（纯手工，**不接链**）。
 *
 * 读 `docs/AGENT-SWARM-PLAYBOOK.md` 的 §7-A 历史建议池，挑出 `since=` 超过 30 天的条目 id。
 * 它是一个**清单工具**，不是判据：口径本身还可能变（R33 那次"规范未稳别上机读守护"），
 * 所以刻意不挂在 `test:guards:chain` 上（教训㊺/㊿）。
 *
 * 用法：
 *   npm run backlog:stale              # 默认 30 天
 *   node scripts/backlog-stale.mjs --days=60
 *   node scripts/backlog-stale.mjs --now=2026-11-05   # 便于自检（固定"今天"）
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const DOC = join(ROOT, "docs/AGENT-SWARM-PLAYBOOK.md");

function argValue(argv, flag) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  return eq ? eq.slice(flag.length + 1) : null;
}

/** 解析 §7-A 表格里带 `since=YYYY-MM-DD` 的行 ⇒ [{id, since, days}]。 */
export function parsePool(text, now = new Date()) {
  const i = text.indexOf("## 7-A");
  const poolText = i >= 0 ? text.slice(i) : "";
  const out = [];
  for (const line of poolText.split("\n")) {
    if (!line.startsWith("| `")) continue;
    const cells = line.split("|").map((c) => c.trim());
    const id = (cells[1] ?? "").replace(/`/g, "");
    const m = line.match(/since=(\d{4}-\d{2}-\d{2})/);
    if (!id || !m) continue;
    const since = new Date(`${m[1]}T00:00:00Z`);
    const days = Math.floor((now.getTime() - since.getTime()) / 86_400_000);
    out.push({ id, since: m[1], days });
  }
  return out;
}

function main(argv) {
  const days = Number(argValue(argv, "--days") ?? 30);
  const nowArg = argValue(argv, "--now");
  const now = nowArg ? new Date(`${nowArg}T00:00:00Z`) : new Date();
  const pool = parsePool(readFileSync(DOC, "utf8"), now);
  if (pool.length === 0) {
    console.error("✖ 读不到 §7-A 的带 since= 的条目 —— 判据面消失（池被清空/格式变了）");
    return 1;
  }
  const stale = pool.filter((e) => e.days > days);
  console.log(`池内条目 ${pool.length} 条（阈值 ${days} 天，基准日 ${now.toISOString().slice(0, 10)}）`);
  if (stale.length === 0) {
    console.log(`✔ 无「超 ${days} 天未立项」条目`);
    return 0;
  }
  console.log(`以下 ${stale.length} 条已超 ${days} 天未立项（应入池/标废，或补新证据续期）：`);
  for (const e of stale) console.log(`  · ${e.id} —— since=${e.since}（${e.days} 天）`);
  return 0; // 清单工具：发现陈旧条目不是"失败"，交给人工处置
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}

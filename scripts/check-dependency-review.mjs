#!/usr/bin/env node
/**
 * N-13 / BUG-04：依赖审计豁免**复查机制**（把「等人记起来」变成「每次审计自动带复查」）。
 *
 * 背景 —— 为什么需要这道机制，而不是再人工翻一次页：
 * CI 的 `npm-audit` job 有一份 append-only 的 GHSA 豁免清单，每条都写了「复查日期」。
 * 但**没有任何东西会读那个日期**：日期到了不会红、不会提醒、不会出现在任何输出里，
 * 全靠有人记得。BUG-04（minio 链 2 条 moderate）自 2026-09-08 起就是这样挂着的，
 * 复查日 2026-10-01 一到，若无人主动翻页，豁免会**静默无限期续期**。
 *
 * 本脚本做三件事：
 *   ① **机检豁免清单与 CI 的一致性**：从 `.github/workflows/ci.yml` 的 npm-audit
 *      job 里解析出豁免 GHSA 列表与复查日期（单一事实源仍是 CI 文件本身，不另建
 *      一份会漂移的副本）；CI 里出现但脚本注册表未登记的 GHSA 即失败。
 *   ② **过期即失败（fail-closed）**：任一条豁免的复查日期 <= 今天，脚本 exit 1，
 *      并打印该条的链路/原因/到期天数。到期不是"提醒"，是**红**——因为豁免的本质
 *      是「暂时接受一个已知漏洞」，无限期接受等于没有这个决定。
 *   ③ **可复跑的复查面**：`--report` 打印完整复查报告（含每条豁免的当前上游状态
 *      检查提示），供轮次收口时归档。
 *
 * 与 `npm audit` 的分工：npm audit 回答「现在有没有新漏洞」，本脚本回答
 * 「我们接受的那些，还该继续接受吗」。
 *
 * 用法：
 *   node scripts/check-dependency-review.mjs              # 正式检查（过期即 exit 1）
 *   node scripts/check-dependency-review.mjs --report     # 打印复查报告（同判据）
 *   node scripts/check-dependency-review.mjs --selftest   # 有齿自检
 *   node scripts/check-dependency-review.mjs --today=2026-10-02   # 覆写"今天"（自检/演练）
 *
 * 退出码：0=全部在有效期内；1=有过期/未登记/解析失败。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const CI_FILE = '.github/workflows/ci.yml';

/**
 * 豁免注册表：脚本侧的**语义**事实源（链路/原因/到期后的处置），
 * GHSA 集合本身从 CI 文件解析（避免两处清单漂移）。
 *
 * `reviewBy` 必须与 CI 注释里的复查日期一致，不一致即失败——CI 注释是给人看的
 * 承诺，这里是给机器执行的判据，两者漂移正是本机制要消灭的形态。
 * `expiredAction` 写到期后该做什么（下次复查时照着执行），不是装饰。
 */
export const EXEMPTIONS = [
  {
    ghsa: 'GHSA-528h-pc64-c93x',
    package: 'stream-json',
    severity: 'moderate',
    chain: 'admin-api minio@8.0.7 → stream-json@1.9.1',
    reason:
      'minio 8.x 钉 stream-json ^1.8；其 notification.js 硬依赖 `stream-json/jsonl/Parser.js`（v1 路径+大写 P）',
    reviewBy: '2026-10-01',
    // N-13 复查实测（2026-09-27，真实 MinIO）：**原计划的 override 强升不可行**——
    // stream-json@3 把文件改名为 src/jsonl/parser.js（小写）并加了 exports map，
    // minio 的 require("stream-json/jsonl/Parser.js") 直接 MODULE_NOT_FOUND；
    // 更严重的是 minio.js 第 32 行**无条件 eager require** notification.js，
    // 于是 `require('minio')` 本身即抛（不是只坏掉通知功能——整条 S3 日志链全废）。
    // 故到期动作=**不采用 override**，维持豁免并等待上游，或改用别的 S3 客户端。
    expiredAction: 'DO_NOT_OVERRIDE（N-13 实测会 break require("minio")）；续期豁免或换 S3 客户端',
    probe: 'stream-json',
  },
];

/** 从 CI 的 npm-audit job 解析豁免 GHSA 与复查日期（单一事实源=CI 文件）。 */
export function parseCiExemptions(ciText) {
  const lines = ciText.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*npm-audit:\s*$/.test(l));
  if (start === -1) return { found: false, ghsa: [], reviewDates: [], raw: '' };
  // job 块范围：下一个与 `  npm-audit:` 同缩进的顶层键为止
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  \S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const block = lines.slice(start, end).join('\n');

  // GHSA：**只认 CI 实际比对用的 `known='...'` 变量**，不扫全块文本。
  // 教训（本脚本首版即踩）：全块扫 GHSA 会把"已清偿"的散文注释也算成活跃豁免
  // ——N-13 清偿 decode-uri-component 后，注释里留了一句「GHSA-xxx 已清偿」，
  // 首版解析器立刻把它当成未登记豁免报红。活跃豁免的唯一事实源是 known 变量。
  const knownMatch = /known='([\s\S]*?)'/.exec(block);
  const ghsa = new Set();
  if (knownMatch) {
    for (const m of knownMatch[1].matchAll(/GHSA-[A-Za-z0-9-]{6,}/g)) ghsa.add(m[0]);
  }

  // 复查日期：注释里的「复查：YYYY-MM-DD」与 notice 行的日期
  const reviewDates = new Set();
  for (const m of block.matchAll(/复查[：:]\s*(\d{4}-\d{2}-\d{2})/g)) reviewDates.add(m[1]);
  for (const m of block.matchAll(/Next review date:\s*(\d{4}-\d{2}-\d{2})/g)) reviewDates.add(m[1]);

  return { found: true, ghsa: [...ghsa].sort(), reviewDates: [...reviewDates].sort(), raw: block };
}

function daysBetween(fromISO, toISO) {
  const a = Date.parse(`${fromISO}T00:00:00Z`);
  const b = Date.parse(`${toISO}T00:00:00Z`);
  return Math.round((a - b) / 86400000);
}

/**
 * @param {object} opts
 * @param {string} opts.ciText  CI 文件内容
 * @param {string} opts.today   YYYY-MM-DD（可覆写，供自检/演练）
 * @param {Array}  [opts.exemptions]
 */
export function check({ ciText, today, exemptions = EXEMPTIONS }) {
  const failures = [];
  const notes = [];
  const parsed = parseCiExemptions(ciText);

  if (!parsed.found) {
    failures.push('未能在 ci.yml 中找到 npm-audit job —— 解析失败即失败（不给"跳过=通过"的口子）');
    return { failures, notes, parsed };
  }
  if (parsed.ghsa.length === 0) {
    failures.push('npm-audit job 中未解析到任何 GHSA 豁免 —— 若确实已清零请同时删除脚本注册表条目');
  }
  if (parsed.reviewDates.length === 0) {
    failures.push('npm-audit job 中未解析到复查日期 —— 「豁免无到期日」是静默无限续期的根因');
  }

  const registered = new Set(exemptions.map((e) => e.ghsa));

  // ① CI 有、注册表无 → 未登记（新增豁免必须显式登记语义）
  for (const g of parsed.ghsa) {
    if (!registered.has(g)) {
      failures.push(`CI 豁免清单含未登记 GHSA：${g} —— 请在 scripts/check-dependency-review.mjs 的 EXEMPTIONS 登记链路/原因/到期动作`);
    }
  }
  // ② 注册表有、CI 无 → 已清偿，注册表应同步删除（防"清完了还挂着"）
  for (const e of exemptions) {
    if (!parsed.ghsa.includes(e.ghsa)) {
      failures.push(`注册表登记了 ${e.ghsa}，但 CI 豁免清单已无此项 —— 说明已清偿，请删除该注册表条目（避免僵尸豁免）`);
    }
  }

  // ③ 到期即失败（fail-closed）
  for (const e of exemptions) {
    const d = daysBetween(e.reviewBy, today);
    if (!Number.isFinite(d)) {
      failures.push(`${e.ghsa} 的 reviewBy 不是合法日期：${e.reviewBy}`);
      continue;
    }
    if (d <= 0) {
      failures.push(
        `${e.ghsa}（${e.package}@${e.severity}）复查日期 ${e.reviewBy} 已到期 ${-d} 天 —— ` +
          `到期动作：${e.expiredAction}｜链路：${e.chain}`,
      );
    } else {
      notes.push(`${e.ghsa}（${e.package}）距复查 ${e.reviewBy} 还有 ${d} 天｜到期动作：${e.expiredAction}`);
    }

    // ④ 注册表 reviewBy 必须与 CI 注释里的复查日期一致（两处漂移正是本机制要消灭的）
    for (const rv of parsed.reviewDates) {
      if (rv !== e.reviewBy) {
        failures.push(
          `${e.ghsa} 的 reviewBy=${e.reviewBy} 与 CI 注释中的复查日期 ${rv} 不一致 —— ` +
            `人工承诺与机器判据漂移，两处必须同批更新`,
        );
      }
    }
  }

  return { failures, notes, parsed };
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) {
    const r = spawnSync(process.execPath, [path.join(here, 'check-dependency-review.selftest.mjs')], { stdio: 'inherit' });
    process.exit(r.status ?? 1);
  }
  const todayArg = args.find((a) => a.startsWith('--today='));
  const today = todayArg ? todayArg.split('=')[1] : new Date().toISOString().slice(0, 10);
  const report = args.includes('--report');

  const ciText = fs.readFileSync(path.join(root, CI_FILE), 'utf8');
  const { failures, notes, parsed } = check({ ciText, today });

  if (report) {
    console.log(`依赖审计豁免复查报告（判据日 ${today}）`);
    console.log(`CI 豁免 GHSA：${parsed.ghsa.join(', ') || '(无)'}`);
    console.log(`CI 复查日期：${parsed.reviewDates.join(', ') || '(无)'}`);
    console.log('');
    for (const e of EXEMPTIONS) {
      console.log(`● ${e.ghsa}  ${e.package}@${e.severity}`);
      console.log(`  链路：${e.chain}`);
      console.log(`  原因：${e.reason}`);
      console.log(`  复查：${e.reviewBy}（剩 ${daysBetween(e.reviewBy, today)} 天）`);
      console.log(`  到期动作：${e.expiredAction}`);
      console.log('');
    }
  }
  for (const n of notes) console.log(`  ✔ ${n}`);
  if (failures.length > 0) {
    console.error('');
    for (const f of failures) console.error(`  ✘ ${f}`);
    console.error(`\n依赖审计复查机制失败（${failures.length} 项）。`);
    process.exit(1);
  }
  console.log('\n依赖审计豁免全部在有效期内，且与 CI 清单一致。');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}

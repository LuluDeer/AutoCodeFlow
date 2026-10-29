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
 * ## T4（第 4 轮守卫自检审计）：伴生 selftest **收编**进 `--selftest`
 *
 * 原 `scripts/check-dependency-review.selftest.mjs` 已删除，全部断言并入下面的
 * `selftest()`（用例对照见该函数）。**为什么收编而不是保留**：
 *   · 该伴生文件的每一条用例都在测**本脚本的判据**——它 `import { check,
 *     parseCiExemptions, EXEMPTIONS }`，喂一段 CI 文本再断言返回的 failures。
 *     它唯一的"外部依赖"是 `.github/workflows/ci.yml`（**本仓事实源**）与
 *     `check-npm-audit-exemptions.mjs` 的 EXEMPTIONS（同一个仓库的单一事实源），
 *     既不访问 npm registry、也不跑 `npm audit`、不依赖任何产物或网络——
 *     所以「保留伴生文件」的理由（独立工具 / 网络 / 外部依赖）在这里不成立。
 *   · 旧形态的共同失效模式正好落在「函数级断言」的盲区：它直接调 `check()`，
 *     于是删掉 CLI 入口的 `process.exit(1)`、`--root`/`--today` 把参数吃掉、
 *     报错文案改两个字符，它一条都看不见。收编时全部改写为 `runGuard`
 *     真子进程 + `expectExit` 断言退出码与关键文本。
 *   · 唯一不再逐条复刻的两条（原 ①b 的"散文已清偿"、原 ①c 的 CIR-03 回落）
 *     改为**后果断言**：解析器若把注释里的 GHSA 算成活跃豁免，真脚本会报
 *     「未登记 GHSA」而变红；回落若失效，真脚本会报「未解析到任何 GHSA」。
 *     这比断言解析器的返回值更强（它连"解析对了但没接线"也能抓住）。
 *
 * ## T4 同时补的两件事（不改判据语义，只补「事实源缺失」与「扫描面塌陷」）
 *   · **`--root`**：模块级 `const root = path.resolve(here,'..')` 收成参数，
 *     `import` 本文件时不实扫、不 `process.exit`；selftest 才能在 fixture 树上跑真脚本。
 *   · **结构红**：① `.github/workflows/ci.yml` 缺失（旧版 `readFileSync` 直接崩栈，
 *     读者只看到一句 ENOENT，与"判据失败"混在同一个退出通道）；② npm-audit job
 *     解析出的块行数跌破 `MIN_CI_BLOCK_LINES`（CI 结构改动后解析面塌陷时，
 *     "0 条活跃豁免"与"真的清完了"不可区分）。两者都是**判据不可信**，不是违规。
 *   · 注册表侧**刻意不设绝对地板**：`EXEMPTIONS` 的条数会随逐条清偿下降，
 *     一个"只增不减"的下界会与正常清偿打架。它的永真风险已被现有判据堵住——
 *     注册表被清空时，CI 侧任何一条豁免都会立刻报「未登记 GHSA」，而 CI 侧清空
 *     则报「未解析到任何 GHSA」，两个方向都不是"0 个 = 没问题"。
 *
 * 用法：
 *   node scripts/check-dependency-review.mjs              # 正式检查（过期即 exit 1）
 *   node scripts/check-dependency-review.mjs --report     # 打印复查报告（同判据）
 *   node scripts/check-dependency-review.mjs --selftest   # 有齿自检（真子进程）
 *   node scripts/check-dependency-review.mjs --today=2026-10-02   # 覆写"今天"（自检/演练）
 *   node scripts/check-dependency-review.mjs --root <dir>         # 只给 selftest：把 fixture 当仓库根
 *
 * 退出码：0=全部在有效期内；1=有过期/未登记/解析失败/结构错误。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXEMPTIONS as AUDIT_ENFORCEMENT_EXEMPTIONS } from './check-npm-audit-exemptions.mjs';

import { expectExit, makeFixtureRepo, reportCases, runGuard } from './lib/guard-selftest.mjs';

const SELF = fileURLToPath(import.meta.url);

export const CI_FILE = '.github/workflows/ci.yml';

/**
 * 扫描面下界：npm-audit job 块至少 3 行（job 头 + 至少两步）。
 *
 * 为什么需要：本守卫的全部判据都建立在「从 ci.yml 里解析出豁免集合与复查日期」
 * 之上。job 只解析到 1–2 行时（缩进改了、job 被拆走、`run:` 块被移到别的文件），
 * 解析结果恒为空——此时"没有未登记豁免 / 没有日期漂移"是永真断言，只有
 * 「未解析到任何 GHSA」那一句在兜底，容易被当成"清完了"的信号读过去。
 */
export const MIN_CI_BLOCK_LINES = 3;

function argValue(argv, flag) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const at = argv.indexOf(flag);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1];
  return null;
}

/**
 * 豁免注册表：脚本侧的**语义**事实源（链路/原因/到期后的处置），
 * GHSA 集合本身从 CI 文件解析（避免两处清单漂移）。
 *
 * CIR-03（2026-10-29）后 GHSA 集合迁到 scripts/check-npm-audit-exemptions.mjs
 * （跨 CI/local 的**判定**单一事实源），ci.yml 不再内联 `known='...'`。故集合解析有
 * 两态：CI 仍有 `known=` 时以它为准（防漂移的原判据不变）；CI 已无 `known=` 时回落到
 * 单一事实源 —— 本注册表 ↔ 单一事实源之间的 ①②④ 三条比对仍然真实有效。
 * 显式 `known=''`（空清单）**不**走回落：空清单是「清完了但没删注册表」的信号，必须报错。
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
    reviewBy: '2026-12-30',
    // N-13 复查实测（2026-09-27，真实 MinIO）：**原计划的 override 强升不可行**——
    // stream-json@3 把文件改名为 src/jsonl/parser.js（小写）并加了 exports map，
    // minio 的 require("stream-json/jsonl/Parser.js") 直接 MODULE_NOT_FOUND；
    // 更严重的是 minio.js 第 32 行**无条件 eager require** notification.js，
    // 于是 `require('minio')` 本身即抛（不是只坏掉通知功能——整条 S3 日志链全废）。
    // 故到期动作=**不采用 override**，维持豁免并等待上游，或改用别的 S3 客户端。
    // 2026-10-01 复审续期（+90d）：复核 minio@8.0.7 仍钉 ^1.8、stream-json@3
    // 无兼容回迁迹象，override 结论维持；下轮关注 minio 大版本是否更换解析器。
    expiredAction: 'DO_NOT_OVERRIDE（N-13 实测会 break require("minio")）；续期豁免或换 S3 客户端',
    probe: 'stream-json',
  },
  {
    ghsa: 'GHSA-hqr4-qq8f-hg3x',
    package: 'stream-json',
    severity: 'moderate',
    chain: 'admin-api minio@8.0.7 → stream-json@1.9.1',
    reason:
      'JSONC 解析器/校验器对累积注释每次输入整段重扫（O(n²)）——修复版 3.5.1 在 v3，与 GHSA-528h 同一不可 override 约束；通知链仅消费 admin 私服内部 MinIO 事件，非公网输入面',
    reviewBy: '2026-12-30',
    expiredAction: '随 GHSA-528h 同批复查：续期豁免或换 S3 客户端，不得 override',
    probe: 'stream-json',
  },
  {
    ghsa: 'GHSA-mjw6-4jj6-33hc',
    package: 'stream-json',
    severity: 'moderate',
    chain: 'admin-api minio@8.0.7 → stream-json@1.9.1',
    reason:
      'Assembler 原型污染（this.current[this.key] 写在 Object.prototype 上）——修复版 3.6.0 在 v3，与 GHSA-528h 同一不可 override 约束；通知链仅消费 admin 私服内部 MinIO 事件，非公网输入面',
    reviewBy: '2026-12-30',
    expiredAction: '随 GHSA-528h 同批复查：续期豁免或换 S3 客户端，不得 override',
    probe: 'stream-json',
  },

  // ── 2026-10-19 依赖告警批次：无修复版的 devDependency 链 ────────────────
  // 本轮把 38 条 Dependabot 告警逐条溯源，27 条已用 override/升级消除。
  // 剩下 11 条的共同特征：**上游无修复版**（first_patched_version = null），
  // 且全部位于开发期工具链，不进生产运行时。逐条登记如下。
  {
    ghsa: 'GHSA-7pqw-9j4j-h8q3',
    package: 'extract-zip',
    severity: 'high',
    chain: 'admin-web devDep @lhci/cli@0.15.1 → @puppeteer/browsers → extract-zip@2.0.1',
    reason:
      '符号链接归档条目可导致任意文件写入。**上游无修复版**：extract-zip 最新即 2.0.1（vulnerable range = <=2.0.1）；@lhci/cli 最新 0.15.1 是唯一版本，无法再升。该链仅用于 Lighthouse CI 性能审计（`npm run lighthouse`，CI 的 admin-web-lighthouse job），不在任何生产构建产物中',
    reviewBy: '2026-12-30',
    expiredAction:
      '复查上游是否发布 extract-zip >2.0.1 或 @lhci/cli 换掉 puppeteer 链；若已发布则升级并移除本条。不得 override（无目标版本）',
    probe: 'extract-zip',
  },
  {
    ghsa: 'GHSA-jmr9-qjv8-65gv',
    package: 'extract-zip',
    severity: 'high',
    chain: '同上（@lhci/cli → @puppeteer/browsers → extract-zip@2.0.1）',
    reason:
      '未校验的符号链接路径穿越。与 GHSA-7pqw 同一不可修复约束（上游停更，2.0.1 即最新）；同样仅在 Lighthouse CI 工具链中可达',
    reviewBy: '2026-12-30',
    expiredAction: '随 GHSA-7pqw-9j4j-h8q3 同批复查',
    probe: 'extract-zip',
  },
  // 2026-10-23（审计轮 #4）：`GHSA-hp3w-g68c-fv3c`（sprintf-js）**已从本注册表移除**。
  // 理由：该 advisory 于 2026-10-22 19:21 UTC 被 GitHub **撤回**
  // （`withdrawn_at` 已置，理由=格式串精度异常属应用侧职责），Dependabot 侧亦已
  // dismiss。保留一条"已失效的豁免"会让注册表与真实告警面漂移——这正是本机制
  // 要消灭的形态。
  // 历史处置（仍有效）：admin-api / executor-node / node-sdk 用 `argparse@2.0.1`
  // override 消除了 js-yaml@3→argparse@1→sprintf-js 链；executor-desktop 残留
  // 的 sprintf-js@1.1.3 属构建期工具链（electron-builder 下载 Electron 时可达），
  // 因 advisory 撤回已无需登记。
];

/** 从 CI 的 npm-audit job 解析豁免 GHSA 与复查日期（单一事实源=CI 文件）。 */
export function parseCiExemptions(ciText) {
  const lines = ciText.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*npm-audit:\s*$/.test(l));
  if (start === -1) return { found: false, ghsa: [], reviewDates: [], raw: '', blockLines: 0 };
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
  // 只认**代码行**里的 known 变量：注释里提到 `known='...'`（解释迁移历史时
  // 很自然）不能被当成「CI 仍有内联清单」——否则 CIR-03 迁移后回落失效，
  // 集合为空 → 注册表每条都报「僵尸豁免」。这是本解析器第二次踩「注释与代码
  // 同形」，故用去掉注释行后的 codeBlock 做判据。
  const codeBlock = block
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
  const knownMatch = /known='([\s\S]*?)'/.exec(codeBlock);
  // 是否存在 `known=` 变量（`known=''` 也算"存在"，只是内容为空）。
  const hasKnownVar = /known='/.test(codeBlock);
  const ghsa = new Set();
  if (knownMatch) {
    for (const m of knownMatch[1].matchAll(/GHSA-[A-Za-z0-9-]{6,}/g)) ghsa.add(m[0]);
  } else if (!hasKnownVar) {
    // CIR-03：清单已迁到单一事实源脚本，CI 侧不再内联 —— 集合取该脚本的 EXEMPTIONS。
    for (const e of AUDIT_ENFORCEMENT_EXEMPTIONS) ghsa.add(e.ghsa);
  }

  // 复查日期：注释里的「复查：YYYY-MM-DD」与 notice 行的日期
  const reviewDates = new Set();
  for (const m of block.matchAll(/复查[：:]\s*(\d{4}-\d{2}-\d{2})/g)) reviewDates.add(m[1]);
  for (const m of block.matchAll(/Next review date:\s*(\d{4}-\d{2}-\d{2})/g)) reviewDates.add(m[1]);
  if (reviewDates.size === 0 && !hasKnownVar) {
    for (const e of AUDIT_ENFORCEMENT_EXEMPTIONS) reviewDates.add(e.reviewBy);
  }

  return {
    found: true,
    ghsa: [...ghsa].sort(),
    reviewDates: [...reviewDates].sort(),
    raw: block,
    blockLines: block.split('\n').filter((l) => l.trim() !== '').length,
  };
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
  const structure = [];
  const parsed = parseCiExemptions(ciText);

  if (!parsed.found) {
    failures.push('未能在 ci.yml 中找到 npm-audit job —— 解析失败即失败（不给"跳过=通过"的口子）');
    return { failures, notes, parsed, structure };
  }
  // 结构：解析面塌陷（job 还在，但块内几乎没内容——判据此时全在空集上成立）
  if (parsed.blockLines < MIN_CI_BLOCK_LINES) {
    structure.push(
      `npm-audit job 只解析到 ${parsed.blockLines} 行（下界 ${MIN_CI_BLOCK_LINES}）——` +
        `CI 结构改动后解析面已塌陷，此时"无未登记豁免 / 无日期漂移"是永真断言。` +
        `请检查 job 缩进与 \`run: |\` 块是否仍在 npm-audit job 内。`,
    );
    return { failures, notes, parsed, structure };
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

  return { failures, notes, parsed, structure };
}

// ── 自检（T4：原伴生 checks 全部改写为真子进程断言）─────────────────────────
/**
 * fixture 里的 CI 文本：与真实 CI 同形（`known='…'` + 复查日期注释 + `::notice`），
 * GHSA 集合与复查日期默认取自**本脚本的注册表** —— 这样正例的"绿"是判据真的
 * 对上了，而不是 fixture 恰好空。
 */
function makeCi({
  ghsa = EXEMPTIONS.map((e) => e.ghsa),
  dates = [...new Set(EXEMPTIONS.map((e) => e.reviewBy))].sort(),
  knownVar = true,
  sedNote = null,
  extraJob = true,
  stepLines = ['          echo "npm audit"'],
} = {}) {
  const list = ghsa.map((g) => `          # ${g}  some advisory`).join('\n');
  const d = dates.map((x) => `          #   复查：${x}（评估 overrides）`).join('\n');
  const knownLine = knownVar ? `          known='${ghsa.join('\n          ')}'` : null;
  return [
    '  npm-audit:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: npm audit (with retry)',
    '        run: |',
    sedNote ? `          # N-13：**${sedNote} 已清偿**——已从下方 known 移除` : null,
    list,
    d,
    knownLine,
    ...stepLines,
    dates.length
      ? `          echo "::notice::All findings are known exemptions (SEC-06). Next review date: ${dates[0]}."`
      : null,
    ...(extraJob
      ? ['', '  pip-audit:', '    runs-on: ubuntu-latest', '    # GHSA-DECOY-0000-0000 不属于 npm-audit job']
      : []),
  ]
    .filter((l) => l !== null && l !== '')
    .join('\n');
}

const shiftDays = (iso, n) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const REVIEW_DATES = [...new Set(EXEMPTIONS.map((e) => e.reviewBy))].sort();
const MIN_REVIEW = REVIEW_DATES[0];
const MAX_REVIEW = REVIEW_DATES[REVIEW_DATES.length - 1];
/** 窗口内：最早复查日的前一天（对真实注册表恒成立，不写死某个日期）。 */
const IN_WINDOW = shiftDays(MIN_REVIEW, -1);

/** 一份 fixture 树：只含 ci.yml（本守卫唯一的事实源）。 */
const ciTree = (options = {}) => ({ [CI_FILE]: makeCi(options) });

/**
 * 自检：15 条用例，全部 `runGuard` 真子进程（`--root` 指向 fixture 树）。
 *
 * ①–⑪ 对应原伴生 `check-dependency-review.mjs` 的用例（判据逐条保留）：
 *   ① 正例全绿　② 解析器不吃隔壁 job　③ 散文"已清偿"不算活跃豁免
 *   ④ known 为空 → 提示同步删注册表　⑤ CIR-03 回落（无 known= 时用单一事实源）
 *   ⑥ 到期当天　⑦ 到期次日　⑧ CI 有注册表无（未登记）　⑨ 注册表有 CI 无（僵尸）
 *   ⑩ 日期漂移　⑪ 找不到 npm-audit job
 * ⑫–⑮ 是 T4 新增的结构红 / 扫描面下界 / 真实仓库与注册表元数据的反证。
 */
export function selftest() {
  const cases = [];
  /** fixture 树：`files` 是 `{ 相对路径: 内容 }`，默认给一份与真实 CI 同形的 ci.yml。 */
  const subprocess = (name, { files = ciTree(), args = [], expect: exp }) => {
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(files, { prefix: 'dependency-review-selftest-' });
        try {
          expectExit(
            runGuard(SELF, { args: ['--root', repo.dir, ...args] }),
            { ...exp, withinMs: 3000, label: name },
          );
        } finally {
          repo.cleanup();
        }
      },
    });
  };

  // ── 正例：注册表 GHSA 与日期在 CI 里一致、未到期 → 绿 ─────────────────
  subprocess('① 正例（注册表 ↔ CI 一致、未到期）→ 绿并逐条打印剩余天数', {
    args: [`--today=${IN_WINDOW}`],
    expect: {
      code: 0,
      contains: [
        '依赖审计豁免全部在有效期内，且与 CI 清单一致。',
        `距复查 ${MIN_REVIEW} 还有`,
        '到期动作：',
      ],
      absent: ['✘', '结构错误'],
    },
  });

  // ── ① 解析器必须只吃 npm-audit job（不能把隔壁 job 的 GHSA 算进来） ──
  // 判据：pip-audit job 里的 GHSA-DECOY 若被算成活跃豁免，会立刻报「未登记」→ 红。
  subprocess('② 【反证·job 边界】隔壁 pip-audit job 的 GHSA 不算活跃豁免 → 仍绿', {
    args: [`--today=${IN_WINDOW}`],
    expect: { code: 0, contains: ['依赖审计豁免全部在有效期内'], absent: ['GHSA-DECOY', '未登记'] },
  });

  // ── ①b 解析器只认 known 变量：散文里提到的 GHSA（如"已清偿"注记）不得算活跃 ──
  subprocess('③ 【反证·注释算数】散文里的"已清偿 GHSA"不算活跃豁免 → 仍绿', {
    files: ciTree({ sedNote: 'GHSA-zzzz-zzzz-zzzz' }),
    args: [`--today=${IN_WINDOW}`],
    expect: { code: 0, contains: ['依赖审计豁免全部在有效期内'], absent: ['GHSA-zzzz', '未登记'] },
  });

  // ── known 为空（漏洞已清零）：→ 应触发"请同步删注册表" ────────────────
  subprocess('④ known="" 空清单 → 红（清完了但注册表还挂着）', {
    files: ciTree({ ghsa: [] }),
    args: [`--today=${IN_WINDOW}`],
    expect: { code: 1, contains: ['未解析到任何 GHSA', '同时删除脚本注册表条目'], absent: ['依赖审计豁免全部在有效期内'] },
  });

  // ── ①c CIR-03 迁移态：CI 不再内联 known= 时，集合回落到单一事实源脚本 ──
  subprocess('⑤ 【CIR-03 回落】CI 无 known= → 回落到单一事实源且与注册表一致 → 绿', {
    files: ciTree({ knownVar: false }),
    args: [`--today=${IN_WINDOW}`],
    expect: {
      code: 0,
      contains: ['依赖审计豁免全部在有效期内'],
      absent: ['未解析到任何 GHSA', '未登记 GHSA', '已无此项'],
    },
  });

  // ── ② 到期即失败（fail-closed） ─────────────────────────────────
  subprocess(`⑥ 到期当天（today=${MIN_REVIEW}）→ 红，且写"已到期 0 天"`, {
    args: [`--today=${MIN_REVIEW}`],
    expect: { code: 1, contains: ['已到期 0 天', '到期动作：', '链路：'], absent: ['依赖审计豁免全部在有效期内'] },
  });
  subprocess(`⑦ 到期次日（today=${shiftDays(MIN_REVIEW, 1)}）→ 红，且写"已到期 1 天"`, {
    args: [`--today=${shiftDays(MIN_REVIEW, 1)}`],
    expect: { code: 1, contains: ['已到期 1 天'], absent: ['依赖审计豁免全部在有效期内'] },
  });

  // ── ③ CI 有、注册表无 → 未登记（新增豁免必须显式登记语义） ──────
  subprocess('⑧ CI 多一条未登记 GHSA → 红并点名该 GHSA 与登记位置', {
    files: ciTree({ ghsa: [...EXEMPTIONS.map((e) => e.ghsa), 'GHSA-new0-0000-0000'] }),
    args: [`--today=${IN_WINDOW}`],
    expect: {
      code: 1,
      contains: ['未登记 GHSA：GHSA-new0-0000-0000', 'EXEMPTIONS 登记链路/原因/到期动作'],
      absent: ['依赖审计豁免全部在有效期内'],
    },
  });

  // ── ④ 注册表有、CI 无 → 僵尸豁免（已清偿应同步删除） ────────────
  subprocess(`⑨ CI 少一条（${EXEMPTIONS[0].ghsa}）→ 僵尸豁免红`, {
    files: ciTree({ ghsa: EXEMPTIONS.slice(1).map((e) => e.ghsa) }),
    args: [`--today=${IN_WINDOW}`],
    expect: {
      code: 1,
      contains: [`注册表登记了 ${EXEMPTIONS[0].ghsa}，但 CI 豁免清单已无此项`, '避免僵尸豁免'],
      absent: ['依赖审计豁免全部在有效期内'],
    },
  });

  // ── ⑤ 人工承诺与机器判据漂移（CI 注释日期 ≠ 注册表 reviewBy） ──
  subprocess('⑩ CI 注释复查日期与注册表 reviewBy 不一致 → 红（两处漂移）', {
    files: ciTree({ dates: [shiftDays(MAX_REVIEW, 15)] }),
    args: [`--today=${IN_WINDOW}`],
    expect: {
      code: 1,
      contains: ['不一致', '人工承诺与机器判据漂移，两处必须同批更新'],
      absent: ['依赖审计豁免全部在有效期内'],
    },
  });

  // ── ⑥ 解析失败不得"跳过=通过" ─────────────────────────────────
  subprocess('⑪ ci.yml 里没有 npm-audit job → 红（不给跳过的口子）', {
    files: { [CI_FILE]: '  something-else:\n    runs-on: ubuntu-latest\n' },
    args: [`--today=${IN_WINDOW}`],
    expect: { code: 1, contains: ['未能在 ci.yml 中找到 npm-audit job'], absent: ['依赖审计豁免全部在有效期内'] },
  });

  // ── ⑫ 结构红：事实源缺失（ci.yml 被删） ───────────────────────────
  subprocess('⑫ 事实源缺失（.github/workflows/ci.yml 不存在）→ 结构红，不崩栈', {
    files: { 'README.md': '# 空树（无 .github/workflows/ci.yml）\n' },
    args: [`--today=${IN_WINDOW}`],
    expect: {
      code: 1,
      contains: ['结构错误', `事实源不存在：${CI_FILE}`],
      absent: ['依赖审计豁免全部在有效期内', 'ENOENT', 'Error:'],
    },
  });

  // ── ⑬ 结构红：扫描面下界（job 只剩 2 行） ─────────────────────────
  subprocess(`⑬ npm-audit job 只解析到 2 行 → 结构红（下界 ${MIN_CI_BLOCK_LINES}）`, {
    files: { [CI_FILE]: ['  npm-audit:', '    runs-on: ubuntu-latest'].join('\n') },
    args: [`--today=${IN_WINDOW}`],
    expect: {
      code: 1,
      contains: ['结构错误', `只解析到 2 行（下界 ${MIN_CI_BLOCK_LINES}）`],
      absent: ['依赖审计豁免全部在有效期内'],
    },
  });

  // ── ⑭ 反证有牙：真实仓库（默认根=仓库根）必须绿 ────────────────────
  cases.push({
    name: '⑭ 真实 CI 文件全绿（守卫真的在跑，默认根=仓库根）',
    fn: () => {
      expectExit(runGuard(SELF), {
        code: 0,
        withinMs: 3000,
        contains: ['依赖审计豁免全部在有效期内，且与 CI 清单一致。'],
        absent: ['✘'],
        label: '⑭ 真实仓库',
      });
    },
  });

  // ── ⑮ 注册表元数据（经 --report 观测）：每条都要有到期动作与合法 reviewBy ──
  cases.push({
    name: '⑮ 注册表每条豁免都有到期动作（≥10 字）与 YYYY-MM-DD 的 reviewBy',
    fn: () => {
      const result = expectExit(runGuard(SELF, { args: ['--report', `--today=${IN_WINDOW}`] }), {
        code: 0,
        withinMs: 3000,
        contains: EXEMPTIONS.map((e) => `● ${e.ghsa}`),
        absent: ['✘'],
        label: '⑮ 注册表元数据',
      });
      // 逐条核 到期动作 / 复查日期：报告行是「  到期动作：…」与「  复查：YYYY-MM-DD（剩 N 天）」
      const lines = String(result.stdout).split('\n');
      const bad = [];
      for (const e of EXEMPTIONS) {
        const at = lines.findIndex((l) => l.trim() === `● ${e.ghsa}  ${e.package}@${e.severity}`);
        if (at < 0) {
          bad.push(`${e.ghsa}：--report 未打印该条（注册表与报告面不一致）`);
          continue;
        }
        const block = lines.slice(at, at + 6).join('\n');
        const action = /到期动作：(.*)$/m.exec(block)?.[1] ?? '';
        if (action.trim().length < 10) bad.push(`${e.ghsa}：到期动作缺失或过短（「${action.trim()}」）`);
        const review = /复查：(\S+)（剩/.exec(block)?.[1] ?? '';
        if (!/^\d{4}-\d{2}-\d{2}$/.test(review)) bad.push(`${e.ghsa}：复查日期不是 YYYY-MM-DD（「${review}」）`);
      }
      if (bad.length > 0) throw new Error(`注册表元数据不达标：\n  · ${bad.join('\n  · ')}`);
    },
  });

  const failed = reportCases(cases, { title: 'check-dependency-review selftest' });
  if (failed > 0) process.exit(1);
}

function main(argv = process.argv.slice(2)) {
  const todayArg = argv.find((a) => a.startsWith('--today='));
  const today = todayArg ? todayArg.split('=')[1] : new Date().toISOString().slice(0, 10);
  const report = argv.includes('--report');
  const root = path.resolve(argValue(argv, '--root') ?? process.cwd());
  const ciPath = path.join(root, CI_FILE);

  // 事实源缺失 → 结构红（旧版 readFileSync 直接崩栈，读者只看到一句 ENOENT）
  if (!fs.existsSync(ciPath)) {
    console.error('');
    console.error('✖ 依赖审计复查守卫结构错误（判据本身不可信）：');
    console.error(`  · 事实源不存在：${CI_FILE}（在 ${root} 下找不到）—— 豁免清单与复查日期的唯一事实源`);
    console.error('');
    process.exit(1);
  }

  const ciText = fs.readFileSync(ciPath, 'utf8');
  const { failures, notes, parsed, structure } = check({ ciText, today });

  if (structure.length > 0) {
    console.error('');
    console.error('✖ 依赖审计复查守卫结构错误（判据本身不可信）：');
    for (const e of structure) console.error(`  · ${e}`);
    console.error('');
    process.exit(1);
  }

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

const isMain =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  if (process.argv.includes('--selftest')) {
    selftest();
  } else {
    main();
  }
}

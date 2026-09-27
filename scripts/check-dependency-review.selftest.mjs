#!/usr/bin/env node
// scripts/check-dependency-review.mjs 自检：构造 CI 文本矩阵，断言判据逐条有齿。
// 每个负例都对应一个**真实会发生的**静默形态（漏登记/僵尸豁免/日期漂移/到期）。
import { check, parseCiExemptions, EXEMPTIONS } from './check-dependency-review.mjs';

let failures = 0;
function assert(name, cond) {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.error(`  ✘ ${name}`);
  }
}

/** 造一段最小可解析的 npm-audit job（含 job 块边界，验证解析器不吃到隔壁 job）。 */
function makeCi({ ghsa = ['GHSA-vcc3-ghjq-m6fr', 'GHSA-528h-pc64-c93x'], dates = ['2026-10-01'], extraJob = true } = {}) {
  const known = ghsa.map((g) => `          # ${g}  some advisory`).join('\n');
  const d = dates.map((x) => `          #   复查：${x}（评估 overrides）`).join('\n');
  // 活跃豁免的事实源 = known 变量（与真实 CI 形态一致）
  const knownVar = ghsa.length ? `          known='${ghsa.join('\n          ')}'` : "          known=''";
  return [
    '  npm-audit:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: npm audit (with retry)',
    '        run: |',
    known,
    d,
    knownVar,
    `          echo "::notice::All findings are known exemptions (SEC-06). Next review date: ${dates[0]}."`,
    ...(extraJob ? ['', '  pip-audit:', '    runs-on: ubuntu-latest', '    # GHSA-DECOY-0000-0000 不属于 npm-audit job'] : []),
  ].join('\n');
}

const TODAY = '2026-09-27';

/** 合成注册表：与"真实当前有几条豁免"解耦（真实条数会随清偿变化）。 */
const EX = (ghsa, reviewBy = '2026-10-01') => ({
  ghsa, package: 'pkg', severity: 'moderate', chain: 'a→b', reason: 'r',
  reviewBy, expiredAction: 'DO_SOMETHING_ACTION',
});
const TWO = [EX('GHSA-vcc3-ghjq-m6fr'), EX('GHSA-528h-pc64-c93x')];

// ── 正例：合成两条豁免、日期一致、未到期时必须绿 ────────────────
// 用合成 GHSA 与合成注册表，不绑定"当前真实有几条豁免"（真实条数会随清偿变化）。
{
  const ex = [
    { ghsa: 'GHSA-vcc3-ghjq-m6fr', package: 'x', severity: 'moderate', chain: 'a→b', reason: 'r', reviewBy: '2026-10-01', expiredAction: 'DO_SOMETHING_ACTION' },
    { ghsa: 'GHSA-528h-pc64-c93x', package: 'y', severity: 'moderate', chain: 'c→d', reason: 'r', reviewBy: '2026-10-01', expiredAction: 'DO_OTHER_ACTION' },
  ];
  const { failures: f } = check({ ciText: makeCi(), today: TODAY, exemptions: ex });
  assert('正例（两条豁免、日期一致、未到期）无违规', f.length === 0);
}

// ── ① 解析器必须只吃 npm-audit job（不能把隔壁 job 的 GHSA 算进来） ──
{
  const p = parseCiExemptions(makeCi({ extraJob: true }));
  assert('解析器不吃隔壁 job 的 GHSA', !p.ghsa.includes('GHSA-DECOY-0000-0000'));
  assert('解析器取到两条豁免', p.ghsa.length === 2);
}

// ── ①b 解析器只认 known 变量：散文里提到的 GHSA（如"已清偿"注记）不得算活跃 ──
{
  const ci = [
    '  npm-audit:',
    '    steps:',
    '      - run: |',
    '          # N-13：**GHSA-zzzz-zzzz-zzzz 已清偿**——已从下方 known 移除',
    "          known='GHSA-528h-pc64-c93x'",
    '          echo "::notice::Next review date: 2026-10-01."',
  ].join('\n');
  const p = parseCiExemptions(ci);
  assert('散文中的已清偿 GHSA 不算活跃豁免', !p.ghsa.includes('GHSA-zzzz-zzzz-zzzz'));
  assert('known 变量中的豁免被取到', p.ghsa.includes('GHSA-528h-pc64-c93x'));
}
{
  // 空 known（漏洞已清零）：解析到 0 条 → 应触发"请同步删注册表"
  const ci = [
    '  npm-audit:',
    '    steps:',
    '      - run: |',
    "          known=''",
    '          echo "::notice::Next review date: 2026-10-01."',
  ].join('\n');
  const { failures: f } = check({ ciText: ci, today: TODAY });
  assert('known 为空时必须提示同步删注册表', f.some((x) => x.includes('未解析到任何 GHSA')));
}

// ── ② 到期即失败（fail-closed） ─────────────────────────────────
{
  const { failures: f } = check({ ciText: makeCi(), today: '2026-10-01', exemptions: TWO });
  assert('到期当天必须失败（含"已到期 0 天"）', f.some((x) => x.includes('已到期')));
}
{
  const { failures: f } = check({ ciText: makeCi(), today: '2026-10-02', exemptions: TWO });
  assert('到期次日必须失败', f.some((x) => x.includes('已到期 1 天')));
}

// ── ③ CI 有、注册表无 → 未登记（新增豁免必须显式登记语义） ──────
{
  const { failures: f } = check({
    ciText: makeCi({ ghsa: ['GHSA-vcc3-ghjq-m6fr', 'GHSA-528h-pc64-c93x', 'GHSA-new0-0000-0000'] }),
    today: TODAY,
    exemptions: TWO,
  });
  assert('未登记 GHSA 必须被检出', f.some((x) => x.includes('未登记') && x.includes('GHSA-new0')));
}

// ── ④ 注册表有、CI 无 → 僵尸豁免（已清偿应同步删除） ────────────
{
  const { failures: f } = check({ ciText: makeCi({ ghsa: ['GHSA-vcc3-ghjq-m6fr'] }), today: TODAY, exemptions: TWO });
  assert('僵尸豁免（CI 已清、注册表仍在）必须被检出', f.some((x) => x.includes('僵尸豁免') || x.includes('已无此项')));
}

// ── ⑤ 人工承诺与机器判据漂移（CI 注释日期 ≠ 注册表 reviewBy） ──
{
  const { failures: f } = check({ ciText: makeCi({ dates: ['2026-11-15'] }), today: TODAY, exemptions: TWO });
  assert('复查日期两处不一致必须被检出', f.some((x) => x.includes('不一致')));
}

// ── ⑥ 解析失败不得"跳过=通过" ─────────────────────────────────
{
  const { failures: f } = check({ ciText: '  something-else:\n    runs-on: ubuntu-latest\n', today: TODAY, exemptions: TWO });
  assert('找不到 npm-audit job 必须失败（不给跳过的口子）', f.some((x) => x.includes('npm-audit')));
}
{
  // 有 job 但无任何 GHSA（真实形态：漏洞已清零）
  const noGhsa = '  npm-audit:\n    steps:\n      - run: echo hi\n';
  const { failures: f } = check({ ciText: noGhsa, today: TODAY, exemptions: TWO });
  assert('豁免清零时必须提示同步删注册表（而非静默通过）', f.length > 0);
}

// ── ⑦ 每条豁免都必须有到期动作（不能只写日期不写做什么） ────────
{
  const missing = EXEMPTIONS.filter((e) => !e.expiredAction || e.expiredAction.length < 10);
  assert('全部豁免均登记了到期动作', missing.length === 0);
  const badDate = EXEMPTIONS.filter((e) => !/^\d{4}-\d{2}-\d{2}$/.test(e.reviewBy));
  assert('全部豁免 reviewBy 均为 YYYY-MM-DD', badDate.length === 0);
}

// ── 反证有牙：真实 CI 文件喂进去必须绿（守卫不能空转） ──────────
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const ciText = fs.readFileSync(path.join(here, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
  const { failures: f } = check({ ciText, today: TODAY });
  assert('真实 CI 文件在窗口内全绿（守卫真的在跑）', f.length === 0);
  const p = parseCiExemptions(ciText);
  // 真实 CI 的活跃豁免条数必须与注册表一致（不硬编码数字——清偿会改变条数）
  assert(`真实 CI 活跃豁免条数(${p.ghsa.length}) 与注册表(${EXEMPTIONS.length}) 一致`, p.ghsa.length === EXEMPTIONS.length);
}

console.log(failures === 0 ? '\ncheck-dependency-review selftest: all passed' : `\ncheck-dependency-review selftest: ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);

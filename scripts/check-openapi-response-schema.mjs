#!/usr/bin/env node
/**
 * ARCH-23 / N-12：OpenAPI **响应体 schema 覆盖率**守卫（棘轮门）。
 *
 * ## 为什么需要这道守卫（本轮净新发现）
 *
 * ARCH-23 的「OpenAPI→前端类型生成」链路**早已全部落地**（N-12 认领前复核结论）：
 *   · `apps/admin-api/openapi.json` 已提交，`npm run swagger:export` 可重导出；
 *   · `apps/admin-web` 有 `gen:api-types`（openapi-typescript 7.13.0）；
 *   · CI `api-types-drift` job 三重把关：① openapi.json ↔ 装饰器 diff、
 *     ② api-types.ts ↔ openapi.json diff、③ 空 schema 白名单（PK-15）。
 * 本轮实测重跑 `npm run gen:api-types` **零 diff**，链路确实在跑。
 *
 * **但「手写 interface 替换过半」这个验收指标卡住的真正原因不在前端**：
 * 实测 `openapi.json` 的 **208 个 2xx 响应里有 174 个（84%）没有 schema**
 * ——只写了 `{ description: "" }`，没有任何 `content`/`schema`。没有 schema
 * 就没有可生成的类型，前端只能继续手写。缺口集中在：
 * Team Task(27) / Application(14) / sop(13) / Executors(12) / System Config(11) /
 * App Deployment(11) / Executor Package(11) / Projects(10) …
 *
 * 即这是一个**后端装饰器覆盖**问题，而非生成链问题。要迁就该逐控制器补
 * `@ApiResponse({ type: XxxDto })`——那是跨多轮的工程，且**没有度量就无法推进**
 * （不知道在哪、不知道有没有倒退）。
 *
 * ## 本守卫做什么
 *
 * 把「响应 schema 覆盖率」变成可度量、只增不减的棘轮：
 *   ① 统计每个 tag 的 2xx 响应总数与**已有 schema** 数，输出缺口排名；
 *   ② 与 `scripts/openapi-response-schema-baseline.json` 的**已覆盖清单**比对：
 *      - 清单里**已覆盖但实际缺了**（说明有人删了装饰器）→ 红（防倒退）；
 *      - 实际覆盖数**低于**基线总数下限 → 红（总量倒退）；
 *      - 覆盖率**提升**时提示更新基线（棘轮上探，与 QA-02 覆盖率棘轮同纪律）。
 *
 * 为什么按「已覆盖条目清单」而不是只记一个百分比：百分比会掩盖
 * "补了 3 个又删了 3 个"；清单能把每个已覆盖的 `METHOD PATH CODE` 钉住，
 * 倒退无处可藏（与 check-failure-reasons / check-enum-drift 同思路）。
 *
 * ## 用法
 *   node scripts/check-openapi-response-schema.mjs            # 守卫
 *   node scripts/check-openapi-response-schema.mjs --report   # 打印缺口排名
 *   node scripts/check-openapi-response-schema.mjs --update   # 重写基线（棘轮上探后）
 *   node scripts/check-openapi-response-schema.mjs --selftest
 *
 * 纯静态读取 openapi.json（已提交产物），无需 npm ci / PG / Redis，秒级。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const SPEC = 'apps/admin-api/openapi.json';
const BASELINE = 'scripts/openapi-response-schema-baseline.json';

/** 收集全部 2xx 响应及其是否有 schema。 */
export function collect(spec) {
  const rows = [];
  for (const [p, ops] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(ops ?? {})) {
      if (!op || typeof op !== 'object') continue;
      if (!['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(method)) continue;
      const tag = (op.tags && op.tags[0]) || '(untagged)';
      for (const [code, res] of Object.entries(op.responses ?? {})) {
        if (!/^2\d\d$/.test(code)) continue;
        const hasSchema = Boolean(res && (res.content || res.schema || res.$ref));
        rows.push({
          key: `${method.toUpperCase()} ${p} ${code}`,
          tag,
          path: p,
          method: method.toUpperCase(),
          code,
          hasSchema,
          summary: op.summary ?? op.operationId ?? '',
        });
      }
    }
  }
  return rows;
}

/** 汇总统计（总数 / 已覆盖 / 按 tag 缺口排名）。 */
export function summarize(rows) {
  const total = rows.length;
  const covered = rows.filter((r) => r.hasSchema).length;
  const byTag = new Map();
  for (const r of rows) {
    const e = byTag.get(r.tag) ?? { total: 0, covered: 0 };
    e.total += 1;
    if (r.hasSchema) e.covered += 1;
    byTag.set(r.tag, e);
  }
  const gaps = [...byTag.entries()]
    .map(([tag, e]) => ({ tag, ...e, gap: e.total - e.covered }))
    .sort((a, b) => b.gap - a.gap || a.tag.localeCompare(b.tag));
  return { total, covered, uncovered: total - covered, pct: total ? (covered / total) * 100 : 100, byTag, gaps };
}

export function loadBaseline(p) {
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/**
 * @param {object} opts
 * @param {Array}  opts.rows       collect() 结果
 * @param {object} opts.baseline   基线（null = 无基线，首次运行）
 */
export function check({ rows, baseline }) {
  const failures = [];
  const notes = [];
  const s = summarize(rows);
  const coveredKeys = rows.filter((r) => r.hasSchema).map((r) => r.key);
  const coveredSet = new Set(coveredKeys);

  if (!baseline) {
    notes.push('无基线文件——首次运行，请用 --update 生成基线把当前覆盖钉住');
    return { failures, notes, summary: s };
  }

  // ① 防倒退：基线里已覆盖的条目必须仍然覆盖
  const regressed = (baseline.coveredKeys ?? []).filter((k) => !coveredSet.has(k));
  for (const k of regressed) {
    failures.push(
      `响应 schema 倒退：${k} 基线中已覆盖，现已缺失（有人删了 @ApiResponse({type}) 装饰器？）`,
    );
  }

  // ② 防总量倒退（覆盖数不得低于基线）
  const baseCovered = baseline.coveredCount ?? 0;
  if (s.covered < baseCovered) {
    failures.push(
      `响应 schema 覆盖数倒退：基线 ${baseCovered}，实际 ${s.covered}（少 ${baseCovered - s.covered}）`,
    );
  }

  // ③ 棘轮上探提示（有进步就该更新基线，否则下次可能悄悄退回去）
  if (s.covered > baseCovered) {
    notes.push(
      `覆盖率已提升：${baseCovered} → ${s.covered}（+${s.covered - baseCovered}）。` +
        `请运行 node scripts/check-openapi-response-schema.mjs --update 更新基线（棘轮只增不减）。`,
    );
  }

  for (const n of notes) void n;
  if (failures.length === 0) {
    notes.push(
      `响应 schema 覆盖 ${s.covered}/${s.total}（${s.pct.toFixed(1)}%），与基线一致且无倒退`,
    );
  }
  return { failures, notes, summary: s };
}

function writeBaseline(rows) {
  const s = summarize(rows);
  const coveredKeys = rows.filter((r) => r.hasSchema).map((r) => r.key).sort();
  const payload = {
    $comment:
      'ARCH-23 / N-12 响应 schema 覆盖率棘轮基线。coveredKeys = 已验证有 response schema 的 ' +
      'METHOD PATH CODE 条目（防倒退：删装饰器即红）；coveredCount = 覆盖总数下限（只增不减）。' +
      '补齐装饰器后用 --update 上探。覆盖率低不是缺陷本身，但**倒退**是。',
    coveredCount: s.covered,
    totalCount: s.total,
    pct: Number(s.pct.toFixed(1)),
    coveredKeys,
  };
  fs.writeFileSync(path.join(root, BASELINE), `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) {
    const r = spawnSync(process.execPath, [path.join(here, 'check-openapi-response-schema.selftest.mjs')], {
      stdio: 'inherit',
    });
    process.exit(r.status ?? 1);
  }

  const spec = JSON.parse(fs.readFileSync(path.join(root, SPEC), 'utf8'));
  const rows = collect(spec);

  if (args.includes('--update')) {
    const p = writeBaseline(rows);
    console.log(`基线已更新：覆盖 ${p.coveredCount}/${p.totalCount}（${p.pct}%），${p.coveredKeys.length} 条已覆盖条目`);
    process.exit(0);
  }

  if (args.includes('--report')) {
    const s = summarize(rows);
    console.log(`响应 schema 覆盖率：${s.covered}/${s.total}（${s.pct.toFixed(1)}%），缺口 ${s.uncovered}`);
    console.log('\n按 tag 缺口排名（前 25）：');
    for (const g of s.gaps.slice(0, 25)) {
      if (g.gap === 0) continue;
      console.log(`  gap=${String(g.gap).padStart(3)}  (${g.covered}/${g.total})  ${g.tag}`);
    }
    console.log('\n缺口明细（前 15 条）：');
    for (const r of rows.filter((x) => !x.hasSchema).slice(0, 15)) {
      console.log(`  ${r.key}  [${r.tag}]  ${r.summary}`.slice(0, 130));
    }
    process.exit(0);
  }

  const baseline = loadBaseline(path.join(root, BASELINE));
  const { failures, notes, summary } = check({ rows, baseline });
  for (const n of notes) console.log(`  ● ${n}`);
  if (failures.length > 0) {
    console.error('');
    for (const f of failures) console.error(`  ✘ ${f}`);
    console.error('\n响应 schema 覆盖率守卫失败。补齐 @ApiResponse({ type }) 装饰器后重跑；');
    console.error('若确为有意移除，请同步 --update 基线并在 PR 说明理由。');
    process.exit(1);
  }
  console.log(`\n响应 schema 覆盖率守卫通过（覆盖 ${summary.covered}/${summary.total}，无倒退）。`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}

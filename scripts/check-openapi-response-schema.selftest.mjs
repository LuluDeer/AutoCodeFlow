#!/usr/bin/env node
// scripts/check-openapi-response-schema.mjs 自检。
//
// 两层（T4 收编，统一走 scripts/lib/guard-selftest.mjs）：
//   ① **函数级矩阵**：collect/summarize/check 的判据逐条反证（删装饰器 / 改造端点 /
//      部分倒退 / 空壳 / 无基线…），每个负例都对应一个**真实会发生的**倒退形态；
//   ② **CLI 级反证**：把守卫当黑盒起真子进程，断言**退出码 + 关键文本 + 耗时**。
//      函数级测不到的东西全在 CLI 层：`process.exit(1)` 还在不在、事实源读不到时是
//      甩栈还是一句话、`--report` 会不会把结构性错误吞成 exit 0、扫描面坍缩后
//      「0 条 = 0 缺口」会不会被当成全绿。旧版自检一条 CLI 用例都没有。
//
// 直接执行本文件 / `node scripts/check-openapi-response-schema.mjs --selftest`
// 都跑同一套用例（后者 in-process import，省一层 node 启动）。
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expectExit, makeFixtureRepo, reportCases, runGuard } from './lib/guard-selftest.mjs';
import { check, collect, readSpec, summarize } from './check-openapi-response-schema.mjs';

const SELF = fileURLToPath(import.meta.url);
const HERE = path.dirname(SELF);
const REPO_ROOT = path.resolve(HERE, '..');
const GUARD = path.join(HERE, 'check-openapi-response-schema.mjs');
const SPEC_REL = 'apps/admin-api/openapi.json';
const BASELINE_REL = 'scripts/openapi-response-schema-baseline.json';

/** 单条 CLI 用例的耗时上限：一次完整扫描实测 ~50ms，留 40 倍余量防慢 runner。 */
const CASE_BUDGET_MS = 2000;

/** 造一个最小 openapi 文档。`entries` = [method, path, hasSchema, tag]。 */
function spec(entries) {
  const paths = {};
  for (const [method, p, hasSchema, tag] of entries) {
    paths[p] = paths[p] || {};
    paths[p][method] = {
      tags: [tag ?? 'T'],
      summary: `${method} ${p}`,
      responses: hasSchema
        ? { 200: { description: '', content: { 'application/json': { schema: { type: 'object' } } } } }
        : { 200: { description: '' } },
    };
  }
  return { paths };
}

/**
 * 造 n 条 2xx 的 openapi 文档（默认全部有 schema）。
 *
 * 为什么要「大」fixture：守卫新增了扫描面下界（`MIN_2XX_RESPONSES = 150`），
 * 只有真实量级的输入才能同时验证「正常规模放行」与「坍缩到几十条即红」。
 * `holes` 里的下标故意不带 schema —— 用来模拟「有人删了 @ApiResponse 装饰器」。
 */
function bigSpec(n, holes = []) {
  const paths = {};
  for (let i = 0; i < n; i += 1) {
    paths[`/p${i}`] = {
      get: {
        tags: ['T'],
        summary: `get /p${i}`,
        responses: { 200: holes.includes(i) ? { description: '' } : { description: '', content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } } } } },
      },
    };
  }
  return { paths };
}

/** 把真守卫脚本本身拷进 fixture：它的 root 由 `import.meta.url` 推出（`<fixture>/scripts/..`）。 */
function guardCopy() {
  return { [path.join('scripts', 'check-openapi-response-schema.mjs')]: fs.readFileSync(GUARD, 'utf8') };
}

export function runSelftest() {
  const cases = [];
  const test = (name, fn) => cases.push({ name, fn });
  const must = (cond, message) => {
    if (!cond) throw new Error(message);
  };
  /** CLI 级用例：造树 → 跑真子进程 → 断言 → cleanup。 */
  const subprocess = (name, files, args, expectations) => {
    test(name, () => {
      const repo = makeFixtureRepo({ ...guardCopy(), ...files }, {
        prefix: 'openapi-schema-selftest-',
      });
      try {
        const script = repo.pathOf(path.join('scripts', 'check-openapi-response-schema.mjs'));
        expectExit(runGuard(script, { args }), { ...expectations, withinMs: CASE_BUDGET_MS, label: name });
      } finally {
        repo.cleanup();
      }
    });
  };

  // ── collect：只认 2xx、只认 HTTP 方法、正确判定 content/schema/$ref ────────
  {
    const s = spec([
      ['get', '/a', true],
      ['post', '/b', false],
    ]);
    // 混入非 2xx 与 $ref 形态
    s.paths['/c'] = {
      get: { tags: ['T'], responses: { 404: { description: 'nope' }, 201: { $ref: '#/x' } } },
    };
    s.paths['/d'] = { parameters: [] }; // 非方法键必须忽略
    const rows = collect(s);
    test('只统计 2xx（404 不计入）', () =>
      must(!rows.some((r) => r.code === '404'), '404 响应被统计进来了'));
    test('$ref 形态算已覆盖', () =>
      must(rows.find((r) => r.path === '/c')?.hasSchema === true, '/c 的 $ref 形未被算作已覆盖'));
    test('非方法键（parameters）被忽略', () =>
      must(!rows.some((r) => r.path === '/d'), 'parameters 键被当成了 HTTP 方法'));
    test('总数 = 3（a/b 各 1 + c 的 201；c 的 404 不计）', () =>
      must(rows.length === 3, `rows.length=${rows.length}，期望 3`));
  }

  // ── summarize：覆盖率与 tag 缺口排名 ──────────────────────────────────
  {
    const rows = collect(
      spec([
        ['get', '/x1', true, 'A'],
        ['get', '/x2', true, 'A'],
        ['get', '/x3', false, 'A'],
        ['get', '/y1', false, 'B'],
        ['get', '/y2', false, 'B'],
      ]),
    );
    const s = summarize(rows);
    test('覆盖率 2/5 = 40%', () =>
      must(
        s.covered === 2 && s.total === 5 && Math.round(s.pct) === 40,
        `covered=${s.covered} total=${s.total} pct=${s.pct}`,
      ));
    test('缺口排名按 gap 降序（B gap=2 在 A gap=1 之前）', () =>
      must(s.gaps[0].tag === 'B', `gaps[0]=${JSON.stringify(s.gaps[0])}`));
  }

  // ── ① 防倒退：基线已覆盖，现缺失 → 红 ──────────────────────────────
  {
    const rows = collect(spec([['get', '/a', false], ['get', '/b', true]]));
    const baseline = { coveredCount: 2, coveredKeys: ['GET /a 200', 'GET /b 200'] };
    const { failures: f } = check({ rows, baseline });
    test('删掉装饰器（基线已覆盖现缺失）必须被检出', () =>
      must(
        f.some((x) => x.includes('倒退') && x.includes('GET /a 200')),
        `failures=${JSON.stringify(f)}`,
      ));
  }

  // ── ② 防总量倒退（即便 key 集合对不上也要判） ──────────────────────
  {
    const rows = collect(spec([['get', '/b', true]]));
    const baseline = { coveredCount: 5, coveredKeys: ['GET /b 200'] };
    const { failures: f } = check({ rows, baseline });
    test('覆盖总数低于基线必须被检出', () =>
      must(f.some((x) => x.includes('覆盖数倒退')), `failures=${JSON.stringify(f)}`));
  }

  // ── ③ 无倒退时通过 ─────────────────────────────────────────────────
  {
    const rows = collect(spec([['get', '/a', true], ['get', '/b', false]]));
    const baseline = { coveredCount: 1, coveredKeys: ['GET /a 200'] };
    const { failures: f, notes: n } = check({ rows, baseline });
    test('无倒退时零失败', () => must(f.length === 0, `failures=${JSON.stringify(f)}`));
    test('通过时给出覆盖率提示', () =>
      must(n.some((x) => x.includes('1/2')), `notes=${JSON.stringify(n)}`));
  }

  // ── ④ 棘轮上探提示（覆盖提升时要求更新基线） ────────────────────────
  {
    const rows = collect(spec([['get', '/a', true], ['get', '/b', true]]));
    const baseline = { coveredCount: 1, coveredKeys: ['GET /a 200'] };
    const { failures: f, notes: n } = check({ rows, baseline });
    test('覆盖提升时零失败（不拦进步）', () => must(f.length === 0, `failures=${JSON.stringify(f)}`));
    test('覆盖提升时提示更新基线（棘轮上探）', () =>
      must(
        n.some((x) => x.includes('已提升') || x.includes('--update')),
        `notes=${JSON.stringify(n)}`,
      ));
  }

  // ── ⑤ 无基线：不得"跳过=通过"，要提示生成 ───────────────────────────
  {
    const rows = collect(spec([['get', '/a', false]]));
    const { failures: f, notes: n } = check({ rows, baseline: null });
    test('无基线时零失败但给出提示', () =>
      must(f.length === 0 && n.some((x) => x.includes('基线')), `f=${JSON.stringify(f)} n=${JSON.stringify(n)}`));
  }

  // ── ⑦ 空壳 schema：引用空组件不得算已覆盖（首版假绿来源） ──────────
  {
    // 造「实体类无 @ApiProperty」的典型产物：具名 schema 存在但 properties 为空
    const hollowSpec = {
      components: {
        schemas: {
          BareEntity: { type: 'object', properties: {} },
          RealDto: { type: 'object', properties: { id: { type: 'string' } } },
        },
      },
      paths: {
        '/hollow': { get: { tags: ['T'], responses: { 200: { description: '', content: { 'application/json': { schema: { $ref: '#/components/schemas/BareEntity' } } } } } } },
        '/real': { get: { tags: ['T'], responses: { 200: { description: '', content: { 'application/json': { schema: { $ref: '#/components/schemas/RealDto' } } } } } } },
      },
    };
    const rows = collect(hollowSpec);
    const hollow = rows.find((r) => r.path === '/hollow');
    const real = rows.find((r) => r.path === '/real');
    test('引用空壳组件的响应 hasSchema=false（不算已覆盖）', () =>
      must(hollow.hasSchema === false, `hollow.hasSchema=${hollow.hasSchema}`));
    test('引用空壳组件的响应 hollow=true（单独标记）', () =>
      must(hollow.hollow === true, `hollow.hollow=${hollow.hollow}`));
    test('引用有字段 DTO 的响应 hasSchema=true', () =>
      must(real.hasSchema === true && real.hollow === false, `real=${JSON.stringify(real)}`));
    test('summarize 单独暴露空壳计数', () =>
      must(summarize(rows).hollow === 1, `hollow=${summarize(rows).hollow}`));
  }

  // ── ⑧ 新增空壳必须被拦住（存量允许、新增即红） ─────────────────────
  {
    const rows = collect({
      components: { schemas: { BareEntity: { type: 'object', properties: {} } } },
      paths: { '/h': { get: { tags: ['T'], responses: { 200: { description: '', content: { 'application/json': { schema: { $ref: '#/components/schemas/BareEntity' } } } } } } } },
    });
    const { failures: f1 } = check({ rows, baseline: { coveredCount: 0, coveredKeys: [], hollowKeys: [] } });
    test('新增空壳必须被检出', () =>
      must(f1.some((x) => x.includes('新增空壳')), `failures=${JSON.stringify(f1)}`));
    const { failures: f2 } = check({ rows, baseline: { coveredCount: 0, coveredKeys: [], hollowKeys: ['GET /h 200'] } });
    test('基线已接受的存量空壳不重复报红', () =>
      must(!f2.some((x) => x.includes('新增空壳')), `failures=${JSON.stringify(f2)}`));
  }

  // ── ⑥ 反证有牙：真实 openapi.json 喂进去必须绿（守卫不能空转） ──────
  {
    const specJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, SPEC_REL), 'utf8'));
    const baseline = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, BASELINE_REL), 'utf8'));
    const rows = collect(specJson);
    const { failures: f } = check({ rows, baseline });
    test('真实 openapi.json + 真实基线全绿（守卫真的在跑）', () =>
      must(f.length === 0, `failures=${JSON.stringify(f.slice(0, 3))}`));
    test(`真实覆盖数 = 基线（${baseline.coveredCount}）`, () =>
      must(
        summarize(rows).covered === baseline.coveredCount,
        `实际 ${summarize(rows).covered} ≠ 基线 ${baseline.coveredCount}——覆盖率提升后请跑 ` +
          `node scripts/check-openapi-response-schema.mjs --update 上探基线（棘轮只增不减，但基线必须跟上）`,
      ));
  }

  // ── CLI 级反证（T4 收编）：退出码 + 关键文本 + 耗时 ───────────────────
  // ① 控制组：真仓库真事实源 → 必须 exit 0。没有它，「后面几条全红」也可能只是
  //    因为守卫根本跑不起来。顺带钉住「扫描面下界（150）不误伤真实规模（240+）」。
  test('CLI ① 真仓库原样 → exit 0（控制组）', () => {
    expectExit(runGuard(GUARD), {
      code: 0,
      contains: ['响应 schema 覆盖率守卫通过'],
      absent: ['✘', '扫描面'],
      withinMs: CASE_BUDGET_MS,
      label: 'CLI ① 真仓库原样 → exit 0',
    });
  });

  // ② 防倒退在 CLI 层真的关门：删掉一个基线已覆盖条目的 schema → exit 1 + 点名条目。
  //    （函数级已覆盖判据本身，这条钉的是「判据红了之后 process.exit(1) 还在」。）
  {
    // 基线**记录着** 150 条已覆盖（含 GET /p7 200），真值只有 149 条 —— 差的这条
    // 就是「有人删了 @ApiResponse({type}) 装饰器」的形态。
    const allKeys = Array.from({ length: 150 }, (_, i) => `GET /p${i} 200`);
    subprocess(
      'CLI ② 删掉一条已覆盖条目的 schema → exit 1 并点名',
      {
        [SPEC_REL]: bigSpec(150, [7]),
        [BASELINE_REL]: { coveredCount: allKeys.length, coveredKeys: allKeys },
      },
      [],
      {
        code: 1,
        contains: ['响应 schema 倒退', 'GET /p7 200'],
        absent: ['响应 schema 覆盖率守卫通过'],
      },
    );
  }

  // ③ `--report` 不得吞结构错误：扫描面坍缩（只有 3 条 2xx，远低于 MIN_2XX_RESPONSES=150）
  //    时，旧实现在这里 print 完一屏「3/3（100%）」就 exit 0 —— 那正是「闸自己把闸
  //    拆了」的形态。用 3 条而不是 0 条：0 条也会被同一条下限判死（0 < 150），
  //    而 3 条能顺带证明**下界常量本身**在起作用（不是只判「空」）。
  subprocess(
    'CLI ③ --report 遇上扫描面坍缩（3 条 2xx ≪ 下界 150）→ exit 1（不再吞结构错误）',
    { [SPEC_REL]: bigSpec(3) },
    ['--report'],
    {
      code: 1,
      contains: ['只扫到 3 个 2xx 响应', '明显少于历史规模'],
      absent: ['按 tag 缺口排名'],
    },
  );

  // ④ 事实源缺失：`readSpec` 必须**返回**一句可读报错而不是 throw（旧实现是裸
  //    `JSON.parse(fs.readFileSync(...))`：CLI 上表现为一屏 SyntaxError/ENOENT 栈）。
  //    这条走 in-process —— 它测的是「读取契约」（不抛、点名路径、指向 swagger:export），
  //    而 CLI 上「错误文本 + exit 1」的接线由 CLI ③ 那条同源的结构闸用例证明；
  //    openapi.json 是仓库固定路径（没有 --root），起子进程也只能看同一个文件。
  test('CLI ④ 事实源（openapi.json）缺失 → 返回可读报错、不抛栈', () => {
    const missing = path.join(HERE, '__definitely_missing_openapi.json');
    let result;
    try {
      result = readSpec(missing);
    } catch (err) {
      throw new Error(`readSpec 抛了错（CLI 上就是一屏栈）：${err.message}`);
    }
    must(result.spec === null && typeof result.error === 'string', `result=${JSON.stringify(result)}`);
    must(
      result.error.includes('__definitely_missing_openapi.json') && result.error.includes('不可读/不可解析'),
      `报错没点名路径/没说明不可读：${result.error}`,
    );
    must(
      !/\n\s+at /.test(result.error),
      '报错文本里带了调用栈（应当只有一句话）',
    );
  });

  const failed = reportCases(cases, { title: 'check-openapi-response-schema selftest' });
  return failed === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(SELF)) {
  process.exit(runSelftest());
}

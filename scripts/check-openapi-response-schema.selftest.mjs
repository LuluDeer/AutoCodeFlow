#!/usr/bin/env node
// scripts/check-openapi-response-schema.mjs 自检：构造 spec 矩阵，断言判据逐条有齿。
// 每个负例都对应一个**真实会发生的**倒退形态（删装饰器 / 改造端点 / 部分倒退）。
import { collect, summarize, check } from './check-openapi-response-schema.mjs';

let failures = 0;
function assert(name, cond) {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.error(`  ✘ ${name}`);
  }
}

/** 造一个最小 openapi 文档。`covered` = 需要带 schema 的 [method, path] 列表。 */
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
  assert('只统计 2xx（404 不计入）', !rows.some((r) => r.code === '404'));
  assert('$ref 形态算已覆盖', rows.find((r) => r.path === '/c')?.hasSchema === true);
  assert('非方法键（parameters）被忽略', !rows.some((r) => r.path === '/d'));
  assert('总数 = 3（a/b 各 1 + c 的 201；c 的 404 不计）', rows.length === 3);
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
  assert('覆盖率 2/5 = 40%', s.covered === 2 && s.total === 5 && Math.round(s.pct) === 40);
  assert('缺口排名按 gap 降序（B gap=2 在 A gap=1 之前）', s.gaps[0].tag === 'B');
}

// ── ① 防倒退：基线已覆盖，现缺失 → 红 ──────────────────────────────
{
  const rows = collect(spec([['get', '/a', false], ['get', '/b', true]]));
  const baseline = { coveredCount: 2, coveredKeys: ['GET /a 200', 'GET /b 200'] };
  const { failures: f } = check({ rows, baseline });
  assert('删掉装饰器（基线已覆盖现缺失）必须被检出', f.some((x) => x.includes('倒退') && x.includes('GET /a 200')));
}

// ── ② 防总量倒退（即便 key 集合对不上也要判） ──────────────────────
{
  const rows = collect(spec([['get', '/b', true]]));
  const baseline = { coveredCount: 5, coveredKeys: ['GET /b 200'] };
  const { failures: f } = check({ rows, baseline });
  assert('覆盖总数低于基线必须被检出', f.some((x) => x.includes('覆盖数倒退')));
}

// ── ③ 无倒退时通过 ─────────────────────────────────────────────────
{
  const rows = collect(spec([['get', '/a', true], ['get', '/b', false]]));
  const baseline = { coveredCount: 1, coveredKeys: ['GET /a 200'] };
  const { failures: f, notes: n } = check({ rows, baseline });
  assert('无倒退时零失败', f.length === 0);
  assert('通过时给出覆盖率提示', n.some((x) => x.includes('1/2')));
}

// ── ④ 棘轮上探提示（覆盖提升时要求更新基线） ────────────────────────
{
  const rows = collect(spec([['get', '/a', true], ['get', '/b', true]]));
  const baseline = { coveredCount: 1, coveredKeys: ['GET /a 200'] };
  const { failures: f, notes: n } = check({ rows, baseline });
  assert('覆盖提升时零失败（不拦进步）', f.length === 0);
  assert('覆盖提升时提示更新基线（棘轮上探）', n.some((x) => x.includes('已提升') || x.includes('--update')));
}

// ── ⑤ 无基线：不得"跳过=通过"，要提示生成 ───────────────────────────
{
  const rows = collect(spec([['get', '/a', false]]));
  const { failures: f, notes: n } = check({ rows, baseline: null });
  assert('无基线时零失败但给出提示', f.length === 0 && n.some((x) => x.includes('基线')));
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
  assert('引用空壳组件的响应 hasSchema=false（不算已覆盖）', hollow.hasSchema === false);
  assert('引用空壳组件的响应 hollow=true（单独标记）', hollow.hollow === true);
  assert('引用有字段 DTO 的响应 hasSchema=true', real.hasSchema === true && real.hollow === false);
  assert('summarize 单独暴露空壳计数', summarize(rows).hollow === 1);
}

// ── ⑧ 新增空壳必须被拦住（存量允许、新增即红） ─────────────────────
{
  const rows = collect({
    components: { schemas: { BareEntity: { type: 'object', properties: {} } } },
    paths: { '/h': { get: { tags: ['T'], responses: { 200: { description: '', content: { 'application/json': { schema: { $ref: '#/components/schemas/BareEntity' } } } } } } } },
  });
  const { failures: f1 } = check({ rows, baseline: { coveredCount: 0, coveredKeys: [], hollowKeys: [] } });
  assert('新增空壳必须被检出', f1.some((x) => x.includes('新增空壳')));
  const { failures: f2 } = check({ rows, baseline: { coveredCount: 0, coveredKeys: [], hollowKeys: ['GET /h 200'] } });
  assert('基线已接受的存量空壳不重复报红', !f2.some((x) => x.includes('新增空壳')));
}

// ── ⑥ 反证有牙：真实 openapi.json 喂进去必须绿（守卫不能空转） ──────
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const specJson = JSON.parse(fs.readFileSync(path.join(here, '..', 'apps', 'admin-api', 'openapi.json'), 'utf8'));
  const baseline = JSON.parse(fs.readFileSync(path.join(here, 'openapi-response-schema-baseline.json'), 'utf8'));
  const rows = collect(specJson);
  const { failures: f } = check({ rows, baseline });
  assert('真实 openapi.json + 真实基线全绿（守卫真的在跑）', f.length === 0);
  assert(`真实覆盖数 = 基线（${baseline.coveredCount}）`, summarize(rows).covered === baseline.coveredCount);
}

console.log(failures === 0 ? '\ncheck-openapi-response-schema selftest: all passed' : `\ncheck-openapi-response-schema selftest: ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);

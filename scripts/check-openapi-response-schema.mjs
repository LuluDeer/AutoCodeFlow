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
 * ## 入口前置闸（T4 收编补）
 *   · 事实源读不到/写坏（openapi.json、基线 JSON）→ **一句可读报错 + exit 1**，
 *     不再抛 node 栈（栈让人分不清是「文件坏了」还是「守卫崩了」）；
 *   · 扫描面下界：2xx 响应数 < `MIN_2XX_RESPONSES`（150，实测当前 240）→ exit 1。
 *     这道闸对 `--report` / `--update` **同样生效**——旧行为是前者照常 exit 0
 *     （「3/3 = 100%」的假绿）、后者把一份坍缩的基线写盘（此后守卫永远绿）。
 *
 * 纯静态读取 openapi.json（已提交产物），无需 npm ci / PG / Redis，秒级。
 *
 * ## 自检：伴生文件已**归并**进 `--selftest`（T4 收编）
 *
 * 原 `scripts/check-openapi-response-schema.selftest.mjs` 已删除，全部断言并入下面的
 * `runSelftest()`（入口只有 `node scripts/check-openapi-response-schema.mjs --selftest`）。
 * 理由：该伴生文件的每条用例都在测**本脚本的判据**（`import { check, collect,
 * readSpec, summarize }` 喂内存 fixture），既不联网也不依赖产物——保留独立文件的
 * 理由不成立，却多了一个入口（`--selftest` 还要再 `import()` 一次自己）。归并后
 * 用例逐条保留（函数级矩阵 + CLI 级真子进程反证 + 一条元用例）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expectExit, makeFixtureRepo, reportCases, runGuard } from './lib/guard-selftest.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const SPEC = 'apps/admin-api/openapi.json';
const BASELINE = 'scripts/openapi-response-schema-baseline.json';

/**
 * 扫描面下界（T4 收编补）。
 *
 * `collect()` 只认 `paths[*][<http method>].responses[*]` 里的 2xx —— 所以
 * openapi.json 一旦被截断、换成别的 schema 版本、或 `paths` 键被重命名，rows 会
 * **静默变成 0 条**，而「0 条 = 0 缺口 = 100% 覆盖」在那个方向上恰好是绿色。
 * 基线在库时，总量棘轮（`covered < baseCovered`）能兜住；但基线缺失（首次运行、
 * 或有人把基线也清空）时就是纯假绿，`--report` 更会直接 exit 0、`--update` 会把
 * 一份 0/0 基线写盘——**此后守卫永远绿**（这是最贵的一种：闸自己把闸拆了）。
 *
 * 故：所有入口（判红绿 / --report / --update）先过 `structuralProblems()`，
 * 结构性问题一律退出码 1 + 一句可读报错。下界取 150（实测当前 240 条 2xx），
 * 与 check-migration-symmetry 的 `DEFAULT_ROOT_MIN_MIGRATIONS=100`、
 * check-guards-wired 的 `MIN_GUARD_COUNT=20` 同口径：明显少于历史规模即视为
 * 扫描面失效，而不是「缺口归零」。
 */
const MIN_2XX_RESPONSES = 150;

/** 收集全部 2xx 响应及其 schema 是否**实质有效**。 */
export function collect(spec) {
  // 「有 content」不等于「有可用类型」：@nestjs/swagger 对**实体类**（无 @ApiProperty）
  // 会 emit `{type:'object', properties:{}}` —— 一个**空壳 schema**。前端据此生成的是
  // `Record<string, never>`，比没有 schema 更坏（看着有类型，实际什么都写不了）。
  // 故先把「空 object schema」的具名组件收集起来，凡 `$ref` 指向它们的响应一律
  // **不算已覆盖**。这一条是本守卫首版**真实的假绿来源**：首版只看 `res.content`
  // 是否存在，于是把 9 条空壳响应（Application/TaskTemplate/EventSubscription 等）
  // 计成了"已覆盖"——CI 的 PK-15 空 schema 闸正是这样把本仓打红的（见 74afb6f8 的
  // api-types-drift 失败），而本守卫当时却报绿，属"守卫之间口径不一致"。
  const schemas = spec.components?.schemas ?? {};
  const emptySchemas = new Set(
    Object.entries(schemas)
      .filter(([, s]) => {
        if (!s || typeof s !== 'object') return false;
        if (s.allOf || s.anyOf || s.oneOf) return false;
        if (s.type !== 'object') return false;
        // 只有 properties 存在且为空才算空壳；无 properties 键的（如纯 $ref 别名）不判
        return s.properties && Object.keys(s.properties).length === 0;
      })
      .map(([n]) => n),
  );

  const refsOf = (node) => {
    const found = [];
    const walk = (n) => {
      if (!n || typeof n !== 'object') return;
      if (typeof n.$ref === 'string') found.push(n.$ref.split('/').pop());
      for (const v of Object.values(n)) walk(v);
    };
    walk(node);
    return found;
  };

  const rows = [];
  for (const [p, ops] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(ops ?? {})) {
      if (!op || typeof op !== 'object') continue;
      if (!['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(method)) continue;
      const tag = (op.tags && op.tags[0]) || '(untagged)';
      for (const [code, res] of Object.entries(op.responses ?? {})) {
        if (!/^2\d\d$/.test(code)) continue;
        // 2026-10-07 扩展：非 JSON 成功载荷（text/x-shellscript 安装脚本、
        // application/gzip 产物下载）此前被当"无 schema"漏计；204 无内容响应
        // （executor DELETE）同理。前者回退取首个 content 的 schema，后者在
        // 有 description 时视为完整声明（无内容可描述 ≠ 未声明）。
        const schemaNode =
          res?.content?.['application/json']?.schema ??
          res?.content?.['*/*']?.schema ??
          res?.schema ??
          (res?.$ref ? { $ref: res.$ref } : null) ??
          (code === '204' && res?.description
            ? { type: 'string', description: 'no content' }
            : null) ??
          Object.values(res?.content ?? {})[0]?.schema ??
          null;
        const hasContent = Boolean(schemaNode);
        // 空壳判定：引用了空 schema，且 schema 本身没有任何内联字段
        const inlineProps =
          schemaNode && typeof schemaNode === 'object' && schemaNode.properties
            ? Object.keys(schemaNode.properties).length
            : null;
        const refs = hasContent ? refsOf(schemaNode) : [];
        // R7（2026-10-07）第二形态空壳：schema 只有 example/examples（PK-15
        // 的 example-only 装饰器残留）——没有任何类型信息，前端生成不出字段，
        // 与 properties:{} 同罪。有 $ref/properties/items/additionalProperties/
        // oneOf/anyOf/allOf/format/nullable 结构的都算有类型。
        const typeBearing =
          hasContent &&
          typeof schemaNode === 'object' &&
          ['$ref', 'properties', 'items', 'additionalProperties', 'oneOf', 'anyOf', 'allOf', 'format', 'nullable'].some(
            (k) => k in schemaNode,
          ) &&
          (schemaNode.type === undefined || schemaNode.type !== 'object' || 'properties' in schemaNode || 'additionalProperties' in schemaNode);
        const exampleOnly =
          hasContent &&
          typeof schemaNode === 'object' &&
          !typeBearing &&
          ('example' in schemaNode || 'examples' in schemaNode) &&
          Object.keys(schemaNode).every((k) => ['example', 'examples', 'description'].includes(k));
        const hollow =
          hasContent &&
          (inlineProps === 0 ||
            exampleOnly ||
            (inlineProps === null && refs.length > 0 && refs.every((r) => emptySchemas.has(r))));
        rows.push({
          key: `${method.toUpperCase()} ${p} ${code}`,
          tag,
          path: p,
          method: method.toUpperCase(),
          code,
          hasSchema: hasContent && !hollow,
          hollow,
          summary: op.summary ?? op.operationId ?? '',
        });
      }
    }
  }
  return rows;
}

/** 汇总统计（总数 / 已覆盖 / 空壳 / 按 tag 缺口排名）。 */
export function summarize(rows) {
  const total = rows.length;
  const covered = rows.filter((r) => r.hasSchema).length;
  // 空壳单独计数并暴露：它们**看着有 schema 却生成不出可用类型**，
  // 是"覆盖率虚高"的唯一来源，必须与真覆盖分开报。
  const hollow = rows.filter((r) => r.hollow).length;
  const byTag = new Map();
  for (const r of rows) {
    const e = byTag.get(r.tag) ?? { total: 0, covered: 0, hollow: 0 };
    e.total += 1;
    if (r.hasSchema) e.covered += 1;
    if (r.hollow) e.hollow += 1;
    byTag.set(r.tag, e);
  }
  const gaps = [...byTag.entries()]
    .map(([tag, e]) => ({ tag, ...e, gap: e.total - e.covered }))
    .sort((a, b) => b.gap - a.gap || a.tag.localeCompare(b.tag));
  return {
    total,
    covered,
    hollow,
    uncovered: total - covered,
    pct: total ? (covered / total) * 100 : 100,
    byTag,
    gaps,
  };
}

export function loadBaseline(p) {
  if (!fs.existsSync(p)) return null;
  // 事实源损坏不抛栈（T4 收编）：基线写坏时裸 `JSON.parse` 会甩出一屏 node 内部
  // 栈，读的人分不清「基线写坏了」与「守卫自己崩了」。转成一句带路径的可读报错，
  // 由 main() 判 1（仍然 fail-closed：不会把「读不懂基线」当成「没有基线」）。
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    throw new Error(
      `基线文件不可读/不可解析：${p}（${err.code ?? err.message}）——请修好它，或删掉它重跑 --update 生成`,
    );
  }
}

/**
 * 结构闸：把「扫到的内容不构成一个有意义的扫描面」单独判死。
 *
 * 见 `MIN_2XX_RESPONSES` 的注释：这是 `--report` / `--update` 与判红绿三条路径
 * 共用的同一道闸（以前只有判红绿路径间接受基线保护，另两条直接 exit 0）。
 */
export function structuralProblems(rows) {
  if (rows.length === 0) {
    return [
      `扫描面为空：${SPEC} 里一个 2xx 响应都没读到（paths / responses 键名或 OpenAPI 版本变了？）` +
        `——「0 条 = 0 缺口」不是全绿，是扫描面失效。`,
    ];
  }
  if (rows.length < MIN_2XX_RESPONSES) {
    return [
      `只扫到 ${rows.length} 个 2xx 响应，明显少于历史规模（${MIN_2XX_RESPONSES}+）——` +
        `${SPEC} 被截断/换版本了吗？扫描面失效时覆盖率数字没有意义。`,
    ];
  }
  return [];
}

/**
 * 读事实源（openapi.json 是 swagger:export 的已提交产物）：失败给可读报错而不是栈。
 *
 * `specPath` 可传（默认仓库里那份）：selftest 用它断言「事实源缺失 → 返回可读
 * error 而不是 throw」——这条契约在 CLI 层的表现是「一句话 + exit 1」而不是一屏栈。
 */
export function readSpec(specPath = path.join(root, SPEC)) {
  try {
    return { spec: JSON.parse(fs.readFileSync(specPath, 'utf8')), error: null };
  } catch (err) {
    return {
      spec: null,
      error:
        `${specPath} 不可读/不可解析（${err.code ?? err.message}）——` +
        `这是 npm run swagger:export 的已提交产物，被移走/改名/写坏了吗？`,
    };
  }
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

  // ③ 空壳 schema（"看着有、生成不出类型"）：新增即红。
  // 这是本守卫首版的假绿来源——只判 `res.content` 存在会把实体类引用的空壳
  // 计成已覆盖。基线里已有的空壳（TaskTemplate/EventSubscription 等，属历史遗留）
  // 记入 baseline.hollowKeys 以允许存量，但**新增**空壳必须拦住：它会让覆盖率虚高，
  // 且前端生成出 `Record<string, never>` 比没有类型更坏。
  const hollowKeys = rows.filter((r) => r.hollow).map((r) => r.key).sort();
  const baseHollow = new Set(baseline.hollowKeys ?? []);
  const newHollow = hollowKeys.filter((k) => !baseHollow.has(k));
  for (const k of newHollow) {
    failures.push(
      `新增空壳 schema：${k} 的响应引用了一个 properties 为空的组件（通常是直接标注**实体类**——` +
        `实体没有 @ApiProperty，@nestjs/swagger 只 emit {type:'object',properties:{}}）。` +
        `前端会生成 Record<string, never>，比没有类型更坏。请改标响应 DTO（带 @ApiProperty）。`,
    );
  }

  // ④ 棘轮上探提示（有进步就该更新基线，否则下次可能悄悄退回去）
  if (s.covered > baseCovered) {
    notes.push(
      `覆盖率已提升：${baseCovered} → ${s.covered}（+${s.covered - baseCovered}）。` +
        `请运行 node scripts/check-openapi-response-schema.mjs --update 更新基线（棘轮只增不减）。`,
    );
  }

  if (s.hollow > 0) {
    notes.push(
      `空壳 schema（引用空组件，生成不出可用类型）：${s.hollow} 条` +
        `${baseHollow.size > 0 ? `（基线已接受 ${baseHollow.size} 条存量）` : ''}` +
        `。清单：${hollowKeys.slice(0, 5).join(', ')}${hollowKeys.length > 5 ? ' …' : ''}`,
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
  const hollowKeys = rows.filter((r) => r.hollow).map((r) => r.key).sort();
  const payload = {
    $comment:
      'ARCH-23 / N-12 响应 schema 覆盖率棘轮基线。coveredKeys = 已验证有**实质** response schema 的 ' +
      'METHOD PATH CODE 条目（防倒退：删装饰器即红）；coveredCount = 覆盖总数下限（只增不减）。' +
      'hollowKeys = 引用**空壳组件**（properties 为空的具名 schema）的响应——看着有 schema，' +
      '前端却只生成 Record<string, never>。存量记此以允许历史遗留，**新增即红**。' +
      '补齐装饰器后用 --update 上探。覆盖率低不是缺陷本身，但**倒退与空壳新增**是。',
    coveredCount: s.covered,
    totalCount: s.total,
    pct: Number(s.pct.toFixed(1)),
    hollowCount: s.hollow,
    coveredKeys,
    hollowKeys,
  };
  fs.writeFileSync(path.join(root, BASELINE), `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

// ─────────────────────────────── 自检 ───────────────────────────────
// 两层（统一走 `scripts/lib/guard-selftest.mjs`）：
//   ① **函数级矩阵**：collect/summarize/check 的判据逐条反证（删装饰器 / 改造端点 /
//      部分倒退 / 空壳 / 无基线…），每个负例都对应一个**真实会发生的**倒退形态；
//   ② **CLI 级反证**：把守卫当黑盒起真子进程（`runGuard` + `expectExit`），断言
//      **退出码 + 关键文本 + 耗时**。函数级测不到的东西全在 CLI 层：`process.exit(1)`
//      还在不在、事实源读不到时是甩栈还是一句话、`--report` 会不会把结构性错误吞成
//      exit 0、扫描面坍缩后「0 条 = 0 缺口」会不会被当成全绿。
// 旧版自检（伴生文件）一条 CLI 用例都没有；收编时补上，并加一条**元用例**钉住
// 「自检判红 → `--selftest` 退出码 1」。

/** 单条 CLI 用例的耗时上限：一次完整扫描实测 ~50ms，留 40 倍余量防慢 runner。 */
const CASE_BUDGET_MS = 2000;

/** 造一个最小 openapi 文档。`entries` = [method, path, hasSchema, tag]。 */
function specFixture(entries) {
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

const GUARD_REL = path.join('scripts', 'check-openapi-response-schema.mjs');
const HARNESS_REL = path.join('scripts', 'lib', 'guard-selftest.mjs');

/**
 * 把真守卫脚本**和它静态依赖的 harness** 一起拷进 fixture。
 *
 * 守卫的 `root` 由 `import.meta.url` 推出（`<fixture>/scripts/..`），所以只有把脚本
 * 本身放进 `<fixture>/scripts/` 才能让它在假树上而不是真仓库上跑。harness 必须一起拷：
 * 归并后本文件顶层 `import './lib/guard-selftest.mjs'`，少拷一份子进程会以
 * `MODULE_NOT_FOUND` 起不来——那种失败容易被误读成「守卫崩了」，而不是「夹具缺文件」。
 */
function guardCopy() {
  return {
    [GUARD_REL]: fs.readFileSync(path.join(here, 'check-openapi-response-schema.mjs'), 'utf8'),
    [HARNESS_REL]: fs.readFileSync(path.join(here, 'lib', 'guard-selftest.mjs'), 'utf8'),
  };
}

/** 跑自检；返回退出码（0 = 全绿）。 */
function runSelftest() {
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
        const script = repo.pathOf(GUARD_REL);
        expectExit(runGuard(script, { args }), { ...expectations, withinMs: CASE_BUDGET_MS, label: name });
      } finally {
        repo.cleanup();
      }
    });
  };

  // ── collect：只认 2xx、只认 HTTP 方法、正确判定 content/schema/$ref ────────
  {
    const s = specFixture([
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
      specFixture([
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
    const rows = collect(specFixture([['get', '/a', false], ['get', '/b', true]]));
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
    const rows = collect(specFixture([['get', '/b', true]]));
    const baseline = { coveredCount: 5, coveredKeys: ['GET /b 200'] };
    const { failures: f } = check({ rows, baseline });
    test('覆盖总数低于基线必须被检出', () =>
      must(f.some((x) => x.includes('覆盖数倒退')), `failures=${JSON.stringify(f)}`));
  }

  // ── ③ 无倒退时通过 ─────────────────────────────────────────────────
  {
    const rows = collect(specFixture([['get', '/a', true], ['get', '/b', false]]));
    const baseline = { coveredCount: 1, coveredKeys: ['GET /a 200'] };
    const { failures: f, notes: n } = check({ rows, baseline });
    test('无倒退时零失败', () => must(f.length === 0, `failures=${JSON.stringify(f)}`));
    test('通过时给出覆盖率提示', () =>
      must(n.some((x) => x.includes('1/2')), `notes=${JSON.stringify(n)}`));
  }

  // ── ④ 棘轮上探提示（覆盖提升时要求更新基线） ────────────────────────
  {
    const rows = collect(specFixture([['get', '/a', true], ['get', '/b', true]]));
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
    const rows = collect(specFixture([['get', '/a', false]]));
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
  // 事实源在**用例内**才读：读盘放在注册期会让「事实源缺失」直接炸掉整套自检
  // （甩一屏栈、一条 ✘ 都不打印），那样连元用例都无法观测「判红 → 退出码 1」。
  {
    test('真实 openapi.json + 真实基线全绿（守卫真的在跑）', () => {
      const rows = collect(JSON.parse(fs.readFileSync(path.join(root, SPEC), 'utf8')));
      const baseline = JSON.parse(fs.readFileSync(path.join(root, BASELINE), 'utf8'));
      const { failures: f } = check({ rows, baseline });
      must(f.length === 0, `failures=${JSON.stringify(f.slice(0, 3))}`);
    });
    test('真实覆盖数 = 基线（棘轮只增不减）', () => {
      const rows = collect(JSON.parse(fs.readFileSync(path.join(root, SPEC), 'utf8')));
      const baseline = JSON.parse(fs.readFileSync(path.join(root, BASELINE), 'utf8'));
      const covered = summarize(rows).covered;
      must(
        covered === baseline.coveredCount,
        `实际 ${covered} ≠ 基线 ${baseline.coveredCount}——覆盖率提升后请跑 ` +
          `node scripts/check-openapi-response-schema.mjs --update 上探基线（棘轮只增不减，但基线必须跟上）`,
      );
    });
  }

  // ── CLI 级反证：退出码 + 关键文本 + 耗时 ───────────────────────────────
  // ① 控制组：真仓库真事实源 → 必须 exit 0。没有它，「后面几条全红」也可能只是
  //    因为守卫根本跑不起来。顺带钉住「扫描面下界（150）不误伤真实规模（240+）」。
  test('CLI ① 真仓库原样 → exit 0（控制组）', () => {
    expectExit(runGuard(path.join(here, 'check-openapi-response-schema.mjs')), {
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
        [SPEC]: bigSpec(150, [7]),
        [BASELINE]: { coveredCount: allKeys.length, coveredKeys: allKeys },
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
    { [SPEC]: bigSpec(3) },
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
    const missing = path.join(here, '__definitely_missing_openapi.json');
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

  // ── 元用例：自检判红必须真的关门（`--selftest` → 退出码 1）──────────────
  // 唯一能观测「selftest 末尾 process.exit(1) 还在不在」的用例：自检本身在同一个进程
  // 里跑，失败只落在内存里，退出码没人看得见。做法：把守卫 + harness 原样拷进一棵
  // **没有 openapi.json / 没有基线**的空 fixture 再跑 `--selftest` —— 内层
  // 「真实 openapi.json + 真实基线全绿」用例读不到事实源、CLI ① 也拿不到 exit 0，
  // 于是这里必须看到 ✘ + 退出码 1。把 runSelftest 的 `return failed === 0 ? 0 : 1`
  // 那一侧的 1 抹掉，本条立刻转红。
  // 递归：子进程带 `ACF_GUARD_SELFTEST_META=0`，它自己的元用例据此跳过（只影响这一条）。
  if (process.env.ACF_GUARD_SELFTEST_META === '0') {
    console.log('  ⚠ 跳过元用例（本进程由元用例启动，防无限递归）');
  } else {
    test('元用例：内层用例判红 → --selftest 退出码 1', () => {
      const repo = makeFixtureRepo(guardCopy(), { prefix: 'openapi-schema-meta-' });
      try {
        expectExit(
          runGuard(repo.pathOf(GUARD_REL), {
            args: ['--selftest'],
            cwd: repo.dir,
            env: { ACF_GUARD_SELFTEST_META: '0' },
          }),
          {
            code: 1,
            contains: ['✘'],
            absent: ['selftest 通过'],
            label: '元用例：内层用例判红 → --selftest 退出码 1',
          },
        );
      } finally {
        repo.cleanup();
      }
    });
  }

  const failed = reportCases(cases, { title: 'check-openapi-response-schema selftest' });
  return failed === 0 ? 0 : 1;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) {
    // T4 收编：以前这里裸 `spawnSync(process.execPath, [selftest])`（stdio 继承、
    // `status ?? 1`），再后来改为 `import()` 伴生 selftest 文件。两个毛病：①
    // 被信号打断/起不来与「退出码 1」不可区分；② 多一层 node 启动，而 --selftest
    // 的耗时预算要留给真正的子进程用例。现在自检就在本文件里跑（内部仍把守卫
    // 当黑盒起真子进程），入口只有一个。
    process.exit(runSelftest());
  }

  const { spec, error } = readSpec();
  if (error) {
    console.error(`✗ ${error}`);
    process.exit(1);
  }
  const rows = collect(spec);

  // 结构闸（--report / --update / 判红绿三条路径共用）：扫描面失效时，后面所有
  // 数字都不作数——尤其 `--update` 会把一份 0/0 基线写盘，从此守卫永远绿。
  const structural = structuralProblems(rows);
  if (structural.length > 0) {
    for (const p of structural) console.error(`✗ ${p}`);
    process.exit(1);
  }

  if (args.includes('--update')) {
    const p = writeBaseline(rows);
    console.log(`基线已更新：覆盖 ${p.coveredCount}/${p.totalCount}（${p.pct}%），${p.coveredKeys.length} 条已覆盖条目`);
    process.exit(0);
  }

  if (args.includes('--report')) {
    const s = summarize(rows);
    console.log(
      `响应 schema 覆盖率：${s.covered}/${s.total}（${s.pct.toFixed(1)}%），缺口 ${s.uncovered}` +
        `，其中空壳 ${s.hollow} 条`,
    );
    console.log('\n按 tag 缺口排名（前 25）：');
    for (const g of s.gaps.slice(0, 25)) {
      if (g.gap === 0 && g.hollow === 0) continue;
      console.log(
        `  gap=${String(g.gap).padStart(3)}  (${g.covered}/${g.total})${g.hollow ? ` [空壳${g.hollow}]` : ''}  ${g.tag}`,
      );
    }
    if (s.hollow > 0) {
      console.log('\n空壳 schema（引用空组件，前端生成 Record<string, never>）：');
      for (const r of rows.filter((x) => x.hollow)) console.log(`  ${r.key}  [${r.tag}]`);
    }
    console.log('\n缺口明细（前 15 条）：');
    for (const r of rows.filter((x) => !x.hasSchema && !x.hollow).slice(0, 15)) {
      console.log(`  ${r.key}  [${r.tag}]  ${r.summary}`.slice(0, 130));
    }
    process.exit(0);
  }

  let baseline;
  try {
    baseline = loadBaseline(path.join(root, BASELINE));
  } catch (err) {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  }
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

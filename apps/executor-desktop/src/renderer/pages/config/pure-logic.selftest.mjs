/**
 * `ConfigPage` 纯逻辑外提（R7-C）的**真行为断言**。
 *
 * 为什么需要它：设置页此前**从未被类型检查、从未被执行**——`test:main` 的
 * 58 个 selftest 的 rootDir 是 `src/main`，`test:renderer` 对该页的全部手段是
 * `readFileSync` + `includes`（证明"源码文本没动"，与"重构后行为没变"是两件事，
 * 后者它一条都证明不了）。
 *
 * 这里用的是仓内已有的两条"零新依赖"通道（都已在 renderer.selftest.mjs 里用过）：
 *   ① `await import('./x.ts')` —— Node ≥22.6 原生解析 TypeScript（用于无依赖文件）；
 *   ② `ts.transpileModule` → CJS + `require` 注入 —— 用于**有相对依赖**的文件
 *      （`num-draft.ts` 依赖 `../../number-input`，裸 node 解析不了无扩展名的
 *      相对导入）。注入的是**真实** number-input 模块，不是替身，故不存在
 *      替身漂移（ADR-027）。
 *
 * 断言口径：每条都钉"行为/边界/真值表格子"，不钉实现写法。刻意包含几条
 * **记录既有怪癖**的用例（'4.6' 静默取整但不报钳制、'12abc' 被接受），
 * 它们的作用是：将来有人"顺手修"这些行为时，这条断言会先红。
 *
 * 由 `renderer.selftest.mjs` 尾部 import 驱动（`npm run test:renderer`）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const here = resolve(import.meta.dirname);
let checked = 0;
const check = (cond, msg) => {
  checked += 1;
  if (!cond) throw new Error(`ConfigPage 纯逻辑: ${msg}`);
};
const eq = (got, want, msg) => {
  checked += 1;
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) throw new Error(`ConfigPage 纯逻辑: ${msg}（得到 ${a}，期望 ${b}）`);
};
const same = (got, want, msg) => {
  checked += 1;
  if (got !== want) throw new Error(`ConfigPage 纯逻辑: ${msg}（两者不是同一引用）`);
};

/** 同 renderer.selftest.mjs 里 i18n 块用的转译加载器（那份是块内作用域）。 */
const ts = (await import('typescript')).default;
const loadTsModule = (file, deps = {}) => {
  const js = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: file,
  }).outputText;
  const mod = { exports: {} };
  new Function('exports', 'module', 'require', js)(mod.exports, mod, (spec) => {
    if (Object.prototype.hasOwnProperty.call(deps, spec)) return deps[spec];
    throw new Error(`ConfigPage 纯逻辑: ${file} 出现未注入的依赖 ${spec}`);
  });
  return mod.exports;
};

const numberInput = await import('../../number-input.ts');
const { MAX_CONCURRENT_TASKS, EXECUTOR_PORT, DOWNLOAD_TIMEOUT_MS } = numberInput;
const { draftOrDisplay, commitFromDraft, settleDraft, withoutKey } = loadTsModule(
  resolve(here, 'num-draft.ts'),
  { '../../number-input': numberInput },
);
const { sameConfigValue, anyFieldDiffer, changedEntriesOf, dirtySectionsOf } = await import('./dirty.ts');
const { planSave, saveStatusOf } = await import('./save-plan.ts');
const { normalizeSearchTerm, searchResultsOf, MAX_SEARCH_RESULTS } = await import('./search-index.ts');

// ── ① numDraft：草稿优先的显示值 ─────────────────────────────────────────
eq(draftOrDisplay({ port: '80' }, 'port', 8002, 8002), '80', '草稿优先于表单值（键入中不被回填）');
eq(draftOrDisplay({ port: '' }, 'port', 8002, 8002), '', '空草稿显示空串（不是默认值）');
eq(draftOrDisplay({ port: '0' }, 'port', 8002, 8002), '0', "草稿 '0' 不被当成缺失");
eq(draftOrDisplay({}, 'port', 8002, 8002), '8002', '无草稿时显示表单值');
eq(draftOrDisplay({}, 'port', NaN, 8002), '8002', '无草稿 + 状态 NaN → 回落默认（所见即所存）');
eq(draftOrDisplay({}, 'port', null, 8002), '8002', '无草稿 + 状态 null → 回落默认');

// ── ② numDraft：onChange 的提交判定（null = 只留草稿、不动表单）─────────
eq(commitFromDraft(EXECUTOR_PORT, '9999'), 9999, '合法整数即时入表单（区间内不改写）');
eq(commitFromDraft(EXECUTOR_PORT, ''), null, '空串不写 form（显示权在草稿，blur 收口）');
eq(commitFromDraft(EXECUTOR_PORT, '   '), null, '纯空白同空串');
eq(commitFromDraft(EXECUTOR_PORT, 'abc'), null, '非数字不写 form（不塞 NaN）');
eq(commitFromDraft(EXECUTOR_PORT, '0'), 1, '低于下界即时钳到 1');
eq(commitFromDraft(EXECUTOR_PORT, '-5'), 1, '负数即时钳到下界');
eq(commitFromDraft(EXECUTOR_PORT, '99999'), 65535, '高于上界即时钳到 65535');
eq(commitFromDraft(EXECUTOR_PORT, '4.6'), 4, '小数按 parseInt 取整');
eq(commitFromDraft(EXECUTOR_PORT, '12abc'), 12, '既有怪癖：parseInt 前缀解析（12abc → 12）');
eq(commitFromDraft(DOWNLOAD_TIMEOUT_MS, '0'), 0,
  '0 是合法值（min=0）：提交判定必须是 !== null，不能写成 !commit');

// ── ③ numDraft：onBlur 收口 + 钳制提示的触发条件 ─────────────────────────
eq(settleDraft(EXECUTOR_PORT, ''), { parsed: 8002, clamped: false }, '空串回落默认，不算钳制');
eq(settleDraft(EXECUTOR_PORT, 'abc'), { parsed: 8002, clamped: false }, '非数字回落默认，不算钳制');
eq(settleDraft(EXECUTOR_PORT, '8002'), { parsed: 8002, clamped: false }, '合法值原样收口');
eq(settleDraft(EXECUTOR_PORT, ' 8003 '), { parsed: 8003, clamped: false }, '首尾空白不算钳制');
eq(settleDraft(EXECUTOR_PORT, '0'), { parsed: 1, clamped: true }, '越界被改写 → 触发一次性提示');
eq(settleDraft(EXECUTOR_PORT, '99999'), { parsed: 65535, clamped: true }, '超上界被改写 → 触发提示');
eq(settleDraft(EXECUTOR_PORT, '-5'), { parsed: 1, clamped: true }, '负数被改写 → 触发提示');
eq(settleDraft(EXECUTOR_PORT, '4.6'), { parsed: 4, clamped: false },
  "既有怪癖：'4.6' 静默取整为 4 且**不**报钳制（parseInt 两侧同口径）");
eq(settleDraft(MAX_CONCURRENT_TASKS, '999'), { parsed: 100, clamped: true }, '并发数走自己的上界 100');

// ── ④ withoutKey：不可变删除 + 同引用短路（setState 依赖它）─────────────
{
  const absent = { a: '1' };
  same(withoutKey(absent, 'b'), absent, '键不存在时返回原对象（React 以引用相等跳过空重渲染）');
  const present = { a: '1', b: '2' };
  eq(withoutKey(present, 'b'), { a: '1' }, '键存在时返回删掉该键的副本');
  eq(present, { a: '1', b: '2' }, '不修改入参（不可变）');
  eq(withoutKey({}, 'x'), {}, '空对象原样返回');
}

// ── ⑤ dirty：值等价 + 跨域差分 ───────────────────────────────────────────
check(sameConfigValue(8002, 8002), '同标量相等');
check(!sameConfigValue(8002, '8002'), '数字与字符串不等（掩码视图类型敏感）');
check(sameConfigValue(NaN, null), '既有怪癖：JSON 口径下 NaN 与 null 等价（本次未改）');
check(sameConfigValue(['a', 'b'], ['a', 'b']), '数组逐项相等');
check(!sameConfigValue(['a', 'b'], ['b', 'a']), '数组顺序敏感');
check(sameConfigValue({ x: 1 }, { x: 1 }), '对象结构相等');
check(!sameConfigValue(undefined, null), 'undefined 与 null 不等');

eq(anyFieldDiffer({ a: 1 }, { a: 1 }, ['a', 'b']), false, '全部相等 → 无改动');
eq(anyFieldDiffer({ a: 1 }, { a: 2 }, ['a', 'b']), true, '任一不同 → 有改动');
eq(anyFieldDiffer({ a: 1 }, { a: 2 }, []), false, '空键表 → 永不判脏（不误报）');

const FIELD_LABELS = [['port', 'cfg.net.portLabel'], ['name', 'cfg.gen.nameLabel'], ['tok', 'cfg.conn.tokenLabel']];
eq(changedEntriesOf({ port: 1, name: 'a', tok: 'x' }, { port: 2, name: 'a', tok: 'x' }, FIELD_LABELS),
  [{ key: 'port', labelKey: 'cfg.net.portLabel' }], '改动清单只含改过的字段，且带标签键');
eq(changedEntriesOf({ port: 1, name: 'a' }, { port: 1, name: 'a' }, FIELD_LABELS), [],
  '无改动 → 空清单（不显示「查看改动」）');
eq(changedEntriesOf({ port: 1, name: 'b', tok: 'y' }, { port: 1, name: 'a', tok: 'x' }, FIELD_LABELS)
  .map((e) => e.key), ['name', 'tok'], '顺序 = 字段标签表的顺序（不是对象键序）');

const SECTIONS_F = [{ id: 'connection' }, { id: 'network' }, { id: 'about' }];
const SECTION_KEYS_F = { connection: ['port', 'name'], network: ['host'], about: ['logLevel'] };
eq([...dirtySectionsOf({ port: 1, name: 'a', host: 'h', logLevel: 'info' }, { port: 1, name: 'a', host: 'h', logLevel: 'info' },
  SECTIONS_F, SECTION_KEYS_F)], [], '全相等 → 无分区圆点');
eq([...dirtySectionsOf({ port: 1, name: 'a', host: 'h2', logLevel: 'debug' }, { port: 1, name: 'a', host: 'h', logLevel: 'info' },
  SECTIONS_F, SECTION_KEYS_F)], ['network', 'about'], '只点亮有改动的分区（且按分区表顺序）');
eq([...dirtySectionsOf({ port: 9 }, { port: 1 }, SECTIONS_F, SECTION_KEYS_F)], ['connection'],
  '同分区任一字段改动即点亮该分区');
check(dirtySectionsOf({}, {}, SECTIONS_F, SECTION_KEYS_F) instanceof Set, '返回值是 Set（页面用 .size/.has）');

// ── ⑥ savePlan：requestSave 的真值表 ────────────────────────────────────
const gate = (over) => planSave({ isDirty: true, saving: false, checkingSaveImpact: false, needsRestart: true, status: 'unprobed', ...over });

check(gate({ isDirty: false }) === 'noop', '不脏 → noop（不弹确认、不落盘）');
check(gate({ saving: true }) === 'noop', '保存进行中 → noop（防重复提交）');
check(gate({ checkingSaveImpact: true }) === 'noop', '正在判定影响 → noop（防并发判定）');
check(gate({ isDirty: false, saving: true, checkingSaveImpact: true }) === 'noop', '三个闸任一为真都 noop');
check(gate({ needsRestart: false }) === 'save', '不需要重启 → 直接存（不查运行状态）');
check(gate({ needsRestart: false, status: 'running' }) === 'save',
  '不需要重启时执行器在跑也**不**弹确认（改语言/日志级别不虚惊）');
check(gate({ status: 'unprobed' }) === 'probe', '需要重启 → 先取运行状态');
check(gate({ status: 'running' }) === 'confirm-running', '需要重启 + 在跑 → 弹「会中断任务」确认');
check(gate({ status: 'stopped' }) === 'save', '需要重启 + 已停止 → 直接存');
check(gate({ status: 'unavailable' }) === 'confirm-unknown',
  '状态不可得 → 保守提示（绝不把运行中的任务当空闲）');
check(gate({ needsRestart: false, status: 'unavailable' }) === 'save',
  '状态不可得但不需要重启 → 仍直接存（不因探测失败阻断无害保存）');
check(gate({ isDirty: false, status: 'running' }) === 'noop', 'noop 优先于一切状态');

// ── ⑦ saveStatusOf：唯一有副作用那一步的降级语义 ─────────────────────────
eq(await saveStatusOf(undefined), 'unavailable', '旧版 preload 无该通道 → unavailable');
eq(await saveStatusOf(async () => ({ running: true })), 'running', '在跑 → running');
eq(await saveStatusOf(async () => ({ running: false })), 'stopped', '已停止 → stopped');
eq(await saveStatusOf(async () => { throw new Error('ipc broken'); }), 'unavailable', 'IPC 抛错 → unavailable');
eq(await saveStatusOf(async () => null), 'unavailable', '形状不对（null）→ unavailable（原实现此处 TypeError 同样落保守分支）');

// ── ⑧ searchIndex：命中类型 / 顺序 / 上限 / 归一化 ───────────────────────
const T = (key) => ({
  'cfg.section.connection': '连接与身份',
  'cfg.section.network': '网络',
  'cfg.net.portLabel': '监听端口',
  'cfg.conn.anchorLabel': '执行器地址',
}[key] ?? key);
const SEARCH_SECTIONS = [
  { id: 'connection', labelKey: 'cfg.section.connection' },
  { id: 'network', labelKey: 'cfg.section.network' },
];
const SEARCH_KEYS = { connection: ['adminApiUrl', 'executorPort'], network: ['executorPort', 'pullMode'] };
const SEARCH_LABELS = [['adminApiUrl', 'cfg.conn.anchorLabel'], ['executorPort', 'cfg.net.portLabel']];
const search = (query) => searchResultsOf({
  query, sections: SEARCH_SECTIONS, sectionKeys: SEARCH_KEYS, fieldLabelKeys: SEARCH_LABELS, t: T,
});

eq(search(''), [], '空词不显示结果');
eq(search('   '), [], '纯空白等同空词');
eq(search('连接'), [{ kind: 'section', id: 'connection', section: 'connection', label: '连接与身份' }],
  '分区名命中 → kind=section');
eq(search('PORT').map((h) => [h.kind, h.id, h.section]), [['field', 'executorPort', 'connection'], ['field', 'executorPort', 'network']],
  '字段内部键名命中（大小写不敏感，每分区各算一条）');
eq(search('端口').map((h) => h.label), ['监听端口', '监听端口'], '字段中文标签命中，label 走双语表');
eq(search('port').length, search('  PoRt  ').length, '查询词首尾空白/大小写归一化');
check(search('port').every((h) => h.kind === 'field'), '字段命中不混进分区命中');
eq(search('zzz-not-exist'), [], '无命中 → 空数组（页面据此显示「无结果」）');
eq(searchResultsOf({ query: 'k', sections: [{ id: 's', labelKey: 'L' }],
  sectionKeys: { s: ['k1', 'k2', 'k3'] }, fieldLabelKeys: [], t: (k) => k }).map((h) => h.label),
['k1', 'k2', 'k3'], '字段无标签键时回落显示原始键名（可见但不友好，不阻断）');
check(MAX_SEARCH_RESULTS === 12, '命中上限仍是 12（左侧栏不是结果列表）');
{
  const many = Array.from({ length: 20 }, (_, i) => `field${String(i).padStart(2, '0')}x`);
  const capped = searchResultsOf({
    query: 'x', sections: [{ id: 's', labelKey: 'L' }], sectionKeys: { s: many }, fieldLabelKeys: [], t: (k) => k,
  });
  check(capped.length === MAX_SEARCH_RESULTS, '命中数被截到上限 12');
  eq(capped[0].id, 'field00x', '截断保留前面的命中（不丢首条）');
}
{
  eq(search('con'), [], '既非分区名也非字段名 → 空（不会因为子串巧合命中）');
}
{
  const ordered = searchResultsOf({
    query: 'exe', sections: [{ id: 's', labelKey: 'executor 分区' }], sectionKeys: { s: ['executorPort'] },
    fieldLabelKeys: [['executorPort', 'executor 端口']], t: (k) => (k === 'executor 分区' ? 'executor 分区' : 'executor 端口'),
  });
  eq(ordered.map((h) => h.kind), ['section', 'field'], '命中顺序：分区在前、字段在后');
}

console.log(`ConfigPage 纯逻辑: ${checked} 条真行为断言通过（numDraft / dirty / savePlan / searchIndex）`);

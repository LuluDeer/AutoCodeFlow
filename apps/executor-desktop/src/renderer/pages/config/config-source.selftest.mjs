/**
 * R7-B 第二刀（配置源 / 读路径）：**真行为断言 + 取数面自检 + 实现体唯一性**。
 *
 * 三段，分别对付三种不同的失效：
 *
 *   ① **真行为断言**（`config-source.ts` 的三条判定）：`listText` /
 *      `loadErrorMessage` / `planExternalSync`。这三条原先夹在 `ConfigPage` 的
 *      `loadConfig` 与 `config:changed` effect 里，只有源码文本契约照看——能证明
 *      "代码里写着 mergeConfigWithDisk("，证明不了"用户编辑过白名单时 textarea
 *      草稿被保留、没编辑时随磁盘刷新"（P1-1 的原始缺陷形态：静默覆盖用户刚在
 *      向导里改的值）。这里逐条钉真值表。
 *
 *   ② **取数面自检**（STC-073 同款）：`renderer.selftest.mjs` 的 NETOPT-7⑤ /
 *      P1-1③ 两条位置敏感契约已把取数面指到 `use-config-source.ts`。若实现又被
 *      搬到第三个文件，那些守卫会红成"代码真的没了"——两者的处置完全不同
 *      （前者是守卫自身坏了）。本条先钉"取数面里该有的锚点都在"。
 *
 *   ③ **实现体唯一性**：读路径的四条实现（`function loadConfig`、首屏
 *      `Promise.all`、`onConfigChanged` 订阅、`config:changed` 的合并落点）在
 *      **hook 里各恰好一份**，且**不得回流页面**。只查"存在"不够：实现被复制
 *      一份、或搬去第三个文件时"存在"仍然成立。
 *
 * ## 时序部分无法在这里断言（如实交代）
 *
 * 三个 effect 的**声明顺序**（首屏 load → 6s 提示消退 → config:changed 订阅）
 * 是语义，但要真的观测它需要一个跑 effect 的 React 渲染器——本仓没有，装一个
 * 等于引入新框架。故：
 *   · 顺序的**结构证据**由本文件 §③ 钉住（三条 effect 在 hook 源码里的先后 +
 *     hook 调用点落在页面第一个 `useEffect` 之后、`refreshPyEnv` 之前 ⇒ 声明序号
 *     与拆分前逐位一致）；
 *   · 顺序的**行为后果**（首屏未到就收到广播 ⇒ 合并基于空基线）依赖既有的
 *     端到端/文本断言，本轮不新增假绿。
 * 分支判定（哪些字段保留、提示用哪个键）已全部搬进纯函数 ⇒ 时序里不再夹带分支，
 * "顺序错"与"合并错"因此可以被分开定位。
 *
 * 由 `renderer.selftest.mjs` 尾部 import 驱动（`npm run test:renderer`）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const here = resolve(import.meta.dirname);
const read = (rel) => readFileSync(resolve(here, rel), 'utf8');

const configPage = read('../ConfigPage.tsx');
const hookSrc = read('./use-config-source.ts');
const planSrc = read('./config-source.ts');

/**
 * 去注释视图（`includes`/`indexOf` 在注释上也会成立——本仓的注释会**解释**机制，
 * 于是"注释里提到 useEffect("就能满足结构断言，形成永真门槛。方法学②/⑮）。
 * 结构断言与实现体唯一性一律看这份；文本锚点也用这份（更严）。
 */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
const pageCode = stripComments(configPage);
const hookCode = stripComments(hookSrc);
const planCode = stripComments(planSrc);

let checked = 0;
const check = (cond, msg) => {
  checked += 1;
  if (!cond) throw new Error(`R7-B 配置源: ${msg}`);
};
const eq = (got, want, msg) => {
  checked += 1;
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) throw new Error(`R7-B 配置源: ${msg}（得到 ${a}，期望 ${b}）`);
};

// ── 通道：ts.transpileModule → CJS + 真实依赖注入（同 pure-logic.selftest.mjs）──
// `config-source.ts` 有三条相对依赖（config-merge / ipc-error / dirty），裸 node
// 解析不了无扩展名的相对导入 ⇒ 走转译 + 注入**真实模块**（不是替身，不存在
// 替身漂移：ADR-027）。
const ts = (await import('typescript')).default;
const loadTsModule = (file, deps = {}) => {
  const js = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: file,
  }).outputText;
  const mod = { exports: {} };
  new Function('exports', 'module', 'require', js)(mod.exports, mod, (spec) => {
    if (Object.prototype.hasOwnProperty.call(deps, spec)) return deps[spec];
    throw new Error(`R7-B 配置源: ${file} 出现未注入的依赖 ${spec}`);
  });
  return mod.exports;
};

const configMerge = await import('../../config-merge.ts');
const ipcError = await import('../../ipc-error.ts');
const dirty = await import('./dirty.ts');
const { listText, loadErrorMessage, planExternalSync } = loadTsModule(
  resolve(here, 'config-source.ts'),
  {
    '../../config-merge': configMerge,
    '../../ipc-error': ipcError,
    './dirty': dirty,
  },
);

/** 真实形状的 t：键名 + 插值参数都留在返回值里，便于断言"用了哪个键、带什么参数"。 */
const calls = [];
const t = (key, ...args) => {
  calls.push([key, ...args]);
  return args.length ? `${key}(${args.map((a) => String(a)).join('|')})` : key;
};
const resetCalls = () => { calls.length = 0; };

// ── ① listText：配置数组 ↔ textarea 单行文本（唯一转换口）─────────────
eq(listText(['a', 'b']), 'a\nb', '数组逐行拼接');
eq(listText([]), '', '空数组 → 空串（不是 "undefined"）');
eq(listText(undefined), '', '字段缺失（旧配置无此键）→ 空串');
eq(listText('a,b'), '', '非数组（损坏配置的兜底形态）→ 空串，不得把字符串当数组');
eq(listText(null), '', 'null → 空串');

// ── ② loadErrorMessage：首屏失败文案（NETOPT-7⑤）─────────────────────
resetCalls();
{
  const msg = loadErrorMessage(new Error("Error invoking remote method 'config:get': Error: 配置解密失败"), t);
  eq(msg, 'cfg.error.loadError(配置解密失败)', '剥掉 Electron 包装前缀后落到 cfg.error.loadError');
  eq(calls.map(([k]) => k), ['cfg.error.loadError'],
    '只允许读 loadError 键 —— 用 saveFailed 会让用户以为刚保存失败（前缀撒谎）');
}
resetCalls();
eq(loadErrorMessage('裸字符串', t), 'cfg.error.loadError(裸字符串)', '非 Error 输入同样可用');
eq(calls.map(([k]) => k), ['cfg.error.loadError'], '失败文案的键恒定，与异常形态无关');

// ── ③ planExternalSync：磁盘广播后的合并真值表（P1-1）────────────────
// 三条轴的组合：字段是否被用户编辑 × 磁盘是否变更 × textarea 是否被编辑。
{
  // ① 用户没改过、磁盘变了 ⇒ 表单与 textarea 都随磁盘刷新 + 提示 updated。
  resetCalls();
  const p1 = planExternalSync({
    savedForm: { port: 8002, agentAllowedApps: ['a'] },
    form: { port: 8002, agentAllowedApps: ['a'] },
    disk: { port: 9999, agentAllowedApps: ['a', 'b'] },
    t,
  });
  eq(p1.form.port, 9999, '未编辑字段随磁盘刷新');
  eq(p1.savedForm, { port: 9999, agentAllowedApps: ['a', 'b'] }, '基线整体采用磁盘值');
  eq(p1.allowedAppsText, 'a\nb', '未编辑的 textarea 随磁盘刷新');
  eq(p1.syncMsg, 'cfg.sync.updated(2)', '磁盘变了 2 项 → 提示 updated(2)');
  eq(calls.map(([k]) => k), ['cfg.sync.updated'], '无草稿被保留时不得报 mergedWithDraft');

  // ② 用户**编辑过** textarea 与端口，磁盘也改了同样两个字段 ⇒ 草稿全保留、
  //    textarea 不动，且**不提示**（updatedKeys 只收「用户没改、磁盘变了」的字段
  //    ——本次没有这样的字段；弹"已更新 0 项"是噪音）。记录既有怪癖：
  //    "磁盘变了"与"有提示"不是同一件事，判据是"有没有被磁盘刷新的字段"。
  resetCalls();
  const p2 = planExternalSync({
    savedForm: { port: 8002, agentAllowedApps: ['a'] },
    form: { port: 8003, agentAllowedApps: ['a', 'local'] },
    disk: { port: 9999, agentAllowedApps: ['a', 'b'] },
    t,
  });
  eq(p2.form.port, 8003, '用户改过的端口保留草稿（不得被磁盘静默覆盖）');
  eq(p2.savedForm, { port: 9999, agentAllowedApps: ['a', 'b'] }, '基线仍整体采用磁盘值（改动清单据此如实呈现差异）');
  eq(p2.allowedAppsText, null, '编辑过白名单 ⇒ textarea 草稿保留（null = 不动，否则与 form 互相矛盾）');
  eq(p2.syncMsg, null, '没有被磁盘刷新的字段 ⇒ 不提示（哪怕磁盘确实变了）');
  eq(calls.length, 0, '不提示时一次 t() 都不该调');

  // ②b 混合：端口被用户改、白名单没改 ⇒ 提示 mergedWithDraft（如实说"有草稿被保留"）。
  resetCalls();
  const p2b = planExternalSync({
    savedForm: { port: 8002, agentAllowedApps: ['a'] },
    form: { port: 8003, agentAllowedApps: ['a'] },
    disk: { port: 9999, agentAllowedApps: ['a', 'b'] },
    t,
  });
  eq(p2b.syncMsg, 'cfg.sync.mergedWithDraft(1)', '有草稿被保留 ⇒ 必须如实提示 mergedWithDraft（否则用户以为改动丢了）');
  eq(calls.map(([k]) => k), ['cfg.sync.mergedWithDraft'], '提示键必须随 preservedKeys 切换');
  eq(p2b.allowedAppsText, 'a\nb', '未编辑的白名单随磁盘刷新');
  eq(p2b.form.port, 8003, '编辑过的端口保留草稿');

  // ③ 磁盘没变 ⇒ 不提示（弹"已更新 0 项"是噪音），且 textarea 照常刷新。
  resetCalls();
  const p3 = planExternalSync({
    savedForm: { port: 8002, agentAllowedApps: ['a'] },
    form: { port: 8002, agentAllowedApps: ['a'] },
    disk: { port: 8002, agentAllowedApps: ['a'] },
    t,
  });
  eq(p3.syncMsg, null, '磁盘未变 → 不弹提示');
  eq(calls.length, 0, '磁盘未变 → 一次 t() 都不该调（否则会白算文案）');
  eq(p3.allowedAppsText, 'a', 'textarea 仍与磁盘对齐');

  // ④ 只编辑了**一个** textarea ⇒ 另一个冻结、这个保留（两条轴互相独立）。
  resetCalls();
  const p4 = planExternalSync({
    savedForm: { agentAllowedApps: ['a'], agentAllowedDomains: ['x.com'] },
    form: { agentAllowedApps: ['a'], agentAllowedDomains: ['x.com', 'draft.com'] },
    disk: { agentAllowedApps: ['a', 'b'], agentAllowedDomains: ['x.com', 'wizard.com'] },
    t,
  });
  eq(p4.allowedAppsText, 'a\nb', '没编辑过的白名单随磁盘刷新');
  eq(p4.allowedDomainsText, null, '编辑过的域名白名单保留草稿');
  eq(p4.syncMsg, 'cfg.sync.mergedWithDraft(1)', '只有白名单被磁盘刷新（1 项）+ 域名草稿被保留 ⇒ mergedWithDraft(1)');

  // ⑤ 字段缺失（旧配置）不得炸：listText 回落空串。
  resetCalls();
  const p5 = planExternalSync({ savedForm: {}, form: {}, disk: { agentAllowedApps: undefined }, t });
  eq(p5.allowedAppsText, '', '磁盘里该字段缺失 → 空串（textarea 不能是 undefined）');
  eq(p5.syncMsg, null, '无实际变更 → 不提示');
}

// ── ④ 取数面自检（STC-073）：三个文件的锚点各就各位 ───────────────────
for (const [file, src, anchors] of [
  ['pages/config/use-config-source.ts', hookCode, [
    // 首屏读取链（NETOPT-7⑤ 的取数面）
    'Promise.all([window.electronAPI.getConfig()',
    'setLoadError(',
    'setLoaded(true)',
    // 广播订阅（P1-1 的取数面）
    'onConfigChanged',
    'planExternalSync',
  ]],
  ['pages/config/config-source.ts', planCode, [
    'mergeConfigWithDisk(',
    'cfg.error.loadError',
    'cfg.sync.mergedWithDraft',
    'cfg.sync.updated',
  ]],
  ['pages/ConfigPage.tsx', pageCode, [
    // 页面侧仍归页面的接线：错误行 + 合并提示行 + hook 调用点 + 重试入口
    '{loadError && (',
    '{externalSyncMsg &&',
    'useConfigSource(',
    'loadConfig',
  ]],
]) {
  for (const anchor of anchors) {
    check(src.includes(anchor),
      `${file} 缺锚点「${anchor}」——取数面漏了文件（读路径实现又被搬到别处？），不是代码真的没了`);
  }
}

// ── ⑤ 实现体唯一性：hook 里各恰好一份，且不得回流页面 ─────────────────
for (const body of [
  'function loadConfig',
  'Promise.all([window.electronAPI.getConfig()',
  'electronAPI.onConfigChanged(',
  'planExternalSync(',
]) {
  const n = hookCode.split(body).length - 1;
  check(n === 1, `${body} 在 hook 里出现 ${n} 次（应为 1）——实现体被复制，或搬到了取数面之外`);
  check(!pageCode.includes(body),
    `ConfigPage 又长回了 ${body}——读路径应只在 pages/config/use-config-source.ts（页面只留接线）`);
}
// 合并判定只在纯函数里（页面与 hook 都不得自己判「哪个 textarea 该冻结」）
for (const body of ['function planExternalSync', 'function listText']) {
  const n = planCode.split(body).length - 1;
  check(n === 1, `${body} 在 config-source.ts 出现 ${n} 次（应为 1）——纯判定被复制`);
  check(!pageCode.includes(body) && !hookCode.includes(body),
    `${body} 又长回了页面/hook——判定必须只有一份（在 config-source.ts）`);
}
// listText 的唯一性跨三个文件（它原先在页面，本轮搬走，不得两边各留一份）
check((planCode + hookCode + pageCode).split('Array.isArray(value) ? value.join').length - 1 === 1,
  'listText 的实现体必须全仓只剩一份（config-source.ts）——复制一份就会悄悄漂移');

// ── ⑥ 时序的结构证据：hook 内三条 effect 的先后 + 调用点位置 ───────────
{
  // 注释已剥除：这里的 'useEffect(() =>' 只可能命中真调用。
  const EFFECT = 'useEffect(() =>';
  const at = [];
  for (let i = hookCode.indexOf(EFFECT); i !== -1; i = hookCode.indexOf(EFFECT, i + 1)) at.push(i);
  check(at.length === 3,
    `hook 内必须恰好 3 条 effect（实测 ${at.length}）——拆分前本簇就是 #2 #3 #4 三条，多一条会挤动后续 effect 的声明序号`);
  const [e1, e2, e3] = at;
  check(hookCode.slice(e1, e2).includes('loadConfig()'),
    '第 1 条 effect 必须是首屏 loadConfig()（P3-10：仅挂载一次）');
  check(hookCode.slice(e2, e3).includes('setExternalSyncMsg(null)'),
    '第 2 条 effect 必须是提示的 6s 自动消退');
  check(hookCode.slice(e3).includes('onConfigChanged') && hookCode.slice(e3).includes('planExternalSync({'),
    '第 3 条 effect 必须是 config:changed 订阅，且合并落点在**同一条** effect 里（拆成两半会多出一条 effect）');
  // 调用点：必须在页面第一个 useEffect 之后（clamp 清理仍是 #1）——序号逐位不变。
  const pageCall = pageCode.indexOf('useConfigSource({');
  const firstPageEffect = pageCode.indexOf('useEffect(');
  check(firstPageEffect > -1 && pageCall > firstPageEffect,
    'hook 调用点必须在页面第一个 useEffect（clamp 定时器清理）之后 —— 否则 #1 的声明序号会变');
  // 页面里 hook 调用点之前只能有那 1 条 clamp 清理 effect —— 多一条就会把本 hook
  // 的 #2 #3 #4 整体后移（"顺手加一条前置 effect"正是本清单第 1 条风险）。
  const effectsBeforeCall = pageCode.slice(firstPageEffect, pageCall).split('useEffect(').length - 1;
  check(effectsBeforeCall === 1,
    `hook 调用点前必须恰好 1 条 effect（实测 ${effectsBeforeCall}）——否则本 hook 的 #2 #3 #4 整体后移`);
}

console.log(`R7-B 配置源: ${checked} 条断言通过（合并真值表 / 取数面自检 / 实现体唯一性 / effect 结构）`);

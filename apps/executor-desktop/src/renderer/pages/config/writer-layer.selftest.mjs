/**
 * R7-B 第三刀（配置**写路径**）：`requestSaveRef` 刷新语义的行为证据 + 判定真值表
 * + 取数面自检 + 实现体唯一性 + effect 结构证据。
 *
 * 六段，各对付一种失效（顺序按"最难的先"）：
 *
 *   ① **`requestSaveRef` 的刷新语义（本刀唯一真难点）**：`requestSave` 每渲染都是
 *      新闭包，键盘监听只挂一次（deps 只有 `isDirty`）⇒ 语义是"监听器永远调到
 *      **最新**那次渲染的 requestSave"。这条**不需要 React 就能测**：把 hook 的
 *      真实转译产物放进一个最小调度器（`useState`/`useEffect` 各一个槽位，
 *      deps 逐项 `Object.is`），连做两次渲染、只让**页面**那行赋值，然后触发
 *      **第一次渲染注册的**监听器，断言 `saveConfig` 收到的是**第二次渲染**的
 *      载荷。监听器被冻结在挂载帧（把 `.current` 提前存成局部量）时该断言必红。
 *
 *   ② **结构断言（㊷：保持顺序/身份要用判据钉住，不能靠自觉）**：
 *      hook 里 `requestSaveRef.current` **只读不写**且只出现在 `onKeyDown` 体内；
 *      页面里 `requestSaveRef.current =` **恰好一处**、且在 hook 调用点之后。
 *
 *   ③ **实现体唯一性**：`save` / `requestSave` 在写路径层各恰好一份，且不得回流
 *      页面（只查"存在"不够：复制一份时"存在"仍成立）。
 *
 *   ④ **判定真值表**（真执行）：`classifySaveResult`（`saveConfig` 返回值三态）
 *      逐格钉住——这是本刀从 `save()` 的 if/else 里抽出来的唯一新纯函数，
 *      三个分支都有"静默失败"的缺陷史（ok:false 被当成功 / reloadError 报"已生效"）。
 *
 *   ⑤ **取数面自检**（STC-073 同款）：`renderer.selftest.mjs` 的 D /
 *      "保存反馈" / EXP-06 三条位置敏感契约已把取数面指到
 *      `use-config-writer.ts` 与 `save-plan.ts`。实现若再被搬到第三个文件，那些
 *      守卫会红成"代码真的没了"——两者的处置完全不同，故先钉"该在的锚点都在"。
 *
 *   ⑥ **effect 结构证据**：把页面源码按出现顺序展开成"有效 effect 序列"
 *      （`useConfigSource(` 展开 3 条、`useConfigWriter(` 1 条、`useConfigIo(` 1 条、
 *      页面自己的 `useEffect(` 1 条），断言恰好 9 条且本 hook 落在第 8 位
 *      —— 9 个 effect 的声明序号是语义（见 `use-config-source.ts` 头注的表），
 *      "搬动顺序"必须红。
 *
 * ## 无法在这里断言的部分（如实交代）
 *
 * 真 React 的 effect **提交时机**（何时 attach、StrictMode 双调用、并发渲染被
 * 打断时 render 期写 ref 的可见性）需要真渲染器；本仓没有 DOM/测试渲染器，装一个
 * 等于引入新框架。故本文件用**最小调度器**只证"刷新语义的取值方向"，不证"React
 * 何时调用它"。后者靠三层：既有文本契约（D / EXP-06 / 保存反馈）+
 * `renderer.selftest.mjs` 的页面接线断言 + **真机手点设置页保存与 Ctrl+S**。
 *
 * 刻意放在 `pages/config/` 而非 `renderer.selftest.mjs`：后者已在体量基线里
 *（棘轮只许降不许增），且守卫应与实现同目录。
 *
 * 由 `renderer.selftest.mjs` 尾部 import 驱动（`npm run test:renderer`）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const here = resolve(import.meta.dirname);
const read = (rel) => readFileSync(resolve(here, rel), 'utf8');

const pageSrc = read('../ConfigPage.tsx');
const hookSrc = read('./use-config-writer.ts');
const planSrc = read('./save-plan.ts');

/**
 * 去注释视图：本仓注释会**解释**机制（"监听只挂一次"、"requestSaveRef.current"），
 * 于是 `includes`/`indexOf` 在注释上也会成立 ⇒ 结构断言看注释会被注释满足，形成
 * 永真门槛（方法学②/⑮）。结构断言与计数一律看这份。
 */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
const pageCode = stripComments(pageSrc);
const hookCode = stripComments(hookSrc);
const planCode = stripComments(planSrc);

let checked = 0;
const check = (cond, msg) => {
  checked += 1;
  if (!cond) throw new Error(`R7-B 配置写路径: ${msg}`);
};
const eq = (got, want, msg) => {
  checked += 1;
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) throw new Error(`R7-B 配置写路径: ${msg}（得到 ${a}，期望 ${b}）`);
};

// ── 通道：ts.transpileModule → CJS + 真实依赖注入（同 pure-logic.selftest.mjs）──
const ts = (await import('typescript')).default;
const loadTsModule = (file, deps = {}) => {
  const js = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: file,
  }).outputText;
  const mod = { exports: {} };
  new Function('exports', 'module', 'require', js)(mod.exports, mod, (spec) => {
    if (Object.prototype.hasOwnProperty.call(deps, spec)) return deps[spec];
    throw new Error(`R7-B 配置写路径: ${file} 出现未注入的依赖 ${spec}`);
  });
  return mod.exports;
};

const configRestart = await import('../../../main/config-restart.ts');
const ipcError = await import('../../ipc-error.ts');
const savePlan = await import('./save-plan.ts');

// ── ① 最小 hook 调度器：只实现"槽位 + deps 逐项比较"，不实现 React ────────────
// 够用的判据：我们要测的是"监听器读的是哪一次渲染的闭包"，不是 React 的调度。
const react = (() => {
  let slots = [];
  let effects = [];
  let cursor = 0;
  return {
    beginRender() { cursor = 0; },
    useState(init) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = init;
      const set = (v) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v; };
      return [slots[i], set];
    },
    useEffect(cb, deps) {
      const i = cursor++;
      const prev = effects[i];
      const same = !!prev && Array.isArray(deps) && Array.isArray(prev.deps) &&
        deps.length === prev.deps.length && deps.every((d, k) => Object.is(d, prev.deps[k]));
      if (same) return;
      if (prev && prev.cleanup) prev.cleanup();
      effects[i] = { deps, cleanup: cb() };
    },
    reset() { slots = []; effects = []; cursor = 0; },
    effects: () => effects,
  };
})();

const { useConfigWriter } = loadTsModule(resolve(here, 'use-config-writer.ts'), {
  react,
  '../../../main/config-restart': configRestart,
  '../../ipc-error': ipcError,
  './save-plan': savePlan,
});

// ── 假 window：只实现 hook 真的会碰的那几个面（record，不仿真）──────────────
const listeners = { keydown: [] };
const saveCalls = [];
const reloads = [];
const savedWrites = [];
const baselineWrites = [];
const sectionSwitches = [];
let pyEnvCalls = 0;
let saveReply = { ok: true };
let statusReply = { running: false };
const timers = [];

const fakeWindow = {
  electronAPI: {
    saveConfig: async (cfg) => { saveCalls.push(cfg); return saveReply; },
    getStatus: async () => statusReply,
  },
  location: { reload: () => { reloads.push(true); } },
  addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
  removeEventListener: (type, fn) => { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); },
};

const realWindow = globalThis.window;
const realSetTimeout = globalThis.setTimeout;
globalThis.window = fakeWindow;
// 3s 的「已保存」提示定时器若真的排上，node 会白等 3s 才退出 ⇒ 只记录不排程。
globalThis.setTimeout = (fn, ms) => { timers.push(ms); return 0; };

const t = (key, ...args) => (args.length ? `${key}(${args.map((a) => String(a)).join('|')})` : key);
const flush = async () => { for (let i = 0; i < 4; i += 1) await Promise.resolve(); };

const mkDeps = (over = {}) => ({
  t,
  form: { uiLanguage: 'zh', executorPort: 8002 },
  savedForm: { uiLanguage: 'zh', executorPort: 8002 },
  isDirty: true,
  setSavedForm: (cfg) => { baselineWrites.push(cfg); },
  setSaved: (v) => { savedWrites.push(v); },
  refreshPyEnv: () => { pyEnvCalls += 1; },
  requestSaveRef: { current: async () => {} },
  languageChangeReloadsUi: () => false,
  onSwitchSection: (i) => { sectionSwitches.push(i); },
  ...over,
});

const render = (deps) => { react.beginRender(); return useConfigWriter(deps); };

try {
  // ── ② ref 刷新语义（两次渲染 + 冻结监听器）──────────────────────────────
  {
    react.reset();
    listeners.keydown.length = 0;
    saveCalls.length = 0;
    const ref = { current: async () => {} };

    // 第一次渲染：监听器在这一轮挂上（此后 deps 只由 isDirty 决定 ⇒ 不再重挂）。
    const first = render(mkDeps({
      requestSaveRef: ref,
      form: { uiLanguage: 'en', executorPort: 8002 },
      savedForm: { uiLanguage: 'zh', executorPort: 8002 },
    }));
    ref.current = first.requestSave;
    eq(listeners.keydown.length, 1, '第一次渲染必须挂上 keydown 监听（Ctrl/Cmd+S）');

    // 第二次渲染：新闭包（uiLanguage 从 en 变 zh），页面那行重新赋值。
    const second = render(mkDeps({
      requestSaveRef: ref,
      form: { uiLanguage: 'zh', executorPort: 8002 },
      savedForm: { uiLanguage: 'zh', executorPort: 8002 },
    }));
    ref.current = second.requestSave;
    eq(listeners.keydown.length, 1, 'deps 未变（isDirty 仍 true）⇒ 监听器不得重挂（"只挂一次"）');

    // 触发**第一次渲染注册的**监听器：它必须调到第二次渲染的闭包。
    listeners.keydown[0]({
      ctrlKey: true, metaKey: false, altKey: false, shiftKey: false,
      key: 's', preventDefault: () => {},
    });
    await flush();
    eq(saveCalls.length, 1, 'Ctrl+S 必须真的走到 saveConfig');
    eq(saveCalls[0].uiLanguage, 'zh',
      '监听器必须读到**最新**渲染的 requestSave（把 .current 提前存成局部量 ⇒ 这里会退回 en）');
    eq(savedWrites.includes(true), true, '保存成功必须置「已保存」提示');
    eq(baselineWrites.length, 1, '保存成功必须把基线推进到本次草稿（savedForm）');
    eq(pyEnvCalls, 1, 'EXP-06：保存成功后必须重取 Python 环境诊断');
    eq(timers, [3000], '「已保存」提示 3s 后自动消退（既有行为，不得改时长）');
    eq(reloads.length, 0, 'languageChangeReloadsUi 返回 false ⇒ 不得重载窗口');
  }

  // ── ③ 写路径的判定分支（真执行，不是读源码）────────────────────────────
  {
    // ③-1 脏检查：不脏 ⇒ save 直接返回（不调 IPC、不动任何状态）。
    react.reset();
    saveCalls.length = 0;
    const clean = render(mkDeps({ isDirty: false }));
    await clean.save();
    eq(saveCalls.length, 0, '不脏时 save() 不得调 saveConfig（noop）');

    // ③-2 ok:false（载荷形状被拒）⇒ 必须报错，且**不得**推进基线。
    react.reset();
    saveCalls.length = 0;
    baselineWrites.length = 0;
    saveReply = { ok: false };
    const rejected = render(mkDeps());
    await rejected.save();
    eq(baselineWrites.length, 0, 'ok:false 时不得推进基线（什么都没写进去）');
    const afterRejected = render(mkDeps());
    eq(afterRejected.saveError, 'cfg.error.saveRejected', 'ok:false 必须报"被拒绝"而不是谎报已保存');

    // ③-3 reloadError ⇒ 已落盘但热重载失败：报 reloadFailed，基线推进，不报"已生效"。
    react.reset();
    baselineWrites.length = 0;
    savedWrites.length = 0;
    saveReply = { ok: true, reloadError: 'boom' };
    const reloadFailed = render(mkDeps());
    await reloadFailed.save();
    eq(baselineWrites.length, 1, 'reloadError 时配置已落盘 ⇒ 基线仍要推进');
    eq(savedWrites.includes(true), false, 'reloadError 时不得显示"已保存/已生效"');
    eq(render(mkDeps()).saveError, 'cfg.error.reloadFailed(boom)', 'reloadError 文案必须带上真实原因');

    // ③-4 IPC reject（D 修正）⇒ 错误可见，且 saving 必须回到 false（否则按钮永久禁用）。
    react.reset();
    saveReply = { ok: true };
    const boom = new Error("Error invoking remote method 'config:save': Error: 写盘失败");
    const throwing = render(mkDeps({ requestSaveRef: { current: async () => {} } }));
    fakeWindow.electronAPI.saveConfig = async () => { throw boom; };
    await throwing.save();
    const afterThrow = render(mkDeps());
    eq(afterThrow.saveError, 'cfg.error.saveFailed(写盘失败)', 'reject 必须剥 IPC 前缀后可见（P3-2）');
    eq(afterThrow.saving, false, 'reject 后 saving 必须复位（D：否则按钮永久禁用）');
    fakeWindow.electronAPI.saveConfig = async (cfg) => { saveCalls.push(cfg); return saveReply; };

    // ③-5 requestSave 的运行状态三态：先探针，再按 running/stopped/unavailable 分流。
    react.reset();
    saveCalls.length = 0;
    statusReply = { running: true };
    const probeRunning = render(mkDeps({ form: { uiLanguage: 'zh', executorPort: 9999 } }));
    await probeRunning.requestSave();
    eq(saveCalls.length, 0, '执行器在跑 + 需要重启 ⇒ 先弹确认，绝不能直接写盘');
    eq(render(mkDeps({ form: { uiLanguage: 'zh', executorPort: 9999 } })).saveImpact, 'running',
      '确认弹窗必须落在 running 档（"会中断运行中的任务"）');

    react.reset();
    saveCalls.length = 0;
    statusReply = { running: false };
    const probeStopped = render(mkDeps({ form: { uiLanguage: 'zh', executorPort: 9999 } }));
    await probeStopped.requestSave();
    eq(saveCalls.length, 1, '执行器已停止 + 需要重启 ⇒ 无需确认，直接保存');

    react.reset();
    saveCalls.length = 0;
    const noChannel = render(mkDeps({ form: { uiLanguage: 'zh', executorPort: 9999 } }));
    const withStatus = fakeWindow.electronAPI.getStatus;
    delete fakeWindow.electronAPI.getStatus;
    await noChannel.requestSave();
    eq(saveCalls.length, 0, '取不到运行状态 ⇒ 保守提示，不得当作空闲直接保存');
    eq(render(mkDeps({ form: { uiLanguage: 'zh', executorPort: 9999 } })).saveImpact, 'unknown',
      '状态不明必须落在 unknown 档（保守提示）');
    fakeWindow.electronAPI.getStatus = withStatus;

    // ③-6 键盘：Alt+1..5 只切分区；Ctrl+S 在脏时才动（脏闸在监听器里）。
    // react.reset() 丢弃了 effect 记录 ⇒ 旧监听器的 cleanup 不会跑，这里手动清，
    // 否则会触发**上一轮（isDirty=true）**的残留监听器，测的就不是本轮闭包了。
    react.reset();
    listeners.keydown.length = 0;
    sectionSwitches.length = 0;
    render(mkDeps({ isDirty: false }));
    listeners.keydown[0]({
      ctrlKey: false, metaKey: false, altKey: true, shiftKey: false,
      key: '3', preventDefault: () => {},
    });
    eq(sectionSwitches, [2], 'Alt+3 必须切到第 3 个分区（序号 0 基）');
    saveCalls.length = 0;
    listeners.keydown[0]({
      ctrlKey: true, metaKey: false, altKey: false, shiftKey: false,
      key: 's', preventDefault: () => {},
    });
    await flush();
    eq(saveCalls.length, 0, '不脏时 Ctrl+S 不得触发保存（既有闸门）');
  }
} finally {
  globalThis.setTimeout = realSetTimeout;
  if (realWindow === undefined) delete globalThis.window; else globalThis.window = realWindow;
}

// ── ④ classifySaveResult 真值表（纯函数，逐格）───────────────────────────
{
  const { classifySaveResult } = savePlan;
  eq(classifySaveResult(undefined), { kind: 'ok' }, '旧 preload/无返回 ⇒ 成功（原实现 r 为假值时读 .ok 会抛）');
  eq(classifySaveResult(null), { kind: 'ok' }, 'null 返回 ⇒ 成功（不得落进 catch 变成"保存失败"）');
  eq(classifySaveResult({ ok: true }), { kind: 'ok' }, 'ok:true ⇒ 成功');
  eq(classifySaveResult({}), { kind: 'ok' }, '无 ok 字段 ⇒ 成功（形状宽松，同原实现）');
  eq(classifySaveResult({ ok: false }), { kind: 'rejected' }, 'ok:false ⇒ 被拒（不得谎报已保存）');
  eq(classifySaveResult({ ok: false, reloadError: 'x' }), { kind: 'rejected' },
    'ok:false 优先于 reloadError（原实现的分支顺序）');
  eq(classifySaveResult({ ok: true, reloadError: 'boom' }),
    { kind: 'reloadFailed', message: 'boom' }, 'reloadError ⇒ 已落盘但热重载失败（独立一档）');
  eq(classifySaveResult({ reloadError: '' }), { kind: 'ok' }, '空串 reloadError ⇒ 成功（原实现是假值判断）');
}

// ── ⑤ 取数面自检（STC-073）：三个文件各自必须含预期锚点 ─────────────────
for (const [file, src, anchors] of [
  ['pages/ConfigPage.tsx', pageCode, [
    // 三个展示面仍必须在页面（写路径层没有 JSX）。
    'saveImpact', 'saving', 'saveError',
    // Ctrl+S 的出口：按钮与确认弹窗都接在这两个函数上。
    'requestSave', 'void save()',
    // ref 的**唯一写点**（下面 ⑥ 还会用计数钉住）。
    'requestSaveRef.current = requestSave',
  ]],
  ['pages/config/use-config-writer.ts', hookCode, [
    'classifySaveResult', 'saveConfig', 'restartRequiredFieldsDiffer',
    'requestSaveRef.current()',
  ]],
  ['pages/config/save-plan.ts', planCode, ['classifySaveResult', 'result.ok === false']],
]) {
  for (const anchor of anchors) {
    check(src.includes(anchor),
      `${file} 缺锚点「${anchor}」——取数面漏了文件（写路径实现又被搬到别处？），不是代码真的没了`);
  }
}

// ── ⑥ 实现体唯一性 + ref 读写点 ────────────────────────────────────────
for (const body of ['async function save()', 'async function requestSave()']) {
  const n = hookCode.split(body).length - 1;
  check(n === 1, `${body} 在写路径层出现 ${n} 次（应为 1）——实现体被复制或搬到了取数面之外`);
  check(!pageCode.includes(body), `ConfigPage 又长回了 ${body} 的实现体——写路径应只在 pages/config/use-config-writer.ts`);
}
{
  // 写点唯一：页面恰好 1 处；hook 里 0 处（hook 只读，见文件头注①）。
  const pageWrites = pageCode.split('requestSaveRef.current =').length - 1;
  eq(pageWrites, 1, 'requestSaveRef 的赋值必须恰好在页面一处（两个写者 ⇒ 取值取决于两行先后）');
  const hookWrites = hookCode.split('requestSaveRef.current =').length - 1;
  eq(hookWrites, 0, 'hook 不得给 requestSaveRef 赋值（写点唯一：ref 身份与赋值都归页面）');
  // 读点唯一且在事件体内：`.current` 只出现 1 次，且必须晚于 `function onKeyDown`。
  const reads = hookCode.split('requestSaveRef.current').length - 1;
  eq(reads, 1, 'hook 里 requestSaveRef.current 必须只出现 1 次（缓存成局部量会让监听器冻结在挂载帧）');
  check(hookCode.indexOf('requestSaveRef.current') > hookCode.indexOf('function onKeyDown('),
    'requestSaveRef.current 必须在 onKeyDown **体内**读（渲染期读即等于冻结闭包）');
  // 赋值必须在 hook 调用之后（否则赋的是上一次渲染的闭包）。
  check(pageCode.indexOf('requestSaveRef.current = requestSave') > pageCode.indexOf('useConfigWriter('),
    '页面的 requestSaveRef 赋值必须发生在 useConfigWriter(...) 之后');
  // Alt+1..5 的分区知识留在页面（hook 只收"序号"），且页面必须锁住回调身份。
  check(hookCode.includes('onSwitchSection(Number(e.key) - 1)'),
    'hook 只负责"按键 → 序号"，分区表必须留在页面');
  check(/const onSwitchSection = useCallback\(/.test(pageCode),
    'onSwitchSection 必须用 useCallback 锁住身份（否则键盘 effect 每渲染重挂）');
}

// ── ⑦ effect 结构证据：9 条有效 effect，写路径层恰在第 8 位 ────────────────
{
  const expand = (code) => {
    const out = [];
    const re = /useConfigSource\(|useConfigWriter\(|useConfigIo\(|useEffect\(/g;
    let m = re.exec(code);
    while (m) {
      const hit = m[0];
      if (hit === 'useConfigSource(') out.push('source', 'source', 'source');
      else if (hit === 'useConfigWriter(') out.push('writer');
      else if (hit === 'useConfigIo(') out.push('io');
      else out.push('page');
      m = re.exec(code);
    }
    return out;
  };
  const order = expand(pageCode);
  eq(order, ['page', 'source', 'source', 'source', 'page', 'page', 'page', 'writer', 'io'],
    '9 个 useEffect 的声明序号是语义：拆分前后必须逐位一致（写路径层承担 #8 Ctrl+S）');
  eq(order.indexOf('writer'), 7, '写路径层的键盘 effect 必须仍排在第 8 位');
  eq(hookCode.split('useEffect(').length - 1, 1, '写路径层只允许声明 1 条 effect（多一条就挤动后续序号）');
}

console.log(`R7-B 配置写路径: ${checked} 条断言通过（ref 刷新语义 / 判定分支 / 取数面自检 / 实现体唯一性 / effect 结构）`);

/**
 * `pages/config/io-result.ts`（配置 IO 结果归一）的**真行为断言**。
 *
 * 为什么需要它：设置页这一层原先只有源码文本契约——`readFileSync` + `includes`
 * 能证明"代码里写着 try/finally"，证明不了"用户取消时不弹失败""主进程 ok:false
 * 的 error 原样带出""旧 preload 无诊断通道时无声返回"这类**行为**。而这些正是
 * 本页缺陷史里的高频形态（静默变化：不报错、只有用户看得见）。
 *
 * 通道：与 pure-logic.selftest.mjs 相同，`await import('./io-result.ts')`
 * 直接跑真模块（node ≥22.6 原生解析 TypeScript）。本模块无相对依赖，因此
 * 不需要 `ts.transpileModule` 注入；`t` 用**真实形状**的假件（记录调用的键与
 * 插值参数），断言的是"用哪个键、带什么参数"，不是"实现怎么写"。
 *
 * 由 `renderer.selftest.mjs` 尾部 import 驱动（`npm run test:renderer`）。
 */
const {
  ioMsgOf,
  planDiagnosticsResult,
  planExportResult,
  planImportApplied,
  planImportResult,
  planUpdateCheckText,
} = await import('./io-result.ts');

let checked = 0;
const check = (cond, msg) => {
  checked += 1;
  if (!cond) throw new Error(`配置 IO 结果归一: ${msg}`);
};
const eq = (got, want, msg) => {
  checked += 1;
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) throw new Error(`配置 IO 结果归一: ${msg}（得到 ${a}，期望 ${b}）`);
};
const throws = (fn, msg) => {
  checked += 1;
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(`配置 IO 结果归一: ${msg}（期望抛错，实际没有）`);
};

/** 真实形状的 t：键名 + 插值参数都留在返回值里，便于断言"用了哪个键、带什么参数"。 */
const calls = [];
const t = (key, ...args) => {
  calls.push([key, ...args]);
  return args.length ? `${key}(${args.map((a) => String(a)).join('|')})` : key;
};
const keysCalled = () => calls.map(([key]) => key);

// ── ioMsgOf：归一出口 → 页内提示行 ────────────────────────────────────
eq(ioMsgOf({ kind: 'ok', text: 'x' }), { kind: 'ok', text: 'x' }, 'ok 出口 → status 行');
eq(ioMsgOf({ kind: 'err', text: 'y' }), { kind: 'err', text: 'y' }, 'err 出口 → alert 行');
eq(ioMsgOf({ kind: 'silent' }), null, '用户取消没有提示行（否则会误报失败）');
eq(ioMsgOf({ kind: 'applied' }), null, '导入落盘本身不是提示行（提示在收尾时才写）');

// ── 配置导出 ──────────────────────────────────────────────────────────
eq(planExportResult({ ok: true, canceled: true }, t), { kind: 'silent' }, '导出取消 → 无声返回');
eq(planExportResult({ ok: true, path: '/tmp/cfg.json' }, t),
  { kind: 'ok', text: 'cfg.io.exportDone(/tmp/cfg.json)' }, '导出成功带上结果路径');
eq(planExportResult({ ok: true }, t), { kind: 'ok', text: 'cfg.io.exportDone()' },
  '结果没有 path 时插空串（用户看到"已导出到"后面为空，而非 undefined）');
eq(planExportResult({ ok: false, error: '磁盘已满' }, t), { kind: 'err', text: '磁盘已满' },
  '主进程 error 已是人话 ⇒ 原样呈现，不再套一层键');
eq(planExportResult({ ok: false }, t), { kind: 'err', text: 'cfg.io.exportFailed' },
  '没有 error 时退回通用失败文案');
{
  // 既有形态：原实现在同一位置直读 r.canceled，主进程意外 resolve undefined
  // 就在那里抛 TypeError → 外层 catch 用 ipcErrorMessage 呈现。加 !r 兜底会
  // **换掉用户看到的文案**，故这里钉住"仍然抛"。
  throws(() => planExportResult(undefined, t), 'export 结果 undefined 时仍抛（兜底会改文案）');
}

// ── 配置导入 ──────────────────────────────────────────────────────────
eq(planImportResult({ ok: true, canceled: true }, t), { kind: 'silent' }, '导入取消 → 无声返回');
eq(planImportResult({ ok: false, error: 'bad json' }, t),
  { kind: 'err', text: 'cfg.io.importFailed(bad json)' }, '导入被拒 → 带出主进程原因');
eq(planImportResult({ ok: false }, t), { kind: 'err', text: 'cfg.error.saveRejected' },
  '导入被拒但没有原因 → 退回"配置未被写入"');
eq(planImportResult({ ok: true }, t), { kind: 'applied' }, '导入成功 → applied（尚未回写页面草稿）');
eq(planImportResult({ ok: true, reloadError: 'executor down' }, t), { kind: 'applied' },
  '导入成功但热重载失败仍是 applied：落盘生效了，重载失败在收尾时如实说');
throws(() => planImportResult(undefined, t), 'import 结果 undefined 时仍抛（同 export 口径）');
// 导入错误的三个出口都要能区分：取消 ≠ 失败 ≠ 成功
{
  const outs = [
    planImportResult({ ok: true, canceled: true }, t).kind,
    planImportResult({ ok: false }, t).kind,
    planImportResult({ ok: true }, t).kind,
  ];
  eq(outs, ['silent', 'err', 'applied'], '导入三出口互不相同（调用方按 kind 分派一次即可）');
}

// ── 导入收尾文案 ──────────────────────────────────────────────────────
eq(planImportApplied(undefined, t), { kind: 'ok', text: 'cfg.io.importDone' }, '热重载正常 → 导入成功');
eq(planImportApplied('executor down', t), { kind: 'err', text: 'cfg.error.reloadFailed(executor down)' },
  '热重载失败 → 不得报"导入成功"（与 save() 同口径）');
check(planImportApplied('x', t).kind !== planImportApplied(undefined, t).kind,
  '重载失败与成功必须落在不同的提示行 kind 上（status vs alert）');

// ── 诊断报告导出 ──────────────────────────────────────────────────────
eq(planDiagnosticsResult(undefined, t), { kind: 'silent' },
  '旧 preload 没有 exportDiagnosticReport 通道 ⇒ 无声返回（不得白屏/报失败）');
eq(planDiagnosticsResult({ ok: true, canceled: true }, t), { kind: 'silent' }, '诊断导出取消 → 无声返回');
eq(planDiagnosticsResult({ ok: false, error: 'EACCES' }, t),
  { kind: 'err', text: 'cfg.io.diagnosticFailed(EACCES)' }, '诊断导出失败带上主进程原因');
eq(planDiagnosticsResult({ ok: false }, t), { kind: 'err', text: 'cfg.io.diagnosticFailed()' },
  '没有原因时插空串（键自带的引导语已说明"导出失败"）');
eq(planDiagnosticsResult({ ok: true, path: '/tmp/report.json' }, t),
  { kind: 'ok', text: 'cfg.io.diagnosticDone(/tmp/report.json)' }, '诊断导出成功带上结果路径');

// ── 检查更新 ──────────────────────────────────────────────────────────
// 文案组由页面解析后注入（哨兵字面量 + 双语文案留在页面：A-3 是跨进程契约，
// 主进程侧 selftest 以 ConfigPage.tsx 为取数面钉住"哨兵 ⇒ 双语文案"）。
// 这里断言的是**分支判定**：同一个哨兵 ⇒ 另一句话。
const texts = {
  initiated: 'INITIATED',
  unsupportedInstall: 'UNSUPPORTED',
  unsupportedSentinel: 'UPDATER_UNSUPPORTED_INSTALL',
};
eq(planUpdateCheckText(undefined, texts), 'INITIATED', '主进程静默返回 ⇒ 仍要说"已发起检查"');
eq(planUpdateCheckText({ ok: true }, texts), 'INITIATED', 'ok:true ⇒ 已发起检查（不承诺有新版本）');
eq(planUpdateCheckText({ ok: false, error: 'UPDATER_UNSUPPORTED_INSTALL' }, texts), 'UNSUPPORTED',
  'deb/rpm 等不支持自更新的安装形态 ⇒ 改说"用包管理器升级"');
eq(planUpdateCheckText({ ok: false, error: 'NETWORK_DOWN' }, texts), 'NETWORK_DOWN',
  '其它 error 原样透出（不吞成"已发起"）');
eq(planUpdateCheckText({ ok: false }, texts), 'INITIATED', 'ok:false 但没有 error ⇒ 仍可回落到"已发起"');
// 与上面三条不同：检查更新**没有** silent 出口（用户主动点的，静默 = 没反应）
{
  const results = [undefined, { ok: true }, { ok: false }, { ok: false, error: 'X' }];
  const outs = results.map((r) => planUpdateCheckText(r, texts));
  check(outs.every((x) => typeof x === 'string' && x.length > 0), '任何结果都有一句可见提示（无静默出口）');
  eq(outs, ['INITIATED', 'INITIATED', 'INITIATED', 'X'],
    '只有哨兵与"无 error"两例回落，其余原样透出主进程 error');
}
// 哨兵字面量必须与主进程一致（跨进程契约的本地副本）
check(texts.unsupportedSentinel === 'UPDATER_UNSUPPORTED_INSTALL', 'A-3 哨兵字面量与主进程一致');

console.log(`配置 IO 结果归一: ${checked} 条真行为断言通过（export / import / diagnostics / update-check）`);

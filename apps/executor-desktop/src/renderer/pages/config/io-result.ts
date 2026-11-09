/**
 * 设置页「配置 IO」四条链路（导出 / 导入 / 诊断报告 / 检查更新）的**结果归一**。
 *
 * 为什么单独一个纯模块而不是散在 hook 里：这四条 IPC 各有 2~4 个出口
 * （用户取消 / 成功 / 主进程返回 ok:false / reject），原先每个出口各自
 * `setIoMsg` ——调用方为了知道"该写哪一行、写哪一种 role"，必须同时读
 * 4 个 busy 布尔 + 4 条文案规则。这里把出口归一成**同一个可判别对象**
 * `IoOutcome`，hook 只按 `kind` 分派一次，界面侧不再按来源分支：
 *
 *   silent   → 无声返回（用户取消：这里不是失败，绝不能弹"失败"行）
 *   ok/err   → 写同一行提示（kind 决定 role=status|alert 与图标）
 *   applied  → 边界上唯一的"跨层"出口：导入已落盘，需回写页面草稿
 *              （表单/基线/textarea 草稿/连接测试结果），由页面回调完成
 *
 * 纯函数（无 state / DOM / 时钟），由 `pages/config/io-result.selftest.mjs`
 * 直接执行断言——设置页这一层此前只有"源码文本契约"，文本契约证明不了
 * "用户取消不弹失败""ok:false 的 error 原样带出"这类行为。
 */

/** 页内提示行（与连接测试结果同款 test-result 排版：ok → status，err → alert）。 */
export type IoMsg = { kind: 'ok' | 'err'; text: string };

/** 文案取值函数（与 i18n.ts `createCfgTexts()` 同签名）。 */
export type CfgText = (key: string, ...args: (string | number | boolean)[]) => string;

/** 四条链路共用的归一出口（见文件头）。 */
export type IoOutcome =
  | { kind: 'silent' }
  | { kind: 'ok'; text: string }
  | { kind: 'err'; text: string }
  | { kind: 'applied' };

/** 归一出口 → 页内提示行（silent / applied 没有提示行）。 */
export function ioMsgOf(outcome: IoOutcome): IoMsg | null {
  if (outcome.kind === 'ok') return { kind: 'ok', text: outcome.text };
  if (outcome.kind === 'err') return { kind: 'err', text: outcome.text };
  return null;
}

export type ExportResult = { ok: boolean; canceled?: boolean; path?: string; error?: string };

export type ImportResult = {
  ok: boolean;
  canceled?: boolean;
  reloadError?: string;
  restartDeferred?: boolean;
  error?: string;
};

/**
 * 配置导出：`canceled` = 用户在 saveDialog 点了取消 ⇒ 无声返回。
 *
 * 注意 `r.canceled` 是**不设 `!r` 兜底**的直读：原实现在同一位置直接读它，
 * 若主进程意外 resolve undefined 就在此处抛 TypeError → 落到链路外层的
 * catch，用 `ipcErrorMessage(err)` 呈现。加 `!r` 兜底看似更稳，实际会**换掉
 * 用户看到的文案**，不是零行为变更（selftest 有一条断言钉住这个形态）。
 */
export function planExportResult(r: ExportResult, t: CfgText): IoOutcome {
  if (r.canceled) return { kind: 'silent' };
  if (!r || r.ok !== true) {
    // 主进程写文件失败的 error 已是人话，原样呈现；缺失时退回通用文案。
    return { kind: 'err', text: r?.error ?? t('cfg.io.exportFailed') };
  }
  return { kind: 'ok', text: t('cfg.io.exportDone', r.path ?? '') };
}

/**
 * 配置导入：三出口。`applied` = 已落盘，**尚未**回写页面草稿——
 * 回写是页面的事（`ConfigIoDeps.applyImportedConfig`），hook 只负责把它
 * 变成一个可判别的续行决定，不关心页面内部怎么复位。
 */
export function planImportResult(r: ImportResult, t: CfgText): IoOutcome {
  if (r.canceled) return { kind: 'silent' };
  if (!r || r.ok !== true) {
    // 坏 JSON / 消毒拒绝 / 载荷被主进程拒绝——主进程的 error 原样带出
    //（它已是人话），没有 error 时退回通用失败文案。
    return {
      kind: 'err',
      text: r?.error ? t('cfg.io.importFailed', r.error) : t('cfg.error.saveRejected'),
    };
  }
  return { kind: 'applied' };
}

/**
 * 导入落盘后的收尾文案：热重载失败必须如实说（配置已落盘、执行器已停），
 * 不能报"导入成功"——与 `save()` 同一口径。
 */
export function planImportApplied(reloadError: string | undefined, t: CfgText): IoOutcome {
  return reloadError
    ? { kind: 'err', text: t('cfg.error.reloadFailed', reloadError) }
    : { kind: 'ok', text: t('cfg.io.importDone') };
}

export type DiagnosticResult = { ok: boolean; canceled?: boolean; path?: string; error?: string };

/** 诊断报告导出：取消（含旧 preload 无通道 ⇒ undefined）一律无声返回。 */
export function planDiagnosticsResult(r: DiagnosticResult | undefined, t: CfgText): IoOutcome {
  if (!r || r.canceled) return { kind: 'silent' };
  if (r.ok !== true) return { kind: 'err', text: t('cfg.io.diagnosticFailed', r.error ?? '') };
  return { kind: 'ok', text: t('cfg.io.diagnosticDone', r.path ?? '') };
}

/**
 * 检查更新的文案组（由页面解析后注入，见 `UpdateCheckTexts`）。
 *
 * 为什么要"页面解析、hook 传字符串"而不是把 `t` 传进纯函数：A-3 的哨兵
 * 字面量与其 i18n 映射是**跨进程契约**（主进程 ipc-handlers.ts 回同一个哨兵），
 * 主进程侧 selftest 以 ConfigPage.tsx 为取数面钉住"哨兵 ⇒ 双语文案、不得内联
 * 中文"。文案解析留在页面（语言层的唯一所在地），纯函数只负责**分支判定**，
 * 两者都能被断言：分支在 io-result.selftest.mjs，锚点在页面。
 */
export type UpdateCheckTexts = {
  /** 普通结果："已发起检查"（开发模式主进程静默返回时也不承诺有新版本）。 */
  initiated: string;
  /** 不支持自更新的安装形态："请用包管理器升级"。 */
  unsupportedInstall: string;
  /** 主进程回 ok:false 时携带的稳定哨兵字面量。 */
  unsupportedSentinel: string;
};

export type UpdateCheckResult = { ok: boolean; error?: string };

/**
 * 检查更新：**总是**有一句提示（与上面三条不同，这里没有 silent 出口）——
 * 该动作是用户主动点的，静默等于"点了没反应"。
 *
 * DSK-05 的口径：开发模式（未打包）主进程 updater 未初始化、`checkForUpdates`
 * 静默返回，因此这里刻意不承诺"有新版本"，只说"已发起检查"；只有拿到
 * `unsupportedSentinel`（deb/rpm 等非 AppImage 安装）才改说"用包管理器升级"，
 * 否则用户永远等不到下发事件。
 */
export function planUpdateCheckText(
  r: UpdateCheckResult | undefined,
  texts: UpdateCheckTexts,
): string {
  if (r && r.ok === false) {
    if (r.error === texts.unsupportedSentinel) return texts.unsupportedInstall;
    return r.error || texts.initiated;
  }
  return texts.initiated;
}

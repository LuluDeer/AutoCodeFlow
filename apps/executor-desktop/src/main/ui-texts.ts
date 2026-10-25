/**
 * F-27（UIUX 审计 2026-10-25）：主进程「系统通知 + 原生对话框」的双语文案表。
 *
 * 漏网面收口：渲染层（i18n.ts / renderer.selftest 键位对齐钉子）与托盘
 * （tray-texts.ts / tray-texts.selftest）早已双语化，但系统通知（notifier.ts）
 * 与主进程原生对话框（ipc-handlers.ts 的 R105 破坏性确认 / 重启执行器征询 /
 * 导出导入对话框标题）此前硬编码中文——英文界面混排中文。
 *
 * 语言解析与文案表**复用同一来源**：判定本体在 ui-language.ts（显式设置
 * 'zh'/'en' 优先、'auto' 跟随系统、非法值默认英文），与 tray-texts /
 * renderer i18n 共用同一份规则；本表键风格对齐 renderer i18n 的**扁平点号键**
 * （对齐 admin-web locales 的命名空间风格），zh/en 两块键序一致——
 * ui-texts.selftest.ts 据此做键位对齐 + 非空 + 插值占位符一致的断言。
 *
 * 无 electron 依赖（同 tray-texts 的可测性理由），selftest 可直接驱动。
 * 取值走 uiText()：字符串直出、{var} 占位符插值；缺键回退键名本身（与
 * renderer i18n 缺键行为一致，肉眼可见、不炸流程——selftest 键位对齐保证
 * 正常情况下到不了）。
 */
import type { UiLocale } from './ui-language';

/** 插值变量（值先 String() 再替换，调用方传 number 无妨）。 */
export type UiTextVars = Record<string, string | number>;

export const UI_TEXTS: Record<UiLocale, Record<string, string>> = {
  zh: {
    // ── 系统通知（notifier.ts；zh 值与原硬编码逐字一致）──
    'notify.executorOffline.title': '执行器离线',
    'notify.executorOffline.body': '与平台的心跳连接已中断，请检查网络或平台状态',
    'notify.taskSuccess.title': '任务执行成功',
    'notify.taskFailed.title': '任务执行失败',
    'notify.task.durationSuffix': '耗时 {duration}',
    'notify.task.exitCodeSuffix': '退出码 {code}',
    'notify.updateAvailable.title': '发现新版本',
    'notify.updateAvailable.body': '新版本 {version} 已可升级，可在状态页下载安装',
    'notify.updateAvailable.bodyCached':
      '新版本 {version} 此前已下载完成，可在状态页直接安装（复用本地缓存）',
    // ── 原生对话框（ipc-handlers.ts）──
    // R105 破坏性确认（confirmViaNativeDialog；按钮顺序 = [取消, 继续]）
    'dialog.confirm.cancel': '取消',
    'dialog.confirm.continue': '继续',
    'dialog.confirm.message': '确定要{action}吗？',
    // 重启执行器征询（confirmExecutorRestart；按钮顺序 = [重启, 暂不重启]）
    'dialog.restart.accept': '重启执行器',
    'dialog.restart.defer': '暂不重启',
    'dialog.restart.message': '配置已保存，需要重启执行器才能生效',
    'dialog.restart.detail':
      '重启执行器会中断正在运行的任务。要现在重启吗？\n（选择「暂不重启」后，新配置将在下次启动执行器时生效）',
    // 导出 / 导入对话框标题
    'dialog.exportConfig.title': '导出配置（执行器密钥以掩码导出）',
    'dialog.importConfig.title': '导入配置',
    'dialog.exportDiagnostics.title': '导出诊断报告（执行器密钥已脱敏）',
    'dialog.exportExecLog.title': '导出执行日志',
  },
  en: {
    // ── System notifications (notifier.ts) ──
    'notify.executorOffline.title': 'Executor offline',
    'notify.executorOffline.body':
      'The heartbeat connection to the platform was interrupted. Check your network or the platform status.',
    'notify.taskSuccess.title': 'Task succeeded',
    'notify.taskFailed.title': 'Task failed',
    'notify.task.durationSuffix': 'took {duration}',
    'notify.task.exitCodeSuffix': 'exit code {code}',
    'notify.updateAvailable.title': 'New version available',
    'notify.updateAvailable.body': 'Version {version} is available. Download and install it from the status page.',
    'notify.updateAvailable.bodyCached':
      'Version {version} was downloaded earlier and can be installed directly from the status page (reusing the local cache).',
    // ── Native dialogs (ipc-handlers.ts) ──
    'dialog.confirm.cancel': 'Cancel',
    'dialog.confirm.continue': 'Continue',
    'dialog.confirm.message': 'Are you sure you want to {action}?',
    'dialog.restart.accept': 'Restart executor',
    'dialog.restart.defer': 'Restart later',
    'dialog.restart.message': 'Configuration saved — the executor must restart for the changes to take effect',
    'dialog.restart.detail':
      'Restarting the executor interrupts running tasks. Restart now?\n(Choose "Restart later" and the new configuration takes effect the next time the executor starts.)',
    'dialog.exportConfig.title': 'Export configuration (executor secret exported masked)',
    'dialog.importConfig.title': 'Import configuration',
    'dialog.exportDiagnostics.title': 'Export diagnostic report (executor secrets redacted)',
    'dialog.exportExecLog.title': 'Export execution log',
  },
};

/**
 * 取一条文案：字符串直出；{var} 占位符用 vars 插值（未提供的占位符原样
 * 残留——selftest 的键位对齐 + 占位符一致断言保证正常情况下到不了）。
 * 缺键回退键名本身（与 renderer i18n 缺键行为一致，肉眼可见）。
 */
export function uiText(locale: UiLocale, key: string, vars?: UiTextVars): string {
  let text = UI_TEXTS[locale][key] ?? key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      // split/join 而非 replaceAll：本仓 main tsconfig 的 lib 早于 es2021。
      text = text.split(`{${name}}`).join(String(value));
    }
  }
  return text;
}

/**
 * 提取一条文案里的 {var} 占位符名（selftest 键位对齐用：两语言的同一键必须
 * 提供同一组占位符，否则插值会漏填/错位）。
 */
export function uiTextPlaceholderNames(text: string): string[] {
  return Array.from(text.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g), (m) => m[1]);
}

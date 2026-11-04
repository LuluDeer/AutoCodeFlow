import { useEffect, useRef, useState } from 'react';
import { ipcErrorMessage } from '../../ipc-error';
import {
  ioMsgOf,
  planDiagnosticsResult,
  planExportResult,
  planImportApplied,
  planImportResult,
  planUpdateCheckText,
  type CfgText,
  type DiagnosticResult,
  type ExportResult,
  type ImportResult,
  type IoMsg,
  type UpdateCheckResult,
  type UpdateCheckTexts,
} from './io-result';

/**
 * 设置页的**配置 IO 层**（R7-B 第一刀：按读写路径分层，只抽"最独立"的这一簇）。
 *
 * 归属边界（为什么是这些、不是 `loadConfig` / `save`）：
 *   · 本 hook 只管**不参与「配置值读写时序」**的四条链路 —— 配置导出 / 配置导入 /
 *     诊断报告导出 / 手动检查更新，外加开机自启的**写路径**。
 *   · `loadConfig` + 首屏 `Promise.all` + `config:changed` 合并（读路径）与
 *     `save` / `requestSave` + `requestSaveRef`（写路径与键盘绑定）**留在页面**：
 *     读路径的 effect 声明顺序本身是语义（"首屏未到就先收到广播"），写路径的
 *     `requestSaveRef.current = requestSave` 是 render-time 赋值（引用身份是语义）。
 *     这两刀另行处理，本 hook 刻意不碰。
 *   · 本 hook 里**只有一个** `useEffect`（F-38 的定时器卸载清理）。它在页面里的
 *     声明位置被原样保留（hook 调用点就落在它原来所在的那一行），所以 effect 的
 *     声明序号与拆分前一致 —— 不靠"反正 effect 之间无依赖"来赌。
 *
 * 唯一一次读：导入成功后的 `getConfig()` 重读。它属于导入链路（要拿磁盘真值
 * 回写页面草稿），不是首屏/广播读路径；页面怎么复位由 `applyImportedConfig`
 * 负责，hook 只拿到一个可判别的续行决定（见 `ImportApplyOutcome`）。
 */

declare const window: Window & {
  electronAPI: {
    getConfig: () => Promise<Record<string, unknown>>;
    exportConfig: () => Promise<ExportResult>;
    importConfig: () => Promise<ImportResult>;
    checkForUpdate: () => Promise<UpdateCheckResult>;
    setAutoLaunch: (enable: boolean) => Promise<{ ok: boolean }>;
    exportDiagnosticReport?: () => Promise<DiagnosticResult>;
  };
};

/**
 * 导入成功后「回写页面草稿」的**单出口协议**（对应页面注入的
 * `applyImportedConfig`）：页面把五连 setState + 语言判定收成一个可判别对象，
 * 调用方不按"配置来自哪条链路"分支，只问"续行还是中止"。
 *
 *   applied → 草稿已与磁盘对齐，导入链路继续（重取诊断 + 写成功/重载失败提示）
 *   reload  → 备份文件带了另一种界面语言，页面已 `location.reload()`；
 *             后续提示不再写（同原实现在 setState 之后 `return` 的语义）
 *
 * 第三个可能——重读掩码配置失败——不归页面：hook 自己的 `catch` 把它归到
 * `applied` 的续行分支（保持既有显示，导入结果照常呈现），页面无需知道。
 */
export type ImportApplyOutcome = { kind: 'applied' } | { kind: 'reload' };

export interface ConfigIoDeps {
  /** 文案取值（语言在页面求值一次，与既有 N-04 口径一致）。 */
  t: CfgText;
  /** 检查更新的文案组（页面解析：哨兵字面量 + 双语文案，见 io-result.ts 注释）。 */
  updateCheckTexts: UpdateCheckTexts;
  /**
   * `autoLaunch` 的**真值**归页面：首屏由 `loadConfig()` 的
   * `getAutoLaunch().then(setAutoLaunch)` 播种（读路径，本刀不抽）。
   * hook 只拥有**写路径**（乐观更新 + 失败回滚），故只收 setter。
   */
  setAutoLaunch: (enable: boolean) => void;
  /** 导入成功后重取 Python 环境诊断（EXP-06 同语义：诊断块必须反映已落盘值）。 */
  refreshPyEnv: () => void;
  /** 导入成功后的页面草稿回写（见 `ImportApplyOutcome`）。 */
  applyImportedConfig: (cfg: Record<string, unknown>) => ImportApplyOutcome;
}

export interface ConfigIo {
  checking: boolean;
  checkMsg: string | null;
  checkUpdate: () => Promise<void>;
  ioBusy: 'export' | 'import' | null;
  ioMsg: IoMsg | null;
  ioSupported: boolean;
  exportConfig: () => Promise<void>;
  importConfig: () => Promise<void>;
  diagBusy: boolean;
  diagMsg: IoMsg | null;
  diagSupported: boolean;
  exportDiagnostics: () => Promise<void>;
  toggleAutoLaunch: (enable: boolean) => Promise<void>;
}

export function useConfigIo(deps: ConfigIoDeps): ConfigIo {
  const { t, updateCheckTexts, setAutoLaunch, refreshPyEnv, applyImportedConfig } = deps;
  // DSK-05：手动检查更新。/update 检查结果通过「状态监控」页的 UpdateBanner
  // 呈现（updater 事件是主进程广播，与触发点解耦）；这里只反馈"已发起"。
  const [checking, setChecking] = useState(false);
  const [checkMsg, setCheckMsg] = useState<string | null>(null);
  // 拓展包：配置导出/导入（配置备份）。in-flight 用 kind 区分两个按钮的
  // loading 形态；结果走 ioMsg 行（kind=ok → status，err → alert），复用
  // 连接测试同款 test-result 排版——桌面端无 toast 体系，反馈必须页内可见。
  const [ioBusy, setIoBusy] = useState<'export' | 'import' | null>(null);
  const [ioMsg, setIoMsg] = useState<IoMsg | null>(null);
  const ioSupported =
    typeof window.electronAPI.exportConfig === 'function' &&
    typeof window.electronAPI.importConfig === 'function';
  // PLAN-EXECUTOR-DESKTOP-UX 5.2：诊断报告导出。独立于 ioBusy 的 in-flight
  // 状态——它与配置备份是两条不同的链路（一个改配置、一个只读现场），
  // 共用 busy 会让「导入进行中」误禁用诊断按钮，反之亦然。
  const [diagBusy, setDiagBusy] = useState(false);
  const [diagMsg, setDiagMsg] = useState<IoMsg | null>(null);
  const diagSupported = typeof window.electronAPI.exportDiagnosticReport === 'function';

  // F-38（UIUX 审计）：6s 自动清除的 setTimeout 必须随卸载清理——切走/卸载后
  // 仍会对已卸载组件 setState。句柄入 ref，重挂前清旧 + 卸载清尾。
  const checkMsgTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (checkMsgTimerRef.current !== null) clearTimeout(checkMsgTimerRef.current);
  }, []);

  // DSK-05：手动检查更新。开发模式（未打包）主进程 updater 未初始化，
  // checkForUpdates 静默返回——因此提示文案刻意不承诺"有新版本"。
  async function checkUpdate(): Promise<void> {
    setChecking(true);
    setCheckMsg(null);
    try {
      const r = await window.electronAPI.checkForUpdate();
      // A-3：主进程在「当前安装形态不支持自更新」时回 ok:false + 稳定哨兵；
      // 分支判定收在纯函数里（io-result.ts），这里只写结果。
      setCheckMsg(planUpdateCheckText(r, updateCheckTexts));
    } catch (err) {
      setCheckMsg(ipcErrorMessage(err));
    } finally {
      setChecking(false);
      if (checkMsgTimerRef.current !== null) clearTimeout(checkMsgTimerRef.current);
      checkMsgTimerRef.current = setTimeout(() => setCheckMsg(null), 6000);
    }
  }

  // ── 拓展包：配置导出 / 导入（配置备份）─────────────────────────────
  // 导出：主进程 saveDialog + 写入 getAllMasked() 的掩码配置，渲染层只呈现
  // 结果路径（用户取消 = 无声返回，不弹"失败"）。
  // 导入：主进程 openDialog → parseImportedConfig（白名单 + 掩码/空 token
  // 剥离）→ sanitizeConfigInput → save 同一条保存链路；成功后重新 getConfig()
  // 刷新渲染层配置态（表单/草稿/诊断与已落盘值对齐）。
  async function exportConfig(): Promise<void> {
    if (ioBusy !== null) return;
    setIoBusy('export');
    setIoMsg(null);
    try {
      const r = await window.electronAPI.exportConfig();
      const plan = planExportResult(r, t);
      if (plan.kind === 'silent') return;
      setIoMsg(ioMsgOf(plan));
    } catch (err) {
      setIoMsg({ kind: 'err', text: ipcErrorMessage(err) });
    } finally {
      setIoBusy(null);
    }
  }

  async function importConfig(): Promise<void> {
    if (ioBusy !== null) return;
    setIoBusy('import');
    setIoMsg(null);
    try {
      const r = await window.electronAPI.importConfig();
      const plan = planImportResult(r, t);
      if (plan.kind === 'silent') return;
      if (plan.kind === 'err') {
        setIoMsg(ioMsgOf(plan));
        return;
      }
      // plan.kind === 'applied'：配置已落盘。回写页面草稿（表单/基线/textarea
      // 草稿/连接测试结果）由一个回写回调完成，返回单出口协议。
      let applied: ImportApplyOutcome = { kind: 'applied' };
      try {
        const cfg = await window.electronAPI.getConfig();
        applied = applyImportedConfig(cfg);
      } catch {
        /* 掩码配置重读失败：保持既有显示，导入结果照常呈现 */
      }
      if (applied.kind === 'reload') return;
      // 导入可能改了 uv 组——诊断块反映的是已保存配置，立即重取（EXP-06 同语义）。
      refreshPyEnv();
      setIoMsg(ioMsgOf(planImportApplied(r.reloadError, t)));
    } catch (err) {
      setIoMsg({ kind: 'err', text: ipcErrorMessage(err) });
    } finally {
      setIoBusy(null);
    }
  }

  // PLAN-EXECUTOR-DESKTOP-UX 5.2：导出诊断报告。
  // 主进程侧一次性收齐现场（版本/环境、脱敏配置、健康、工作目录、最近日志）
  // 并写成单个 JSON；渲染层只呈现结果路径（用户取消 = 无声返回，不弹失败）。
  // 与 exportConfig 同款 try/catch/finally——reject 后按钮必须能再点。
  async function exportDiagnostics(): Promise<void> {
    if (diagBusy) return;
    setDiagBusy(true);
    setDiagMsg(null);
    try {
      const r = await window.electronAPI.exportDiagnosticReport?.();
      const plan = planDiagnosticsResult(r, t);
      if (plan.kind === 'silent') return;
      setDiagMsg(ioMsgOf(plan));
    } catch (err) {
      setDiagMsg({ kind: 'err', text: t('cfg.io.diagnosticFailed', ipcErrorMessage(err)) });
    } finally {
      setDiagBusy(false);
    }
  }

  // DSK-04：开机自启走独立 IPC（autolaunch:get/set，即时生效，不经保存按钮）。
  async function toggleAutoLaunch(enable: boolean): Promise<void> {
    setAutoLaunch(enable); // 乐观更新，失败由 catch 回滚
    try {
      // DEV-AUTOLAUNCH：主进程在开发模式会拒绝写入并返回 { ok: false }
      // （而非 reject）——同样要回滚开关，否则 UI 显示「已开启」、
      // 系统层却无自启项。
      const r = await window.electronAPI.setAutoLaunch(enable);
      if (!r || r.ok !== true) setAutoLaunch(!enable);
    } catch {
      setAutoLaunch(!enable);
    }
  }

  return {
    checking, checkMsg, checkUpdate,
    ioBusy, ioMsg, ioSupported, exportConfig, importConfig,
    diagBusy, diagMsg, diagSupported, exportDiagnostics,
    toggleAutoLaunch,
  };
}

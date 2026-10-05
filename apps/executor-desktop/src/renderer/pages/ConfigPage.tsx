import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Icon, { type IconName } from '../components/Icon';
import PageHeader from '../components/PageHeader';
import ConfirmBar from '../components/ConfirmBar';
import {
  DOWNLOAD_TIMEOUT_MS,
  EXECUTOR_PORT,
  MAX_CONCURRENT_TASKS,
  displayNumber,
  parseBoundedInt,
} from '../number-input';
// N-04：渲染层双语——文案本体在 ../i18n.ts 的 CFG_TEXTS（zh/en 扁平键表，
// 与托盘 tray-texts 同范式）；语言判定 navigator.language en* → en，其余 zh。
import { createCfgTexts, resolveRendererLocale, type RendererLocale } from '../i18n';
// Agent 最近结果（lastOutcome）是英文枚举（delivered / deliver_failed / …），
// 与状态页共用 main/agent-status-view 的查表映射——已知值出双语标签、表外
// 未知值原样透出。不在设置页再写一份裸枚举直出。
import { agentOutcomeLabel } from '../../main/agent-status-view';

declare const window: Window & {
  electronAPI: {
    getConfig: () => Promise<Record<string, unknown>>;
    getStatus?: () => Promise<{ running: boolean }>;
    saveConfig: (cfg: Record<string, unknown>) => Promise<{ ok: boolean; reloadError?: string }>;
    testConnection: (url: string) => Promise<{ ok: boolean; message: string }>;
    getLocalIPs: () => Promise<string[]>;
    getAutoLaunch: () => Promise<boolean>;
    setAutoLaunch: (enable: boolean) => Promise<{ ok: boolean }>;
    checkForUpdate: () => Promise<{ ok: boolean }>;
    getPythonEnvStatus?: () => Promise<PythonEnvStatus>;
  };
};

/** python_task_multiversion：设置页诊断面（实际生效的 uv / 池，见主进程 IPC）。 */
type PythonEnvStatus = {
  uvPath: string | null;
  uvSource: 'config' | 'bundled' | 'env' | 'path';
  uvFromSystemEnv: boolean;
  /** UX-DSK-UV：显式配了 uvPath 但文件用不了——"配了却没生效"。 */
  uvConfiguredButMissing?: boolean;
  /** false = 只能由 executor-node 运行时从 PATH 兜底，**不是**缺失。 */
  uvStaticallyConfirmed?: boolean;
  interpretersDir: string;
  poolEntries: string[];
  poolReadable: boolean;
  mirrorConfigured: boolean;
  pypiConfigured: boolean;
};

function Toggle({ id, label, checked, onChange }: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="toggle">
      <input type="checkbox" id={id} aria-label={label} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <div className="toggle-track"><div className="toggle-thumb" /></div>
    </label>
  );
}

// R3 D-03：配置页渐进披露——超过一行半的长 hint 与多段拼贴 banner 默认收起，
// 点开 summary 才展开，把「留空即用」的用户与排障文档解耦。原生
// <details>/<summary>：零 JS、无内联事件（CSP 安全），summary 天然可聚焦、
// Enter/Space 可切换（键盘可达）。label 由调用方传 i18n 键值（双语，i18n 二期
// 收尾后必传——不再留 zh 硬编码兜底默认值）；展开内容复用 .cfg-hint 的
// 11px/text3 排版。
function HintDetails({ label, children }: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <details className="cfg-hint-details">
      <summary>{label}</summary>
      <span className="cfg-hint">{children}</span>
    </details>
  );
}

// B-03 分区重组：id 由后端字段分组改为「谁在什么时候改」的心智分组——
// 连接与身份（首次安装即填 + 名称/并发）、网络、Python、Agent（实验性；
// 「实验性」是重要成熟度信号，nav 标签不改「高级」）、关于与更新（低频
// 运维项收拢）。nav 顺序不变；`general` 更名 `about`（旧 id 无残留）。
type SectionId = 'connection' | 'network' | 'python' | 'agent' | 'about';

// N-04：label/desc 不再内联中文，键进 CFG_TEXTS（cfg.section.*，双语成对）。
const SECTIONS: { id: SectionId; icon: IconName; labelKey: string; descKey: string }[] = [
  { id: 'connection', icon: 'link', labelKey: 'cfg.section.connection', descKey: 'cfg.section.connectionDesc' },
  { id: 'network',    icon: 'globe', labelKey: 'cfg.section.network', descKey: 'cfg.section.networkDesc' },
  // python_task_multiversion：内网/离线部署的关键配置面。此前这些字段
  // （uvPath / 镜像 / 池目录 / PyPI 源）虽然后端全部实现，却**没有任何 UI
  // 入口**——运维只能去手工编辑 userData 里的 config.json，实际等于不可用。
  { id: 'python',     icon: 'terminal', labelKey: 'cfg.section.python', descKey: 'cfg.section.pythonDesc' },
  { id: 'agent',      icon: 'bot', labelKey: 'cfg.section.agent', descKey: 'cfg.section.agentDesc' },
  { id: 'about',      icon: 'gear', labelKey: 'cfg.section.about', descKey: 'cfg.section.aboutDesc' },
];

// SECTION_KEYS 同时驱动 nav 的 cfg-nav-dirty 未保存圆点（B-03：字段迁到哪个
// 分区，圆点就亮在哪个 nav 项——executorName/maxConcurrentTasks 随字段迁入
// connection，autoLaunch/检查更新走独立 IPC 不入表，原「基本设置」口径不变）。
const SECTION_KEYS: Record<SectionId, string[]> = {
  connection: ['adminApiUrl', 'executorToken', 'executorName', 'maxConcurrentTasks'],
  network: ['executorHost', 'executorPort', 'executorAddressPublic', 'pullMode'],
  python: ['uvPath', 'uvPythonInstallMirror', 'uvPythonInstallDir', 'pypiRegistryUrl', 'interpreterDownloadTimeoutMs'],
  agent: ['agentEnabled', 'agentPermissionProfile', 'agentCodeExecution', 'agentHostAccess', 'agentTaskExecution', 'agentAllowedApps', 'agentAllowedDomains'],
  about: ['logLevel', 'autoStartExecutor', 'notifyEnabled'],
};

function sameConfigValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

// ── V4-4（X-02）：配置改动清单 ──────────────────────────────────────
// 字段 → i18n label 键（改动清单里显示人话字段名，不露内部键名）。
// 键集 = SECTION_KEYS 的并集（新字段入分区时必须同步进这张表，否则改动
// 清单里回落显示原始键名——可见但不友好，不阻断）。
const FIELD_LABEL_KEYS: Array<[string, string]> = [
  ['adminApiUrl', 'cfg.conn.adminApiLabel'],
  ['executorToken', 'cfg.conn.tokenLabel'],
  ['executorName', 'cfg.gen.nameLabel'],
  ['maxConcurrentTasks', 'cfg.gen.maxTasksLabel'],
  ['executorHost', 'cfg.net.hostLabel'],
  ['executorPort', 'cfg.net.portLabel'],
  ['executorAddressPublic', 'cfg.net.publicLabel'],
  ['pullMode', 'cfg.net.pullToggleLabel'],
  ['uvPath', 'cfg.py.uvPathLabel'],
  ['uvPythonInstallMirror', 'cfg.py.mirrorLabel'],
  ['uvPythonInstallDir', 'cfg.py.poolDirLabel'],
  ['pypiRegistryUrl', 'cfg.py.pypiLabel'],
  ['interpreterDownloadTimeoutMs', 'cfg.py.timeoutLabel'],
  ['agentEnabled', 'cfg.agent.enableTitle'],
  ['agentPermissionProfile', 'cfg.agent.profileLabel'],
  ['agentCodeExecution', 'cfg.agent.codeExecLabel'],
  ['agentHostAccess', 'cfg.agent.hostAccessLabel'],
  ['agentTaskExecution', 'cfg.agent.taskExecLabel'],
  ['agentAllowedApps', 'cfg.agent.appsLabel'],
  ['agentAllowedDomains', 'cfg.agent.domainsLabel'],
  ['logLevel', 'cfg.gen.logLevelLabel'],
  ['autoStartExecutor', 'cfg.gen.autoRunTitle'],
  ['notifyEnabled', 'cfg.gen.notifyTitle'],
];

/** 改动清单取值格式化：密钥一律掩码（改动清单不能变成密钥泄露面），数组
    展开为顿号串，空值显示「（空）」，长值截断。 */
function formatDiffValue(t: (key: string, ...args: (string | number | boolean)[]) => string, key: string, value: unknown): string {
  if (key === 'executorToken') return value ? t('cfg.footer.valueMasked') : t('cfg.footer.valueEmpty');
  let text: string;
  if (Array.isArray(value)) text = value.length > 0 ? value.join('、') : t('cfg.footer.valueEmpty');
  else if (value === '' || value === undefined || value === null) text = t('cfg.footer.valueEmpty');
  else text = String(value);
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

function listText(value: unknown): string {
  return Array.isArray(value) ? value.join('\n') : '';
}

function parseListText(value: string): string[] {
  return value.split(/[\n,]/).map((entry) => entry.trim()).filter(Boolean);
}

export default function ConfigPage() {
  // N-04：整页共用一个 locale 的文案函数（同 tray「同一轮渲染锁同语言」，
  // 杜绝混语；渲染层无热切语言入口，重挂载时按 navigator.language 重取）。
  const locale: RendererLocale = resolveRendererLocale(() => navigator.language);
  const t = createCfgTexts(locale);
  const [form, setForm] = useState<Record<string, unknown>>({});
  const [savedForm, setSavedForm] = useState<Record<string, unknown>>({});
  const [allowedAppsText, setAllowedAppsText] = useState('');
  const [allowedDomainsText, setAllowedDomainsText] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [checkingSaveImpact, setCheckingSaveImpact] = useState(false);
  const [saveImpact, setSaveImpact] = useState<'running' | 'unknown' | null>(null);
  const [saved, setSaved] = useState(false);
  // D 修正：保存失败必须可见（原实现 reject 后按钮永久 disabled）
  const [saveError, setSaveError] = useState<string | null>(null);
  // NETOPT-7⑤（2026-09-20）：首屏配置读取失败的页内呈现（桌面端无 toast 体系）。
  // configStore.getAllMasked 读损坏配置/解密异常时 getConfig() 会 reject——
  // 不与 saveError 复用同一 state：保存失败行的「保存失败：」前缀会撒谎。
  const [loadError, setLoadError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [localIPs, setLocalIPs] = useState<string[]>([]);
  const [active, setActive] = useState<SectionId>('connection');
  // DSK-04：开机自启走独立 IPC（autolaunch:get/set，即时生效，不经保存按钮），
  // 与托盘菜单的「开机自启」复选框同源（setAutoLaunch 后主进程会 rebuildMenu）。
  const [autoLaunch, setAutoLaunch] = useState(false);
  // DSK-05：手动检查更新。/update 检查结果通过「状态监控」页的 UpdateBanner
  // 呈现（updater 事件是主进程广播，与触发点解耦）；这里只反馈"已发起"。
  const [checking, setChecking] = useState(false);
  const [checkMsg, setCheckMsg] = useState<string | null>(null);
  // V4-4（X-02）：改动清单显隐。清单内容由 form/savedForm 派生（useMemo）。
  const [showDiff, setShowDiff] = useState(false);
  const changedEntries = useMemo(
    () => FIELD_LABEL_KEYS
      .filter(([key]) => !sameConfigValue(form[key], savedForm[key]))
      .map(([key, labelKey]) => ({ key, labelKey })),
    [form, savedForm],
  );
  // python_task_multiversion：进入「Python 运行环境」时拉一次诊断，显示实际
  // 生效的 uv / 池路径。刻意在切到该页时刷新而不是随表单实时联动——诊断反映
  // 的是**已保存**的配置，跟着未保存的输入框变化会误导用户。
  const [pyEnv, setPyEnv] = useState<PythonEnvStatus | null>(null);
  const [pyEnvError, setPyEnvError] = useState<string | null>(null);
  // P7b：Agent 托管状态（进入 Agent 组时拉一次——反映的是**实际运行**状态，
  // 与上方未保存的表单解耦，同 pyEnv 的"显示已保存配置"语义）。
  const [agentStatus, setAgentStatus] = useState<{
    enabled: boolean; working: boolean; processed: number;
    lastOutcome: string | null; lastEffectiveProfile: string | null;
  } | null>(null);

  useEffect(() => {
    Promise.all([window.electronAPI.getConfig(), window.electronAPI.getLocalIPs()])
      .then(([cfg, ips]) => {
        setForm(cfg);
        setSavedForm(cfg);
        setAllowedAppsText(listText(cfg.agentAllowedApps));
        setAllowedDomainsText(listText(cfg.agentAllowedDomains));
        setLocalIPs(ips);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        // NETOPT-7⑤（2026-09-20）：getConfig() 走主进程 configStore.getAllMasked——
        // 配置文件损坏/schema 校验抛错/token 解密异常时该 IPC reject。原实现无
        // .catch：loaded 恒 false → 整页永久「加载中...」+ unhandled rejection，
        // 用户既进不了设置页也不知道原因。对齐 EXP-04 修法（StatusWindow.tsx
        // getStatus() 同源缺陷的先例）：脱离加载态，把原因呈现在页内错误行。
        setLoadError(t('cfg.error.loadError', err instanceof Error ? err.message : String(err)));
        setLoaded(true);
      });
    // 旧版 preload 可能未暴露 autolaunch 通道——容错降级为隐藏开关
    if (typeof window.electronAPI.getAutoLaunch === 'function') {
      window.electronAPI.getAutoLaunch().then(setAutoLaunch).catch(() => undefined);
    }
  }, []);

  // 切到「Python 运行环境」页时刷新诊断（旧版 preload 无此通道时静默降级为
  // 不显示诊断块，不影响其余设置项的编辑与保存）。
  //
  // EXP-06（本轮体验审查）：抽出 refreshPyEnv()，并在**保存成功后**再调一次。
  // 原实现只在 `active` 变化时拉取，于是用户在「Python 运行环境」页改完
  // uvPath / 解释器池目录 / 下载预算并点「保存配置」后，诊断块**仍显示旧值**
  // ——而诊断块的全部意义就是回答"我配的到底生效了没有"。用户因此会怀疑
  // 保存没生效而反复保存，或者带着错误的认知去排障（看不到 uv 路径已变、
  // 池里已有解释器）。这类"改完不刷新"的缺陷不会报错，只是让用户看到的
  // 信息与真实状态不一致。
  const refreshPyEnv = useCallback(() => {
    if (typeof window.electronAPI.getPythonEnvStatus !== 'function') return () => {};
    let cancelled = false;
    setPyEnvError(null);
    window.electronAPI
      .getPythonEnvStatus()
      .then((s) => { if (!cancelled) setPyEnv(s); })
      .catch((err) => {
        if (!cancelled) setPyEnvError(err instanceof Error ? err.message : String(err));
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (active !== 'python') return;
    return refreshPyEnv();
  }, [active, refreshPyEnv]);

  // P7b：进入 Agent 组时拉托管状态（旧版 preload 未暴露该通道时静默降级
  // 为不显示状态行——同 getAutoLaunch 先例，不影响其余设置项）。
  useEffect(() => {
    if (active !== 'agent') return;
    if (typeof (window as unknown as { electronAPI?: { getAgentStatus?: () => Promise<{ enabled: boolean; working: boolean; processed: number; lastOutcome: string | null; lastEffectiveProfile: string | null }> } }).electronAPI?.getAgentStatus !== 'function') return;
    (window as unknown as { electronAPI: { getAgentStatus: () => Promise<{ enabled: boolean; working: boolean; processed: number; lastOutcome: string | null; lastEffectiveProfile: string | null }> } })
      .electronAPI.getAgentStatus()
      .then(setAgentStatus)
      .catch(() => undefined);
  }, [active, saved]);

  function set(key: string, value: unknown) {
    setForm((f) => ({ ...f, [key]: value }));
    setSaved(false);
    if (key === 'adminApiUrl') setTestResult(null);
  }

  const dirtySections = new Set(
    SECTIONS.filter((section) => SECTION_KEYS[section.id].some(
      (key) => !sameConfigValue(form[key], savedForm[key]),
    )).map((section) => section.id),
  );
  const isDirty = dirtySections.size > 0;

  async function toggleAutoLaunch(enable: boolean) {
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

  async function save() {
    if (!isDirty) {
      setSaveImpact(null);
      return;
    }
    setSaveImpact(null);
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const r = await window.electronAPI.saveConfig(form);
      // 主进程可能返回 ok:false（载荷形状被拒——防御路径）。不能把它当成功，
      // 否则会显示"✓ 已保存，配置已生效"而其实什么都没写。
      if (r && r.ok === false) {
        setSaveError(t('cfg.error.saveRejected'));
      } else if (r?.reloadError) {
        // 配置已落盘，但执行器热重载可能失败——此时不能报"已生效"，
        // 否则用户以为执行器在跑，实际已停在停止态。
        setSavedForm(form);
        setSaveError(t('cfg.error.reloadFailed', r.reloadError));
      } else {
        setSavedForm(form);
        setSaved(true);
        setTimeout(() => setSaved(false), 3000);
        // EXP-06：保存成功后立刻重取 Python 环境诊断——用户刚改的就是 uvPath /
        // 解释器池 / 下载预算这些值，诊断块必须如实反映"改完之后的实际生效值"。
        // 只在成功分支调用：失败时保留上一次的诊断（比清空更有参考价值）。
        refreshPyEnv();
      }
    } catch (err) {
      // D 修正：原实现未包 try——saveConfig reject 会让 saving 永久为 true，
      // 「保存配置」按钮永久禁用且用户完全无感知，只能重启应用。
      setSaveError(t('cfg.error.saveFailed', err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  }

  async function requestSave() {
    if (!isDirty || saving || checkingSaveImpact) return;
    setCheckingSaveImpact(true);
    setSaveImpact(null);
    try {
      const getStatus = window.electronAPI.getStatus;
      if (typeof getStatus !== 'function') {
        setSaveImpact('unknown');
        return;
      }
      const snapshot = await getStatus();
      if (snapshot.running) {
        setSaveImpact('running');
      } else {
        await save();
      }
    } catch {
      // 状态无法确认时保守提示，不把运行中的任务当作空闲任务处理。
      setSaveImpact('unknown');
    } finally {
      setCheckingSaveImpact(false);
    }
  }

  async function test() {
    setTesting(true); setTestResult(null);
    try {
      const r = await window.electronAPI.testConnection(String(form.adminApiUrl || ''));
      setTestResult(r);
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  }

  // V4-4（X-02）：放弃修改——回滚到最近一次保存的值。allowedApps/Domains 的
  // textarea 草稿是独立 state，必须一并回滚；连接测试结果随 URL 回滚失效。
  function discardChanges() {
    setForm(savedForm);
    setAllowedAppsText(listText(savedForm.agentAllowedApps));
    setAllowedDomainsText(listText(savedForm.agentAllowedDomains));
    setTestResult(null);
    setShowDiff(false);
    setSaveError(null);
  }

  // DSK-05：手动检查更新。开发模式（未打包）主进程 updater 未初始化，
  // checkForUpdates 静默返回——因此提示文案刻意不承诺"有新版本"。
  async function checkUpdate() {
    setChecking(true); setCheckMsg(null);
    try {
      await window.electronAPI.checkForUpdate();
      setCheckMsg(t('cfg.gen.checkInitiated'));
    } catch (err) {
      setCheckMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(false);
      setTimeout(() => setCheckMsg(null), 6000);
    }
  }

  if (!loaded) return (
    <div className="page-loading">{t('cfg.common.loading')}</div>
  );

  // UX-DSK-NUM：端口/并发数等数值一律走 displayNumber —— 状态里若残留 NaN/null
  // （旧配置或 IPC 脏值），显示与保存必须指向同一个值。
  const port = displayNumber(form.executorPort, EXECUTOR_PORT.fallback);

  return (
    <div className="cfg-layout">

      {/* 侧边导航 */}
      <nav className="cfg-nav">
        <div className="cfg-nav-heading">{t('cfg.common.navHeading')}</div>
        {SECTIONS.map(s => (
          <button
            key={s.id}
            className={`cfg-nav-item${active === s.id ? ' active' : ''}`}
            onClick={() => setActive(s.id)}
          >
            <span className="cfg-nav-icon"><Icon name={s.icon} /></span>
            <div className="cfg-nav-text">
              <span className="cfg-nav-label">
                {t(s.labelKey)}
                {dirtySections.has(s.id) && <span className="cfg-nav-dirty" title={t('cfg.common.unsavedDotTitle')} aria-label={t('cfg.common.unsavedDotAria')} />}
              </span>
              <span className="cfg-nav-sub">{t(s.descKey)}</span>
            </div>
          </button>
        ))}
      </nav>

      {/* 内容区 */}
      <div className="cfg-body">
        <div className="cfg-scroll">
          <div className="cfg-scroll-inner">

          {/* NETOPT-7⑤：首屏配置读取失败——脱离「加载中」后必须把原因呈现出来，
              否则用户看到的是一张"空表单"而无从知晓读取失败（复用 cfg-save-error
              同型错误行；不与保存失败的 state 合并，避免文案前缀撒谎）。 */}
          {loadError && (
            <div className="cfg-save-error" role="alert"><Icon name="warning" className="icon-xs" /> {loadError}</div>
          )}

          {/* V4-3（V-02）：分区内容收进 cfg-section（cfg-main + cfg-aside 双栏）。
              ≥1400px 宽屏：主列放字段组、右上下文栏放诊断/引导/低频说明——
              2000px 下右半不再空转；<1400px 退化为单列（aside 顺流到主列之后）。 */}
          {active === 'connection' && (
            <div className="cfg-section">
              <PageHeader
                headingLevel="h2"
                icon={<Icon name="link" />}
                title={t('cfg.conn.title')}
                meta={t('cfg.conn.subtitle')}
              />

              <div className="cfg-main">
              <div className="cfg-group">
                <div className="cfg-group-title">{t('cfg.conn.groupPlatform')}</div>
                <div className="cfg-field">
                  <label className="cfg-label">{t('cfg.conn.adminApiLabel')}</label>
                  <div className="cfg-row">
                    <input aria-label={t('cfg.conn.adminApiLabel')} className="input" placeholder="http://192.168.1.10:3001"
                      value={String(form.adminApiUrl || '')}
                      onChange={(e) => set('adminApiUrl', e.target.value)} />
                    <button className="btn cfg-test-button" onClick={test} disabled={testing}>
                      {testing ? <><Icon name="refresh" className="icon-spin" /> {t('cfg.conn.testing')}</> : <><Icon name="zap" /> {t('cfg.conn.test')}</>}
                    </button>
                  </div>
                  {testResult && (
                    <div className={`test-result ${testResult.ok ? 'ok' : 'fail'}`}>
                      <Icon name={testResult.ok ? 'check' : 'close'} className="icon-xs" /> {testResult.message}
                    </div>
                  )}
                  <span className="cfg-hint">{t('cfg.conn.adminApiHint')}</span>
                </div>
              </div>

              {/* B-03：executorName / maxConcurrentTasks 自原「基本设置」迁入——
                  与密钥同属「装好后一次性填好的执行器自身属性」，页头即「连接与身份」；
                  原「身份与并发」组随字段迁走，组标题沿用此处（键值改「身份与并发」）。 */}
              <div className="cfg-group">
                <div className="cfg-group-title">{t('cfg.conn.groupIdentity')}</div>
                <div className="cfg-field">
                  <label className="cfg-label">{t('cfg.conn.tokenLabel')}</label>
                  <input aria-label={t('cfg.conn.tokenLabel')} className="input" type="password" placeholder={t('cfg.conn.tokenPlaceholder')}
                    value={String(form.executorToken || '')}
                    onChange={(e) => set('executorToken', e.target.value)} />
                  <span className="cfg-hint">{t('cfg.conn.tokenHint')}</span>
                </div>

                <div className="cfg-field">
                  <label className="cfg-label">{t('cfg.gen.nameLabel')}</label>
                  <input aria-label={t('cfg.gen.nameLabel')} className="input" placeholder="my-executor-1"
                    value={String(form.executorName || '')}
                    onChange={(e) => set('executorName', e.target.value)} />
                  <span className="cfg-hint">{t('cfg.gen.nameHint')}</span>
                </div>

                <div className="cfg-field cfg-field-narrow">
                  <label className="cfg-label">{t('cfg.gen.maxTasksLabel')}</label>
                  {/* UX-DSK-NUM：原实现 `parseInt(e.target.value, 10)` 无兜底——
                      清空输入框得到 NaN，显示层 `Number(form.x || 10)` 仍渲染 10，
                      于是"界面显示 10、实际保存 NaN"。NaN 经 IPC 序列化为 null，
                      主进程写入时撞 electron-store 的 schema 校验整次抛错。
                      这里与保存路径同源：留空 = 回落默认 10，越界钳到 1–100。 */}
                  <input aria-label={t('cfg.gen.maxTasksLabel')} className="input" type="number" min={1} max={100}
                    value={displayNumber(form.maxConcurrentTasks, MAX_CONCURRENT_TASKS.fallback)}
                    onChange={(e) => set('maxConcurrentTasks',
                      parseBoundedInt(e.target.value, MAX_CONCURRENT_TASKS.fallback,
                        MAX_CONCURRENT_TASKS.min, MAX_CONCURRENT_TASKS.max))}
                    onBlur={(e) => set('maxConcurrentTasks',
                      parseBoundedInt(e.target.value, MAX_CONCURRENT_TASKS.fallback,
                        MAX_CONCURRENT_TASKS.min, MAX_CONCURRENT_TASKS.max))} />
                  <span className="cfg-hint">{t('cfg.gen.maxTasksHint')}</span>
                </div>
              </div>
              </div>

              <aside className="cfg-aside">
                {/* G-01 同源引导：首次配置的三步路标（宽屏右栏/窄屏文末） */}
                <div className="cfg-guide-card">
                  <div className="cfg-guide-title"><Icon name="bulb" className="icon-xs" /> {t('cfg.conn.guideTitle')}</div>
                  <ol className="cfg-guide-steps">
                    <li>{t('cfg.conn.guideStep1')}</li>
                    <li>{t('cfg.conn.guideStep2')}</li>
                    <li>{t('cfg.conn.guideStep3')}</li>
                  </ol>
                </div>
              </aside>
            </div>
          )}

          {active === 'network' && (
            <div className="cfg-section">
              <PageHeader
                headingLevel="h2"
                icon={<Icon name="globe" />}
                title={t('cfg.net.title')}
                meta={t('cfg.net.subtitle')}
              />

              <div className="cfg-main">
              <div className="cfg-group">
                <div className="cfg-group-title">{t('cfg.net.groupListen')}</div>
                <div className="cfg-two-col">
                <div className="cfg-field">
                  <label className="cfg-label">{t('cfg.net.hostLabel')}</label>
                  {/* P2-2：bind host 此前只在向导里硬编码 0.0.0.0、设置页无入口，
                      用户事后无法修改。它直接决定子进程的 BIND_ADDRESS。 */}
                  <input aria-label={t('cfg.net.hostLabel')} className="input" placeholder="0.0.0.0"
                    value={String(form.executorHost || '0.0.0.0')}
                    onChange={(e) => set('executorHost', e.target.value)}
                    onBlur={(e) => {
                      // 留空会让子进程拿到空 BIND_ADDRESS 并回落 127.0.0.1
                      // （只听本机、永远收不到推送）——强制回到安全默认 0.0.0.0。
                      if (!e.target.value.trim()) set('executorHost', '0.0.0.0');
                    }} />
                  <span className="cfg-hint">
                    {t('cfg.net.hostHint')}
                  </span>
                </div>
                <div className="cfg-field">
                  <label className="cfg-label">{t('cfg.net.portLabel')}</label>
                  {/* 与「最大并发任务数」同源缺陷：清空输入框 → NaN → 显示 8002
                      却保存 null。留空回落默认端口；失焦时把越界的 1–65535
                      之外的值钳回（HTML min/max 不阻止手输/粘贴）。 */}
                  <input aria-label={t('cfg.net.portLabel')} className="input" type="number" min={1} max={65535} value={port}
                    onChange={(e) => set('executorPort',
                      parseBoundedInt(e.target.value, EXECUTOR_PORT.fallback,
                        EXECUTOR_PORT.min, EXECUTOR_PORT.max))}
                    onBlur={(e) => set('executorPort',
                      parseBoundedInt(e.target.value, EXECUTOR_PORT.fallback,
                        EXECUTOR_PORT.min, EXECUTOR_PORT.max))} />
                  </div>
                </div>
              </div>

              <div className="cfg-group">
                <div className="cfg-group-title">{t('cfg.net.groupPublic')}</div>
                <div className="cfg-field">
                  <label className="cfg-label">{t('cfg.net.publicLabel')}</label>
                  {/* 此前 placeholder 写「留空自动检测」，但主进程**没有任何自动
                      检测**：留空会把 executorHost 的默认值 `0.0.0.0` 注册出去，而
                      admin-api 把 0.0.0.0 归为 reserved 并**无条件拒绝**
                      （safe-http.util 的 assertSafeExecutorUrl，即便开了私网开关也
                      不放行）。用户照 placeholder 做，得到的是一个注册成功、
                      显示在线、却永远派发不到的执行器。文案改为如实说明，
                      并在留空时自动填入第一块网卡（下方已有 IP 快速填入）；
                      主进程构造子进程 env 时还会再兜底一次（buildExecutorChildEnv）。 */}
                  <input aria-label={t('cfg.net.publicLabel')} className="input" placeholder={t('cfg.net.publicPlaceholder')}
                    value={String(form.executorAddressPublic || '')}
                    onChange={(e) => set('executorAddressPublic', e.target.value)}
                    onBlur={(e) => {
                      // 留空时用第一块网卡兜底（而不是让 0.0.0.0 流到注册请求）。
                      if (!e.target.value.trim() && localIPs.length > 0) {
                        set('executorAddressPublic', `${localIPs[0]}:${port}`);
                      }
                    }} />
                  <span className="cfg-hint">
                    {t('cfg.net.publicHint')}
                  </span>
                </div>

                {localIPs.length > 0 && (
                  <div className="cfg-field">
                    <label className="cfg-label">{t('cfg.net.ipPickerLabel')}</label>
                    <div className="ip-picker">
                      {localIPs.map((ip) => {
                        const full = `${ip}:${port}`;
                        const sel = String(form.executorAddressPublic || '') === full;
                        return (
                          <button
                            type="button"
                            key={ip}
                            className={`ip-chip${sel ? ' selected' : ''}`}
                            onClick={() => set('executorAddressPublic', full)}
                            aria-pressed={sel}
                            aria-label={`${full}${sel ? t('cfg.net.ipChipSelected') : t('cfg.net.ipChipUse')}`}
                          >
                            {full}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
              </div>

              <aside className="cfg-aside">
                <div className="info-banner">
                  <span className="info-banner-icon"><Icon name="bulb" /></span>
                  <span>{t('cfg.net.bannerA')}<strong>{t('cfg.net.bannerStrong1')}</strong>{t('cfg.net.bannerB')}<strong>{t('cfg.net.bannerStrong2')}</strong>{t('cfg.net.bannerC')}</span>
                </div>

                {/* ARCH-33（ADR-016）：pull 回连模式。
                    桌面端的典型部署是「公网中台 + 内网办公机」，而办公机在 NAT 后
                    根本没有可填的公网地址——push 模式下 admin 每次拨入都超时
                    （生产实证 "Failed to reach executor after 3 attempts"）。
                    回连模式由执行器主动长轮询，中台无需反向连入。 */}
                <div className="cfg-toggle-card">
                  <div className="cfg-toggle-info">
                    <strong>{t('cfg.net.pullTitle')}</strong>
                    <span>
                      {t('cfg.net.pullDesc')}
                    </span>
                  </div>
                  <Toggle id="pullMode" label={t('cfg.net.pullToggleLabel')} checked={form.pullMode === true}
                    onChange={(v) => set('pullMode', v)} />
                </div>
              </aside>
            </div>
          )}

          {active === 'python' && (
            <div className="cfg-section">
              <PageHeader
                headingLevel="h2"
                icon={<Icon name="terminal" />}
                title={t('cfg.py.title')}
                meta={t('cfg.py.subtitle')}
              />

              <div className="cfg-main">
              {/* 诊断块：显示**已保存配置**下实际生效的 uv / 池。这是排查
                  "配置了却没生效"最快的一手信息（uvPath 指错、自带 uv 缺失、
                  池被配到工作目录等），因此放在最上方。 */}
              {pyEnv && (
                <div className={`py-env-status ${
                  pyEnv.uvConfiguredButMissing
                    ? 'warn'
                    : pyEnv.uvPath || pyEnv.uvFromSystemEnv ? 'ok' : 'warn'
                }`}>
                  <div className="py-env-row">
                    <span className="py-env-key">uv</span>
                    <span className="py-env-val">
                      {pyEnv.uvPath
                        ? <><code>{pyEnv.uvPath}</code>
                            <em>
                              {pyEnv.uvSource === 'config'
                                ? (pyEnv.uvConfiguredButMissing
                                    ? t('cfg.py.uvFromConfigBroken')
                                    : t('cfg.py.uvFromConfig'))
                                : pyEnv.uvSource === 'bundled' ? t('cfg.py.uvBundled') : ''}
                            </em>
                          </>
                        : pyEnv.uvFromSystemEnv
                          ? <><code>{t('cfg.py.uvSystemKey')}</code><em>{t('cfg.py.uvFromSystem')}</em></>
                          // UX-DSK-UV：既没显式配置也没自带 uv 时，**不等于缺失**——
                          // executor-node 启动后还会实跑 `uv --version` 做 PATH
                          // 探测。原实现一律显示"未找到 uv"，在 uv 装在 PATH 上的
                          // 机器上给出假的致命告警（诊断比没有诊断更误导）。
                          : <em className={pyEnv.uvStaticallyConfirmed === false ? '' : 'py-env-missing'}>
                              {pyEnv.uvStaticallyConfirmed === false
                                ? t('cfg.py.uvRuntimeLookup')
                                : t('cfg.py.uvMissing')}
                            </em>}
                    </span>
                  </div>
                  <div className="py-env-row">
                    <span className="py-env-key">{t('cfg.py.poolKey')}</span>
                    <span className="py-env-val">
                      <code>{pyEnv.interpretersDir}</code>
                      {!pyEnv.poolReadable
                        ? <em className="py-env-missing">{t('cfg.py.poolUnreadable')}</em>
                        : pyEnv.poolEntries.length > 0
                          ? <em>{t('cfg.py.poolReady', pyEnv.poolEntries.length, pyEnv.poolEntries.join('、'))}</em>
                          : <em>{t('cfg.py.poolEmpty')}</em>}
                    </span>
                  </div>
                  <div className="py-env-row">
                    <span className="py-env-key">{t('cfg.py.mirrorKey')}</span>
                    <span className="py-env-val">
                      {pyEnv.mirrorConfigured
                        ? <em>{t('cfg.py.mirrorConfigured')}</em>
                        : <em>{t('cfg.py.mirrorMissing')}</em>}
                      {' · '}
                      {pyEnv.pypiConfigured
                        ? <em>{t('cfg.py.pypiConfigured')}</em>
                        : <em>{t('cfg.py.pypiOfficial')}</em>}
                    </span>
                  </div>
                </div>
              )}
              {pyEnvError && (
                <div className="cfg-save-error" role="alert"><Icon name="warning" className="icon-xs" /> {t('cfg.py.envError', pyEnvError)}</div>
              )}

              <div className="cfg-group">
                <div className="cfg-group-title">{t('cfg.py.groupSource')}</div>
                <div className="cfg-field">
                  <label className="cfg-label">{t('cfg.py.uvPathLabel')}</label>
                  <input aria-label={t('cfg.py.uvPathLabel')} className="input" placeholder={t('cfg.py.uvPathPlaceholder')}
                    value={String(form.uvPath || '')}
                    onChange={(e) => set('uvPath', e.target.value)} />
                  <HintDetails label={t('cfg.details.label')}>
                    {t('cfg.py.uvPathHint')}
                  </HintDetails>
                </div>

                <div className="cfg-field">
                  <label className="cfg-label">{t('cfg.py.mirrorLabel')}</label>
                  <input aria-label={t('cfg.py.mirrorLabel')} className="input" placeholder={t('cfg.py.mirrorPlaceholder')}
                    value={String(form.uvPythonInstallMirror || '')}
                    onChange={(e) => set('uvPythonInstallMirror', e.target.value)} />
                  <HintDetails label={t('cfg.details.label')}>
                    {t('cfg.py.mirrorHint')}
                  </HintDetails>
                </div>

                <div className="cfg-field">
                  <label className="cfg-label">{t('cfg.py.poolDirLabel')}</label>
                  <input aria-label={t('cfg.py.poolDirLabel')} className="input" placeholder={t('cfg.py.poolDirPlaceholder')}
                    value={String(form.uvPythonInstallDir || '')}
                    onChange={(e) => set('uvPythonInstallDir', e.target.value)} />
                  <HintDetails label={t('cfg.details.label')}>
                    {t('cfg.py.poolDirHint')}
                  </HintDetails>
                </div>

                <div className="cfg-field">
                  <label className="cfg-label">{t('cfg.py.pypiLabel')}</label>
                  <input aria-label={t('cfg.py.pypiLabel')} className="input" placeholder={t('cfg.py.pypiPlaceholder')}
                    value={String(form.pypiRegistryUrl || '')}
                    onChange={(e) => set('pypiRegistryUrl', e.target.value)} />
                  <HintDetails label={t('cfg.details.label')}>
                    {t('cfg.py.pypiHint')}
                  </HintDetails>
                </div>

                <div className="cfg-field cfg-field-narrow">
                  <label className="cfg-label">{t('cfg.py.timeoutLabel')}</label>
                  <input aria-label={t('cfg.py.timeoutLabel')} className="input" type="number" min={0}
                    value={displayNumber(form.interpreterDownloadTimeoutMs, DOWNLOAD_TIMEOUT_MS.fallback)}
                    onChange={(e) => set('interpreterDownloadTimeoutMs',
                      parseBoundedInt(e.target.value, DOWNLOAD_TIMEOUT_MS.fallback,
                        DOWNLOAD_TIMEOUT_MS.min, DOWNLOAD_TIMEOUT_MS.max))}
                    onBlur={(e) => set('interpreterDownloadTimeoutMs',
                      parseBoundedInt(e.target.value, DOWNLOAD_TIMEOUT_MS.fallback,
                        DOWNLOAD_TIMEOUT_MS.min, DOWNLOAD_TIMEOUT_MS.max))} />
                  <span className="cfg-hint">{t('cfg.py.timeoutHint')}</span>
                </div>
              </div>
              </div>

              <aside className="cfg-aside">
                {/* D-03：多段背景说明默认收起——「留空即用」的用户不需要读 README，
                    内网/离线部署的运维点开「阅读背景」再看。 */}
                <div className="info-banner">
                  <span className="info-banner-icon"><Icon name="bulb" /></span>
                  <HintDetails label={t('cfg.details.readBg')}>
                    {t('cfg.py.bannerA')}<strong>{t('cfg.py.bannerStrongUv')}</strong>{t('cfg.py.bannerB')}<strong>{t('cfg.py.bannerStrongNoPy')}</strong>{t('cfg.py.bannerC')}<strong>{t('cfg.py.bannerStrongOnline')}</strong>{t('cfg.py.bannerD')}<strong>{t('cfg.py.bannerStrongIntranet')}</strong>{t('cfg.py.bannerE')}
                  </HintDetails>
                </div>

                {/* D-03：Python 3.7 是唯一无法在线获取的版本——例外说明收进折叠，
                    常规路径（3.8+ 在线/镜像）用户不必被这段离线运维细节打断。 */}
                <div className="info-banner">
                  <span className="info-banner-icon"><Icon name="pin" /></span>
                  <HintDetails label={t('cfg.details.py37')}>
                    <strong>{t('cfg.py.py37Strong')}</strong>{t('cfg.py.py37A')}<code>{t('cfg.py.py37Code')}</code>{t('cfg.py.py37B')}<code>{t('cfg.py.py37BCode')}</code>{t('cfg.py.py37C')}
                  </HintDetails>
                </div>
              </aside>
            </div>
          )}

          {active === 'agent' && (
            <div className="cfg-section">
              <PageHeader
                headingLevel="h2"
                icon={<Icon name="bot" />}
                title={t('cfg.agent.title')}
                meta={t('cfg.agent.subtitle')}
              />

              <div className="cfg-main">
              <div className="cfg-toggle-card">
                <div className="cfg-toggle-info">
                  <strong>{t('cfg.agent.enableTitle')}</strong>
                  <span>
                    {t('cfg.agent.enableDesc')}
                  </span>
                </div>
                <Toggle id="agentEnabled" label={t('cfg.agent.enableTitle')} checked={form.agentEnabled === true}
                  onChange={(v) => set('agentEnabled', v)} />
              </div>

              <div className="cfg-group">
                <div className="cfg-group-title">{t('cfg.agent.groupPerms')}</div>
                <div className="cfg-field cfg-agent-select-field">
                  <label className="cfg-label">{t('cfg.agent.profileLabel')}</label>
                {/* P7a 只实现 minimal / standard（09 §6）；其余三档是登记在案的
                    保留名——显示为禁用项让用户知道路线图，但**选不了**（选了也
                    会被解析层钳回 minimal，界面与行为一致比可点更重要）。 */}
                <select aria-label={t('cfg.agent.profileLabel')} className="input"
                  value={String(form.agentPermissionProfile || 'minimal')}
                  onChange={(e) => set('agentPermissionProfile', e.target.value)}>
                  <option value="minimal">{t('cfg.agent.profileMinimal')}</option>
                  <option value="standard">{t('cfg.agent.profileStandard')}</option>
                  <option value="developer" disabled>{t('cfg.agent.profileDeveloper')}</option>
                  <option value="ops-assist" disabled>{t('cfg.agent.profileOps')}</option>
                  <option value="full-trust" disabled>{t('cfg.agent.profileFull')}</option>
                </select>
                <HintDetails label={t('cfg.details.label')}>{t('cfg.agent.profileHint')}</HintDetails>
              </div>

              <div className="cfg-field cfg-agent-select-field">
                <label className="cfg-label">{t('cfg.agent.codeExecLabel')}</label>
                <select aria-label={t('cfg.agent.codeExecLabel')} className="input"
                  value={String(form.agentCodeExecution || '')}
                  onChange={(e) => set('agentCodeExecution', e.target.value)}>
                  <option value="">{t('cfg.agent.followPreset')}</option>
                  <option value="off">{t('cfg.agent.codeExecOff')}</option>
                  <option value="sandbox">{t('cfg.agent.codeExecSandbox')}</option>
                  <option value="host" disabled>{t('cfg.agent.codeExecHost')}</option>
                </select>
                <HintDetails label={t('cfg.details.label')}>{t('cfg.agent.codeExecHint')}</HintDetails>
              </div>

              <div className="cfg-field cfg-agent-select-field">
                <label className="cfg-label">{t('cfg.agent.hostAccessLabel')}</label>
                <select aria-label={t('cfg.agent.hostAccessLabel')} className="input"
                  value={String(form.agentHostAccess || '')}
                  onChange={(e) => set('agentHostAccess', e.target.value)}>
                  <option value="">{t('cfg.agent.hostFollowPreset')}</option>
                  <option value="none">{t('cfg.agent.hostNone')}</option>
                  <option value="app-scoped">{t('cfg.agent.hostScoped')}</option>
                  <option value="session" disabled>{t('cfg.agent.hostSession')}</option>
                </select>
                <HintDetails label={t('cfg.details.label')}>
                  {t('cfg.agent.hostAccessHint')}
                </HintDetails>
              </div>

              <div className="cfg-field cfg-agent-select-field">
                <label className="cfg-label">{t('cfg.agent.taskExecLabel')}</label>
                {/* P7e 前半：isolated-runner 已实现（08 §2.4 方案 A 的独立执行端点）。
                    中台上限 standard 时仍被钳回 deploy-only——与 GUI 同款集中管控。 */}
                <select aria-label={t('cfg.agent.taskExecLabel')} className="input"
                  value={String(form.agentTaskExecution || '')}
                  onChange={(e) => set('agentTaskExecution', e.target.value)}>
                  <option value="">{t('cfg.agent.taskFollowPreset')}</option>
                  <option value="deploy-only">{t('cfg.agent.taskDeployOnly')}</option>
                  <option value="isolated-runner">{t('cfg.agent.taskIsolated')}</option>
                </select>
                <HintDetails label={t('cfg.details.label')}>
                  {t('cfg.agent.taskExecHint')}
                </HintDetails>
                </div>
              </div>

              <div className="cfg-group">
                <div className="cfg-group-title">{t('cfg.agent.groupAllow')}</div>
                <div className="cfg-field">
                <label className="cfg-label">{t('cfg.agent.appsLabel')}<span className="cfg-label-count">{t('cfg.agent.itemsCount', Array.isArray(form.agentAllowedApps) ? form.agentAllowedApps.length : 0)}</span></label>
                <textarea aria-label={t('cfg.agent.appsLabel')} className="input cfg-list-input" rows={6}
                  placeholder={'notepad\nexcel'}
                  value={allowedAppsText}
                  onChange={(e) => {
                    setAllowedAppsText(e.target.value);
                    set('agentAllowedApps', parseListText(e.target.value));
                  }} />
                <HintDetails label={t('cfg.details.label')}>
                  {t('cfg.agent.appsHint')}
                </HintDetails>
              </div>

              <div className="cfg-field">
                <label className="cfg-label">{t('cfg.agent.domainsLabel')}<span className="cfg-label-count">{t('cfg.agent.itemsCount', Array.isArray(form.agentAllowedDomains) ? form.agentAllowedDomains.length : 0)}</span></label>
                <textarea aria-label={t('cfg.agent.domainsLabel')} className="input cfg-list-input" rows={6}
                  placeholder={'erp.corp.com\ncrm.corp.com'}
                  value={allowedDomainsText}
                  onChange={(e) => {
                    setAllowedDomainsText(e.target.value);
                    set('agentAllowedDomains', parseListText(e.target.value));
                  }} />
                <HintDetails label={t('cfg.details.label')}>
                  {t('cfg.agent.domainsHintA')}<strong>{t('cfg.agent.domainsHintStrong')}</strong>{t('cfg.agent.domainsHintB')}
                </HintDetails>
                </div>
              </div>
              </div>

              <aside className="cfg-aside">
                {/* 托管状态行：反映**实际运行**状态（与上方未保存表单解耦）。
                    saved 变化后会重新拉取——保存后立即可见启停是否生效。 */}
                {agentStatus && (
                  <div className="info-banner">
                    <span className={`agent-status-dot${agentStatus.working ? ' is-working' : agentStatus.enabled ? ' is-ok' : ''}`} aria-hidden="true" />
                    <span>
                      {agentStatus.working
                        ? t('cfg.agent.statusWorking')
                        : agentStatus.enabled
                          ? t('cfg.agent.statusEnabled', agentStatus.processed)
                          : t('cfg.agent.statusDisabled')}
                      {agentStatus.lastOutcome ? t('cfg.agent.lastOutcomeFmt', agentOutcomeLabel(agentStatus.lastOutcome, locale)) : ''}
                      {agentStatus.lastEffectiveProfile ? t('cfg.agent.lastProfileFmt', agentStatus.lastEffectiveProfile) : ''}
                    </span>
                  </div>
                )}

                {/* G-01（v3 规划补落地）：「这是什么/开启后果/如何收紧」三行引导卡，
                    术语墙（SOP 指派/权限档位/钳回/沙箱）在字段 hint 里的压力由它分走 */}
                <div className="cfg-guide-card">
                  <div className="cfg-guide-title"><Icon name="bot" className="icon-xs" /> {t('cfg.agent.guideTitle')}</div>
                  <div className="cfg-guide-row"><strong>{t('cfg.agent.guideWhatT')}</strong><span>{t('cfg.agent.guideWhatBody')}</span></div>
                  <div className="cfg-guide-row"><strong>{t('cfg.agent.guideEffectT')}</strong><span>{t('cfg.agent.guideEffectBody')}</span></div>
                  <div className="cfg-guide-row"><strong>{t('cfg.agent.guideTightenT')}</strong><span>{t('cfg.agent.guideTightenBody')}</span></div>
                </div>

                {/* D-03：shield 边界长文是「安全边界说明」——默认收起，开启 Agent
                    的用户与审计者点开阅读；保留 banner 壳与图标以维持警示存在感。 */}
                <div className="info-banner">
                  <span className="info-banner-icon"><Icon name="shield" /></span>
                  <HintDetails label={t('cfg.details.boundary')}>
                    {t('cfg.agent.boundary')}
                  </HintDetails>
                </div>
              </aside>
            </div>
          )}

          {/* B-03：原「基本设置」更名「关于与更新」——executorName/maxConcurrentTasks
              已迁入「连接与身份」，此处收拢低频运维项：日志、自启/通知三开关、
              版本更新（DSK-05 手动检查）；autoLaunch 走独立 IPC 即时生效不经保存。 */}
          {active === 'about' && (
            <div className="cfg-section">
              <PageHeader
                headingLevel="h2"
                icon={<Icon name="gear" />}
                title={t('cfg.about.title')}
                meta={t('cfg.about.subtitle')}
              />

              <div className="cfg-main">
              <div className="cfg-group">
                <div className="cfg-group-title">{t('cfg.gen.groupLog')}</div>
                <div className="cfg-field cfg-field-narrow">
                  <label className="cfg-label">{t('cfg.gen.logLevelLabel')}</label>
                  {/* P3-1：logLevel 此前是没有任何消费者的死字段（向导硬编码 info、
                      设置页无入口、executor-node logger 也不读 LOG_LEVEL）。现已
                      两端打通：桌面文件日志 + 子进程 winston 均按此级别输出。 */}
                  <select aria-label={t('cfg.gen.logLevelLabel')} className="input"
                    value={['debug', 'info', 'error'].includes(String(form.logLevel))
                      ? String(form.logLevel) : 'info'}
                    onChange={(e) => set('logLevel', e.target.value)}>
                    <option value="debug">{t('cfg.gen.logDebug')}</option>
                    <option value="info">{t('cfg.gen.logInfo')}</option>
                    <option value="error">{t('cfg.gen.logError')}</option>
                  </select>
                  <span className="cfg-hint">{t('cfg.gen.logHint')}</span>
                </div>
              </div>

              <div className="cfg-toggle-card">
                <div className="cfg-toggle-info">
                  <strong>{t('cfg.gen.autoRunTitle')}</strong>
                  <span>{t('cfg.gen.autoRunDesc')}</span>
                </div>
                <Toggle id="autoStart" label={t('cfg.gen.autoRunTitle')} checked={Boolean(form.autoStartExecutor)}
                  onChange={(v) => set('autoStartExecutor', v)} />
              </div>

              {/* I-04：即时生效/需保存两种契约——autolaunch 独立 IPC 即时生效，
                  界面必须标注，否则与旁边需保存的开关无从区分 */}
              <div className="cfg-toggle-card">
                <div className="cfg-toggle-info">
                  <strong>{t('cfg.gen.autoLaunchTitle')}<span className="cfg-inline-tag">{t('cfg.gen.instantTag')}</span></strong>
                  <span>{t('cfg.gen.autoLaunchDesc')}</span>
                </div>
                {typeof window.electronAPI.getAutoLaunch === 'function' ? (
                  <Toggle id="autoLaunch" label={t('cfg.gen.autoLaunchTitle')} checked={autoLaunch}
                    onChange={(v) => void toggleAutoLaunch(v)} />
                ) : (
                  <span className="unsupported-label">{t('cfg.gen.unsupported')}</span>
                )}
              </div>

              <div className="cfg-toggle-card">
                <div className="cfg-toggle-info">
                  <strong>{t('cfg.gen.notifyTitle')}</strong>
                  <span>{t('cfg.gen.notifyDesc')}</span>
                </div>
                <Toggle id="notifyEnabled" label={t('cfg.gen.notifyTitle')} checked={form.notifyEnabled !== false}
                  onChange={(v) => set('notifyEnabled', v)} />
              </div>
              </div>

              <aside className="cfg-aside">
                {/* DSK-05：手动检查更新（自动检查为启动后延迟 30s，仅生产包启用）。
                    V4-3：低频运维项收进右上下文栏（宽屏）/文末（窄屏）。 */}
                <div className="cfg-group">
                  <div className="cfg-group-title">{t('cfg.about.groupUpdate')}</div>
                  <div className="cfg-field">
                    <div className="cfg-row">
                      <button
                        type="button"
                        className="btn"
                        onClick={checkUpdate}
                        disabled={checking || typeof window.electronAPI.checkForUpdate !== 'function'}
                      >
                        {checking ? <><Icon name="refresh" className="icon-spin" /> {t('cfg.gen.checking')}</> : <><Icon name="refresh" /> {t('cfg.gen.checkUpdate')}</>}
                      </button>
                    </div>
                    {checkMsg && <span className="cfg-hint" role="status">{checkMsg}</span>}
                  </div>
                </div>
              </aside>
            </div>
          )}

          </div>
        </div>

        {/* V4-4（X-01）：保存影响确认换装共享 ConfirmBar（impact 琥珀变体） */}
        {saveImpact && (
          <ConfirmBar
            variant="impact"
            titleId="cfg-save-impact-title"
            title={saveImpact === 'running' ? t('cfg.impact.runningTitle') : t('cfg.impact.unknownTitle')}
            description={saveImpact === 'running' ? t('cfg.impact.runningDesc') : t('cfg.impact.unknownDesc')}
            confirmLabel={saveImpact === 'running' ? t('cfg.impact.confirmRunning') : t('cfg.impact.confirmAnyway')}
            cancelLabel={t('cfg.impact.cancel')}
            confirmDisabled={saving}
            onConfirm={() => void save()}
            onCancel={() => setSaveImpact(null)}
          />
        )}

        {/* V4-4（X-02）：改动清单——「有未保存更改」从死文案变成可点开的
            字段级 diff（旧值→新值），配置类工具的标准闭环 */}
        {showDiff && isDirty && changedEntries.length > 0 && (
          <div className="cfg-diff-panel" role="region" aria-label={t('cfg.footer.diffAria')}>
            <div className="cfg-diff-title">{t('cfg.footer.diffTitle')}</div>
            {changedEntries.map(({ key, labelKey }) => (
              <div key={key} className="cfg-diff-row">
                <span className="cfg-diff-key">{t(labelKey)}</span>
                <span className="cfg-diff-val is-from">{formatDiffValue(t, key, savedForm[key])}</span>
                <Icon name="chevron-right" className="cfg-diff-arrow icon-xs" />
                <span className="cfg-diff-val is-to">{formatDiffValue(t, key, form[key])}</span>
              </div>
            ))}
          </div>
        )}

        {/* 底部保存栏 */}
        <div className="cfg-footer">
          {saveError && (
            <div className="cfg-save-error" role="alert"><Icon name="warning" className="icon-xs" /> {saveError}</div>
          )}
          {saved && !isDirty && <div className="saved-toast"><Icon name="check" className="icon-xs" /> {t('cfg.footer.savedToast')}</div>}
          {isDirty && (
            <>
              <span className="cfg-unsaved" role="status"><span aria-hidden="true" />{t('cfg.footer.unsavedBar')}</span>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setShowDiff((v) => !v)}
                aria-expanded={showDiff}
              >
                <Icon name={showDiff ? 'chevron-down' : 'chevron-right'} className="icon-xs" />
                {t('cfg.footer.viewChanges', changedEntries.length)}
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={discardChanges}
                disabled={saving || checkingSaveImpact}
              >
                {t('cfg.footer.discard')}
              </button>
            </>
          )}
          <button className="btn btn-primary btn-lg" onClick={requestSave} disabled={saving || checkingSaveImpact || !isDirty || saveImpact !== null}>
            {saving ? <><Icon name="refresh" className="icon-spin" /> {t('cfg.footer.saving')}</> : checkingSaveImpact ? t('cfg.footer.checkingStatus') : t('cfg.footer.save')}
          </button>
        </div>
      </div>
    </div>
  );
}

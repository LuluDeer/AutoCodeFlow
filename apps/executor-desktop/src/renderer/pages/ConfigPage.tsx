import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Icon, { type IconName } from '../components/Icon';
import PageHeader from '../components/PageHeader';
import ConfirmBar from '../components/ConfirmBar';
// UI V5：设置工作台的行结构（左标签 / 右控件 / 下方 hint）。
import SettingRow from '../components/SettingRow';
// PLAN-EXECUTOR-DESKTOP-UX 5.1：健康检查面板（纯展示层，判定逻辑在
// main/health-panel.ts 的纯函数里，行为由 health-panel.selftest.ts 钉住）。
import HealthPanelCard from '../components/HealthPanelCard';
import {
  DOWNLOAD_TIMEOUT_MS,
  EXECUTOR_PORT,
  MAX_CONCURRENT_TASKS,
  displayNumber,
  parseBoundedInt,
} from '../number-input';
// N-04：渲染层双语——文案本体在 ../i18n.ts 的 CFG_TEXTS（zh/en 扁平键表，
// 与托盘 tray-texts 同范式）；语言判定见 i18n.ts 的 resolveRendererLocale
//（i18n-DESK-01：用户设置优先，'auto' 才按 navigator.language 判定）。
import { createCfgTexts, resolveRendererLocale, type RendererLocale } from '../i18n';
// i18n-DESK-01：「界面语言」下拉的合法取值与默认值——与主进程
// config-sanitize.ts 的 ENUM_FIELDS / config-store defaults 同源同一份常量，
// 避免三处各写一遍 zh/en/auto 清单而漂移。
import { UI_LANGUAGE_DEFAULT, UI_LANGUAGE_VALUES } from '../../main/ui-language';
// Agent 最近结果（lastOutcome）是英文枚举（delivered / deliver_failed / …），
// 与状态页共用 main/agent-status-view 的查表映射——已知值出双语标签、表外
// 未知值原样透出。不在设置页再写一份裸枚举直出。
import { agentOutcomeLabel } from '../../main/agent-status-view';
// 保存前判断"本次改动是否真的要求重启执行器"——与主进程共用同一份字段
// 清单（main/config-restart.ts），否则改界面语言/日志级别也会被提示
// "会立即重启执行器"，把无副作用保存说成高风险操作。
import { restartRequiredFieldsDiffer } from '../../main/config-restart';
// P3-2：IPC reject 错误消息剥 Electron 包装前缀（用户可读化）。
import { ipcErrorMessage } from '../ipc-error';
// P1-1：向导保存广播 config:changed → 表单与磁盘真值合并（磁盘覆盖基线、
// 用户未提交草稿保留）。合并策略抽成纯函数由 renderer.selftest 驱动。
import { mergeConfigWithDisk } from '../config-merge';
// P3-5：对外地址的网卡判定与向导同源（排除链路本地/回环）。
import { pickRecommendedIp } from '../network-address';

declare const window: Window & {
  electronAPI: {
    getConfig: () => Promise<Record<string, unknown>>;
    getStatus?: () => Promise<{ running: boolean }>;
    saveConfig: (cfg: Record<string, unknown>) => Promise<{ ok: boolean; reloadError?: string }>;
    testConnection: (url: string) => Promise<{ ok: boolean; message: string }>;
    // 重新运行初始化向导（唤出/聚焦向导窗口；保存走 save-and-close-wizard）
    openWizard?: () => Promise<{ ok: boolean }>;
    getLocalIPs: () => Promise<string[]>;
    getAutoLaunch: () => Promise<boolean>;
    setAutoLaunch: (enable: boolean) => Promise<{ ok: boolean }>;
    // A-3：ok:false 时带稳定哨兵错误码（如 UPDATER_UNSUPPORTED_INSTALL）——
    // 旧契约只有 {ok:boolean}，渲染层拿不到"为什么没检查"。
    checkForUpdate: () => Promise<{ ok: boolean; error?: string }>;
    getPythonEnvStatus?: () => Promise<PythonEnvStatus>;
    // 拓展包：配置导出/导入（主进程 saveDialog/openDialog + 读写，渲染层只收结果）
    exportConfig: () => Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>;
    importConfig: () => Promise<{
      ok: boolean;
      canceled?: boolean;
      reloadError?: string;
      restartDeferred?: boolean;
      error?: string;
    }>;
    // PLAN-EXECUTOR-DESKTOP-UX 5.2：诊断报告导出（主进程 saveDialog + 纯函数
    // buildDiagnosticReport 组装；渲染层只收结果路径，拿不到报告内容）。
    exportDiagnosticReport?: () => Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>;
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
  about: ['logLevel', 'autoStartExecutor', 'notifyEnabled', 'uiLanguage'],
};

// UI V5：左侧导航按「基础 / 运行时 / 系统」分组，组内保持原有 5 个分区顺序。
// 分组标题走 cfgx.nav.*（11px / --text3），不再是每项下方的副标题。
const NAV_GROUPS: { labelKey: string; sections: SectionId[] }[] = [
  { labelKey: 'cfgx.nav.basic', sections: ['connection', 'network'] },
  { labelKey: 'cfgx.nav.runtime', sections: ['python', 'agent'] },
  { labelKey: 'cfgx.nav.system', sections: ['about'] },
];

// UI V5：域名校验只做 UI 提示（不去重、不阻断保存）。字形规则与主进程
// agent/domain-allowlist.ts 同源：至少一个点、标签首尾非连字符、无通配符。
const DOMAIN_RE = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

// Agent 枚举值 → 既有双语标签键（矩阵/「当前生效」展示用，不新造文案）。
const AGENT_VALUE_LABEL_KEYS: Record<string, string> = {
  '': 'cfg.agent.followPreset',
  minimal: 'cfg.agent.profileMinimal',
  standard: 'cfg.agent.profileStandard',
  developer: 'cfg.agent.profileDeveloper',
  'ops-assist': 'cfg.agent.profileOps',
  'full-trust': 'cfg.agent.profileFull',
  off: 'cfg.agent.codeExecOff',
  sandbox: 'cfg.agent.codeExecSandbox',
  host: 'cfg.agent.codeExecHost',
  none: 'cfg.agent.hostNone',
  'app-scoped': 'cfg.agent.hostScoped',
  session: 'cfg.agent.hostSession',
  'deploy-only': 'cfg.agent.taskDeployOnly',
  'isolated-runner': 'cfg.agent.taskIsolated',
};

function sameConfigValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * i18n-DESK-01：界面语言下拉的受控值——非法/缺失（手改配置文件、旧版残值）
 * 一律显示默认值「中文」，与主进程消毒层（ENUM_FIELDS fallback: 'zh'）同口径：
 * select 的 value 必须是它自己某个 option 的 value，否则浏览器会静默显示第一项，
 * 于是"盘上的值和界面显示的值不是一回事"。
 */
function uiLanguageValue(raw: unknown): string {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return (UI_LANGUAGE_VALUES as readonly string[]).includes(v) ? v : UI_LANGUAGE_DEFAULT;
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
  ['uiLanguage', 'cfg.gen.uiLanguageLabel'],
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

/**
 * i18n-DESK-01：这次语言设置的变化是否**真的会改变界面语言**——只有会变才
 * 重载窗口。zh → auto 在中文系统上视觉零变化，白重载一次只会丢掉「已保存」
 * 提示、让用户以为界面抽了一下。
 */
function languageChangeReloadsUi(before: unknown, after: unknown): boolean {
  const getLanguage = () => navigator.language;
  return (
    resolveRendererLocale(getLanguage, uiLanguageValue(before)) !==
    resolveRendererLocale(getLanguage, uiLanguageValue(after))
  );
}

function listText(value: unknown): string {
  return Array.isArray(value) ? value.join('\n') : '';
}

function parseListText(value: string): string[] {
  return value.split(/[\n,]/).map((entry) => entry.trim()).filter(Boolean);
}

export default function ConfigPage() {
  // N-04：整页共用一个 locale 的文案函数（同 tray「同一轮渲染锁同语言」，
  // 杜绝混语）。i18n-DESK-01：locale 来自用户在设置页选的「界面语言」
  // （main.tsx 启动时经 config:get 灌入 i18n 的模块级设置），'auto'/未设置才按
  // navigator.language 判定。语言**不热切换**——本页只读设置、不改本次渲染的
  // 语言；保存生效后走 location.reload() 重载（见 save()）用新语言重新求值。
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
  // UI V5：「当前生效」卡片里的连接耗时（只测量本页测试动作，不新增 IPC）。
  const [testLatency, setTestLatency] = useState<number | null>(null);
  const [localIPs, setLocalIPs] = useState<string[]>([]);
  // UI V5：左栏设置搜索（仅本页本地态，不持久化）。
  const [searchQuery, setSearchQuery] = useState('');
  // UI V5：搜索命中字段后，等目标分区渲染完成再滚动到 data-cfgx-field 锚点。
  const [pendingField, setPendingField] = useState<string | null>(null);
  // UI V5：失焦校验提示（仅 UI 提示，不改变既有 clamp/save 语义）。
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [active, setActive] = useState<SectionId>('connection');
  // DSK-04：开机自启走独立 IPC（autolaunch:get/set，即时生效，不经保存按钮），
  // 与托盘菜单的「开机自启」复选框同源（setAutoLaunch 后主进程会 rebuildMenu）。
  const [autoLaunch, setAutoLaunch] = useState(false);
  // DSK-05：手动检查更新。/update 检查结果通过「状态监控」页的 UpdateBanner
  // 呈现（updater 事件是主进程广播，与触发点解耦）；这里只反馈"已发起"。
  const [checking, setChecking] = useState(false);
  const [checkMsg, setCheckMsg] = useState<string | null>(null);
  // 拓展包：配置导出/导入（配置备份）。in-flight 用 kind 区分两个按钮的
  // loading 形态；结果走 ioMsg 行（kind=ok → status，err → alert），复用
  // 连接测试同款 test-result 排版——桌面端无 toast 体系，反馈必须页内可见。
  const [ioBusy, setIoBusy] = useState<'export' | 'import' | null>(null);
  const [ioMsg, setIoMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const ioSupported =
    typeof window.electronAPI.exportConfig === 'function' &&
    typeof window.electronAPI.importConfig === 'function';
  // PLAN-EXECUTOR-DESKTOP-UX 5.2：诊断报告导出。独立于 ioBusy 的 in-flight
  // 状态——它与配置备份是两条不同的链路（一个改配置、一个只读现场），
  // 共用 busy 会让「导入进行中」误禁用诊断按钮，反之亦然。
  const [diagBusy, setDiagBusy] = useState(false);
  const [diagMsg, setDiagMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const diagSupported = typeof window.electronAPI.exportDiagnosticReport === 'function';
  // V4-4（X-02）：改动清单显隐。清单内容由 form/savedForm 派生（useMemo）。
  const [showDiff, setShowDiff] = useState(false);
  // F-34（UIUX 审计）：数值输入的「输入中草稿」。controlled-clamp 的标准毛刺：
  // onChange 立即 parseBoundedInt 会把清空/中间态立刻回填成默认值——用户想
  // 输入新值得先全选再打字。输入过程只把**原样字符串**存进草稿（显示权归
  // 草稿，含空串），form 只在得到合法整数时更新（越界先钳，保证 form 恒为
  // 合法值）；blur 才走完整 parseBoundedInt（空串=回落默认、越界钳制）并清
  // 草稿——「所见即所存」的保存语义不变，输入过程中不再被回填打断。
  const [numDrafts, setNumDrafts] = useState<Record<string, string>>({});
  // P3-7：失焦钳制的一次性可读提示（key=字段名，渲染于对应字段 hint 位）。
  // 向导对同场景有显式 portRange/portRequired 错误条，设置页此前静默改写，
  // 用户不知道自己填的值被改了。6s 自动消退（同 checkMsg 的 timer 纪律）。
  const [clampNotice, setClampNotice] = useState<Record<string, string>>({});
  const clampTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  useEffect(() => () => {
    for (const timer of Object.values(clampTimersRef.current)) clearTimeout(timer);
  }, []);
  function reportClamp(key: string, value: number): void {
    setClampNotice((prev) => ({ ...prev, [key]: String(value) }));
    const existing = clampTimersRef.current[key];
    if (existing) clearTimeout(existing);
    clampTimersRef.current[key] = setTimeout(() => {
      setClampNotice((prev) => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
      delete clampTimersRef.current[key];
    }, 6000);
  }

  /** 数值输入的受控 value：键入中显示草稿原样串，其余显示安全取值（脏值回落默认）。 */
  function numValue(key: string, value: unknown, fallback: number): string {
    return numDrafts[key] ?? String(displayNumber(value, fallback));
  }

  /** 数值输入 onChange：草稿原样保留 + 合法整数即时入表单（越界先钳）。 */
  function numChange(
    key: string,
    rule: { readonly fallback: number; readonly min: number; readonly max: number },
    raw: string,
  ): void {
    setNumDrafts((d) => ({ ...d, [key]: raw }));
    const trimmed = raw.trim();
    // 空串/number input 非法半态：form 保持原值，显示权在草稿；blur 收口。
    if (trimmed === '') return;
    const n = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(n)) return;
    set(key, Math.min(Math.max(n, rule.min), rule.max));
  }

  /** 数值输入 onBlur：完整 parseBoundedInt 收口（空串=默认/越界钳制）+ 清草稿。 */
  function numBlur(
    key: string,
    rule: { readonly fallback: number; readonly min: number; readonly max: number },
    raw: string,
  ): void {
    setNumDrafts((d) => {
      if (!(key in d)) return d;
      const next = { ...d };
      delete next[key];
      return next;
    });
    const parsed = parseBoundedInt(raw, rule.fallback, rule.min, rule.max);
    // P3-7：越界钳制不再静默——原始输入是合法整数但被改写时给一次性提示
    // （空串/非数字回落默认是「未指定」既定语义，不算钳制，不打扰）。
    const trimmed = raw.trim();
    if (trimmed !== '') {
      const n = Number.parseInt(trimmed, 10);
      if (Number.isFinite(n) && n !== parsed) reportClamp(key, parsed);
    }
    set(key, parsed);
  }
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

  // P3-10：配置加载抽成可重入函数——挂载时跑一次，loadError 错误行提供
  // 「重试」钮（对齐 History/Apps/日志区的错误+重试口径）。
  function loadConfig(): void {
    Promise.all([window.electronAPI.getConfig(), window.electronAPI.getLocalIPs()])
      .then(([cfg, ips]) => {
        setForm(cfg);
        setSavedForm(cfg);
        setAllowedAppsText(listText(cfg.agentAllowedApps));
        setAllowedDomainsText(listText(cfg.agentAllowedDomains));
        setLocalIPs(ips);
        setLoaded(true);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        // NETOPT-7⑤（2026-09-20）：getConfig() 走主进程 configStore.getAllMasked——
        // 配置文件损坏/schema 校验抛错/token 解密异常时该 IPC reject。原实现无
        // .catch：loaded 恒 false → 整页永久「加载中...」+ unhandled rejection，
        // 用户既进不了设置页也不知道原因。对齐 EXP-04 修法（StatusWindow.tsx
        // getStatus() 同源缺陷的先例）：脱离加载态，把原因呈现在页内错误行。
        setLoadError(t('cfg.error.loadError', ipcErrorMessage(err)));
        setLoaded(true);
      });
    // 旧版 preload 可能未暴露 autolaunch 通道——容错降级为隐藏开关
    if (typeof window.electronAPI.getAutoLaunch === 'function') {
      window.electronAPI.getAutoLaunch().then(setAutoLaunch).catch(() => undefined);
    }
  }

  useEffect(() => {
    loadConfig();
    // 仅挂载时执行（P3-10 的重试走 loadConfig 按钮，不重挂 effect）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // P1-1：向导保存落盘后主进程广播 config:changed → 重取配置并合并。
  // 合并语义（config-merge.ts）：基线整体采用磁盘新值；用户改过的字段保留
  // 草稿（改动清单继续如实呈现），没改过的字段随磁盘刷新——既不丢用户
  // 未提交的修改，也让「保存配置」不再以陈旧基线整表回写、覆盖向导新值。
  const formRef = useRef(form);
  formRef.current = form;
  const savedFormRef = useRef(savedForm);
  savedFormRef.current = savedForm;
  // 合并结果的一次性提示（6s 消退，同 checkMsg 纪律）：磁盘更新了 N 项 +
  // 有用户草稿被保留时如实提示，差异可见。
  const [externalSyncMsg, setExternalSyncMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!externalSyncMsg) return;
    const timer = setTimeout(() => setExternalSyncMsg(null), 6000);
    return () => clearTimeout(timer);
  }, [externalSyncMsg]);

  useEffect(() => {
    const electronAPI = (window as unknown as {
      electronAPI?: { onConfigChanged?: (cb: () => void) => () => void; getConfig?: () => Promise<Record<string, unknown>> };
    }).electronAPI;
    // 旧版 preload 缺通道时降级为既有行为（不合并——旧行为，不影响其余功能）
    if (typeof electronAPI?.onConfigChanged !== 'function' || typeof electronAPI.getConfig !== 'function') return;
    const offConfigChanged = electronAPI.onConfigChanged(() => {
      electronAPI.getConfig()!
        .then((disk) => {
          const currentForm = formRef.current;
          const currentSaved = savedFormRef.current;
          const merged = mergeConfigWithDisk({ savedForm: currentSaved, form: currentForm, disk });
          setForm(merged.form);
          setSavedForm(merged.savedForm);
          // textarea 草稿是独立 state：字段未被用户编辑时随磁盘刷新；编辑过
          // 则保留（与 merge 的字段级语义一致）。
          const appsEdited = !sameConfigValue(currentForm.agentAllowedApps, currentSaved.agentAllowedApps);
          const domainsEdited = !sameConfigValue(currentForm.agentAllowedDomains, currentSaved.agentAllowedDomains);
          if (!appsEdited) setAllowedAppsText(listText(merged.form.agentAllowedApps));
          if (!domainsEdited) setAllowedDomainsText(listText(merged.form.agentAllowedDomains));
          if (merged.updatedKeys.length > 0) {
            setExternalSyncMsg(
              merged.preservedKeys.length > 0
                ? t('cfg.sync.mergedWithDraft', merged.updatedKeys.length)
                : t('cfg.sync.updated', merged.updatedKeys.length),
            );
          }
        })
        .catch(() => {
          // 重取失败：保持既有表单（磁盘可能只是瞬时不可读），不打断编辑。
        });
    });
    return () => offConfigChanged();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        if (!cancelled) setPyEnvError(ipcErrorMessage(err));
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
    // 用户重新编辑即清掉该字段上一次的失焦校验提示（不再持续报旧错）。
    setFieldErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  function setFieldError(key: string, message: string): void {
    setFieldErrors((prev) => (prev[key] === message ? prev : { ...prev, [key]: message }));
  }

  function clearFieldError(key: string): void {
    setFieldErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  /** UI V5：Admin API 地址失焦校验（只认 http/https；空值不报「非法」）。 */
  function validateAdminApiUrl(raw: string): void {
    if (raw.trim() !== '' && !/^https?:\/\//i.test(raw.trim())) {
      setFieldError('adminApiUrl', t('cfgx.validation.url'));
    } else {
      clearFieldError('adminApiUrl');
    }
  }

  /** UI V5：必填项失焦校验（密钥 / 执行器名称）。 */
  function validateRequired(key: string, raw: string): void {
    if (raw.trim() === '') setFieldError(key, t('cfgx.validation.required'));
    else clearFieldError(key);
  }

  /** UI V5：端口区间校验——与保存路径的 1–65535 钳制同口径，但不阻断。 */
  function validatePortRange(raw: string): void {
    const trimmed = raw.trim();
    if (trimmed === '') {
      clearFieldError('executorPort');
      return;
    }
    const n = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(n) || n < 1 || n > 65535) {
      setFieldError('executorPort', t('cfgx.validation.port'));
    } else {
      clearFieldError('executorPort');
    }
  }

  /** UI V5：Agent 域名白名单逐条校验（逗号/换行分隔，空列表不算错）。 */
  function validateDomainList(raw: string): void {
    const entries = parseListText(raw);
    if (entries.some((entry) => entry.length > 253 || !DOMAIN_RE.test(entry))) {
      setFieldError('agentAllowedDomains', t('cfgx.validation.domain'));
    } else {
      clearFieldError('agentAllowedDomains');
    }
  }

  // 搜索命中字段后：分区已切过去，下一帧把目标行滚到视野中央。
  useEffect(() => {
    if (!pendingField) return;
    const field = pendingField;
    setPendingField(null);
    const target = document.querySelector(`[data-cfgx-field="${field}"]`);
    if (target instanceof HTMLElement) {
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [pendingField, active]);

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
        // i18n-DESK-01：界面语言**不是热切换**的（渲染层文案在模块作用域求值，
        // 只求值一次）——语言真的变了就重载本窗口，重载即用新语言重新跑一遍启动
        // 流程。重载后「已保存」提示自然消失：界面本身已是新语言，无需再提示。
        if (languageChangeReloadsUi(savedForm.uiLanguage, form.uiLanguage)) {
          window.location.reload();
          return;
        }
      }
    } catch (err) {
      // D 修正：原实现未包 try——saveConfig reject 会让 saving 永久为 true，
      // 「保存配置」按钮永久禁用且用户完全无感知，只能重启应用。
      setSaveError(t('cfg.error.saveFailed', ipcErrorMessage(err)));
    } finally {
      setSaving(false);
    }
  }

  async function requestSave() {
    if (!isDirty || saving || checkingSaveImpact) return;
    // 仅重载渲染层/热同步主进程的字段（语言、日志级别、通知、Agent 档位等）
    // 不需要动执行器。此前只要执行器在跑就一律弹"保存会立即重启执行器"，
    // 与本进程真实的 finalizeConfigSave 判据不一致，属于虚惊。
    const needsRestart = restartRequiredFieldsDiffer(savedForm, form);
    setSaveImpact(null);
    if (!needsRestart) {
      await save();
      return;
    }
    setCheckingSaveImpact(true);
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

  // UI V5：Ctrl/Cmd+S 走既有 requestSave（未保存时才动作）；Alt+1..5 切分区。
  // requestSave 每次渲染都会重建，用 ref 取最新闭包，监听只挂一次。
  const requestSaveRef = useRef(requestSave);
  requestSaveRef.current = requestSave;
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      const modifier = e.ctrlKey || e.metaKey;
      if (modifier && !e.altKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        if (isDirty) void requestSaveRef.current();
        return;
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && /^[1-5]$/.test(e.key)) {
        e.preventDefault();
        setActive(SECTIONS[Number(e.key) - 1].id);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isDirty]);

  async function test() {
    setTesting(true); setTestResult(null); setTestLatency(null);
    const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    try {
      const r = await window.electronAPI.testConnection(String(form.adminApiUrl || ''));
      setTestResult(r);
      if (r.ok) {
        const finishedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
        setTestLatency(Math.max(0, Math.round(finishedAt - startedAt)));
      }
    } catch (err) {
      setTestResult({ ok: false, message: ipcErrorMessage(err) });
    } finally {
      setTesting(false);
    }
  }

  // V4-4（X-02）：放弃修改——回滚到最近一次保存的值。allowedApps/Domains 的
  // textarea 草稿是独立 state，必须一并回滚；数值输入的键入草稿（F-34）与
  // 连接测试结果随 URL 回滚失效。
  function discardChanges() {
    setForm(savedForm);
    setAllowedAppsText(listText(savedForm.agentAllowedApps));
    setAllowedDomainsText(listText(savedForm.agentAllowedDomains));
    setNumDrafts({});
    setTestResult(null);
    setShowDiff(false);
    setSaveError(null);
  }

  // DSK-05：手动检查更新。开发模式（未打包）主进程 updater 未初始化，
  // checkForUpdates 静默返回——因此提示文案刻意不承诺"有新版本"。
  // F-38（UIUX 审计）：6s 自动清除的 setTimeout 此前不随卸载清理——切走/
  // 卸载后仍会对已卸载组件 setState。句柄入 ref，重挂前清旧 + 卸载清尾。
  const checkMsgTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (checkMsgTimerRef.current !== null) clearTimeout(checkMsgTimerRef.current);
  }, []);
  async function checkUpdate() {
    setChecking(true); setCheckMsg(null);
    try {
      const r = await window.electronAPI.checkForUpdate();
      // A-3：主进程在「当前安装形态不支持自更新」时回 ok:false + 稳定哨兵
      // （deb/rpm 等非 AppImage 安装：electron-updater 直接 resolve(null)、
      // 不发任何事件）。此时必须改说"用包管理器升级"，否则界面只闪一句
      // 「已发起检查」，用户永远等不到结果。
      setCheckMsg(
        r && r.ok === false
          ? r.error === 'UPDATER_UNSUPPORTED_INSTALL'
            ? t('cfg.gen.updateUnsupportedInstall')
            : (r.error || t('cfg.gen.checkInitiated'))
          : t('cfg.gen.checkInitiated'),
      );
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
  async function exportConfig() {
    if (ioBusy !== null) return;
    setIoBusy('export');
    setIoMsg(null);
    try {
      const r = await window.electronAPI.exportConfig();
      if (r.canceled) return;
      if (!r || r.ok !== true) {
        // 主进程写文件失败的 error 已是人话，原样呈现；缺失时退回通用文案。
        setIoMsg({ kind: 'err', text: r?.error ?? t('cfg.io.exportFailed') });
      } else {
        setIoMsg({ kind: 'ok', text: t('cfg.io.exportDone', r.path ?? '') });
      }
    } catch (err) {
      setIoMsg({ kind: 'err', text: ipcErrorMessage(err) });
    } finally {
      setIoBusy(null);
    }
  }

  async function importConfig() {
    if (ioBusy !== null) return;
    setIoBusy('import');
    setIoMsg(null);
    try {
      const r = await window.electronAPI.importConfig();
      if (r.canceled) return;
      if (!r || r.ok !== true) {
        // 坏 JSON / 消毒拒绝 / 载荷被主进程拒绝——主进程的 error 原样带出
        //（它已是人话），没有 error 时退回通用失败文案。
        setIoMsg({ kind: 'err', text: r?.error ? t('cfg.io.importFailed', r.error) : t('cfg.error.saveRejected') });
        return;
      }
      // 成功后刷新渲染层配置态：重读掩码配置并复位表单与草稿（allowedApps/
      // Domains 的 textarea 草稿是独立 state，必须一并复位）。重读失败不
      // 掩盖导入成功——落盘已生效，只提示导入完成。
      try {
        const cfg = await window.electronAPI.getConfig();
        setForm(cfg);
        setSavedForm(cfg);
        setAllowedAppsText(listText(cfg.agentAllowedApps));
        setAllowedDomainsText(listText(cfg.agentAllowedDomains));
        setTestResult(null);
        // i18n-DESK-01：备份文件里可能带着另一种界面语言——导入后同样需要重载
        // 才能生效（同 save() 的口径），否则用户看到"导入成功"但界面没变。
        if (languageChangeReloadsUi(savedForm.uiLanguage, cfg.uiLanguage)) {
          window.location.reload();
          return;
        }
      } catch {
        /* 掩码配置重读失败：保持既有显示，导入结果照常呈现 */
      }
      // 导入可能改了 uv 组——诊断块反映的是已保存配置，立即重取（EXP-06 同语义）。
      refreshPyEnv();
      if (r.reloadError) {
        // 与 save() 同款如实呈现：配置已落盘，但执行器热重载失败（停止态）。
        setIoMsg({ kind: 'err', text: t('cfg.error.reloadFailed', r.reloadError) });
      } else {
        setIoMsg({ kind: 'ok', text: t('cfg.io.importDone') });
      }
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
  async function exportDiagnostics() {
    if (diagBusy) return;
    setDiagBusy(true);
    setDiagMsg(null);
    try {
      const r = await window.electronAPI.exportDiagnosticReport?.();
      if (!r || r.canceled) return;
      if (r.ok !== true) {
        setDiagMsg({ kind: 'err', text: t('cfg.io.diagnosticFailed', r.error ?? '') });
      } else {
        setDiagMsg({ kind: 'ok', text: t('cfg.io.diagnosticDone', r.path ?? '') });
      }
    } catch (err) {
      setDiagMsg({ kind: 'err', text: t('cfg.io.diagnosticFailed', ipcErrorMessage(err)) });
    } finally {
      setDiagBusy(false);
    }
  }

  // ── UI V5：设置搜索 / 「当前生效」派生数据 ─────────────────────────
  // 搜索范围 = 分区名 + 该分区字段名（标签走既有双语表）。空词不显示结果。
  const fieldLabelKey = (key: string): string =>
    FIELD_LABEL_KEYS.find(([fieldKey]) => fieldKey === key)?.[1] ?? key;
  const searchTerm = searchQuery.trim().toLowerCase();
  const searchResults: { kind: 'section' | 'field'; id: string; section: SectionId; label: string }[] =
    searchTerm === ''
      ? []
      : [
          ...SECTIONS
            .filter((section) => t(section.labelKey).toLowerCase().includes(searchTerm))
            .map((section) => ({
              kind: 'section' as const,
              id: section.id,
              section: section.id,
              label: t(section.labelKey),
            })),
          ...SECTIONS.flatMap((section) =>
            SECTION_KEYS[section.id]
              .filter((key) => key.toLowerCase().includes(searchTerm) || t(fieldLabelKey(key)).toLowerCase().includes(searchTerm))
              .map((key) => ({
                kind: 'field' as const,
                id: key,
                section: section.id,
                label: t(fieldLabelKey(key)),
              })),
          ),
        ].slice(0, 12);

  function pickSearchResult(result: { kind: 'section' | 'field'; id: string; section: SectionId }): void {
    setActive(result.section);
    setSearchQuery('');
    if (result.kind === 'field') setPendingField(result.id);
  }

  function agentValueLabel(value: unknown, fallback = ''): string {
    const raw = String(value ?? '') || fallback;
    const key = AGENT_VALUE_LABEL_KEYS[raw];
    return key ? t(key) : raw;
  }

  // 「当前生效」里的重启提示：只看连接/网络/并发（与 save 的真实重启判据
  // 解耦——这里是设置台的状态提示，不改变保存行为）。
  const effectiveRestartDirty = [...SECTION_KEYS.connection, ...SECTION_KEYS.network]
    .some((key) => !sameConfigValue(form[key], savedForm[key]));

  const renderEffective = () => (
    <div className="cfgx-effective">
      <div className="cfgx-effective-title">
        <Icon name="activity" className="icon-xs" /> {t('cfgx.effective.title')}
      </div>
      <div className={`cfgx-effective-status ${testResult ? (testResult.ok ? 'is-ok' : 'is-fail') : 'is-idle'}`} role="status">
        <Icon name={testResult ? (testResult.ok ? 'check' : 'close') : 'clock'} className="icon-xs" />
        <span>
          {testResult
            ? (testResult.ok ? t('cfgx.status.connected') : t('cfgx.status.failed'))
            : t('cfgx.status.untested')}
        </span>
        {testResult?.ok && testLatency !== null && (
          <span className="cfgx-effective-latency">{t('cfgx.status.latency', testLatency)}</span>
        )}
      </div>
      {testResult && !testResult.ok && testResult.message && (
        <div className="cfgx-effective-msg">{testResult.message}</div>
      )}
      <dl className="cfgx-effective-list">
        <div className="cfgx-effective-item">
          <dt>{t('cfgx.effective.platform')}</dt>
          <dd>{String(savedForm.adminApiUrl || '—')}</dd>
        </div>
        <div className="cfgx-effective-item">
          <dt>{t('cfgx.effective.public')}</dt>
          <dd>{String(savedForm.executorAddressPublic || '—')}</dd>
        </div>
        <div className="cfgx-effective-item">
          <dt>{t('cfgx.effective.concurrency')}</dt>
          <dd>{displayNumber(savedForm.maxConcurrentTasks, MAX_CONCURRENT_TASKS.fallback)}</dd>
        </div>
        <div className="cfgx-effective-item">
          <dt>{t('cfgx.effective.agent')}</dt>
          <dd>{agentValueLabel(savedForm.agentPermissionProfile, 'minimal')}</dd>
        </div>
      </dl>
      {isDirty && effectiveRestartDirty && (
        <div className="cfgx-effective-restart">
          <Icon name="warning" className="icon-xs" /> {t('cfgx.effective.restart')}
        </div>
      )}
    </div>
  );

  if (!loaded) return (
    <div className="page-loading">{t('cfg.common.loading')}</div>
  );

  // UX-DSK-NUM：端口/并发数等数值一律走 displayNumber —— 状态里若残留 NaN/null
  // （旧配置或 IPC 脏值），显示与保存必须指向同一个值。
  const port = displayNumber(form.executorPort, EXECUTOR_PORT.fallback);

  return (
    <div className="cfg-layout">

      {/* 侧边导航：搜索 + 分组（基础 / 运行时 / 系统）。
          e2e 依赖的 cfg-nav / cfg-nav-item / cfg-nav-text / cfg-nav-label /
          cfg-nav-icon / cfg-nav-dirty 类名全部保留。 */}
      <nav className="cfg-nav">
        <div className="cfgx-search-wrap">
          <div className="cfgx-search">
            <Icon name="search" className="cfgx-search-icon icon-xs" />
            <input
              type="search"
              className="cfgx-search-input"
              value={searchQuery}
              placeholder={t('cfgx.search.placeholder')}
              aria-label={t('cfgx.search.placeholder')}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setSearchQuery('');
                  return;
                }
                if (e.key === 'Enter' && searchResults.length > 0) {
                  e.preventDefault();
                  pickSearchResult(searchResults[0]);
                }
              }}
            />
          </div>
          {searchTerm !== '' && (
            <div className="cfgx-search-results" role="listbox" aria-label={t('cfgx.search.placeholder')}>
              {searchResults.length === 0 ? (
                <div className="cfgx-search-empty">{t('cfgx.search.empty')}</div>
              ) : (
                searchResults.map((result) => (
                  <button
                    type="button"
                    key={`${result.kind}:${result.id}`}
                    className="cfgx-search-result"
                    role="option"
                    aria-selected="false"
                    onClick={() => pickSearchResult(result)}
                  >
                    <Icon name={result.kind === 'section' ? 'chevron-right' : 'pin'} className="icon-xs" />
                    <span className="cfgx-search-result-label">{result.label}</span>
                    {result.kind === 'field' && (
                      <span className="cfgx-search-result-section">
                        {t(SECTIONS.find((section) => section.id === result.section)?.labelKey ?? '')}
                      </span>
                    )}
                  </button>
                ))
              )}
            </div>
          )}
        </div>
        {NAV_GROUPS.map((group) => (
          <div className="cfgx-nav-group" key={group.labelKey}>
            <div className="cfgx-nav-group-title">{t(group.labelKey)}</div>
            {group.sections.map((id) => {
              const section = SECTIONS.find((entry) => entry.id === id);
              if (!section) return null;
              return (
                <button
                  key={section.id}
                  className={`cfg-nav-item${active === section.id ? ' active' : ''}`}
                  onClick={() => setActive(section.id)}
                >
                  <span className="cfg-nav-icon"><Icon name={section.icon} /></span>
                  <span className="cfg-nav-text">
                    <span className="cfg-nav-label">
                      {t(section.labelKey)}
                      {dirtySections.has(section.id) && (
                        <span
                          className="cfg-nav-dirty"
                          title={t('cfg.common.unsavedDotTitle')}
                          aria-label={t('cfg.common.unsavedDotAria')}
                        />
                      )}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
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
            <div className="cfg-save-error" role="alert">
              <Icon name="warning" className="icon-xs" /> {loadError}
              {/* P3-10：读取失败给重试入口（对齐 History/Apps/日志区口径）——
                  此前只能重启应用来重载窗口。 */}
              <button type="button" className="btn btn-sm" onClick={() => loadConfig()}>{t('ui.retry')}</button>
            </div>
          )}
          {/* P1-1：向导改写配置后表单基线已随磁盘刷新的一次性提示（差异可见：
              更新字段数 + 是否有用户草稿被保留）。 */}
          {externalSyncMsg && <div className="cfg-unsaved" role="status"><span aria-hidden="true" />{externalSyncMsg}</div>}

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
              <div className="cfgx-panel">
                <div className="cfgx-group">
                  <div className="cfgx-group-title">{t('cfg.conn.groupPlatform')}</div>
                  <SettingRow
                    label={t('cfg.conn.adminApiLabel')}
                    field="adminApiUrl"
                    error={fieldErrors.adminApiUrl}
                    hint={t('cfg.conn.adminApiHint')}
                  >
                    <div className="cfgx-inline">
                      <input aria-label={t('cfg.conn.adminApiLabel')} className="input" placeholder="http://192.168.1.10:3001"
                        value={String(form.adminApiUrl || '')}
                        onChange={(e) => set('adminApiUrl', e.target.value)}
                        onBlur={(e) => validateAdminApiUrl(e.target.value)} />
                      <button className="btn cfg-test-button" onClick={test} disabled={testing}>
                        {testing ? <><Icon name="refresh" className="icon-spin" /> {t('cfg.conn.testing')}</> : <><Icon name="zap" /> {t('cfg.conn.test')}</>}
                      </button>
                    </div>
                    {testResult && (
                      <div className={`test-result ${testResult.ok ? 'ok' : 'fail'}`}>
                        <Icon name={testResult.ok ? 'check' : 'close'} className="icon-xs" /> {testResult.message}
                      </div>
                    )}
                  </SettingRow>
                </div>

                {/* B-03：executorName / maxConcurrentTasks 自原「基本设置」迁入——
                    与密钥同属「装好后一次性填好的执行器自身属性」，页头即「连接与身份」；
                    原「身份与并发」组随字段迁走，组标题沿用此处（键值改「身份与并发」）。 */}
                <div className="cfgx-group">
                  <div className="cfgx-group-title">{t('cfg.conn.groupIdentity')}</div>
                  <SettingRow
                    label={t('cfg.conn.tokenLabel')}
                    field="executorToken"
                    error={fieldErrors.executorToken}
                    hint={t('cfg.conn.tokenHint')}
                  >
                    <input aria-label={t('cfg.conn.tokenLabel')} className="input" type="password" placeholder={t('cfg.conn.tokenPlaceholder')}
                      value={String(form.executorToken || '')}
                      onChange={(e) => set('executorToken', e.target.value)}
                      onBlur={(e) => validateRequired('executorToken', e.target.value)} />
                  </SettingRow>

                  <div className="cfgx-row-pair">
                    <SettingRow
                      label={t('cfg.gen.nameLabel')}
                      field="executorName"
                      error={fieldErrors.executorName}
                      hint={t('cfg.gen.nameHint')}
                      compact
                    >
                      <input aria-label={t('cfg.gen.nameLabel')} className="input" placeholder="my-executor-1"
                        value={String(form.executorName || '')}
                        onChange={(e) => set('executorName', e.target.value)}
                        onBlur={(e) => validateRequired('executorName', e.target.value)} />
                    </SettingRow>

                    <SettingRow
                      label={t('cfg.gen.maxTasksLabel')}
                      field="maxConcurrentTasks"
                      hint={clampNotice.maxConcurrentTasks
                        ? <span role="status">{t('cfg.error.clamped', clampNotice.maxConcurrentTasks)}</span>
                        : t('cfg.gen.maxTasksHint')}
                      compact
                    >
                      {/* UX-DSK-NUM：原实现 `parseInt(e.target.value, 10)` 无兜底——
                          清空输入框得到 NaN，显示层 `Number(form.x || 10)` 仍渲染 10，
                          于是"界面显示 10、实际保存 NaN"。NaN 经 IPC 序列化为 null，
                          主进程写入时撞 electron-store 的 schema 校验整次抛出。
                          这里与保存路径同源：留空 = 回落默认 10，越界钳到 1–100。
                          F-34：夹紧时机后移到 blur——键入过程显示草稿原样串
                          （含空串），不再清空即回填默认。 */}
                      <input aria-label={t('cfg.gen.maxTasksLabel')} className="input" type="number" min={1} max={100}
                        value={numValue('maxConcurrentTasks', form.maxConcurrentTasks, MAX_CONCURRENT_TASKS.fallback)}
                        onChange={(e) => numChange('maxConcurrentTasks', MAX_CONCURRENT_TASKS, e.target.value)}
                        onBlur={(e) => numBlur('maxConcurrentTasks', MAX_CONCURRENT_TASKS, e.target.value)} />
                    </SettingRow>
                  </div>
                </div>
              </div>
              </div>

              <aside className="cfg-aside">
                {renderEffective()}
                {/* G-01 同源引导：首次配置的三步路标（宽屏右栏/窄屏文末）。
                    UI V5 审计：默认收起为一行 summary，避免与「当前生效」抢首屏；
                    内容（三步 + 重跑向导）完整保留，展开即可见。 */}
                <details className="cfg-guide-card cfgx-guide">
                  <summary className="cfgx-guide-summary">
                    <Icon name="bulb" className="icon-xs" /> {t('cfg.conn.guideTitle')}
                  </summary>
                  <ol className="cfg-guide-steps">
                    <li>{t('cfg.conn.guideStep1')}</li>
                    <li>{t('cfg.conn.guideStep2')}</li>
                    <li>{t('cfg.conn.guideStep3')}</li>
                  </ol>
                  {/* 重新运行初始化向导（2026-10-13 用户需求）：已配置过的机器
                      也能再走一遍引导。向导表单预填当前配置、未保存前关闭不
                      改动任何配置；保存走既有 save-and-close-wizard 链路。
                      旧版 preload 缺通道时隐藏（EXP-09 容错口径）。 */}
                  {typeof window.electronAPI.openWizard === 'function' && (
                    <button
                      type="button"
                      className="btn btn-sm cfg-guide-rerun"
                      onClick={() => { void window.electronAPI.openWizard?.(); }}
                    >
                      <Icon name="refresh" className="icon-xs" /> {t('cfg.conn.rerunWizard')}
                    </button>
                  )}
                </details>
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
              <div className="cfgx-panel">
                <div className="cfgx-group">
                  <div className="cfgx-group-title">{t('cfg.net.groupListen')}</div>
                  <div className="cfgx-row-pair">
                    <SettingRow
                      label={t('cfg.net.hostLabel')}
                      field="executorHost"
                      hint={t('cfg.net.hostHint')}
                      compact
                    >
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
                    </SettingRow>
                    <SettingRow
                      label={t('cfg.net.portLabel')}
                      field="executorPort"
                      error={fieldErrors.executorPort}
                      hint={clampNotice.executorPort
                        ? <span role="status">{t('cfg.error.clamped', clampNotice.executorPort)}</span>
                        : null}
                      compact
                    >
                      {/* 与「最大并发任务数」同源缺陷：清空输入框 → NaN → 显示 8002
                          却保存 null。留空回落默认端口；失焦时把 1–65535 之外的值
                          钳回（HTML min/max 不阻止手输/粘贴）。F-34：夹紧时机后移
                          到 blur——键入过程显示草稿原样串（含空串），不再清空即
                          回填默认；显示层仍走 numValue（脏值回落默认）。 */}
                      <input aria-label={t('cfg.net.portLabel')} className="input" type="number" min={1} max={65535} value={numValue('executorPort', form.executorPort, EXECUTOR_PORT.fallback)}
                        onChange={(e) => numChange('executorPort', EXECUTOR_PORT, e.target.value)}
                        onBlur={(e) => { validatePortRange(e.target.value); numBlur('executorPort', EXECUTOR_PORT, e.target.value); }} />
                    </SettingRow>
                  </div>
                </div>

                <div className="cfgx-group">
                  <div className="cfgx-group-title">{t('cfg.net.groupPublic')}</div>
                  <SettingRow
                    label={t('cfg.net.publicLabel')}
                    field="executorAddressPublic"
                    hint={t('cfg.net.publicHint')}
                  >
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
                        // 留空时用第一块**可对外注册**的网卡兜底（而不是让
                        // 0.0.0.0 流到注册请求）。P3-5：与向导 D-04 同源判定
                        // （network-address.ts）——链路本地（169.254.*）与回环
                        // （127.*）不能作为对外地址，此前取 localIPs[0] 会把
                        // 这类地址填出去（与向导口径漂移）。无可推荐地址时
                        // 保留空串（用户手填），不静默填一个不可达值。
                        if (!e.target.value.trim()) {
                          const recommended = pickRecommendedIp(localIPs);
                          if (recommended) set('executorAddressPublic', `${recommended}:${port}`);
                        }
                      }} />
                  </SettingRow>

                  {localIPs.length > 0 && (
                    <SettingRow
                      label={t('cfg.net.ipPickerLabel')}
                      field="executorAddressPublicPicker"
                    >
                      <div className="ip-picker">
                        {/* P3-5：与失焦自动填充同源——链路本地/回环地址不进
                            快速选择（注册到中台后不可达），同 pickRecommendedIp */}
                        {localIPs.filter((ip) => !ip.startsWith('169.254.') && !ip.startsWith('127.')).map((ip) => {
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
                    </SettingRow>
                  )}

                  {/* ARCH-33（ADR-016）：pull 回连模式。
                      桌面端的典型部署是「公网中台 + 内网办公机」，而办公机在 NAT 后
                      根本没有可填的公网地址——push 模式下 admin 每次拨入都超时
                      （生产实证 "Failed to reach executor after 3 attempts"）。
                      回连模式由执行器主动长轮询，中台无需反向连入。 */}
                  <SettingRow
                    label={t('cfg.net.pullTitle')}
                    field="pullMode"
                    hint={t('cfg.net.pullDesc')}
                  >
                    <Toggle id="pullMode" label={t('cfg.net.pullToggleLabel')} checked={form.pullMode === true}
                      onChange={(v) => set('pullMode', v)} />
                  </SettingRow>
                </div>
              </div>
              </div>

              <aside className="cfg-aside">
                {renderEffective()}
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
              <div className="cfgx-panel">
                <div className="cfgx-group">
                  <div className="cfgx-group-title">{t('cfg.py.groupSource')}</div>
                  <SettingRow
                    label={t('cfg.py.uvPathLabel')}
                    field="uvPath"
                    hint={<HintDetails label={t('cfg.details.label')}>{t('cfg.py.uvPathHint')}</HintDetails>}
                  >
                    <input aria-label={t('cfg.py.uvPathLabel')} className="input" placeholder={t('cfg.py.uvPathPlaceholder')}
                      value={String(form.uvPath || '')}
                      onChange={(e) => set('uvPath', e.target.value)} />
                  </SettingRow>

                  <SettingRow
                    label={t('cfg.py.mirrorLabel')}
                    field="uvPythonInstallMirror"
                    hint={<HintDetails label={t('cfg.details.label')}>{t('cfg.py.mirrorHint')}</HintDetails>}
                  >
                    <input aria-label={t('cfg.py.mirrorLabel')} className="input" placeholder={t('cfg.py.mirrorPlaceholder')}
                      value={String(form.uvPythonInstallMirror || '')}
                      onChange={(e) => set('uvPythonInstallMirror', e.target.value)} />
                  </SettingRow>

                  <SettingRow
                    label={t('cfg.py.poolDirLabel')}
                    field="uvPythonInstallDir"
                    hint={<HintDetails label={t('cfg.details.label')}>{t('cfg.py.poolDirHint')}</HintDetails>}
                  >
                    <input aria-label={t('cfg.py.poolDirLabel')} className="input" placeholder={t('cfg.py.poolDirPlaceholder')}
                      value={String(form.uvPythonInstallDir || '')}
                      onChange={(e) => set('uvPythonInstallDir', e.target.value)} />
                  </SettingRow>

                  <SettingRow
                    label={t('cfg.py.pypiLabel')}
                    field="pypiRegistryUrl"
                    hint={<HintDetails label={t('cfg.details.label')}>{t('cfg.py.pypiHint')}</HintDetails>}
                  >
                    <input aria-label={t('cfg.py.pypiLabel')} className="input" placeholder={t('cfg.py.pypiPlaceholder')}
                      value={String(form.pypiRegistryUrl || '')}
                      onChange={(e) => set('pypiRegistryUrl', e.target.value)} />
                  </SettingRow>

                  <SettingRow
                    label={t('cfg.py.timeoutLabel')}
                    field="interpreterDownloadTimeoutMs"
                    hint={clampNotice.interpreterDownloadTimeoutMs
                      ? <span role="status">{t('cfg.error.clamped', clampNotice.interpreterDownloadTimeoutMs)}</span>
                      : t('cfg.py.timeoutHint')}
                  >
                    <input aria-label={t('cfg.py.timeoutLabel')} className="input" type="number" min={0}
                      value={numValue('interpreterDownloadTimeoutMs', form.interpreterDownloadTimeoutMs, DOWNLOAD_TIMEOUT_MS.fallback)}
                      onChange={(e) => numChange('interpreterDownloadTimeoutMs', DOWNLOAD_TIMEOUT_MS, e.target.value)}
                      onBlur={(e) => numBlur('interpreterDownloadTimeoutMs', DOWNLOAD_TIMEOUT_MS, e.target.value)} />
                  </SettingRow>
                </div>
              </div>
              </div>

              <aside className="cfg-aside">
                {/* 诊断块：显示**已保存配置**下实际生效的 uv / 池。这是排查
                    "配置了却没生效"最快的一手信息（uvPath 指错、自带 uv 缺失、
                    池被配到工作目录等）。 */}
                <div className="cfgx-aside-title">
                  <Icon name="terminal" className="icon-xs" /> {t('cfgx.python.statusTitle')}
                </div>
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
                <button
                  type="button"
                  className="btn btn-sm cfgx-aside-action"
                  onClick={() => { void refreshPyEnv(); }}
                  disabled={typeof window.electronAPI.getPythonEnvStatus !== 'function'}
                >
                  <Icon name="refresh" className="icon-xs" /> {t('cfgx.python.redetect')}
                </button>

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
              <div className="cfgx-panel">
                <div className="cfgx-group">
                  <div className="cfgx-group-title">{t('cfg.agent.title')}</div>
                  <SettingRow
                    label={t('cfg.agent.enableTitle')}
                    field="agentEnabled"
                    hint={t('cfg.agent.enableDesc')}
                  >
                    <Toggle id="agentEnabled" label={t('cfg.agent.enableTitle')} checked={form.agentEnabled === true}
                      onChange={(v) => set('agentEnabled', v)} />
                  </SettingRow>
                </div>

                <div className="cfgx-group">
                  <div className="cfgx-group-title">{t('cfg.agent.groupPerms')}</div>
                  <SettingRow
                    label={t('cfg.agent.profileLabel')}
                    field="agentPermissionProfile"
                    hint={<HintDetails label={t('cfg.details.label')}>{t('cfg.agent.profileHint')}</HintDetails>}
                  >
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
                  </SettingRow>

                  <SettingRow
                    label={t('cfg.agent.codeExecLabel')}
                    field="agentCodeExecution"
                    hint={<HintDetails label={t('cfg.details.label')}>{t('cfg.agent.codeExecHint')}</HintDetails>}
                  >
                    <select aria-label={t('cfg.agent.codeExecLabel')} className="input"
                      value={String(form.agentCodeExecution || '')}
                      onChange={(e) => set('agentCodeExecution', e.target.value)}>
                      <option value="">{t('cfg.agent.followPreset')}</option>
                      <option value="off">{t('cfg.agent.codeExecOff')}</option>
                      <option value="sandbox">{t('cfg.agent.codeExecSandbox')}</option>
                      <option value="host" disabled>{t('cfg.agent.codeExecHost')}</option>
                    </select>
                  </SettingRow>

                  <SettingRow
                    label={t('cfg.agent.hostAccessLabel')}
                    field="agentHostAccess"
                    hint={<HintDetails label={t('cfg.details.label')}>{t('cfg.agent.hostAccessHint')}</HintDetails>}
                  >
                    <select aria-label={t('cfg.agent.hostAccessLabel')} className="input"
                      value={String(form.agentHostAccess || '')}
                      onChange={(e) => set('agentHostAccess', e.target.value)}>
                      <option value="">{t('cfg.agent.hostFollowPreset')}</option>
                      <option value="none">{t('cfg.agent.hostNone')}</option>
                      <option value="app-scoped">{t('cfg.agent.hostScoped')}</option>
                      <option value="session" disabled>{t('cfg.agent.hostSession')}</option>
                    </select>
                  </SettingRow>

                  <SettingRow
                    label={t('cfg.agent.taskExecLabel')}
                    field="agentTaskExecution"
                    hint={<HintDetails label={t('cfg.details.label')}>{t('cfg.agent.taskExecHint')}</HintDetails>}
                  >
                    {/* P7e 前半：isolated-runner 已实现（08 §2.4 方案 A 的独立执行端点）。
                        中台上限 standard 时仍被钳回 deploy-only——与 GUI 同款集中管控。 */}
                    <select aria-label={t('cfg.agent.taskExecLabel')} className="input"
                      value={String(form.agentTaskExecution || '')}
                      onChange={(e) => set('agentTaskExecution', e.target.value)}>
                      <option value="">{t('cfg.agent.taskFollowPreset')}</option>
                      <option value="deploy-only">{t('cfg.agent.taskDeployOnly')}</option>
                      <option value="isolated-runner">{t('cfg.agent.taskIsolated')}</option>
                    </select>
                  </SettingRow>
                </div>

                <div className="cfgx-group">
                  <div className="cfgx-group-title">{t('cfg.agent.groupAllow')}</div>
                  <SettingRow
                    label={<>{t('cfg.agent.appsLabel')}<span className="cfg-label-count">{t('cfg.agent.itemsCount', Array.isArray(form.agentAllowedApps) ? form.agentAllowedApps.length : 0)}</span></>}
                    field="agentAllowedApps"
                    hint={<HintDetails label={t('cfg.details.label')}>{t('cfg.agent.appsHint')}</HintDetails>}
                  >
                    <textarea aria-label={t('cfg.agent.appsLabel')} className="input cfg-list-input" rows={6}
                      placeholder={'notepad\nexcel'}
                      value={allowedAppsText}
                      onChange={(e) => {
                        setAllowedAppsText(e.target.value);
                        set('agentAllowedApps', parseListText(e.target.value));
                      }} />
                  </SettingRow>

                  <SettingRow
                    label={<>{t('cfg.agent.domainsLabel')}<span className="cfg-label-count">{t('cfg.agent.itemsCount', Array.isArray(form.agentAllowedDomains) ? form.agentAllowedDomains.length : 0)}</span></>}
                    field="agentAllowedDomains"
                    error={fieldErrors.agentAllowedDomains}
                    hint={<HintDetails label={t('cfg.details.label')}>
                      {t('cfg.agent.domainsHintA')}<strong>{t('cfg.agent.domainsHintStrong')}</strong>{t('cfg.agent.domainsHintB')}
                    </HintDetails>}
                  >
                    <textarea aria-label={t('cfg.agent.domainsLabel')} className="input cfg-list-input" rows={6}
                      placeholder={'erp.corp.com\ncrm.corp.com'}
                      value={allowedDomainsText}
                      onChange={(e) => {
                        setAllowedDomainsText(e.target.value);
                        set('agentAllowedDomains', parseListText(e.target.value));
                      }}
                      onBlur={(e) => validateDomainList(e.target.value)} />
                  </SettingRow>
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

                {/* UI V5：权限生效矩阵——「本地设置」（当前草稿）与「当前生效」
                    （已保存配置）纵向排列；右栏只有 310px，三列并排会把
                    “minimal —— 什么都不做”压成三行，改成每项两行更好读。 */}
                <div className="cfgx-matrix">
                  <div className="cfgx-aside-title">
                    <Icon name="shield" className="icon-xs" /> {t('cfgx.agent.matrixTitle')}
                  </div>
                  <div className="cfgx-matrix-row">
                    <span className="cfgx-matrix-cap">{t('cfg.agent.profileLabel')}</span>
                    <span className="cfgx-matrix-values">
                      <span title={agentValueLabel(form.agentPermissionProfile, 'minimal')}>
                        <em>{t('cfgx.agent.localSetting')}</em>{String(form.agentPermissionProfile || 'minimal')}
                      </span>
                      <span title={agentValueLabel(savedForm.agentPermissionProfile, 'minimal')}>
                        <em>{t('cfgx.agent.effective')}</em>{String(savedForm.agentPermissionProfile || 'minimal')}
                      </span>
                    </span>
                  </div>
                  <div className="cfgx-matrix-row">
                    <span className="cfgx-matrix-cap">{t('cfg.agent.codeExecLabel')}</span>
                    <span className="cfgx-matrix-values">
                      <span><em>{t('cfgx.agent.localSetting')}</em>{agentValueLabel(form.agentCodeExecution)}</span>
                      <span><em>{t('cfgx.agent.effective')}</em>{agentValueLabel(savedForm.agentCodeExecution)}</span>
                    </span>
                  </div>
                  <div className="cfgx-matrix-row">
                    <span className="cfgx-matrix-cap">{t('cfg.agent.hostAccessLabel')}</span>
                    <span className="cfgx-matrix-values">
                      <span><em>{t('cfgx.agent.localSetting')}</em>{agentValueLabel(form.agentHostAccess)}</span>
                      <span><em>{t('cfgx.agent.effective')}</em>{agentValueLabel(savedForm.agentHostAccess)}</span>
                    </span>
                  </div>
                  <div className="cfgx-matrix-row">
                    <span className="cfgx-matrix-cap">{t('cfg.agent.taskExecLabel')}</span>
                    <span className="cfgx-matrix-values">
                      <span><em>{t('cfgx.agent.localSetting')}</em>{agentValueLabel(form.agentTaskExecution)}</span>
                      <span><em>{t('cfgx.agent.effective')}</em>{agentValueLabel(savedForm.agentTaskExecution)}</span>
                    </span>
                  </div>
                  <div className="cfgx-matrix-note">{t('cfgx.agent.matrixNote')}</div>
                </div>

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
              <div className="cfgx-panel">
                {/* i18n-DESK-01：界面语言（可切换，默认跟随系统）。放在「关于与更新」
                    分区的首组：它是全应用级偏好，与下方日志级别同属低频设置项。
                    三个选项 = config 键 uiLanguage 的三个合法取值。 */}
                <div className="cfgx-group">
                  <div className="cfgx-group-title">{t('cfg.gen.groupInterface')}</div>
                  <SettingRow
                    label={t('cfg.gen.uiLanguageLabel')}
                    field="uiLanguage"
                    hint={t('cfg.gen.uiLanguageHint')}
                  >
                    <select aria-label={t('cfg.gen.uiLanguageLabel')} className="input"
                      value={uiLanguageValue(form.uiLanguage)}
                      onChange={(e) => set('uiLanguage', e.target.value)}>
                      <option value="zh">{t('cfg.gen.uiLanguageZh')}</option>
                      <option value="en">{t('cfg.gen.uiLanguageEn')}</option>
                      <option value="auto">{t('cfg.gen.uiLanguageAuto')}</option>
                    </select>
                  </SettingRow>
                </div>

                <div className="cfgx-group">
                  <div className="cfgx-group-title">{t('cfg.gen.groupLog')}</div>
                  <SettingRow
                    label={t('cfg.gen.logLevelLabel')}
                    field="logLevel"
                    hint={t('cfg.gen.logHint')}
                  >
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
                  </SettingRow>
                </div>

                <div className="cfgx-group">
                  <div className="cfgx-group-title">{t('cfgx.nav.system')}</div>
                  <SettingRow
                    label={t('cfg.gen.autoRunTitle')}
                    field="autoStartExecutor"
                    hint={t('cfg.gen.autoRunDesc')}
                  >
                    <Toggle id="autoStart" label={t('cfg.gen.autoRunTitle')} checked={Boolean(form.autoStartExecutor)}
                      onChange={(v) => set('autoStartExecutor', v)} />
                  </SettingRow>

                  {/* I-04：即时生效/需保存两种契约——autolaunch 独立 IPC 即时生效，
                      界面必须标注，否则与旁边需保存的开关无从区分 */}
                  <SettingRow
                    label={<>{t('cfg.gen.autoLaunchTitle')}<span className="cfg-inline-tag">{t('cfg.gen.instantTag')}</span></>}
                    field="autoLaunch"
                    hint={t('cfg.gen.autoLaunchDesc')}
                  >
                    {typeof window.electronAPI.getAutoLaunch === 'function' ? (
                      <Toggle id="autoLaunch" label={t('cfg.gen.autoLaunchTitle')} checked={autoLaunch}
                        onChange={(v) => void toggleAutoLaunch(v)} />
                    ) : (
                      <span className="unsupported-label">{t('cfg.gen.unsupported')}</span>
                    )}
                  </SettingRow>

                  <SettingRow
                    label={t('cfg.gen.notifyTitle')}
                    field="notifyEnabled"
                    hint={t('cfg.gen.notifyDesc')}
                  >
                    <Toggle id="notifyEnabled" label={t('cfg.gen.notifyTitle')} checked={form.notifyEnabled !== false}
                      onChange={(v) => set('notifyEnabled', v)} />
                  </SettingRow>
                </div>
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

                {/* 拓展包：配置备份（导出/导入）。与「检查更新」同栏收拢的低频
                    运维项；导出走主进程 saveDialog（掩码配置，token 不落明文），
                    导入成功后由 importConfig() 重读配置刷新整页表单。 */}
                <div className="cfg-group">
                  <div className="cfg-group-title">{t('cfg.about.groupBackup')}</div>
                  <div className="cfg-field">
                    <div className="cfg-row">
                      <button
                        type="button"
                        className="btn"
                        onClick={() => void exportConfig()}
                        disabled={ioBusy !== null || !ioSupported}
                        title={!ioSupported ? t('cfg.gen.unsupported') : undefined}
                      >
                        {ioBusy === 'export'
                          ? <><Icon name="refresh" className="icon-spin" /> {t('cfg.io.exporting')}</>
                          : <><Icon name="download" /> {t('cfg.io.export')}</>}
                      </button>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => void importConfig()}
                        disabled={ioBusy !== null || !ioSupported}
                        title={!ioSupported ? t('cfg.gen.unsupported') : undefined}
                      >
                        {ioBusy === 'import'
                          ? <><Icon name="refresh" className="icon-spin" /> {t('cfg.io.importing')}</>
                          : <><Icon name="upload" /> {t('cfg.io.import')}</>}
                      </button>
                    </div>
                    <span className="cfg-hint">{t('cfg.about.backupHint')}</span>
                    {ioMsg && (
                      <div
                        className={ioMsg.kind === 'ok' ? 'test-result ok' : 'test-result fail'}
                        role={ioMsg.kind === 'ok' ? 'status' : 'alert'}
                      >
                        <Icon name={ioMsg.kind === 'ok' ? 'check' : 'warning'} className="icon-xs" /> {ioMsg.text}
                      </div>
                    )}
                  </div>
                </div>

                {/* PLAN-EXECUTOR-DESKTOP-UX 5.2：诊断报告。
                    报障的第一句话永远是「把日志发我」，但日志里没有版本、没有
                    配置、没有工作目录状态——运维得追问四五轮才能开工。这里一次
                    打包现场（脱敏配置 + 健康 + 目录可写性 + 剩余空间 + 最近日志），
                    用户点一下就能给出全部信息。 */}
                <div className="cfg-group">
                  <div className="cfg-group-title">{t('cfg.about.groupDiagnostics')}</div>
                  <div className="cfg-field">
                    {/* PLAN-EXECUTOR-DESKTOP-UX 5.1：健康检查面板。纯展示层——
                        数据来自主进程对**同一份** buildDiagnosticReport 输出的
                        投影（runtime/health/workDir）+ 既有 python-env-status +
                        既有 test-connection；渲染层不自行采集任何指标。
                        放在诊断组内导出按钮之上：先看"当前怎么样"，再看"要不要打包"。 */}
                    <HealthPanelCard apiUrl={String(savedForm.adminApiUrl || '')} />
                    <div className="cfg-row">
                      <button
                        type="button"
                        className="btn"
                        onClick={() => void exportDiagnostics()}
                        disabled={diagBusy || !diagSupported}
                        title={!diagSupported ? t('cfg.gen.unsupported') : undefined}
                      >
                        {diagBusy
                          ? <><Icon name="refresh" className="icon-spin" /> {t('cfg.io.diagnosticExporting')}</>
                          : <><Icon name="download" /> {t('cfg.io.diagnosticExport')}</>}
                      </button>
                    </div>
                    <span className="cfg-hint">{t('cfg.about.diagnosticsHint')}</span>
                    {diagMsg && (
                      <div
                        className={diagMsg.kind === 'ok' ? 'test-result ok' : 'test-result fail'}
                        role={diagMsg.kind === 'ok' ? 'status' : 'alert'}
                      >
                        <Icon name={diagMsg.kind === 'ok' ? 'check' : 'warning'} className="icon-xs" /> {diagMsg.text}
                      </div>
                    )}
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
          <div className="cfg-footer-inner">
          {saveError && (
            <div className="cfg-save-error" role="alert"><Icon name="warning" className="icon-xs" /> {saveError}</div>
          )}
          {saved && !isDirty && <div className="saved-toast"><Icon name="check" className="icon-xs" /> {t('cfg.footer.savedToast')}</div>}
          {isDirty && (
            <>
              <div className="cfgx-footer-dirty">
                <span className="cfg-unsaved" role="status"><span aria-hidden="true" />{t('cfg.footer.unsavedBar')}</span>
                <span className="cfgx-dirty-count" role="status">{t('cfgx.dirty.count', changedEntries.length)}</span>
              </div>
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
    </div>
  );
}

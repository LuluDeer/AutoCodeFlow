import React, { useEffect, useState } from 'react';
import Icon from '../components/Icon';
// V4-5（I-07 门面四件）+ V4 后续优化（6）i18n 二期：向导全部文案入双语表
// （zh 值与原硬编码逐字一致，e2e 依赖的渲染锚点不变）。
import { createCfgTexts, resolveRendererLocale } from '../i18n';

const t = createCfgTexts(resolveRendererLocale(() => navigator.language));

declare const window: Window & {
  electronAPI: {
    testConnection: (url: string) => Promise<{ ok: boolean; message: string }>;
    // 重跑向导预填：已配置机器从设置页唤出时，表单先载入当前配置（token 为
    // 掩码哨兵 '******'，原样回传 = 保留已存 token，见 config-store TOKEN_MASK）。
    getConfig: () => Promise<Record<string, unknown>>;
    // F-23：重跑向导预填「开机自动启动」用 OS 自启真值（与设置页开关同源，
    // autolaunch:get），避免 config.autoStart 与 OS 状态脱节时预填错值。
    getAutoLaunch: () => Promise<boolean>;
    // 首启向导「下载源」步：并行探测官方源与国内镜像（任一 HTTP 应答即算可达）。
    testInterpreterSource: () => Promise<{
      official: { ok: boolean; ms: number; detail: string };
      mirror: { ok: boolean; ms: number; detail: string };
    }>;
    // B-9：主进程保留启动判定结果——error 非空表示"配置已保存但执行器未起来/
    // 注册预检未通过"，向导窗口保持打开、页内展示。
    saveAndCloseWizard: (cfg: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;
    // B-8：host 透传——端口检测的监听 host 与向导实际保存的 executorHost
    // 同源（本向导固定保存 0.0.0.0，见 finish()）。
    checkPort: (port: number, host?: string) => Promise<{ available: boolean; message: string }>;
    getLocalIPs: () => Promise<string[]>;
    closeWindow: () => void;
  };
};

interface WizardForm {
  adminApiUrl: string;
  executorName: string;
  executorPort: number;
  executorAddressPublic: string;
  executorToken: string;
  // 解释器下载源：'' = 官方源（uv 默认）；非空 = 镜像 base URL，直接落到
  // config.uvPythonInstallMirror（与设置页同一字段、同一消毒与校验链）。
  uvPythonInstallMirror: string;
  // 回连模式（pull mode）：执行器主动连接平台领取任务，平台无需反向连入。
  // 默认开——跨网络/NAT/云主机/内网办公机的主流部署形态。
  pullMode: boolean;
  autoStartExecutor: boolean;
  autoStart: boolean;
}

const DEFAULT_FORM: WizardForm = {
  adminApiUrl: '',
  executorName: '',
  executorPort: 8002,
  executorAddressPublic: '',
  executorToken: '',
  uvPythonInstallMirror: '',
  pullMode: true,
  autoStartExecutor: true,
  autoStart: false,
};

// 与 ipc-handlers.ts 的 INTERPRETER_SOURCE_MIRROR_URL 保持一致（两侧各持一份
// 字面量，改动必须同步）：选中「国内镜像」时写入 uvPythonInstallMirror 的值。
const MIRROR_PYTHON_SOURCE = 'https://registry.npmmirror.com/-/binary/python-build-standalone';

const TOTAL_STEPS = 5;
/** 进度段下的步骤名（v2 指引升级；文案入 shell.* 双语键） */
const STEP_LABELS = [
  t('shell.step1'),
  t('shell.step2'),
  t('shell.step3'),
  t('shell.step4'),
  t('shell.step5'),
];

function Toggle({
  id, label, checked, onChange,
}: { id: string; label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="toggle">
      <input type="checkbox" id={id} aria-label={label} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <div className="toggle-track"><div className="toggle-thumb" /></div>
    </label>
  );
}

export default function Wizard() {
  const [step, setStep] = useState(1);
  const [form, setForm] = useState<WizardForm>(DEFAULT_FORM);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  // 向导保存失败必须可见（原实现无 try，reject 后永久卡在"保存中"）
  const [finishError, setFinishError] = useState<string | null>(null);
  // 预填源（重跑向导）：挂载时读一次当前配置。null = 读取失败或首次安装
  // （配置为默认值），finish() 回落原固定默认，行为不变。
  const [wizardCfg, setWizardCfg] = useState<Record<string, unknown> | null>(null);

  function set(key: keyof WizardForm, value: unknown) {
    setForm((f) => ({ ...f, [key]: value }));
    if (key === 'adminApiUrl') setTestResult(null);
  }

  async function testConnection() {
    if (!form.adminApiUrl) return;
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await window.electronAPI.testConnection(form.adminApiUrl));
    } catch (err) {
      // IPC reject 时 testing 必须复位，否则按钮永久「测试中...」
      setTestResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  }

  // 预填（重跑向导支持，2026-10-13 用户需求）：从设置页唤出时表单先载入
  // 当前已存配置——否则重跑像重新录入。首次安装时配置为默认值（空串/默认
  // 端口），预填无操作、行为不变。token 读回的是掩码哨兵 '******'：原样留
  // 在表单，未改动时回传由 config-store.save 映射为「保留已存 token」，
  // 不会损坏密钥。
  useEffect(() => {
    window.electronAPI.getConfig()
      .then((cfg) => {
        setWizardCfg(cfg);
        setForm((f) => ({
          ...f,
          adminApiUrl: typeof cfg.adminApiUrl === 'string' ? cfg.adminApiUrl : f.adminApiUrl,
          executorName: typeof cfg.executorName === 'string' ? cfg.executorName : f.executorName,
          executorPort: typeof cfg.executorPort === 'number' ? cfg.executorPort : f.executorPort,
          executorAddressPublic: typeof cfg.executorAddressPublic === 'string' ? cfg.executorAddressPublic : f.executorAddressPublic,
          executorToken: typeof cfg.executorToken === 'string' ? cfg.executorToken : f.executorToken,
          uvPythonInstallMirror: typeof cfg.uvPythonInstallMirror === 'string' ? cfg.uvPythonInstallMirror : f.uvPythonInstallMirror,
          // 首次安装保留表单默认（回连模式开）——config-store 的 pullMode
          // 默认值是 false（为存量 push 部署保持升级零行为变化），若在首装
          // 向导里原样套用，界面会出现「回连模式（推荐）」却默认关闭的自相
          // 矛盾。只有已配置过的机器（重跑向导）才尊重已落盘值。
          pullMode: cfg.configured === false
            ? f.pullMode
            : (typeof cfg.pullMode === 'boolean' ? cfg.pullMode : f.pullMode),
        }));
        // F-23（UIUX 审计）：重跑向导不再静默重置「完成」步的两个自启开关——
        // DEFAULT_FORM 的 autoStartExecutor:true / autoStart:false 只是首次
        // 安装的默认值，已配置机器（configured===true）预填当前值，用户未
        // 触碰即原样回传。autoStart 以 OS 自启真值（autolaunch:get）为准：
        // 设置页开关读 OS 真值、托盘勾选态读 config 落盘值，两者此前会因
        // 脱节而互相矛盾——预填 OS 真值让「不动 = 不变」，残留差异由
        // ipc-handlers 保存路径的对称 disable 兜底收敛。
        if (cfg.configured === true) {
          setForm((f) => ({
            ...f,
            autoStartExecutor: typeof cfg.autoStartExecutor === 'boolean' ? cfg.autoStartExecutor : f.autoStartExecutor,
          }));
          window.electronAPI.getAutoLaunch()
            .then((osEnabled) => setForm((f) => ({ ...f, autoStart: osEnabled === true })))
            .catch(() => {
              // 读不到 OS 自启态（平台接口异常等）：退回 config 落盘值——
              // 两处 UI 的最终对齐由保存路径的对称 disable 兜底。
              setForm((f) => ({
                ...f,
                autoStart: typeof cfg.autoStart === 'boolean' ? cfg.autoStart : f.autoStart,
              }));
            });
        }
      })
      .catch(() => { /* 读取失败保持空表单（首次安装语义），不炸向导 */ });
  }, []);

  async function finish() {
    setSaving(true);
    setFinishError(null);
    try {
      const r = await window.electronAPI.saveAndCloseWizard({
        ...form,
        // F-23（UIUX 审计）：重跑向导不再把 executorHost 悄悄改回全网卡监听
        // ——向导没有该字段的输入位，finish() 此前硬编码 '0.0.0.0'，用户刻意
        // 配置的仅本机回环监听（127.0.0.1）会被静默降级且无任何提示。沿用
        // 挂载时读到的已存配置（首次安装读不到/为空时回落原固定默认，行为
        // 不变；与下方 maxConcurrentTasks/logLevel 的「未暴露字段保留」同款
        // 口径）。
        executorHost:
          typeof wizardCfg?.executorHost === 'string' && wizardCfg.executorHost
            ? wizardCfg.executorHost
            : '0.0.0.0',
        // 重跑向导不重置未暴露的档位：沿用挂载时读到的已存配置（首次安装
        // 读不到时回落原默认 10/info，行为不变）——否则重跑一次会把
        // logLevel=debug / 自定义并发数悄悄冲回默认。
        maxConcurrentTasks: typeof wizardCfg?.maxConcurrentTasks === 'number' ? wizardCfg.maxConcurrentTasks : 10,
        workDir: '',
        logLevel: typeof wizardCfg?.logLevel === 'string' ? wizardCfg.logLevel : 'info',
      });
      // B-9：主进程只在启动判定**通过**后才关窗——失败（含注册预检未通过）
      // 时向导保持打开，错误在这里落到页内错误条，用户可返回上一步修改后
      // 重试，或直接关窗稍后处理（配置已保存）。
      if (r && r.ok === false) {
        setFinishError(r.error || t('wizard.saveFail'));
      } else if (r && r.error) {
        setFinishError(r.error);
      }
    } catch (err) {
      // 原实现未包 try——reject 会让 saving 永久为 true，向导卡在"保存中"
      // 且无任何错误提示，用户只能强杀进程。
      setFinishError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="wizard-wrap">
      <div className="wizard">
        {/* 品牌 + 进度——作为拖拽区域 */}
        <div className="wizard-header">
          <div className="wizard-header-drag wizard-drag-region">
            <div className="wizard-brand">
              <div className="wizard-brand-icon"><Icon name="zap" /></div>
              <span className="wizard-brand-name">AutoCodeFlow Executor</span>
            </div>
          </div>
          <button
            className="wizard-close-btn"
            onClick={() => window.electronAPI.closeWindow()}
            title={t('wizard.closeAria')}
            aria-label={t('wizard.closeAria')}
          >
            <Icon name="close" />
          </button>
          <div className="wizard-progress-row">
            <div className="wizard-progress">
              {STEP_LABELS.map((label, i) => (
                <div
                  key={label}
                  className={`wizard-progress-col${i + 1 < step ? ' done' : i + 1 === step ? ' active' : ''}`}
                >
                  <div className="wizard-progress-step" />
                  {/* 步骤名直接标注在进度段下（v2 指引升级）：不用猜第几段是什么 */}
                  <span className="wizard-progress-name">{label}</span>
                </div>
              ))}
            </div>
            <span className="wizard-progress-label" aria-live="polite">
              {t('shell.stepOf', step, TOTAL_STEPS)}
            </span>
          </div>
        </div>

        {step === 1 && <StepWelcome onNext={() => setStep(2)} />}
        {step === 2 && (
          <StepConnect
            url={form.adminApiUrl}
            onUrlChange={(v) => set('adminApiUrl', v)}
            testing={testing}
            testResult={testResult}
            onTest={testConnection}
            onBack={() => setStep(1)}
            onNext={() => setStep(3)}
          />
        )}
        {step === 3 && (
          <StepExecutor
            form={form}
            onChange={set}
            onBack={() => setStep(2)}
            onNext={() => setStep(4)}
          />
        )}
        {step === 4 && (
          <StepSource
            value={form.uvPythonInstallMirror}
            onChange={(v) => set('uvPythonInstallMirror', v)}
            onBack={() => setStep(3)}
            onNext={() => setStep(5)}
          />
        )}
        {step === 5 && (
          <StepFinish
            form={form}
            onChange={set}
            onBack={() => setStep(4)}
            onFinish={finish}
            saving={saving}
            error={finishError}
          />
        )}
      </div>
    </div>
  );
}

function StepWelcome({ onNext }: { onNext: () => void }) {
  return (
    <>
      <div className="wizard-title">{t('wizard.welcome.title')}</div>
      <div className="wizard-subtitle">{t('wizard.welcome.subtitle')}</div>
      <div className="wizard-body">
        <div className="wizard-hero" aria-hidden="true">
          <span className="wizard-hero-glyph"><Icon name="zap" /></span>
          <div className="wizard-hero-text">
            <strong>{t('wizard.welcome.heroTitle')}</strong>
            <span>{t('wizard.welcome.heroBody')}</span>
          </div>
        </div>
        <div className="wizard-features">
          <div className="wizard-feature">
            <div className="wizard-feature-icon icon-blue"><Icon name="link" /></div>
            <div className="wizard-feature-text">
              <strong>{t('wizard.welcome.f1Title')}</strong>
              <span>{t('wizard.welcome.f1Body')}</span>
            </div>
          </div>
          <div className="wizard-feature">
            <div className="wizard-feature-icon icon-purple"><Icon name="monitor" /></div>
            <div className="wizard-feature-text">
              <strong>{t('wizard.welcome.f2Title')}</strong>
              <span>{t('wizard.welcome.f2Body')}</span>
            </div>
          </div>
          <div className="wizard-feature">
            <div className="wizard-feature-icon icon-green"><Icon name="check-circle" /></div>
            <div className="wizard-feature-text">
              <strong>{t('wizard.welcome.f3Title')}</strong>
              <span>{t('wizard.welcome.f3Body')}</span>
            </div>
          </div>
        </div>
      </div>
      <div className="wizard-actions">
        <button className="btn btn-primary btn-lg" onClick={onNext}>{t('wizard.welcome.start')} <Icon name="chevron-right" className="icon-xs" /></button>
      </div>
    </>
  );
}

function StepConnect({
  url, onUrlChange, testing, testResult, onTest, onBack, onNext,
}: {
  url: string;
  onUrlChange: (v: string) => void;
  testing: boolean;
  testResult: { ok: boolean; message: string } | null;
  onTest: () => void;
  onBack: () => void;
  onNext: () => void;
}) {
  // B-11：连接闸门——「测试连接」通过才直接放行；未通过（或还没测）时点
  // 「下一步」给**一次性页内确认**（不用 window.confirm：无边框窗口下会阻塞
  // 渲染进程且样式不可控，与 AppsPage 的页内确认条同一取舍）。修改地址或
  // 重新发起测试都会撤销该确认。
  const [confirmSkip, setConfirmSkip] = useState(false);
  const testedOk = testResult?.ok === true;

  function handleNext() {
    if (testedOk) {
      onNext();
      return;
    }
    if (!confirmSkip) {
      setConfirmSkip(true);
      return;
    }
    onNext();
  }

  return (
    <>
      <div className="wizard-title">{t('wizard.connect.title')}</div>
      <div className="wizard-subtitle">{t('wizard.connect.subtitle')}</div>
      <div className="wizard-body">
        <div className="field">
          <label className="label">{t('wizard.connect.urlLabel')}</label>
          <div className="input-group">
            <input aria-label={t('wizard.connect.urlLabel')}
              className={`input${testResult && !testResult.ok ? ' error' : ''}`}
              placeholder="http://192.168.1.10:3001"
              value={url}
              onChange={(e) => { onUrlChange(e.target.value); setConfirmSkip(false); }}
              onKeyDown={(e) => e.key === 'Enter' && url && onTest()}
            />
            <button className="btn wizard-inline-button" onClick={() => { onTest(); setConfirmSkip(false); }} disabled={!url || testing}>
              {testing ? t('wizard.connect.testing') : t('wizard.connect.test')}
            </button>
          </div>
          <span className="hint">{t('wizard.connect.hint')}</span>
          {testResult && (
            <div className={`test-result ${testResult.ok ? 'ok' : 'fail'}`}>
              <Icon name={testResult.ok ? 'check' : 'close'} className="icon-xs" /> {testResult.message}
            </div>
          )}
          {confirmSkip && !testedOk && (
            <div className="test-result fail" role="alert">
              <Icon name="warning" className="icon-xs" /> {t('wizard.connect.skipWarning')}
              <button type="button" className="btn btn-sm" onClick={onTest} disabled={!url || testing}>{t('wizard.connect.retryTest')}</button>
              <button type="button" className="btn btn-sm" onClick={onNext}>{t('wizard.connect.continueAnyway')}</button>
            </div>
          )}
        </div>
      </div>
      <div className="wizard-actions">
        <button className="btn" onClick={onBack}><Icon name="chevron-right" className="icon-xs icon-flip-h" /> {t('wizard.back')}</button>
        <button className="btn btn-primary" onClick={handleNext} disabled={!url || testing}>
          {t('wizard.next')} <Icon name="chevron-right" className="icon-xs" />
        </button>
      </div>
    </>
  );
}

/** D-04：推荐网卡判定——排除链路本地（169.254.*）与回环（127.*）后取第一个地址；
 *  全部被排除时返回 null，调用方兜底取 ips[0]（主进程大概率已滤，此处防御性再判）。 */
function pickRecommendedIp(ips: string[]): string | null {
  return ips.find((ip) => !ip.startsWith('169.254.') && !ip.startsWith('127.')) ?? null;
}

function StepExecutor({
  form, onChange, onBack, onNext,
}: {
  form: WizardForm;
  onChange: (k: keyof WizardForm, v: unknown) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const [localIPs, setLocalIPs] = useState<string[]>([]);
  const [recommendedIp, setRecommendedIp] = useState<string | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [checkingPort, setCheckingPort] = useState(false);
  const [portResult, setPortResult] = useState<{ available: boolean; message: string } | null>(null);
  // F-33（UIUX 审计）：端口输入改为「草稿字符串」受控。原实现把
  // parseInt('') = NaN 直接塞进表单并渲染 value={NaN}（React 控制台告警
  // "Received NaN for the `value` attribute"），且清空后「下一步」静默禁用、
  // 无任何原因提示。输入过程只保留用户键入的原样字符串（空串合法）；form
  // 里仍存数值（NaN = 未填写，portValid 闸门拦住「下一步」），显示权归
  // portText——NaN 不再流进 DOM。
  const [portText, setPortText] = useState(() =>
    Number.isFinite(form.executorPort) ? String(form.executorPort) : '');

  // 预填（getConfig 晚到）/返回本步等场景下表单端口外部变化时回填草稿。
  // 按 parseInt 数值比较：'007' 这类手输前导零不会被重写；清空（NaN）两侧
  // 恒不等、重写为空串也无害（草稿本就是空）。
  useEffect(() => {
    const parsed = portText.trim() === '' ? NaN : Number.parseInt(portText.trim(), 10);
    if (form.executorPort !== parsed) {
      setPortText(Number.isFinite(form.executorPort) ? String(form.executorPort) : '');
    }
    // portText 有意不入依赖：本 effect 只响应表单端口的**外部**变化（预填），
    // 键入路径由 handlePortChange 自己同步，回填会打断输入。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.executorPort]);

  useEffect(() => {
    window.electronAPI.getLocalIPs()
      .then((ips) => {
        setLocalIPs(ips);
        // D-04：自动填入优先用推荐网卡（排除链路本地/回环后的第一个地址），
        // 无推荐时兜底仍取第一块网卡。
        const rec = pickRecommendedIp(ips);
        setRecommendedIp(rec);
        // 如果还没填对外地址，自动选第一个
        if (!form.executorAddressPublic && ips.length > 0) {
          onChange('executorAddressPublic', `${rec ?? ips[0]}:${form.executorPort}`);
        }
      })
      .catch(() => setLocalIPs([])); // 失败时静默回落到手填输入框，不炸向导
    // 仅挂载时自动检测一次（form/onChange 有意不入依赖）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function checkPort() {
    if (!form.executorPort) return;
    setCheckingPort(true);
    setPortResult(null);
    try {
      // B-8：传本向导将保存的 executorHost（见 finish() 固定 0.0.0.0）——
      // 检测的监听 host 与执行器实际 bind 的 host 同源，不再依赖主进程的
      // 固定 0.0.0.0。
      setPortResult(await window.electronAPI.checkPort(form.executorPort, '0.0.0.0'));
    } catch (err) {
      setPortResult({ available: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setCheckingPort(false);
    }
  }

  function handlePortChange(raw: string) {
    setPortText(raw);
    // F-33：清空（''）→ NaN 进表单（未填写语义，portValid 闸门接管）；其余
    // 与旧 parseInt 口径一致（非法部分截断）。
    const trimmed = raw.trim();
    const v = trimmed === '' ? NaN : Number.parseInt(trimmed, 10);
    onChange('executorPort', v);
    setPortResult(null);
    // 端口为有效整数时才同步对外地址里的端口段（清空输入得到 NaN 时不拼出 ":NaN"）。
    // 原实现用 split(':')[0] 取主机段——对 IPv6 字面量（::1 / [::1]）会截成
    // 空串，对用户手填的域名也会误伤；改为只替换「最后一个冒号之后」的端口段，
    // 无冒号时（纯 IP/域名）直接补端口。
    if (form.executorAddressPublic && Number.isInteger(v)) {
      onChange('executorAddressPublic', replaceAddressPort(form.executorAddressPublic, v));
    }
  }

  /**
   * 把 addr 的端口部分替换为 port，保留主机段原样（含 IPv6 字面量）。
   * 规则：`[v6]:old` 与 `host:old` 替换末尾端口；`[v6]` 补端口；
   * 裸 IPv6（多个冒号且无方括号）视为无端口——追加会歧义，故原样返回。
   */
  function replaceAddressPort(addr: string, port: number): string {
    const bracketed = addr.match(/^(\[[^\]]+\])(?::\d+)?$/);
    if (bracketed) return `${bracketed[1]}:${port}`;
    const colons = (addr.match(/:/g) ?? []).length;
    if (colons === 0) return `${addr}:${port}`;
    if (colons === 1) return `${addr.slice(0, addr.lastIndexOf(':'))}:${port}`;
    // 多个冒号且无方括号 = 裸 IPv6，无法安全区分端口，保持原值
    return addr;
  }

  function selectIP(ip: string) {
    onChange('executorAddressPublic', `${ip}:${form.executorPort}`);
  }

  // 端口必须落在合法区间：原实现只判 > 0，用户可填 99999 并一路走到完成，
  // 最终由子进程 bind 失败才暴露，错误信息也难懂。
  const portValid = Number.isInteger(form.executorPort) && form.executorPort >= 1 && form.executorPort <= 65535;
  const canNext = !!form.executorName && portValid;

  return (
    <>
      <div className="wizard-title">{t('wizard.machine.title')}</div>
      <div className="wizard-subtitle">{t('wizard.machine.subtitle')}</div>
      <div className="wizard-body">
        <div className="field">
          <label className="label">{t('wizard.machine.nameLabel')}</label>
          <input aria-label={t('wizard.machine.nameLabel')}
            className="input"
            placeholder="my-workstation"
            value={form.executorName}
            onChange={(e) => onChange('executorName', e.target.value)}
          />
          <span className="hint">{t('wizard.machine.nameHint')}</span>
        </div>

        <div className="field">
          <label className="label">{t('wizard.machine.portLabel')}</label>
          <div className="input-group">
            <input aria-label={t('wizard.machine.portLabel')}
              className={`input${portResult && !portResult.available ? ' error' : ''}`}
              // min 与本页校验口径（1–65535，见下方越界提示）及设置页
              // EXECUTOR_PORT 区间对齐——原 min={1024} 与校验文案自相矛盾。
              // F-33：value 走 portText 草稿（清空 = 空串），NaN 不再进 DOM。
              type="number" min={1} max={65535}
              placeholder="8002"
              value={portText}
              onChange={(e) => handlePortChange(e.target.value)}
            />
            <button className="btn wizard-inline-button" onClick={checkPort} disabled={!form.executorPort || checkingPort}>
              {checkingPort ? t('wizard.machine.checking') : t('wizard.machine.checkPort')}
            </button>
          </div>
          {portResult && (
            <div className={`test-result ${portResult.available ? 'ok' : 'fail'}`}>
              <Icon name={portResult.available ? 'check' : 'close'} className="icon-xs" /> {portResult.message}
            </div>
          )}
          {/* HTML 的 min/max 不阻止手输/粘贴越界值——显式给出校验反馈，
              否则用户可带着非法端口一路点到"完成"。清空输入（NaN）时不显示
              越界错误，只在确有整数值但超出范围时提示。F-33：清空是「必填」
              缺失而非越界——给可见原因（portRequired），不再只让「下一步」
              静默禁用。 */}
          {portText.trim() === '' && (
            <div className="test-result fail" role="alert">
              <Icon name="close" className="icon-xs" /> {t('wizard.machine.portRequired')}
            </div>
          )}
          {Number.isInteger(form.executorPort) &&
            (form.executorPort < 1 || form.executorPort > 65535) && (
            <div className="test-result fail" role="alert">
              <Icon name="close" className="icon-xs" /> {t('wizard.machine.portRange')}
            </div>
          )}
        </div>

        <div className="field">
          <label className="label">{t('wizard.machine.publicLabel')}</label>
          {localIPs.length > 0 && (
            <div className="ip-picker-wrap">
              <div className="ip-picker-label">{t('wizard.machine.ipPickerLabel')}</div>
              <div className="ip-picker">
                {localIPs.map((ip) => {
                  const full = `${ip}:${form.executorPort}`;
                  const sel = form.executorAddressPublic === full;
                  const rec = ip === recommendedIp;
                  return (
                    <button
                      type="button"
                      key={ip}
                      className={`ip-chip${sel ? ' selected' : ''}`}
                      onClick={() => selectIP(ip)}
                      aria-pressed={sel}
                      aria-label={`${full}${sel ? t('wizard.machine.chipSelected') : t('wizard.machine.chipUse')}${rec ? t('wizard.machine.chipRecommended') : ''}`}
                    >
                      {full}
                      {rec && <span className="ip-chip-recommended-badge">{t('wizard.machine.recommended')}</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <input aria-label={t('wizard.machine.publicLabel')}
            className="input wizard-address-input"
            placeholder={`192.168.x.x:${form.executorPort}`}
            value={form.executorAddressPublic}
            onChange={(e) => onChange('executorAddressPublic', e.target.value)}
          />
          <span className="hint">{form.pullMode ? t('wizard.machine.publicHintPull') : t('wizard.machine.publicHint')}</span>
        </div>

        {/* 回连模式（pull mode）：执行器主动连出领取任务，平台无需反向连入。
            开启时对外地址变为可选——跨网络/NAT/云主机的主流部署形态。 */}
        <div className="toggle-row">
          <div className="toggle-info">
            <strong>{t('wizard.machine.pullTitle')}</strong>
            <span>{t('wizard.machine.pullDesc')}</span>
          </div>
          <Toggle id="pullMode" label={t('wizard.machine.pullToggleLabel')} checked={form.pullMode} onChange={(v) => onChange('pullMode', v)} />
        </div>

        <div className="field">
          <label className="label">{t('wizard.machine.tokenLabel')}</label>
          {/* A-10 附属：密钥支持显示/隐藏切换——结构与监听端口行同源（input-group），
              图标钮只切 type，不改动保存逻辑。 */}
          <div className="input-group">
            <input aria-label={t('wizard.machine.tokenLabel')}
              className="input"
              type={showToken ? 'text' : 'password'}
              placeholder={t('wizard.machine.tokenPlaceholder')}
              value={form.executorToken}
              onChange={(e) => onChange('executorToken', e.target.value)}
            />
            <button
              type="button"
              className="btn wizard-eye-btn"
              onClick={() => setShowToken((v) => !v)}
              aria-label={showToken ? t('wizard.machine.hideToken') : t('wizard.machine.showToken')}
              title={showToken ? t('wizard.machine.hideToken') : t('wizard.machine.showToken')}
            >
              <Icon name={showToken ? 'eye-off' : 'eye'} className="icon-xs" />
            </button>
          </div>
        </div>
      </div>
      <div className="wizard-actions">
        <button className="btn" onClick={onBack}><Icon name="chevron-right" className="icon-xs icon-flip-h" /> {t('wizard.back')}</button>
        <button className="btn btn-primary" onClick={onNext} disabled={!canNext}>{t('wizard.next')} <Icon name="chevron-right" className="icon-xs" /></button>
      </div>
    </>
  );
}

interface SourceProbeResult {
  ok: boolean;
  ms: number;
  detail: string;
}

/**
 * 解释器下载源（第 4 步）：把「官方源 vs 国内镜像」的选择交给用户。
 *
 * 背景（desktop v1.8.1 真机实证）：国内网络 GitHub 直连经常超时/重置，官方源
 * 首次下载 CPython 直接 download_failed；默认值仍保持官方源（通用产品的中性
 * 解），但进本步自动探测一轮——官方不可达而镜像可达时**自动改选镜像**（只改
 * 未保存的表单状态，用户可见可改，完成页也会如实展示所选）。探测失败不阻塞
 * 下一步：选择可以盲选，运行期真失败仍有 executor-node 的结构化报错兜底。
 */
function StepSource({
  value, onChange, onBack, onNext,
}: {
  value: string;
  onChange: (v: string) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const [probing, setProbing] = useState(false);
  const [results, setResults] = useState<{ official: SourceProbeResult; mirror: SourceProbeResult } | null>(null);
  const [autoSelected, setAutoSelected] = useState(false);

  async function runProbe() {
    setProbing(true);
    try {
      const r = await window.electronAPI.testInterpreterSource();
      setResults(r);
      // 推荐逻辑（进页自动跑一轮，测试按钮可重跑）：官方源不可达且镜像可达、
      // 且用户尚未手动改过选择（仍是默认官方）时，自动改选镜像。
      if (r.official && !r.official.ok && r.mirror && r.mirror.ok && value === '') {
        onChange(MIRROR_PYTHON_SOURCE);
        setAutoSelected(true);
      }
    } catch {
      // IPC 失败静默回落：徽标不显示，按钮可重试，选择仍可手改。
      setResults(null);
    } finally {
      setProbing(false);
    }
  }

  // 仅挂载时自动探测一次（value/onChange 有意不入依赖，重跑走测试按钮）
  useEffect(() => {
    runProbe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function probeBadge(key: 'official' | 'mirror') {
    if (!results) {
      return probing
        ? <span className="hint">{t('wizard.source.testing')}</span>
        : null;
    }
    const r = results[key];
    return (
      <span className={`source-probe ${r.ok ? 'ok' : 'fail'}`}>
        <Icon name={r.ok ? 'check' : 'close'} className="icon-xs" />
        {r.ok ? `${t('wizard.source.reachable')} · ${r.ms}ms` : `${t('wizard.source.unreachable')} · ${r.detail}`}
      </span>
    );
  }

  return (
    <>
      <div className="wizard-title">{t('wizard.source.title')}</div>
      <div className="wizard-subtitle">{t('wizard.source.subtitle')}</div>
      <div className="wizard-body">
        <div className="field">
          <div className="wizard-source-options">
            <label className={`wizard-source-option${value === '' ? ' selected' : ''}`}>
              <input
                type="radio"
                name="interpreter-source"
                checked={value === ''}
                onChange={() => { onChange(''); setAutoSelected(false); }}
              />
              <span className="wizard-source-option-main">
                <strong>{t('wizard.source.optionOfficial')}</strong>
                <span>{t('wizard.source.optionOfficialDesc')}</span>
              </span>
              {probeBadge('official')}
            </label>
            <label className={`wizard-source-option${value !== '' ? ' selected' : ''}`}>
              <input
                type="radio"
                name="interpreter-source"
                checked={value !== ''}
                onChange={() => { onChange(MIRROR_PYTHON_SOURCE); setAutoSelected(false); }}
              />
              <span className="wizard-source-option-main">
                <strong>{t('wizard.source.optionMirror')}</strong>
                <span>{t('wizard.source.optionMirrorDesc')}</span>
              </span>
              {probeBadge('mirror')}
            </label>
          </div>
          <button className="btn wizard-inline-button" onClick={runProbe} disabled={probing}>
            {probing ? t('wizard.source.testing') : t('wizard.source.test')}
          </button>
          {autoSelected && (
            <div className="test-result ok" role="status">
              <Icon name="check" className="icon-xs" /> {t('wizard.source.autoSelected')}
            </div>
          )}
          <span className="hint">{t('wizard.source.hint')}</span>
        </div>
      </div>
      <div className="wizard-actions">
        <button className="btn" onClick={onBack}><Icon name="chevron-right" className="icon-xs icon-flip-h" /> {t('wizard.back')}</button>
        <button className="btn btn-primary" onClick={onNext}>{t('wizard.next')} <Icon name="chevron-right" className="icon-xs" /></button>
      </div>
    </>
  );
}

function StepFinish({
  form, onChange, onBack, onFinish, saving, error,
}: {
  form: WizardForm;
  onChange: (k: keyof WizardForm, v: unknown) => void;
  onBack: () => void;
  onFinish: () => void;
  saving: boolean;
  error: string | null;
}) {
  return (
    <>
      <div className="wizard-title">{t('wizard.finish.title')}</div>
      <div className="wizard-subtitle">{t('wizard.finish.subtitle')}</div>
      <div className="wizard-body">
        <div className="confirm-grid">
          <div className="confirm-row">
            <span className="confirm-key">{t('wizard.finish.keyApi')}</span>
            <span className="confirm-val">{form.adminApiUrl}</span>
          </div>
          <div className="confirm-row">
            <span className="confirm-key">{t('wizard.finish.keyName')}</span>
            <span className="confirm-val">{form.executorName}</span>
          </div>
          <div className="confirm-row">
            <span className="confirm-key">{t('wizard.finish.keyPort')}</span>
            <span className="confirm-val">{form.executorPort}</span>
          </div>
          <div className="confirm-row">
            <span className="confirm-key">{t('wizard.finish.keyPublic')}</span>
            <span className="confirm-val">{form.executorAddressPublic || t('ui.publicAuto', form.executorPort)}</span>
          </div>
          <div className="confirm-row">
            <span className="confirm-key">{t('wizard.finish.keySource')}</span>
            <span className="confirm-val">
              {form.uvPythonInstallMirror ? t('wizard.finish.sourceMirror') : t('wizard.finish.sourceOfficial')}
            </span>
          </div>
          <div className="confirm-row">
            <span className="confirm-key">{t('wizard.finish.keyPull')}</span>
            <span className="confirm-val">{form.pullMode ? t('wizard.finish.pullOn') : t('wizard.finish.pullOff')}</span>
          </div>
        </div>

        <div className="toggle-row">
          <div className="toggle-info">
            <strong>{t('wizard.finish.autoRunTitle')}</strong>
            <span>{t('wizard.finish.autoRunDesc')}</span>
          </div>
          <Toggle id="autoStartExecutor" label={t('wizard.finish.autoRunTitle')} checked={form.autoStartExecutor} onChange={(v) => onChange('autoStartExecutor', v)} />
        </div>
        <div className="toggle-row">
          <div className="toggle-info">
            <strong>{t('wizard.finish.autoLaunchTitle')}</strong>
            <span>{t('wizard.finish.autoLaunchDesc')}</span>
          </div>
          <Toggle id="autoStart" label={t('wizard.finish.autoLaunchTitle')} checked={form.autoStart} onChange={(v) => onChange('autoStart', v)} />
        </div>
        {/* D-01：完成后的三行去向说明（托盘常驻/状态监控/历史）——克制说明块，
            置于确认表单与两个开关之后、滚动区内（随表单滚动，不在 wizard-body 外
            定死：向导窗口固定尺寸下表单超高会滚动，钉死在外层会与滚出的行相抵）。
            纯静态展示不参与 finish() 流程（B-9 成功后主进程关窗的语义不变）。 */}
        <div className="wizard-aftercare">
          <div className="wizard-aftercare-row">
            <Icon name="monitor" className="wizard-aftercare-icon" />
            <span>{t('wizard.finish.aftercare1')}</span>
          </div>
          <div className="wizard-aftercare-row">
            <Icon name="activity" className="wizard-aftercare-icon" />
            <span>{t('wizard.finish.aftercare2')}</span>
          </div>
          <div className="wizard-aftercare-row">
            <Icon name="clock" className="wizard-aftercare-icon" />
            <span>{t('wizard.finish.aftercare3')}</span>
          </div>
        </div>
      </div>
      {error && (
        <div className="wizard-error" role="alert"><Icon name="warning" className="icon-xs" /> {error}</div>
      )}
      <div className="wizard-actions">
        <button className="btn" onClick={onBack} disabled={saving}><Icon name="chevron-right" className="icon-xs icon-flip-h" /> {t('wizard.back')}</button>
        <button className="btn btn-primary btn-lg" onClick={onFinish} disabled={saving}>
          {saving ? t('wizard.finish.launching') : <>{t('wizard.finish.done')} <Icon name="check" className="icon-xs" /></>}
        </button>
      </div>
    </>
  );
}

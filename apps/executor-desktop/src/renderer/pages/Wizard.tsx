import React, { useEffect, useState } from 'react';
import Icon from '../components/Icon';
// V4-5（I-07 门面四件）+ V4 后续优化（6）i18n 二期：向导全部文案入双语表
// （zh 值与原硬编码逐字一致，e2e 依赖的渲染锚点不变）。
import { createCfgTexts, resolveRendererLocale } from '../i18n';

const t = createCfgTexts(resolveRendererLocale(() => navigator.language));

declare const window: Window & {
  electronAPI: {
    testConnection: (url: string) => Promise<{ ok: boolean; message: string }>;
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
  autoStartExecutor: boolean;
  autoStart: boolean;
}

const DEFAULT_FORM: WizardForm = {
  adminApiUrl: '',
  executorName: '',
  executorPort: 8002,
  executorAddressPublic: '',
  executorToken: '',
  autoStartExecutor: true,
  autoStart: false,
};

const TOTAL_STEPS = 4;
/** 进度段下的步骤名（v2 指引升级；文案入 shell.* 双语键） */
const STEP_LABELS = [
  t('shell.step1'),
  t('shell.step2'),
  t('shell.step3'),
  t('shell.step4'),
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

  async function finish() {
    setSaving(true);
    setFinishError(null);
    try {
      const r = await window.electronAPI.saveAndCloseWizard({
        ...form,
        executorHost: '0.0.0.0',
        maxConcurrentTasks: 10,
        workDir: '',
        logLevel: 'info',
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
            <Icon name="close" className="icon-xs" />
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
          <StepFinish
            form={form}
            onChange={set}
            onBack={() => setStep(3)}
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

  function handlePortChange(v: number) {
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
              type="number" min={1} max={65535}
              value={form.executorPort}
              onChange={(e) => handlePortChange(parseInt(e.target.value, 10))}
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
              越界错误，只在确有整数值但超出范围时提示。 */}
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
          <span className="hint">{t('wizard.machine.publicHint')}</span>
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
            <span className="confirm-val">{form.executorAddressPublic || `（自动）:${form.executorPort}`}</span>
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

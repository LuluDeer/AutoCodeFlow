import React, { useEffect, useState } from 'react';

declare const window: Window & {
  electronAPI: {
    testConnection: (url: string) => Promise<{ ok: boolean; message: string }>;
    saveAndCloseWizard: (cfg: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;
    checkPort: (port: number) => Promise<{ available: boolean; message: string }>;
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
      // 主进程已关闭向导窗口；只有失败时才需要回到 UI 反馈
      if (r && r.ok === false) {
        setFinishError(r.error || '保存失败');
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
              <div className="wizard-brand-icon">⚡</div>
              <span className="wizard-brand-name">AutoCodeFlow Executor</span>
            </div>
          </div>
          <button
            className="wizard-close-btn"
            onClick={() => window.electronAPI.closeWindow()}
            title="关闭向导"
            aria-label="关闭向导"
          >
            ✕
          </button>
          <div className="wizard-progress">
            {Array.from({ length: TOTAL_STEPS }, (_, i) => (
              <div
                key={i}
                className={`wizard-progress-step ${
                  i + 1 < step ? 'done' : i + 1 === step ? 'active' : ''
                }`}
              />
            ))}
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
      <div className="wizard-title">欢迎使用 👋</div>
      <div className="wizard-subtitle">几步配置，让执行器连上平台开始工作。</div>
      <div className="wizard-body">
        <div className="wizard-features">
          <div className="wizard-feature">
            <div className="wizard-feature-icon icon-blue">🔗</div>
            <div className="wizard-feature-text">
              <strong>连接 Admin 平台</strong>
              <span>填入服务端 IP 和端口，测试连通性</span>
            </div>
          </div>
          <div className="wizard-feature">
            <div className="wizard-feature-icon icon-purple">🖥️</div>
            <div className="wizard-feature-text">
              <strong>配置本机信息</strong>
              <span>自动检测本机 IP，一键填入，小白友好</span>
            </div>
          </div>
          <div className="wizard-feature">
            <div className="wizard-feature-icon icon-green">✅</div>
            <div className="wizard-feature-text">
              <strong>自动注册上线</strong>
              <span>完成后常驻托盘，自动接收调度任务</span>
            </div>
          </div>
        </div>
      </div>
      <div className="wizard-actions">
        <button className="btn btn-primary btn-lg" onClick={onNext}>开始配置 →</button>
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
  return (
    <>
      <div className="wizard-title">连接服务端</div>
      <div className="wizard-subtitle">输入 AutoCodeFlow 管理平台的地址</div>
      <div className="wizard-body">
        <div className="field">
          <label className="label">Admin API 地址</label>
          <div className="input-group">
            <input
              className={`input${testResult && !testResult.ok ? ' error' : ''}`}
              placeholder="http://192.168.1.10:3001"
              value={url}
              onChange={(e) => onUrlChange(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && url && onTest()}
            />
            <button className="btn wizard-inline-button" onClick={onTest} disabled={!url || testing}>
              {testing ? '测试中...' : '测试'}
            </button>
          </div>
          <span className="hint">格式：http://服务器IP:端口，例如 http://192.168.1.10:3001</span>
          {testResult && (
            <div className={`test-result ${testResult.ok ? 'ok' : 'fail'}`}>
              {testResult.ok ? '✓' : '✗'} {testResult.message}
            </div>
          )}
        </div>
      </div>
      <div className="wizard-actions">
        <button className="btn" onClick={onBack}>← 返回</button>
        <button className="btn btn-primary" onClick={onNext} disabled={!url}>下一步 →</button>
      </div>
    </>
  );
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
  const [checkingPort, setCheckingPort] = useState(false);
  const [portResult, setPortResult] = useState<{ available: boolean; message: string } | null>(null);

  useEffect(() => {
    window.electronAPI.getLocalIPs()
      .then((ips) => {
        setLocalIPs(ips);
        // 如果还没填对外地址，自动选第一个
        if (!form.executorAddressPublic && ips.length > 0) {
          onChange('executorAddressPublic', `${ips[0]}:${form.executorPort}`);
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
      setPortResult(await window.electronAPI.checkPort(form.executorPort));
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
      <div className="wizard-title">本机配置</div>
      <div className="wizard-subtitle">配置执行器名称、端口和对外访问地址</div>
      <div className="wizard-body">
        <div className="field">
          <label className="label">执行器名称</label>
          <input
            className="input"
            placeholder="my-workstation"
            value={form.executorName}
            onChange={(e) => onChange('executorName', e.target.value)}
          />
          <span className="hint">在管理平台中显示的名称，用于区分不同机器</span>
        </div>

        <div className="field">
          <label className="label">监听端口</label>
          <div className="input-group">
            <input
              className={`input${portResult && !portResult.available ? ' error' : ''}`}
              type="number" min={1024} max={65535}
              value={form.executorPort}
              onChange={(e) => handlePortChange(parseInt(e.target.value, 10))}
            />
            <button className="btn wizard-inline-button" onClick={checkPort} disabled={!form.executorPort || checkingPort}>
              {checkingPort ? '检测...' : '检测端口'}
            </button>
          </div>
          {portResult && (
            <div className={`test-result ${portResult.available ? 'ok' : 'fail'}`}>
              {portResult.available ? '✓' : '✗'} {portResult.message}
            </div>
          )}
          {/* HTML 的 min/max 不阻止手输/粘贴越界值——显式给出校验反馈，
              否则用户可带着非法端口一路点到"完成"。清空输入（NaN）时不显示
              越界错误，只在确有整数值但超出范围时提示。 */}
          {Number.isInteger(form.executorPort) &&
            (form.executorPort < 1 || form.executorPort > 65535) && (
            <div className="test-result fail" role="alert">
              ✗ 端口必须是 1 – 65535 之间的整数
            </div>
          )}
        </div>

        <div className="field">
          <label className="label">对外地址（Admin API 回调此地址下发任务）</label>
          {localIPs.length > 0 && (
            <div className="ip-picker-wrap">
              <div className="ip-picker-label">本机网卡 IP（点击快速填入）</div>
              <div className="ip-picker">
                {localIPs.map((ip) => {
                  const full = `${ip}:${form.executorPort}`;
                  const sel = form.executorAddressPublic === full;
                  return (
                    <button
                      type="button"
                      key={ip}
                      className={`ip-chip${sel ? ' selected' : ''}`}
                      onClick={() => selectIP(ip)}
                      aria-pressed={sel}
                      aria-label={`${full}${sel ? '，已选择' : '，使用此地址'}`}
                    >
                      {full}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <input
            className="input wizard-address-input"
            placeholder={`192.168.x.x:${form.executorPort}`}
            value={form.executorAddressPublic}
            onChange={(e) => onChange('executorAddressPublic', e.target.value)}
          />
          <span className="hint">平台通过此地址向本机推送任务，需确保平台能访问到此 IP</span>
        </div>

        <div className="field">
          <label className="label">执行器密钥（Token）</label>
          <input
            className="input"
            type="password"
            placeholder="与平台配置的 EXECUTOR_SECRET 一致"
            value={form.executorToken}
            onChange={(e) => onChange('executorToken', e.target.value)}
          />
        </div>
      </div>
      <div className="wizard-actions">
        <button className="btn" onClick={onBack}>← 返回</button>
        <button className="btn btn-primary" onClick={onNext} disabled={!canNext}>下一步 →</button>
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
      <div className="wizard-title">确认配置 🎉</div>
      <div className="wizard-subtitle">检查以下信息，完成后执行器将自动注册到平台。</div>
      <div className="wizard-body">
        <div className="confirm-grid">
          <div className="confirm-row">
            <span className="confirm-key">Admin API</span>
            <span className="confirm-val">{form.adminApiUrl}</span>
          </div>
          <div className="confirm-row">
            <span className="confirm-key">执行器名称</span>
            <span className="confirm-val">{form.executorName}</span>
          </div>
          <div className="confirm-row">
            <span className="confirm-key">监听端口</span>
            <span className="confirm-val">{form.executorPort}</span>
          </div>
          <div className="confirm-row">
            <span className="confirm-key">对外地址</span>
            <span className="confirm-val">{form.executorAddressPublic || `(自动) :${form.executorPort}`}</span>
          </div>
        </div>

        <div className="toggle-row">
          <Toggle id="autoStartExecutor" label="应用启动时自动运行执行器" checked={form.autoStartExecutor} onChange={(v) => onChange('autoStartExecutor', v)} />
          <div className="toggle-info">
            <strong>应用启动时自动运行执行器</strong>
            <span>打开 Executor 桌面端后自动连接平台</span>
          </div>
        </div>
        <div className="toggle-row">
          <Toggle id="autoStart" label="开机自动启动" checked={form.autoStart} onChange={(v) => onChange('autoStart', v)} />
          <div className="toggle-info">
            <strong>开机自动启动</strong>
            <span>系统开机后自动运行 Executor</span>
          </div>
        </div>
      </div>
      {error && (
        <div className="wizard-error" role="alert">⚠ 保存失败：{error}</div>
      )}
      <div className="wizard-actions">
        <button className="btn" onClick={onBack} disabled={saving}>← 返回</button>
        <button className="btn btn-primary btn-lg" onClick={onFinish} disabled={saving}>
          {saving ? '启动中...' : '完成并启动 ✓'}
        </button>
      </div>
    </>
  );
}

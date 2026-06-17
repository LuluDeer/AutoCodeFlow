import React, { useEffect, useState } from 'react';

declare const window: Window & {
  electronAPI: {
    testConnection: (url: string) => Promise<{ ok: boolean; message: string }>;
    saveAndCloseWizard: (cfg: Record<string, unknown>) => Promise<{ ok: boolean }>;
    checkPort: (port: number) => Promise<{ available: boolean; message: string }>;
    getLocalIPs: () => Promise<string[]>;
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
  id, checked, onChange,
}: { id: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="toggle">
      <input type="checkbox" id={id} checked={checked} onChange={(e) => onChange(e.target.checked)} />
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

  function set(key: keyof WizardForm, value: unknown) {
    setForm((f) => ({ ...f, [key]: value }));
    if (key === 'adminApiUrl') setTestResult(null);
  }

  async function testConnection() {
    if (!form.adminApiUrl) return;
    setTesting(true);
    setTestResult(null);
    const result = await window.electronAPI.testConnection(form.adminApiUrl);
    setTestResult(result);
    setTesting(false);
  }

  async function finish() {
    setSaving(true);
    await window.electronAPI.saveAndCloseWizard({
      ...form,
      executorHost: '0.0.0.0',
      maxConcurrentTasks: 10,
      workDir: '',
      logLevel: 'info',
    });
    setSaving(false);
  }

  return (
    <div className="wizard-wrap">
      {/* 自定义标题栏——无边框模式拖拽区域 */}
      <div className="titlebar titlebar-wizard">
        <span className="titlebar-title">AutoCodeFlow Executor</span>
      </div>
      <div className="wizard">
        {/* 品牌 + 进度 */}
        <div className="wizard-header">
          <div className="wizard-brand">
            <div className="wizard-brand-icon">⚡</div>
            <span className="wizard-brand-name">AutoCodeFlow Executor</span>
          </div>
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
            <div className="wizard-feature-icon">🔗</div>
            <div className="wizard-feature-text">
              <strong>连接 Admin 平台</strong>
              <span>填入服务端 IP 和端口，测试连通性</span>
            </div>
          </div>
          <div className="wizard-feature">
            <div className="wizard-feature-icon">🖥️</div>
            <div className="wizard-feature-text">
              <strong>配置本机信息</strong>
              <span>自动检测本机 IP，一键填入，小白友好</span>
            </div>
          </div>
          <div className="wizard-feature">
            <div className="wizard-feature-icon">✅</div>
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
            <button className="btn" onClick={onTest} disabled={!url || testing} style={{ flexShrink: 0 }}>
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
    window.electronAPI.getLocalIPs().then((ips) => {
      setLocalIPs(ips);
      // 如果还没填对外地址，自动选第一个
      if (!form.executorAddressPublic && ips.length > 0) {
        onChange('executorAddressPublic', `${ips[0]}:${form.executorPort}`);
      }
    });
  }, []);

  async function checkPort() {
    if (!form.executorPort) return;
    setCheckingPort(true);
    setPortResult(null);
    const result = await window.electronAPI.checkPort(form.executorPort);
    setPortResult(result);
    setCheckingPort(false);
  }

  function handlePortChange(v: number) {
    onChange('executorPort', v);
    setPortResult(null);
    // 同步更新对外地址里的端口
    if (form.executorAddressPublic) {
      const ip = form.executorAddressPublic.split(':')[0];
      onChange('executorAddressPublic', `${ip}:${v}`);
    }
  }

  function selectIP(ip: string) {
    onChange('executorAddressPublic', `${ip}:${form.executorPort}`);
  }

  const canNext = !!form.executorName && form.executorPort > 0;

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
            <button className="btn" onClick={checkPort} disabled={!form.executorPort || checkingPort} style={{ flexShrink: 0 }}>
              {checkingPort ? '检测...' : '检测端口'}
            </button>
          </div>
          {portResult && (
            <div className={`test-result ${portResult.available ? 'ok' : 'fail'}`}>
              {portResult.available ? '✓' : '✗'} {portResult.message}
            </div>
          )}
        </div>

        <div className="field">
          <label className="label">对外地址（Admin API 回调此地址下发任务）</label>
          {localIPs.length > 0 && (
            <div className="ip-picker">
              {localIPs.map((ip) => {
                const full = `${ip}:${form.executorPort}`;
                const sel = form.executorAddressPublic === full;
                return (
                  <div
                    key={ip}
                    className={`ip-option${sel ? ' selected' : ''}`}
                    onClick={() => selectIP(ip)}
                  >
                    <span className="ip-option-addr">{full}</span>
                    <span className="ip-option-use">{sel ? '✓ 已选择' : '点击选用'}</span>
                  </div>
                );
              })}
            </div>
          )}
          <input
            className="input"
            placeholder={`192.168.x.x:${form.executorPort}`}
            value={form.executorAddressPublic}
            onChange={(e) => onChange('executorAddressPublic', e.target.value)}
            style={{ marginTop: localIPs.length > 0 ? 6 : 0 }}
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
  form, onChange, onBack, onFinish, saving,
}: {
  form: WizardForm;
  onChange: (k: keyof WizardForm, v: unknown) => void;
  onBack: () => void;
  onFinish: () => void;
  saving: boolean;
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
          <Toggle id="autoStartExecutor" checked={form.autoStartExecutor} onChange={(v) => onChange('autoStartExecutor', v)} />
          <div className="toggle-info">
            <strong>应用启动时自动运行执行器</strong>
            <span>打开 Executor 桌面端后自动连接平台</span>
          </div>
        </div>
        <div className="toggle-row">
          <Toggle id="autoStart" checked={form.autoStart} onChange={(v) => onChange('autoStart', v)} />
          <div className="toggle-info">
            <strong>开机自动启动</strong>
            <span>系统开机后自动运行 Executor</span>
          </div>
        </div>
      </div>
      <div className="wizard-actions">
        <button className="btn" onClick={onBack} disabled={saving}>← 返回</button>
        <button className="btn btn-primary btn-lg" onClick={onFinish} disabled={saving}>
          {saving ? '启动中...' : '完成并启动 ✓'}
        </button>
      </div>
    </>
  );
}

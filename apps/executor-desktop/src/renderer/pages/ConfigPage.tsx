import React, { useEffect, useState } from 'react';

declare const window: Window & {
  electronAPI: {
    getConfig: () => Promise<Record<string, unknown>>;
    saveConfig: (cfg: Record<string, unknown>) => Promise<{ ok: boolean }>;
    testConnection: (url: string) => Promise<{ ok: boolean; message: string }>;
    getLocalIPs: () => Promise<string[]>;
    getAutoLaunch: () => Promise<boolean>;
    setAutoLaunch: (enable: boolean) => Promise<{ ok: boolean }>;
  };
};

function Toggle({ id, checked, onChange }: { id: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="toggle">
      <input type="checkbox" id={id} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <div className="toggle-track"><div className="toggle-thumb" /></div>
    </label>
  );
}

type SectionId = 'connection' | 'network' | 'general';

const SECTIONS: { id: SectionId; icon: string; label: string; desc: string }[] = [
  { id: 'connection', icon: '🔗', label: '连接设置', desc: '平台地址与密钥' },
  { id: 'network',    icon: '🌐', label: '网络地址', desc: '端口与对外 IP' },
  { id: 'general',   icon: '⚙️', label: '基本设置', desc: '名称与并发数' },
];

export default function ConfigPage() {
  const [form, setForm] = useState<Record<string, unknown>>({});
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [localIPs, setLocalIPs] = useState<string[]>([]);
  const [active, setActive] = useState<SectionId>('connection');
  // DSK-04：开机自启走独立 IPC（autolaunch:get/set，即时生效，不经保存按钮），
  // 与托盘菜单的「开机自启」复选框同源（setAutoLaunch 后主进程会 rebuildMenu）。
  const [autoLaunch, setAutoLaunch] = useState(false);

  useEffect(() => {
    Promise.all([window.electronAPI.getConfig(), window.electronAPI.getLocalIPs()])
      .then(([cfg, ips]) => { setForm(cfg); setLocalIPs(ips); setLoaded(true); });
    // 旧版 preload 可能未暴露 autolaunch 通道——容错降级为隐藏开关
    if (typeof window.electronAPI.getAutoLaunch === 'function') {
      window.electronAPI.getAutoLaunch().then(setAutoLaunch).catch(() => undefined);
    }
  }, []);

  function set(key: string, value: unknown) {
    setForm((f) => ({ ...f, [key]: value }));
    setSaved(false);
    if (key === 'adminApiUrl') setTestResult(null);
  }

  async function toggleAutoLaunch(enable: boolean) {
    setAutoLaunch(enable); // 乐观更新，失败由 catch 回滚
    try {
      await window.electronAPI.setAutoLaunch(enable);
    } catch {
      setAutoLaunch(!enable);
    }
  }

  async function save() {
    setSaving(true);
    await window.electronAPI.saveConfig(form);
    setSaving(false); setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  }

  async function test() {
    setTesting(true); setTestResult(null);
    const r = await window.electronAPI.testConnection(String(form.adminApiUrl || ''));
    setTestResult(r); setTesting(false);
  }

  if (!loaded) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#aeaeb2', fontSize: 13 }}>加载中...</div>
  );

  const port = Number(form.executorPort || 8002);

  return (
    <div className="cfg-layout">

      {/* 侧边导航 */}
      <nav className="cfg-nav">
        <div className="cfg-nav-heading">设置</div>
        {SECTIONS.map(s => (
          <button
            key={s.id}
            className={`cfg-nav-item${active === s.id ? ' active' : ''}`}
            onClick={() => setActive(s.id)}
          >
            <span className="cfg-nav-icon">{s.icon}</span>
            <div className="cfg-nav-text">
              <span className="cfg-nav-label">{s.label}</span>
              <span className="cfg-nav-sub">{s.desc}</span>
            </div>
          </button>
        ))}
      </nav>

      {/* 内容区 */}
      <div className="cfg-body">
        <div className="cfg-scroll">

          {active === 'connection' && (
            <>
              <div className="cfg-header">
                <h2 className="cfg-title">连接设置</h2>
                <p className="cfg-subtitle">配置与 AutoCodeFlow 管理平台的连接参数</p>
              </div>

              <div className="cfg-field">
                <label className="cfg-label">Admin API 地址</label>
                <div className="cfg-row">
                  <input className="input" placeholder="http://192.168.1.10:3001"
                    value={String(form.adminApiUrl || '')}
                    onChange={(e) => set('adminApiUrl', e.target.value)} />
                  <button className="btn" onClick={test} disabled={testing} style={{ flexShrink: 0, minWidth: 84 }}>
                    {testing ? '测试中…' : '测试连接'}
                  </button>
                </div>
                {testResult && (
                  <div className={`test-result ${testResult.ok ? 'ok' : 'fail'}`}>
                    {testResult.ok ? '✓' : '✗'} {testResult.message}
                  </div>
                )}
                <span className="cfg-hint">AutoCodeFlow 管理平台的 API 地址，格式 http://IP:端口</span>
              </div>

              <div className="cfg-field">
                <label className="cfg-label">执行器密钥</label>
                <input className="input" type="password" placeholder="EXECUTOR_SECRET 的值"
                  value={String(form.executorToken || '')}
                  onChange={(e) => set('executorToken', e.target.value)} />
                <span className="cfg-hint">与 Admin 服务端 EXECUTOR_SECRET 环境变量保持一致</span>
              </div>
            </>
          )}

          {active === 'network' && (
            <>
              <div className="cfg-header">
                <h2 className="cfg-title">网络 &amp; 地址</h2>
                <p className="cfg-subtitle">配置执行器监听端口与对外可访问地址</p>
              </div>

              <div className="cfg-two-col">
                <div className="cfg-field">
                  <label className="cfg-label">监听端口</label>
                  <input className="input" type="number" value={port}
                    onChange={(e) => set('executorPort', parseInt(e.target.value, 10))} />
                </div>
                <div className="cfg-field">
                  <label className="cfg-label">对外地址</label>
                  <input className="input" placeholder="留空自动检测"
                    value={String(form.executorAddressPublic || '')}
                    onChange={(e) => set('executorAddressPublic', e.target.value)} />
                </div>
              </div>

              {localIPs.length > 0 && (
                <div className="cfg-field">
                  <label className="cfg-label">本机网卡 IP — 点击快速填入</label>
                  <div className="ip-picker">
                    {localIPs.map((ip) => {
                      const full = `${ip}:${port}`;
                      const sel = String(form.executorAddressPublic || '') === full;
                      return (
                        <div key={ip} className={`ip-option${sel ? ' selected' : ''}`}
                          onClick={() => set('executorAddressPublic', full)}>
                          <span className="ip-addr">{full}</span>
                          <span className="ip-action">{sel ? '✓ 已选择' : '使用'}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="info-banner">
                <span style={{ fontSize: 15, flexShrink: 0 }}>💡</span>
                <span>Admin 平台通过<strong>对外地址</strong>向本机推送任务。同局域网选上面的 IP 即可；跨网络或 NAT 环境需填外网 IP / 域名。</span>
              </div>
            </>
          )}

          {active === 'general' && (
            <>
              <div className="cfg-header">
                <h2 className="cfg-title">基本设置</h2>
                <p className="cfg-subtitle">执行器名称、并发数量与启动行为</p>
              </div>

              <div className="cfg-field">
                <label className="cfg-label">执行器名称</label>
                <input className="input" placeholder="my-executor-1"
                  value={String(form.executorName || '')}
                  onChange={(e) => set('executorName', e.target.value)} />
                <span className="cfg-hint">在管理平台中显示的唯一名称，建议使用机器名或角色命名</span>
              </div>

              <div className="cfg-field" style={{ maxWidth: 180 }}>
                <label className="cfg-label">最大并发任务数</label>
                <input className="input" type="number" min={1} max={100}
                  value={Number(form.maxConcurrentTasks || 10)}
                  onChange={(e) => set('maxConcurrentTasks', parseInt(e.target.value, 10))} />
                <span className="cfg-hint">同时运行的最大任务数量（1 – 100）</span>
              </div>

              <div className="cfg-toggle-card">
                <div className="cfg-toggle-info">
                  <strong>启动时自动运行执行器</strong>
                  <span>打开桌面端后自动连接平台并开始接受任务</span>
                </div>
                <Toggle id="autoStart" checked={Boolean(form.autoStartExecutor)}
                  onChange={(v) => set('autoStartExecutor', v)} />
              </div>

              <div className="cfg-toggle-card">
                <div className="cfg-toggle-info">
                  <strong>开机自动启动桌面端</strong>
                  <span>登录系统后自动在后台启动（即时生效，无需保存）</span>
                </div>
                {typeof window.electronAPI.getAutoLaunch === 'function' ? (
                  <Toggle id="autoLaunch" checked={autoLaunch}
                    onChange={(v) => void toggleAutoLaunch(v)} />
                ) : (
                  <span style={{ color: 'var(--text-3)', fontSize: 12 }}>当前版本不支持</span>
                )}
              </div>

              <div className="cfg-toggle-card">
                <div className="cfg-toggle-info">
                  <strong>系统通知</strong>
                  <span>任务完成 / 失败 / 执行器离线时弹出系统通知</span>
                </div>
                <Toggle id="notifyEnabled" checked={form.notifyEnabled !== false}
                  onChange={(v) => set('notifyEnabled', v)} />
              </div>
            </>
          )}

        </div>

        {/* 底部保存栏 */}
        <div className="cfg-footer">
          {saved && <div className="saved-toast">✓ 已保存，配置已生效</div>}
          <button className="btn btn-primary btn-lg" onClick={save} disabled={saving}>
            {saving ? '保存中...' : '保存配置'}
          </button>
        </div>
      </div>
    </div>
  );
}

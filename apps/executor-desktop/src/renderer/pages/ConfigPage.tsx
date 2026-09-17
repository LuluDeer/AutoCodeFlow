import React, { useEffect, useState } from 'react';

declare const window: Window & {
  electronAPI: {
    getConfig: () => Promise<Record<string, unknown>>;
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
  uvSource: 'config' | 'bundled' | 'path';
  uvFromSystemEnv: boolean;
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

type SectionId = 'connection' | 'network' | 'python' | 'general';

const SECTIONS: { id: SectionId; icon: string; label: string; desc: string }[] = [
  { id: 'connection', icon: '🔗', label: '连接设置', desc: '平台地址与密钥' },
  { id: 'network',    icon: '🌐', label: '网络地址', desc: '端口与对外 IP' },
  // python_task_multiversion：内网/离线部署的关键配置面。此前这些字段
  // （uvPath / 镜像 / 池目录 / PyPI 源）虽然后端全部实现，却**没有任何 UI
  // 入口**——运维只能去手工编辑 userData 里的 config.json，实际等于不可用。
  { id: 'python',     icon: '🐍', label: 'Python 运行环境', desc: 'uv、镜像与解释器池' },
  { id: 'general',   icon: '⚙️', label: '基本设置', desc: '名称与并发数' },
];

export default function ConfigPage() {
  const [form, setForm] = useState<Record<string, unknown>>({});
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // D 修正：保存失败必须可见（原实现 reject 后按钮永久 disabled）
  const [saveError, setSaveError] = useState<string | null>(null);
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
  // python_task_multiversion：进入「Python 运行环境」时拉一次诊断，显示实际
  // 生效的 uv / 池路径。刻意在切到该页时刷新而不是随表单实时联动——诊断反映
  // 的是**已保存**的配置，跟着未保存的输入框变化会误导用户。
  const [pyEnv, setPyEnv] = useState<PythonEnvStatus | null>(null);
  const [pyEnvError, setPyEnvError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([window.electronAPI.getConfig(), window.electronAPI.getLocalIPs()])
      .then(([cfg, ips]) => { setForm(cfg); setLocalIPs(ips); setLoaded(true); });
    // 旧版 preload 可能未暴露 autolaunch 通道——容错降级为隐藏开关
    if (typeof window.electronAPI.getAutoLaunch === 'function') {
      window.electronAPI.getAutoLaunch().then(setAutoLaunch).catch(() => undefined);
    }
  }, []);

  // 切到「Python 运行环境」页时刷新诊断（旧版 preload 无此通道时静默降级为
  // 不显示诊断块，不影响其余设置项的编辑与保存）。
  useEffect(() => {
    if (active !== 'python') return;
    if (typeof window.electronAPI.getPythonEnvStatus !== 'function') return;
    let cancelled = false;
    setPyEnvError(null);
    window.electronAPI
      .getPythonEnvStatus()
      .then((s) => { if (!cancelled) setPyEnv(s); })
      .catch((err) => {
        if (!cancelled) setPyEnvError(err instanceof Error ? err.message : String(err));
      });
    return () => { cancelled = true; };
  }, [active]);

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
    setSaveError(null);
    try {
      const r = await window.electronAPI.saveConfig(form);
      // 配置已落盘，但执行器热重载可能失败——此时不能报"已生效"，
      // 否则用户以为执行器在跑，实际已停在停止态。
      if (r?.reloadError) {
        setSaveError(`配置已保存，但执行器重启失败：${r.reloadError}。请在「状态监控」页手动启动。`);
      } else {
        setSaved(true);
        setTimeout(() => setSaved(false), 3000);
      }
    } catch (err) {
      // D 修正：原实现未包 try——saveConfig reject 会让 saving 永久为 true，
      // 「保存配置」按钮永久禁用且用户完全无感知，只能重启应用。
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
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

  // DSK-05：手动检查更新。开发模式（未打包）主进程 updater 未初始化，
  // checkForUpdates 静默返回——因此提示文案刻意不承诺"有新版本"。
  async function checkUpdate() {
    setChecking(true); setCheckMsg(null);
    try {
      await window.electronAPI.checkForUpdate();
      setCheckMsg('已发起检查。若有新版本，将在「状态监控」页顶部提示。');
    } catch (err) {
      setCheckMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(false);
      setTimeout(() => setCheckMsg(null), 6000);
    }
  }

  if (!loaded) return (
    <div className="page-loading">加载中...</div>
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
          <div className="cfg-scroll-inner">

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
                  <button className="btn cfg-test-button" onClick={test} disabled={testing}>
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
                        <button
                          type="button"
                          key={ip}
                          className={`ip-chip${sel ? ' selected' : ''}`}
                          onClick={() => set('executorAddressPublic', full)}
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

              <div className="info-banner">
                <span className="info-banner-icon">💡</span>
                <span>Admin 平台通过<strong>对外地址</strong>向本机推送任务。同局域网选上面的 IP 即可；跨网络或 NAT 环境需填外网 IP / 域名。</span>
              </div>
            </>
          )}

          {active === 'python' && (
            <>
              <div className="cfg-header">
                <h2 className="cfg-title">Python 运行环境</h2>
                <p className="cfg-subtitle">
                  执行器自带的 uv 负责按任务声明的版本准备 Python。默认走在线下载；
                  内网或离线环境请在此配置镜像源或预先填充解释器池。
                </p>
              </div>

              {/* 诊断块：显示**已保存配置**下实际生效的 uv / 池。这是排查
                  "配置了却没生效"最快的一手信息（uvPath 指错、自带 uv 缺失、
                  池被配到工作目录等），因此放在最上方。 */}
              {pyEnv && (
                <div className={`py-env-status ${pyEnv.uvPath || pyEnv.uvFromSystemEnv ? 'ok' : 'warn'}`}>
                  <div className="py-env-row">
                    <span className="py-env-key">uv</span>
                    <span className="py-env-val">
                      {pyEnv.uvPath
                        ? <><code>{pyEnv.uvPath}</code>
                            <em>
                              {pyEnv.uvSource === 'config' ? '（来自上方 uvPath 配置）'
                                : pyEnv.uvSource === 'bundled' ? '（安装包自带）' : ''}
                            </em>
                          </>
                        : pyEnv.uvFromSystemEnv
                          ? <><code>系统环境变量 UV_BIN</code><em>（来自系统环境）</em></>
                          : <strong className="py-env-missing">
                              未找到 uv —— 声明了 Python 版本的任务将无法执行
                            </strong>}
                    </span>
                  </div>
                  <div className="py-env-row">
                    <span className="py-env-key">解释器池</span>
                    <span className="py-env-val">
                      <code>{pyEnv.interpretersDir}</code>
                      {!pyEnv.poolReadable
                        ? <em className="py-env-missing">（目录不可读）</em>
                        : pyEnv.poolEntries.length > 0
                          ? <em>已就绪 {pyEnv.poolEntries.length} 个：{pyEnv.poolEntries.join('、')}</em>
                          : <em>（空——首次使用某版本时将按上方镜像源下载）</em>}
                    </span>
                  </div>
                  <div className="py-env-row">
                    <span className="py-env-key">镜像 / 私有源</span>
                    <span className="py-env-val">
                      {pyEnv.mirrorConfigured
                        ? <em>已配置解释器镜像源</em>
                        : <em>未配置解释器镜像源（需能访问外网）</em>}
                      {' · '}
                      {pyEnv.pypiConfigured
                        ? <em>已配置私有 PyPI 源</em>
                        : <em>用官方 PyPI</em>}
                    </span>
                  </div>
                </div>
              )}
              {pyEnvError && (
                <div className="cfg-save-error" role="alert">⚠ 无法读取 Python 环境状态：{pyEnvError}</div>
              )}

              <div className="info-banner">
                <span className="info-banner-icon">💡</span>
                <span>
                  安装包只自带 <strong>uv</strong>（包管理器），<strong>不含 Python 本体</strong>。
                  任务首次用到某个 Python 版本时由 uv 获取：<strong>能上外网</strong>则自动下载；
                  <strong>纯内网</strong>必须配置下方「解释器镜像源」，或由运维预先填充解释器池目录。
                </span>
              </div>

              <div className="cfg-field">
                <label className="cfg-label">uv 可执行文件路径（uvPath）</label>
                <input className="input" placeholder="留空 = 用自带 uv，其次回退系统 PATH"
                  value={String(form.uvPath || '')}
                  onChange={(e) => set('uvPath', e.target.value)} />
                <span className="cfg-hint">
                  仅在需要指定自建分发的 uv 时填写。留空时使用安装包自带的 uv。
                </span>
              </div>

              <div className="cfg-field">
                <label className="cfg-label">解释器镜像源（uvPythonInstallMirror）</label>
                <input className="input" placeholder="留空 = 用 uv 官方源（需要外网）"
                  value={String(form.uvPythonInstallMirror || '')}
                  onChange={(e) => set('uvPythonInstallMirror', e.target.value)} />
                <span className="cfg-hint">
                  纯内网部署时填内网镜像地址（如 python-build-standalone 镜像）。
                  留空则访问官方源，内网会下载失败。
                </span>
              </div>

              <div className="cfg-field">
                <label className="cfg-label">解释器池目录（uvPythonInstallDir）</label>
                <input className="input" placeholder="留空 = 用户数据目录下的 interpreters"
                  value={String(form.uvPythonInstallDir || '')}
                  onChange={(e) => set('uvPythonInstallDir', e.target.value)} />
                <span className="cfg-hint">
                  下载/预填的 Python 存放位置。离线预填时，把解释器按约定命名放进这里即可被识别。
                  不要指向任务工作目录（会被 TTL 清扫删除）。
                </span>
              </div>

              <div className="cfg-field">
                <label className="cfg-label">私有 PyPI 源（pypiRegistryUrl）</label>
                <input className="input" placeholder="留空 = 用官方 PyPI"
                  value={String(form.pypiRegistryUrl || '')}
                  onChange={(e) => set('pypiRegistryUrl', e.target.value)} />
                <span className="cfg-hint">
                  任务依赖安装使用的源（如内网 Nexus/Artifactory）。仅影响 pip 装包，不影响解释器下载。
                </span>
              </div>

              <div className="cfg-field cfg-field-narrow">
                <label className="cfg-label">解释器下载超时（毫秒）</label>
                <input className="input" type="number" min={0}
                  value={Number(form.interpreterDownloadTimeoutMs || 0)}
                  onChange={(e) => set('interpreterDownloadTimeoutMs', parseInt(e.target.value, 10) || 0)} />
                <span className="cfg-hint">单个解释器下载的最长等待时间。0 = 使用执行器默认值。</span>
              </div>

              <div className="info-banner">
                <span className="info-banner-icon">📌</span>
                <span>
                  <strong>Python 3.7 无法在线获取</strong>，必须由运维离线预填解释器池
                  （池目录下按 <code>cpython-3.7.9-&lt;平台三元组&gt;</code> 命名）。
                  未预填时声明 3.7 的任务会明确失败并归类为
                  <code>interpreter_unavailable</code>，不会悄悄回退到系统解释器。
                </span>
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

              <div className="cfg-field cfg-field-narrow">
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
                <Toggle id="autoStart" label="启动时自动运行执行器" checked={Boolean(form.autoStartExecutor)}
                  onChange={(v) => set('autoStartExecutor', v)} />
              </div>

              <div className="cfg-toggle-card">
                <div className="cfg-toggle-info">
                  <strong>开机自动启动桌面端</strong>
                  <span>登录系统后自动在后台启动（即时生效，无需保存）</span>
                </div>
                {typeof window.electronAPI.getAutoLaunch === 'function' ? (
                  <Toggle id="autoLaunch" label="开机自动启动桌面端" checked={autoLaunch}
                    onChange={(v) => void toggleAutoLaunch(v)} />
                ) : (
                  <span className="unsupported-label">当前版本不支持</span>
                )}
              </div>

              <div className="cfg-toggle-card">
                <div className="cfg-toggle-info">
                  <strong>系统通知</strong>
                  <span>任务完成 / 失败 / 执行器离线时弹出系统通知</span>
                </div>
                <Toggle id="notifyEnabled" label="系统通知" checked={form.notifyEnabled !== false}
                  onChange={(v) => set('notifyEnabled', v)} />
              </div>

              {/* DSK-05：手动检查更新（自动检查为启动后延迟 30s，仅生产包启用） */}
              <div className="cfg-field">
                <label className="cfg-label">版本更新</label>
                <div className="cfg-row">
                  <button
                    type="button"
                    className="btn"
                    onClick={checkUpdate}
                    disabled={checking || typeof window.electronAPI.checkForUpdate !== 'function'}
                  >
                    {checking ? '检查中…' : '检查更新'}
                  </button>
                </div>
                {checkMsg && <span className="cfg-hint" role="status">{checkMsg}</span>}
              </div>
            </>
          )}

          </div>
        </div>

        {/* 底部保存栏 */}
        <div className="cfg-footer">
          {saveError && (
            <div className="cfg-save-error" role="alert">⚠ 保存失败：{saveError}</div>
          )}
          {saved && <div className="saved-toast">✓ 已保存，配置已生效</div>}
          <button className="btn btn-primary btn-lg" onClick={save} disabled={saving}>
            {saving ? '保存中...' : '保存配置'}
          </button>
        </div>
      </div>
    </div>
  );
}

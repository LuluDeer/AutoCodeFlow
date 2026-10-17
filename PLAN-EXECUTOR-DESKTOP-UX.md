# Executor Desktop 用户体验优化计划

**优先级**: 中  
**预计工作量**: 4-6 人天  
**目标**: 提升桌面执行器的用户体验和可维护性

---

## 1. 系统托盘增强

### 背景
当前桌面执行器只有基础的托盘图标，缺少快捷操作。

### 优化方案

#### 1.1 右键菜单扩展
```typescript
// main/tray.ts
function createTrayMenu() {
  const template: MenuItemConstructorOptions[] = [
    { label: '打开控制台', click: () => mainWindow.show() },
    { type: 'separator' },
    { label: `状态: ${getStatus()}`, enabled: false },
    { label: `运行中任务: ${getRunningCount()} / ${getMaxConcurrent()}`, enabled: false },
    { type: 'separator' },
    { 
      label: '暂停接收任务', 
      type: 'checkbox',
      checked: isPaused(),
      click: (item) => setPaused(item.checked),
    },
    { label: '刷新配置', click: () => reloadConfig() },
    { label: '查看日志', click: () => shell.openPath(getLogPath()) },
    { type: 'separator' },
    { label: '关于', click: () => showAboutDialog() },
    { label: '退出', click: () => app.quit() },
  ];
  return Menu.buildFromTemplate(template);
}
```

#### 1.2 气泡通知
```typescript
// main/notifications.ts
export function notifyTaskStart(taskName: string) {
  tray.displayBalloon({
    title: '任务开始执行',
    content: `"${taskName}" 正在执行...`,
    icon: nativeImage.createFromPath(join(__dirname, 'icon-running.png')),
  });
}

export function notifyTaskComplete(taskName: string, success: boolean) {
  tray.displayBalloon({
    title: success ? '任务执行成功' : '任务执行失败',
    content: `"${taskName}" 已完成`,
    icon: success 
      ? nativeImage.createFromPath(join(__dirname, 'icon-success.png'))
      : nativeImage.createFromPath(join(__dirname, 'icon-error.png')),
  });
}
```

#### 1.3 动态图标状态
```typescript
// main/tray.ts
function updateTrayIcon() {
  const status = getStatus();
  let iconPath: string;
  
  if (status === 'offline') {
    iconPath = 'tray-offline.png';
  } else if (getRunningCount() > 0) {
    iconPath = 'tray-running.png'; // 绿色，带动画
  } else {
    iconPath = 'tray-idle.png'; // 灰色
  }
  
  tray.setImage(nativeImage.createFromPath(join(__dirname, iconPath)));
  tray.setToolTip(`AutoCodeFlow Executor\n状态: ${status}\n任务: ${getRunningCount()}/${getMaxConcurrent()}`);
}

// 每 5 秒更新一次
setInterval(updateTrayIcon, 5000);
```

---

## 2. 控制台 UI 改进

### 背景
当前渲染进程的 UI 较简陋，缺少丰富的交互。

### 优化方案

#### 2.1 仪表盘视图
```typescript
// renderer/Dashboard.tsx
export function Dashboard() {
  const { status, stats } = useExecutorState();
  
  return (
    <div className="dashboard">
      <Card className="status-card">
        <Statistic
          title="执行器状态"
          value={status}
          prefix={<StatusIcon status={status} />}
          valueStyle={{ color: getStatusColor(status) }}
        />
      </Card>
      
      <Card className="tasks-card">
        <Statistic title="运行中" value={stats.running} suffix={`/ ${stats.max}`} />
        <Progress percent={(stats.running / stats.max) * 100} />
      </Card>
      
      <Card className="stats-card">
        <Row gutter={16}>
          <Col span={8}>
            <Statistic title="今日执行" value={stats.todayTotal} />
          </Col>
          <Col span={8}>
            <Statistic title="成功" value={stats.todaySuccess} valueStyle={{ color: '#3f8600' }} />
          </Col>
          <Col span={8}>
            <Statistic title="失败" value={stats.todayFailed} valueStyle={{ color: '#cf1322' }} />
          </Col>
        </Row>
      </Card>
    </div>
  );
}
```

#### 2.2 实时日志查看器
```typescript
// renderer/LogViewer.tsx
export function LogViewer() {
  const [logs, setLogs] = useState<string[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const logRef = useRef<HTMLDivElement>(null);
  
  useEffect(() => {
    const unsubscribe = window.electronAPI.onLog((line: string) => {
      setLogs(prev => [...prev.slice(-1000), line]); // 保留最近 1000 行
      if (autoScroll) {
        logRef.current?.scrollTo(0, logRef.current.scrollHeight);
      }
    });
    return unsubscribe;
  }, [autoScroll]);
  
  return (
    <div className="log-viewer">
      <div className="toolbar">
        <Checkbox checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)}>
          自动滚动
        </Checkbox>
        <Button icon={<ClearOutlined />} onClick={() => setLogs([])}>清空</Button>
        <Button icon={<DownloadOutlined />} onClick={downloadLogs}>导出</Button>
      </div>
      <div ref={logRef} className="log-content">
        {logs.map((line, i) => (
          <div key={i} className={`log-line log-level-${getLevel(line)}`}>
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}
```

#### 2.3 任务执行历史
```typescript
// renderer/ExecutionHistory.tsx
export function ExecutionHistory() {
  const { data: history } = useQuery({
    queryKey: ['execution-history'],
    queryFn: () => window.electronAPI.getExecutionHistory({ limit: 50 }),
  });
  
  return (
    <Table
      dataSource={history}
      columns={[
        { title: '任务名称', dataIndex: 'taskName', key: 'taskName' },
        { title: '状态', dataIndex: 'status', key: 'status', render: (s) => <Badge status={getStatusBadge(s)} text={s} /> },
        { title: '开始时间', dataIndex: 'startedAt', key: 'startedAt', render: (t) => formatDate(t) },
        { title: '耗时', dataIndex: 'duration', key: 'duration', render: (d) => formatDuration(d) },
        { 
          title: '操作', 
          key: 'actions', 
          render: (_, record) => (
            <Space>
              <Button size="small" onClick={() => viewLogs(record.id)}>查看日志</Button>
              {record.status === 'FAILED' && <Button size="small" onClick={() => retry(record.id)}>重试</Button>}
            </Space>
          ),
        },
      ]}
    />
  );
}
```

---

## 3. 设置面板

### 背景
当前配置修改需要手动编辑 .env 文件，不够友好。

### 优化方案

#### 3.1 可视化设置界面
```typescript
// renderer/Settings.tsx
export function Settings() {
  const [config, setConfig] = useState<ExecutorConfig>();
  
  useEffect(() => {
    window.electronAPI.getConfig().then(setConfig);
  }, []);
  
  const handleSave = async () => {
    await window.electronAPI.updateConfig(config);
    message.success('设置已保存，将在重启后生效');
  };
  
  return (
    <Form layout="vertical">
      <Form.Item label="中台地址">
        <Input 
          value={config?.adminApiUrl} 
          onChange={(e) => setConfig({ ...config, adminApiUrl: e.target.value })} 
        />
      </Form.Item>
      
      <Form.Item label="执行器地址">
        <Input 
          value={config?.executorAddress} 
          onChange={(e) => setConfig({ ...config, executorAddress: e.target.value })} 
          addonAfter={<Button size="small" onClick={detectLocalIp}>自动检测</Button>}
        />
      </Form.Item>
      
      <Form.Item label="并发任务数">
        <Slider 
          min={1} 
          max={10} 
          value={config?.maxConcurrentTasks} 
          onChange={(v) => setConfig({ ...config, maxConcurrentTasks: v })} 
          marks={{ 1: '1', 5: '5', 10: '10' }}
        />
      </Form.Item>
      
      <Form.Item label="工作目录">
        <Input 
          value={config?.workDir} 
          onChange={(e) => setConfig({ ...config, workDir: e.target.value })} 
          addonAfter={<Button size="small" onClick={selectDirectory}>浏览</Button>}
        />
      </Form.Item>
      
      <Form.Item label="共享令牌">
        <Input.Password 
          value={config?.sharedToken} 
          onChange={(e) => setConfig({ ...config, sharedToken: e.target.value })} 
        />
      </Form.Item>
      
      <Form.Item>
        <Space>
          <Button type="primary" onClick={handleSave}>保存</Button>
          <Button onClick={() => window.electronAPI.restartExecutor()}>保存并重启</Button>
        </Space>
      </Form.Item>
    </Form>
  );
}
```

#### 3.2 首次启动向导
```typescript
// renderer/SetupWizard.tsx
export function SetupWizard() {
  const [step, setStep] = useState(0);
  const [config, setConfig] = useState<Partial<ExecutorConfig>>({});
  
  const steps = [
    {
      title: '连接中台',
      content: (
        <Form layout="vertical">
          <Form.Item label="中台地址">
            <Input 
              placeholder="http://localhost:3105" 
              value={config.adminApiUrl}
              onChange={(e) => setConfig({ ...config, adminApiUrl: e.target.value })}
            />
          </Form.Item>
          <Form.Item label="共享令牌">
            <Input.Password 
              placeholder="在中台系统设置中获取"
              value={config.sharedToken}
              onChange={(e) => setConfig({ ...config, sharedToken: e.target.value })}
            />
          </Form.Item>
          <Button onClick={testConnection}>测试连接</Button>
        </Form>
      ),
    },
    {
      title: '配置执行器',
      content: (
        <Form layout="vertical">
          <Form.Item label="执行器名称">
            <Input 
              placeholder="executor-desktop-1"
              value={config.appName}
              onChange={(e) => setConfig({ ...config, appName: e.target.value })}
            />
          </Form.Item>
          <Form.Item label="并发任务数">
            <Slider min={1} max={10} value={config.maxConcurrentTasks || 2} onChange={(v) => setConfig({ ...config, maxConcurrentTasks: v })} />
          </Form.Item>
        </Form>
      ),
    },
    {
      title: '完成',
      content: (
        <Result
          status="success"
          title="配置完成！"
          subTitle="执行器将在后台运行，你可以从系统托盘访问它。"
          extra={<Button type="primary" onClick={finishSetup}>开始使用</Button>}
        />
      ),
    },
  ];
  
  return (
    <div className="setup-wizard">
      <Steps current={step}>
        {steps.map(s => <Steps.Step key={s.title} title={s.title} />)}
      </Steps>
      <div className="step-content">{steps[step].content}</div>
    </div>
  );
}
```

---

## 4. 自动更新

### 背景
当前没有自动更新机制，用户需要手动下载新版本。

### 优化方案

#### 4.1 集成 electron-updater
```typescript
// main/updater.ts
import { autoUpdater } from 'electron-updater';

export function setupAutoUpdater() {
  autoUpdater.checkForUpdatesAndNotify();
  
  autoUpdater.on('update-available', (info) => {
    dialog.showMessageBox({
      type: 'info',
      title: '发现新版本',
      message: `发现新版本 ${info.version}，正在后台下载...`,
      buttons: ['好的'],
    });
  });
  
  autoUpdater.on('update-downloaded', (info) => {
    dialog.showMessageBox({
      type: 'info',
      title: '更新已就绪',
      message: `版本 ${info.version} 已下载完成，是否立即重启应用？`,
      buttons: ['稍后', '立即重启'],
    }).then((result) => {
      if (result.response === 1) {
        autoUpdater.quitAndInstall();
      }
    });
  });
  
  // 每 6 小时检查一次
  setInterval(() => autoUpdater.checkForUpdates(), 6 * 60 * 60 * 1000);
}
```

#### 4.2 更新日志展示
```typescript
// renderer/UpdateNotification.tsx
export function UpdateNotification() {
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  
  useEffect(() => {
    const unsubscribe = window.electronAPI.onUpdateAvailable((info) => {
      setUpdateInfo(info);
    });
    return unsubscribe;
  }, []);
  
  if (!updateInfo) return null;
  
  return (
    <Alert
      type="info"
      message={`发现新版本 ${updateInfo.version}`}
      description={
        <div>
          <ReactMarkdown>{updateInfo.releaseNotes}</ReactMarkdown>
          <Button onClick={() => window.electronAPI.downloadUpdate()}>立即更新</Button>
        </div>
      }
      closable
    />
  );
}
```

---

## 5. 诊断工具

### 背景
当执行器出现问题时，缺少诊断信息。

### 优化方案

#### 5.1 健康检查面板
```typescript
// renderer/HealthCheck.tsx
export function HealthCheck() {
  const { data: health } = useQuery({
    queryKey: ['health'],
    queryFn: () => window.electronAPI.runHealthCheck(),
    refetchInterval: 10000, // 每 10 秒刷新
  });
  
  const checks = [
    { name: '中台连接', status: health?.adminApiReachable, detail: health?.adminApiUrl },
    { name: 'Python 可用', status: health?.pythonAvailable, detail: health?.pythonVersion },
    { name: 'Node.js 可用', status: health?.nodeAvailable, detail: health?.nodeVersion },
    { name: '工作目录可写', status: health?.workDirWritable, detail: health?.workDir },
    { name: '磁盘空间', status: health?.diskSpaceSufficient, detail: `${health?.diskFreeGB}GB 可用` },
  ];
  
  return (
    <List
      dataSource={checks}
      renderItem={(item) => (
        <List.Item>
          <List.Item.Meta
            avatar={item.status ? <CheckCircleOutlined style={{ color: 'green' }} /> : <CloseCircleOutlined style={{ color: 'red' }} />}
            title={item.name}
            description={item.detail}
          />
        </List.Item>
      )}
    />
  );
}
```

#### 5.2 导出诊断报告
```typescript
// main/diagnostics.ts
export async function exportDiagnosticReport(): Promise<string> {
  const report = {
    timestamp: new Date().toISOString(),
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    config: getConfig(),
    health: await runHealthCheck(),
    recentLogs: getRecentLogs(100),
    recentExecutions: await getRecentExecutions(10),
    systemInfo: {
      cpus: os.cpus().length,
      totalMemory: os.totalmem(),
      freeMemory: os.freemem(),
    },
  };
  
  const reportPath = join(app.getPath('temp'), `diagnostic-${Date.now()}.json`);
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  return reportPath;
}
```

---

## 6. 多语言支持

### 背景
当前只有中文界面。

### 优化方案

#### 6.1 i18n 集成
```typescript
// renderer/i18n.ts
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: {
        translation: {
          'dashboard.status': 'Status',
          'dashboard.running': 'Running',
          'dashboard.today': 'Today',
        },
      },
      zh: {
        translation: {
          'dashboard.status': '状态',
          'dashboard.running': '运行中',
          'dashboard.today': '今日',
        },
      },
    },
    lng: 'zh',
    fallbackLng: 'en',
  });

// 使用
const { t } = useTranslation();
<Statistic title={t('dashboard.status')} value={status} />
```

---

## 实施路线图

### 阶段 1（本月）
- [ ] 1.1 托盘右键菜单扩展
- [ ] 1.2 气泡通知
- [ ] 2.1 仪表盘视图
- [ ] 3.1 可视化设置界面

### 阶段 2（下月）
- [ ] 1.3 动态托盘图标
- [ ] 2.2 实时日志查看器
- [ ] 3.2 首次启动向导
- [ ] 5.1 健康检查面板

### 阶段 3（下季度）
- [ ] 2.3 任务执行历史
- [ ] 4.1-4.2 自动更新
- [ ] 5.2 诊断报告
- [ ] 6.1 多语言支持

## 依赖项

- `electron-updater`: 自动更新
- `react-i18next`: 国际化
- `react-markdown`: 更新日志渲染

## 验收标准

- [ ] 所有新增功能有 E2E 测试（Playwright）
- [ ] 打包体积 < 150MB
- [ ] 启动时间 < 2 秒
- [ ] 托盘菜单响应 < 100ms

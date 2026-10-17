# 前端用户体验优化计划

**优先级**: 中  
**预计工作量**: 5-8 人天  
**目标**: 提升 admin-web 的用户体验、可访问性和性能

---

## 1. 竞态与加载状态优化

### 背景
P2 修复了 4 个前端竞态问题，但还有改进空间。

### 优化方案

#### 1.1 统一的加载骨架屏
```typescript
// components/PageSkeleton.tsx
export function PageSkeleton({ type }: { type: 'list' | 'detail' | 'form' }) {
  if (type === 'list') {
    return (
      <Card>
        <Skeleton active paragraph={{ rows: 8 }} />
      </Card>
    );
  }
  // ... 其他类型
}

// 使用示例
if (isLoading) return <PageSkeleton type="list" />;
```

**改进点**:
- 替换现有的 `<Spin />`，提供内容结构预览
- 减少布局跳动（layout shift）

#### 1.2 乐观更新模式统一化
```typescript
// hooks/useOptimisticUpdate.ts
export function useOptimisticUpdate<T>(
  queryKey: QueryKey,
  mutateFn: (data: T) => Promise<void>,
) {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: mutateFn,
    onMutate: async (newData) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<T>(queryKey);
      queryClient.setQueryData(queryKey, newData);
      return { previous };
    },
    onError: (err, newData, context) => {
      queryClient.setQueryData(queryKey, context?.previous);
      message.error('操作失败，已回滚');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey });
    },
  });
}

// 使用示例
const updateTask = useOptimisticUpdate(['task', taskId], async (updated) => {
  await tasksApi.update(taskId, updated);
});
```

**改进点**:
- 统一乐观更新模式，减少重复代码
- 失败自动回滚 + 用户提示

#### 1.3 请求去重与缓存策略
```typescript
// api/client.ts
const dedupedClient = axios.create({
  adapter: cacheAdapter({
    maxAge: 5000, // 5 秒内相同请求返回缓存
    exclude: { method: 'post' | 'put' | 'delete' },
  }),
});

// 使用示例
export const tasksApi = {
  list: (params) => dedupedClient.get('/api/tasks', { params }),
};
```

**改进点**:
- 防止快速连点导致的重复请求
- 减少服务器负载

---

## 2. 表单体验增强

### 背景
当前表单缺少实时校验、自动保存等现代表单特性。

### 优化方案

#### 2.1 实时字段校验（debounced）
```typescript
// TaskFormPage.tsx
const [nameError, setNameError] = useState<string>();
const debouncedCheckName = useMemo(
  () => debounce(async (name: string) => {
    if (!name) return;
    try {
      await tasksApi.checkNameAvailable(name);
      setNameError(undefined);
    } catch {
      setNameError('任务名称已存在');
    }
  }, 500),
  [],
);

<Form.Item 
  label="任务名称" 
  validateStatus={nameError ? 'error' : ''}
  help={nameError}
>
  <Input onChange={(e) => debouncedCheckName(e.target.value)} />
</Form.Item>
```

#### 2.2 自动保存草稿
```typescript
// hooks/useAutoSaveDraft.ts
export function useAutoSaveDraft<T>(
  key: string,
  data: T,
  interval = 30000, // 30 秒
) {
  useEffect(() => {
    const timer = setInterval(() => {
      if (Object.keys(data).length > 0) {
        localStorage.setItem(`draft_${key}`, JSON.stringify(data));
        message.success('草稿已自动保存', 1);
      }
    }, interval);
    return () => clearInterval(timer);
  }, [key, data, interval]);
  
  // 恢复草稿
  const restoreDraft = useCallback(() => {
    const saved = localStorage.getItem(`draft_${key}`);
    return saved ? JSON.parse(saved) : null;
  }, [key]);
  
  return { restoreDraft };
}
```

#### 2.3 表单进度指示
```typescript
// TaskFormPage.tsx
const totalSteps = ['基本信息', '触发条件', '执行配置', '通知设置'];
const [currentStep, setCurrentStep] = useState(0);

<Steps current={currentStep}>
  {totalSteps.map(title => <Steps.Step key={title} title={title} />)}
</Steps>

<div style={{ marginTop: 24 }}>
  {currentStep === 0 && <BasicInfoForm />}
  {currentStep === 1 && <TriggerForm />}
  {currentStep === 2 && <ExecutionForm />}
  {currentStep === 3 && <NotificationForm />}
</div>

<div style={{ marginTop: 24 }}>
  {currentStep > 0 && <Button onClick={() => setCurrentStep(c => c - 1)}>上一步</Button>}
  {currentStep < totalSteps.length - 1 && <Button type="primary" onClick={() => setCurrentStep(c => c + 1)}>下一步</Button>}
  {currentStep === totalSteps.length - 1 && <Button type="primary" onClick={handleSubmit}>提交</Button>}
</div>
```

---

## 3. 执行日志查看器增强

### 背景
当前 ExecutionLogSection 已支持 SSE 流，但还可以更强大。

### 优化方案

#### 3.1 日志级别过滤
```typescript
// ExecutionLogSection.tsx
const [levelFilter, setLevelFilter] = useState<Set<string>>(new Set(['INFO', 'WARN', 'ERROR']));
const filteredLines = logLines.filter(line => {
  const level = line.match(/\[(INFO|WARN|ERROR|DEBUG)\]/)?.[1];
  return !level || levelFilter.has(level);
});

<Space>
  <Checkbox.Group value={[...levelFilter]} onChange={(checked) => setLevelFilter(new Set(checked))}>
    <Checkbox value="DEBUG">Debug</Checkbox>
    <Checkbox value="INFO">Info</Checkbox>
    <Checkbox value="WARN">Warn</Checkbox>
    <Checkbox value="ERROR">Error</Checkbox>
  </Checkbox.Group>
</Space>
```

#### 3.2 日志语法高亮
```typescript
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';

function LogLine({ line }: { line: string }) {
  // 检测 JSON 行
  if (line.trim().startsWith('{')) {
    try {
      const json = JSON.parse(line);
      return (
        <SyntaxHighlighter language="json" style={vscDarkPlus}>
          {JSON.stringify(json, null, 2)}
        </SyntaxHighlighter>
      );
    } catch {}
  }
  
  // 正则高亮
  return (
    <div>
      {line.replace(/\[ERROR\]/g, '<span style="color:red">[ERROR]</span>')}
    </div>
  );
}
```

#### 3.3 日志下载与分享
```typescript
const downloadLogs = () => {
  const blob = new Blob([logLines.join('\n')], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `execution-${executionId}-${Date.now()}.log`;
  a.click();
};

<Tooltip title="下载日志">
  <Button icon={<DownloadOutlined />} onClick={downloadLogs} />
</Tooltip>
```

---

## 4. Dashboard 可视化增强

### 背景
当前 DashboardPage 只有基础指标卡片，缺少趋势图表。

### 优化方案

#### 4.1 执行趋势图（最近 24 小时）
```typescript
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';

const { data: trends } = useQuery({
  queryKey: ['execution-trends'],
  queryFn: () => metricsApi.getExecutionTrends({ hours: 24 }),
});

<Card title="执行趋势（最近 24 小时）">
  <LineChart width={600} height={300} data={trends}>
    <CartesianGrid strokeDasharray="3 3" />
    <XAxis dataKey="hour" />
    <YAxis />
    <Tooltip />
    <Legend />
    <Line type="monotone" dataKey="success" stroke="#52c41a" name="成功" />
    <Line type="monotone" dataKey="failed" stroke="#ff4d4f" name="失败" />
    <Line type="monotone" dataKey="running" stroke="#1890ff" name="运行中" />
  </LineChart>
</Card>
```

#### 4.2 执行器健康热力图
```typescript
import { HeatMapGrid } from 'react-grid-heatmap';

const executorHealth = executors.map(e => ({
  name: e.address,
  load: e.runningTaskCount / e.maxConcurrentTasks,
}));

<Card title="执行器负载热力图">
  <HeatMapGrid
    data={executorHealth.map(e => [e.load])}
    xLabels={executorHealth.map(e => e.name)}
    yLabels={['负载']}
    cellRender={(x, y, value) => (
      <div style={{ backgroundColor: getHeatColor(value) }}>
        {(value * 100).toFixed(0)}%
      </div>
    )}
  />
</Card>
```

#### 4.3 任务成功率饼图
```typescript
import { PieChart, Pie, Cell } from 'recharts';

const taskSuccessRate = [
  { name: '成功', value: stats.successCount, color: '#52c41a' },
  { name: '失败', value: stats.failedCount, color: '#ff4d4f' },
  { name: '超时', value: stats.timeoutCount, color: '#faad14' },
];

<Card title="任务成功率">
  <PieChart width={300} height={300}>
    <Pie data={taskSuccessRate} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} label>
      {taskSuccessRate.map((entry, index) => (
        <Cell key={`cell-${index}`} fill={entry.color} />
      ))}
    </Pie>
    <Tooltip />
  </PieChart>
</Card>
```

---

## 5. 可访问性（A11y）改进

### 背景
当前应用缺少键盘导航、屏幕阅读器支持等无障碍特性。

### 优化方案

#### 5.1 键盘快捷键
```typescript
// hooks/useGlobalKeyboard.ts
export function useGlobalKeyboard() {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ctrl+K: 打开命令面板
      if (e.ctrlKey && e.key === 'k') {
        e.preventDefault();
        commandPalette.open();
      }
      // Ctrl+/: 显示快捷键帮助
      if (e.ctrlKey && e.key === '/') {
        e.preventDefault();
        showKeyboardHelp();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
}

// App.tsx
function App() {
  useGlobalKeyboard();
  return <RouterProvider router={router} />;
}
```

#### 5.2 ARIA 属性补充
```typescript
// ExecutionsPage.tsx
<Table
  dataSource={executions}
  aria-label="执行记录列表"
  aria-describedby="executions-description"
/>
<div id="executions-description" className="sr-only">
  共 {total} 条执行记录，当前显示第 {(page-1)*pageSize + 1} 到 {Math.min(page*pageSize, total)} 条
</div>
```

#### 5.3 焦点管理
```typescript
// Modal 打开时自动聚焦到第一个输入框
const firstInputRef = useRef<InputRef>(null);
useEffect(() => {
  if (visible) {
    setTimeout(() => firstInputRef.current?.focus(), 100);
  }
}, [visible]);

<Modal visible={visible} onCancel={onClose}>
  <Input ref={firstInputRef} placeholder="任务名称" />
</Modal>
```

---

## 6. 性能优化

### 背景
大列表渲染、重复渲染等性能问题。

### 优化方案

#### 6.1 虚拟滚动（大列表）
```typescript
import { VariableSizeList } from 'react-window';

function ExecutionsList({ executions }: { executions: Execution[] }) {
  return (
    <VariableSizeList
      height={600}
      itemCount={executions.length}
      itemSize={(index) => 80} // 每行高度
      width="100%"
    >
      {({ index, style }) => (
        <div style={style}>
          <ExecutionCard execution={executions[index]} />
        </div>
      )}
    </VariableSizeList>
  );
}
```

**适用场景**: ExecutionsPage、TaskListPage 当 total > 100 时

#### 6.2 组件懒加载
```typescript
// router.tsx
const ExecutionDetailPage = lazy(() => import('./pages/ExecutionDetailPage'));
const TaskFormPage = lazy(() => import('./pages/TaskFormPage'));

<Route 
  path="/executions/:id" 
  element={
    <Suspense fallback={<PageSkeleton type="detail" />}>
      <ExecutionDetailPage />
    </Suspense>
  } 
/>
```

#### 6.3 useMemo 优化计算密集型组件
```typescript
// DashboardPage.tsx
const sortedExecutors = useMemo(() => {
  return [...executors].sort((a, b) => b.runningTaskCount - a.runningTaskCount);
}, [executors]);

const healthyCount = useMemo(() => {
  return executors.filter(e => e.status === 'online').length;
}, [executors]);
```

---

## 7. 移动端适配

### 背景
当前应用在移动端体验较差。

### 优化方案

#### 7.1 响应式布局
```typescript
// Layout.tsx
const isMobile = useMediaQuery({ maxWidth: 768 });

<Layout>
  {isMobile ? (
    <Drawer visible={menuVisible} onClose={() => setMenuVisible(false)}>
      <Menu />
    </Drawer>
  ) : (
    <Sider><Menu /></Sider>
  )}
  <Layout.Content>{children}</Layout.Content>
</Layout>
```

#### 7.2 触摸友好的操作
```typescript
// ExecutionCard.tsx (移动端)
<SwipeableListItem
  onSwipeLeft={() => handleStop()}
  onSwipeRight={() => handleRetry()}
>
  <ExecutionCard />
</SwipeableListItem>
```

---

## 实施路线图

### 阶段 1（本月）
- [ ] 1.1 统一加载骨架屏
- [ ] 1.2 乐观更新模式统一化
- [ ] 2.1 实时字段校验
- [ ] 3.1 日志级别过滤

### 阶段 2（下月）
- [ ] 2.2 自动保存草稿
- [ ] 3.2 日志语法高亮
- [ ] 3.3 日志下载
- [ ] 4.1 执行趋势图

### 阶段 3（下季度）
- [ ] 2.3 表单进度指示
- [ ] 4.2-4.3 健康热力图 + 成功率饼图
- [ ] 5.1-5.3 可访问性改进
- [ ] 6.1-6.3 性能优化
- [ ] 7.1-7.2 移动端适配

## 依赖项

- `react-window`: 虚拟滚动
- `recharts`: 图表库
- `react-syntax-highlighter`: 语法高亮
- `react-swipeable-list`: 移动端滑动操作

## 验收标准

- [ ] Lighthouse 性能分数 > 90
- [ ] WCAG 2.1 AA 级无障碍达标
- [ ] 移动端 Chrome DevTools 设备模拟测试通过

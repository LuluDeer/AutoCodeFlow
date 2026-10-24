import { useState, useEffect, useCallback, useRef } from 'react';
// MODAL-01：命令式 Modal 从 utils/modal 取（吃暗色主题 + i18n locale）；
// R1（部署模型评审 §4.2）的下发弹窗是带勾选状态的受控 <Modal> 组件（在 React
// 树内，本就消费主题/locale），按 utils/modal 头注从 antd 导入为 AntdModal。
import { Modal } from '../utils/modal';
import { Modal as AntdModal,
  Checkbox,
  Descriptions,
  Badge,
  Card,
  Table,
  Button,
  Space,
  Tag,
  Typography,
  Spin,
  Empty,
  Row,
  Col,
  Collapse,
  Tooltip,
  Tabs,
  Form,
  Input,
  Select,
  Statistic,
  Alert,
  theme } from 'antd';
import { message } from '../utils/toast';
import {
  ArrowLeftOutlined, SyncOutlined, ReloadOutlined, GithubOutlined,
  SaveOutlined, HistoryOutlined,
  RocketOutlined, RobotOutlined,
} from '@ant-design/icons';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom';
import {
  applicationsApi,
  deploymentsApi,
  Application,
  VersionHistoryEntry,
  AppReleaseRow,
  AppDeploymentEventRow,
  AppDeployment,
  DeployVersionResult,
} from '../api/applications';
import { aiApi, AppHealthReport } from '../api/ai';
import { tasksApi, Task } from '../api/tasks';
import AppDeploymentPage from './AppDeploymentPage';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { getErrMsg, isFormValidationError, isNotFoundError, showApiError } from '../utils/error';
// UX-06：触发方式 / 版本状态的展示标签唯一事实源（此前直接渲染裸枚举）。
import { triggerLabel, releaseStatusLabel, TRIGGER_COLOR } from '../utils/trigger-label';
// D-P2-02b（设计审计 2026-09-22）：runtime 读面走唯一事实源 runtimeLabel
// （与筛选下拉同源；未知值回退原始 token）。
import { runtimeLabel } from '../utils/runtime-label';
import { useRaceGuard } from '../utils/raceGuard';
// D-P2-09：时间格式化统一走共享 formatDateTime（与全站同源）。
import { formatDateTime } from '../utils/timeFormat';
// P3 审计：应用/发布部署状态 → Tag color 映射收敛到单一事实源
import { APPLICATION_STATUS_COLOR, RELEASE_DEPLOY_STATUS_COLOR } from '../utils/status-color';
import { useAuthStore, isAdminUser } from '../store/auth';
import PageHeader from '../components/PageHeader';
import PageSkeleton from '../components/PageSkeleton';
import StateError from '../components/StateError';
import { useExecutorNames } from '../hooks/useExecutorNames';

/**
 * W3 RBAC（对齐 settings 页先例）：应用详情页内的写操作——同步任务、保存应用设置、
 * 回滚、AI 分析——后端已收紧为 @Roles(ADMIN)。普通用户按钮禁用并提示（读面保持可见）。
 */
function useIsAdmin() {
  const user = useAuthStore((s) => s.user);
  return isAdminUser(user);
}

// ─── AI Analysis Tab ────────────────────────────────────────────────────────────
function AiAnalysisTab({ appId }: { appId: string }) {
  const { t } = useTranslation();
  // F-15（DEEP_REVIEW 0ef3bbe）：主色/成功率语义色走 antd token，暗色主题自适应。
  const { token } = theme.useToken();
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<AppHealthReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isAdmin = useIsAdmin();

  const runAnalysis = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await aiApi.analyzeApp(appId);
      setReport(result);
    } catch (err: unknown) {
      setError(getErrMsg(err, t('appDetail.ai.analyzeFail')));
    } finally {
      setLoading(false);
    }
  }, [appId]);

  return (
    <Card
      title={<span><RobotOutlined /> {t('appDetail.ai.title')}</span>}
      extra={(
        <Tooltip title={isAdmin ? undefined : t('appDetail.ai.adminOnly')}>
          <Button icon={<ReloadOutlined />} onClick={runAnalysis} loading={loading} disabled={!isAdmin}>{t('appDetail.ai.reanalyze')}</Button>
        </Tooltip>
      )}
    >
      {!report && !loading && !error && (
        <Empty
          description={t('appDetail.ai.empty')}
          image={<RobotOutlined style={{ fontSize: 48, color: token.colorPrimary }} />}
        >
          <Tooltip title={isAdmin ? undefined : t('appDetail.ai.adminOnly')}>
            <Button type="primary" icon={<RobotOutlined />} onClick={runAnalysis} disabled={!isAdmin}>{t('appDetail.ai.start')}</Button>
          </Tooltip>
        </Empty>
      )}
      {loading && <div style={{ textAlign: 'center', padding: 40 }}><Spin description={t('appDetail.ai.analyzing')} size="large" /></div>}
      {error && <Alert type="error" title={error} showIcon />}
      {report && !loading && (
        <div>
          {/* UI 打磨：三张统计卡加断点并等高——写死 span={8} 在窄容器
              （Tab 内 Card）里三块各 1/3 宽互相截断 */}
          <Row gutter={[16, 16]} align="stretch" style={{ marginBottom: 24 }}>
            <Col xs={24} sm={8}>
              <Card size="small" style={{ height: '100%' }}>
                <Statistic title={t('appDetail.ai.stat.tasks')} value={report.stats.totalTasks} />
              </Card>
            </Col>
            <Col xs={24} sm={8}>
              <Card size="small" style={{ height: '100%' }}>
                <Statistic
                  title={t('appDetail.ai.stat.successRate')}
                  value={report.stats.avgSuccessRate}
                  suffix="%"
                  styles={{ content: { color: report.stats.avgSuccessRate >= 90 ? token.colorSuccess : report.stats.avgSuccessRate >= 70 ? token.colorWarning : token.colorError } }}
                />
              </Card>
            </Col>
            <Col xs={24} sm={8}>
              <Card size="small" style={{ height: '100%' }}>
                <Statistic title={t('appDetail.ai.stat.avgDuration')} value={report.stats.avgDuration ? `${(report.stats.avgDuration / 1000).toFixed(1)}s` : '-'} />
              </Card>
            </Col>
          </Row>
          {(report.stats.criticalTasks?.length ?? 0) > 0 && (
            <Card size="small" title={t('appDetail.ai.criticalTasks')} style={{ marginBottom: 16 }}>
              {report.stats.criticalTasks.map((name) => (
                <div key={name} style={{ marginBottom: 4 }}>
                  <Tag color="red">{t('appDetail.ai.lowSuccessRate')}</Tag>
                  <span>{name}</span>
                </div>
              ))}
            </Card>
          )}
          {report.analysis && (
            <Alert
              type="info"
              title={t('appDetail.ai.conclusion')}
              description={<pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, maxHeight: 240, overflow: 'auto' }}>{report.analysis}</pre>}
              showIcon
              icon={<RobotOutlined />}
            />
          )}
        </div>
      )}
    </Card>
  );
}

const { Text } = Typography;

const STATUS_LABELS = (t: (k: string) => string): Record<string, string> => ({
  active: t('appDetail.status.active'), deploying: t('appDetail.status.deploying'), failed: t('appDetail.status.failed'),
});

const RUNTIME_OPTIONS = [
  { value: 'python', label: 'Python' },
  { value: 'node', label: 'Node.js' },
  { value: 'shell', label: 'Shell' },
];

const GIT_URL_RE = /^(https?:\/\/[\w.@:/~_-]+\.git|git@[\w.-]+:[\w./_-]+\.git)$/;

// ─── Overview Tab ─────────────────────────────────────────────────────────────
function OverviewTab({ app }: { app: Application }) {
  const { t } = useTranslation();
  return (
    <Space orientation="vertical" size={16} style={{ width: '100%' }}>
      <Card title={t('appDetail.info')}>
        <Descriptions bordered size="small" column={{ xs: 1, sm: 2, md: 3 }}>
          <Descriptions.Item label={t('appDetail.field.version')}><Tag color="blue">{app.version}</Tag></Descriptions.Item>
          <Descriptions.Item label={t('appDetail.field.runtime')}><Tag>{runtimeLabel(app.runtime, t)}</Tag></Descriptions.Item>
          <Descriptions.Item label={t('appDetail.field.status')}>
            <Tag color={APPLICATION_STATUS_COLOR[app.status] || 'default'}>{STATUS_LABELS(t)[app.status] || app.status}</Tag>
          </Descriptions.Item>
          {app.description && (
            // antd 6.6.5+：span="filled" 表达「独占整行」——原 span={3} 在
            // xs(1 列)/sm(2 列) 断点超出列数，命中 rc Descriptions 的
            // 「Sum of column span not match column」告警，且 sm 下描述会被
            // 钳制挤压进「状态」同行半格。filled 在各断点均填满当前行，
            // 渲染产物与 md 语义一致。
            <Descriptions.Item label={t('appDetail.field.description')} span="filled">{app.description}</Descriptions.Item>
          )}
          {app.gitRepo && (
            // 断点 span（antd 6.6.5+）：sm 及以上占 2/3（与分支同行），xs 收敛
            // 为 1——原写死 span={2} 在 xs 单列超出列数触发同款告警。
            <Descriptions.Item label={t('appDetail.field.gitRepo')} span={{ sm: 2 }}>
              <Space style={{ maxWidth: '100%' }} size={4}>
                <GithubOutlined style={{ flex: 'none' }} />
                <Text copyable={{ text: app.gitRepo }} ellipsis style={{ maxWidth: '100%' }}>
                  <a
                    href={app.gitRepo.startsWith('http') ? app.gitRepo : '#'}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={app.gitRepo}
                    style={{ display: 'inline-block', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom' }}
                  >
                    {app.gitRepo}
                  </a>
                </Text>
              </Space>
            </Descriptions.Item>
          )}
          {app.gitBranch && <Descriptions.Item label={t('appDetail.field.gitBranch')}><Tag>{app.gitBranch}</Tag></Descriptions.Item>}
          {app.gitCommit && (
            <Descriptions.Item label={t('appDetail.field.commit')}><Text code>{app.gitCommit.slice(0, 8)}</Text></Descriptions.Item>
          )}
          {app.entrypoint && (
            <Descriptions.Item label={t('appDetail.field.entrypoint')}><Text code>{app.entrypoint}</Text></Descriptions.Item>
          )}
          <Descriptions.Item label={t('appDetail.field.createdAt')}>
            {app.createdAt ? formatDateTime(app.createdAt) : '-'}
          </Descriptions.Item>
          <Descriptions.Item label={t('appDetail.field.updatedAt')}>
            {app.updatedAt ? formatDateTime(app.updatedAt) : '-'}
          </Descriptions.Item>
        </Descriptions>

        {app.env && Object.keys(app.env).length > 0 && (
          // antd 6：Collapse 子元素式（Collapse.Panel）已弃用，迁 items API
          //（header→label，渲染产物一致）
          <Collapse
            ghost
            style={{ marginTop: 12 }}
            items={[{
              key: 'env',
              label: t('appDetail.env', { count: Object.keys(app.env).length }),
              children: (
                <Descriptions bordered size="small" column={1}>
                  {Object.entries(app.env).map(([k, v]) => (
                    <Descriptions.Item key={k} label={<Text code>{k}</Text>}>{v}</Descriptions.Item>
                  ))}
                </Descriptions>
              ),
            }]}
          />
        )}
      </Card>

      {app.manifest && (
        <Card title={t('appDetail.manifest')}>
          <Collapse
            ghost
            items={[{
              key: 'manifest',
              label: t('appDetail.viewDetail'),
              children: (
                <pre style={{
                  // UI-02：清单 pre 块双主题（同 SSE 日志区变量）
                  background: 'var(--log-bg)', color: 'var(--log-text)', padding: 16,
                  borderRadius: 8, maxHeight: 300, overflow: 'auto', fontSize: 13,
                  fontFamily: 'var(--font-mono)',
                }}>
                  {JSON.stringify(app.manifest, null, 2)}
                </pre>
              ),
            }]}
          />
        </Card>
      )}
    </Space>
  );
}

// ─── Tasks Tab ─────────────────────────────────────────────────────────────────
function TasksTab({ appId, syncing, onSync }: { appId: string; syncing: boolean; onSync: () => void }) {
  const nav = useNavigate();
  const { t } = useTranslation();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(false);
  // 网络性能审计（2026-09-18）：任务列表从「pageSize:100 全量拉取 + 客户端翻页」
  // 改为服务端分页（pageSize:20）——100 行无虚拟化渲染开销大，且应用内任务
  // 超过 100 时旧逻辑直接丢失第 100 条之后的条目。
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  // UX-05（本轮体验审查）：此前失败只弹一条 message，tasks 保持 []，于是下面
  // `tasks.length === 0 && !loading` 分支渲染「暂无任务」+「创建第一个任务」
  // 引导按钮——**把读取失败谎报成"没有数据"**。message 几秒后消失，用户据此
  // 以为真没任务，很可能重复创建。现记录失败态并在原位渲染 StateError（带重试）。
  const [loadError, setLoadError] = useState<unknown>(null);
  const isAdmin = useIsAdmin();
  const requestControllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  const fetchTasks = useCallback(async (pageNum: number) => {
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    setLoading(true);
    setLoadError(null);
    try {
      const res = await tasksApi.list(
        { page: pageNum, pageSize: 20, applicationId: appId },
        controller.signal,
      );
      if (!controller.signal.aborted && mountedRef.current) {
        setTasks(res.items ?? []);
        setTotal(res.total ?? 0);
      }
    } catch (err: unknown) {
      if (!controller.signal.aborted && mountedRef.current) {
        // UX-05：不再只弹 message——失败态要能落到页内，否则空列表会被读成
        // 「这个应用确实没有任务」。
        setLoadError(err);
      }
    } finally {
      if (mountedRef.current && requestControllerRef.current === controller) {
        requestControllerRef.current = null;
        setLoading(false);
      }
    }
  }, [appId]);

  useEffect(() => {
    mountedRef.current = true;
    // appId 变化（或首次挂载）回到第一页重新拉取
    setPage(1);
    fetchTasks(1);
    return () => {
      mountedRef.current = false;
      requestControllerRef.current?.abort();
      requestControllerRef.current = null;
    };
  }, [fetchTasks]);

  return (
    <Card
      variant="borderless"
      extra={
        <Space>
          <Tooltip title={isAdmin ? t('appDetail.tasks.syncTooltip') : t('appDetail.tasks.syncAdminOnly')}>
            <Button loading={syncing} icon={<SyncOutlined />} onClick={onSync} size="small" disabled={!isAdmin}>{t('appDetail.tasks.sync')}</Button>
          </Tooltip>
          <Button type="primary" size="small" onClick={() => nav(`/tasks/new?applicationId=${appId}`)}>{t('appDetail.tasks.create')}</Button>
          <Button icon={<ReloadOutlined />} size="small" onClick={() => fetchTasks(page)}>{t('appDetail.refresh')}</Button>
        </Space>
      }
    >
      {loadError ? (
        // UX-05：读取失败必须与原位「暂无任务」区分——否则用户会把失败读成
        // 「确实没有任务」并重复创建。
        <StateError
          error={loadError}
          onRetry={() => fetchTasks(page)}
          title={t('appDetail.tasks.loadFail')}
        />
      ) : tasks.length === 0 && !loading ? (
        <Empty description={t('appDetail.tasks.empty')}>
          <Button type="primary" size="small" onClick={() => nav(`/tasks/new?applicationId=${appId}`)}>{t('appDetail.tasks.createFirst')}</Button>
        </Empty>
      ) : (
        <Table<Task>
          columns={[
            {
              title: t('appDetail.tasks.col.name'),
              dataIndex: 'name',
              // O-19：virtual 滚动要求行高恒定——长任务名换行可变高会导致虚拟列表
              // 行错位，故 name 列单行省略（antd ellipsis 自带 title tooltip，长名
              // 悬停可见全文）。
              ellipsis: true,
              // F-33（DEEP_REVIEW 0ef3bbe）：原 <a onClick> 无 href（键盘不可达/读屏不识别），
              // 改 react-router <Link>——渲染真实 href + SPA 跳转，视觉/行为不变。
              render: (n: string, r: Task) => <Link to={`/tasks/${r.id}`}>{n}</Link>,
            },
            {
              title: t('appDetail.tasks.col.status'), dataIndex: 'status', width: 100,
              render: (s: string) => (
                <Badge status={s === 'active' ? 'success' : s === 'paused' ? 'warning' : 'default'}
                  text={s === 'active' ? t('appDetail.tasks.status.running') : s === 'paused' ? t('appDetail.tasks.status.paused') : s} />
              ),
            },
            {
              title: t('appDetail.tasks.col.trigger'), key: 'trigger', width: 90,
              render: (_: unknown, r: Task) => (
                // UX-06：此前直接渲染裸枚举（cron / fixed_rate / manual），
                // 而同一张表的「状态」列已走 t()——中英混排且对非英语用户
                // 不可读。收敛到 utils/trigger-label.ts 的唯一事实源。
                <Tag color={TRIGGER_COLOR[r.triggerType] || 'default'}>
                  {triggerLabel(r.triggerType, t) || '-'}
                </Tag>
              ),
            },
            { title: t('appDetail.tasks.col.runtime'), dataIndex: 'runtime', width: 80, render: (v: string) => v ? <Tag color="blue">{runtimeLabel(v, t)}</Tag> : '-' },
          ]}
          dataSource={tasks}
          rowKey="id" loading={loading} size="small"
          pagination={{
            current: page,
            pageSize: 20,
            total,
            showSizeChanger: false,
            showTotal: (n) => t('appDetail.tasks.total', { count: n }),
            onChange: (p) => { setPage(p); fetchTasks(p); },
          }}
          // O-19：高频任务表启用 antd 内置 virtual 滚动——固定视口高度 + 固定
          // 行高（small≈39px × 10 行 ≈ 400），仅渲染可视区行。网络性能审计
          // （2026-09-18）：API 已从 pageSize=100 全量改为服务端分页
          // pageSize=20（见 fetchTasks），virtual 继续兜底单页渲染。
          virtual
          scroll={{ y: 400 }}
        />
      )}
    </Card>
  );
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────
function SettingsTab({ app, onUpdated }: { app: Application; onUpdated: (a: Application) => void }) {
  const [form] = Form.useForm();
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);
  const isAdmin = useIsAdmin();

  useEffect(() => {
    form.setFieldsValue({
      description: app.description, version: app.version,
      runtime: app.runtime, gitRepo: app.gitRepo, gitBranch: app.gitBranch,
      gitCommit: app.gitCommit, entrypoint: app.entrypoint,
    });
  }, [app, form]);

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      setSaving(true);
      // name 为不可变标识：UpdateApplicationDto 未声明 name 字段，
      // 带上会被全局 ValidationPipe（forbidNonWhitelisted）以 400 拒绝
      delete (values as { name?: string }).name;
      const updated = await applicationsApi.update(app.id, values);
      message.success(t('appDetail.settings.saved'));
      onUpdated(updated);
    } catch (err: unknown) {
      if (isFormValidationError(err)) return;
      // 排查清单 #2/#4 对齐（ExecutorDetailPage UX-11 同款先例）：此前直接
      // message.error(通用文案)——一是因为绕过 showApiError 的 __toastedByClient
      // 去重，与 client.ts 拦截器的全局 toast 连弹两条；二是把后端给出的具体
      // 拒因（如版本号冲突 409）吞成一句"保存失败"。
      showApiError(err, t('appDetail.settings.saveFail'));
    } finally { setSaving(false); }
  };

  return (
    // UI 打磨（用户反馈）：去掉 maxWidth 620——设置 Tab 只有这一张卡片，宽屏右侧留白过大
    <Card title={t('appDetail.settings.edit')}>
      <Form form={form} layout="vertical">
        {/* name 为不可变标识（UpdateApplicationDto 不接受 name），只读展示 */}
        <Form.Item label={t('appDetail.field.name')} tooltip={t('appDetail.settings.nameTooltip')}>
          <Input value={app.name} disabled />
        </Form.Item>
        <Form.Item name="description" label={t('appDetail.field.description')}>
          <Input.TextArea rows={2} />
        </Form.Item>
        <Space style={{ display: 'flex' }} size="middle">
          <Form.Item name="version" label={t('appDetail.field.version')} rules={[{ required: true, message: t('appDetail.settings.versionRequired') }]}>
            <Input placeholder="1.0.0" style={{ width: 160 }} />
          </Form.Item>
          <Form.Item name="runtime" label={t('appDetail.field.runtime')} rules={[{ required: true }]}>
            <Select options={RUNTIME_OPTIONS} style={{ width: 140 }} />
          </Form.Item>
        </Space>
        <Form.Item name="gitRepo" label={t('appDetail.field.gitRepo')}
          rules={[{ pattern: GIT_URL_RE, message: t('appDetail.settings.gitRepoPattern') }]}>
          <Input placeholder="https://github.com/user/repo.git" />
        </Form.Item>
        <Space style={{ display: 'flex' }} size="middle">
          <Form.Item name="gitBranch" label={t('appDetail.field.gitBranch')}>
            <Input placeholder="main" style={{ width: 180 }} />
          </Form.Item>
          <Form.Item name="gitCommit" label={t('appDetail.field.commit')}>
            <Input placeholder="HEAD" style={{ width: 200 }} />
          </Form.Item>
        </Space>
        <Form.Item name="entrypoint" label={t('appDetail.field.entrypoint')}>
          <Input placeholder="src/tasks/index.js" />
        </Form.Item>
        <Form.Item>
          <Tooltip title={isAdmin ? undefined : t('appDetail.settings.adminOnly')}>
            <Button type="primary" icon={<SaveOutlined />} onClick={handleSave} loading={saving} disabled={!isAdmin}>{t('appDetail.settings.save')}</Button>
          </Tooltip>
        </Form.Item>
      </Form>
    </Card>
  );
}

// ─── Version History ─────────────────────────────────────────────────────────
type VersionRecord = VersionHistoryEntry;

function VersionHistoryTab({ app, onAppReload }: { app: Application; onAppReload: () => Promise<void> }) {
  const [records, setRecords] = useState<VersionRecord[]>([]);
  const [loading, setLoading] = useState(false);
  // R1（部署模型评审 §4.2）：旧单一「回滚」拆为「设为当前版本」+「下发到设备」，
  // 行级 loading 各自独立。
  const [settingKey, setSettingKey] = useState<string | null>(null);
  // 用户报障（中台看不出是哪个执行器）：执行器可读名解析（口径见该 hook）。
  const { nameOf } = useExecutorNames();
  // UX-05：同 TasksTab——失败只弹 message，records 保持 []，表格 emptyText 显示
  // 「暂无版本历史」，把读取失败谎报成"没有数据"。
  const [loadError, setLoadError] = useState<unknown>(null);
  const isAdmin = useIsAdmin();
  const { t } = useTranslation();

  // ── R1 §4.2「下发到设备」弹窗状态 ─────────────────────────────────
  const [deployTarget, setDeployTarget] = useState<{
    key: string;
    versionId: string;
    version: string | null;
  } | null>(null);
  // null=清单读取中（弹窗内 Spin）
  const [deployRows, setDeployRows] = useState<AppDeployment[] | null>(null);
  // undefined=未知（读取中/读取失败不误导）；null=快照无 packageUrl；string=有。
  const [deployPkgUrl, setDeployPkgUrl] = useState<string | null | undefined>(undefined);
  // 勾选缺省 = 全部 RUNNING 行的执行器（与旧 rollback 缺省行为一致）
  const [checkedExecutors, setCheckedExecutors] = useState<string[]>([]);
  const [deploying, setDeploying] = useState(false);

  const getVersionKey = (record: VersionRecord) => record.id ?? record.deploymentId ?? `${record.version ?? 'unknown'}-${record.commit ?? 'none'}-${record.createdAt ?? record.deployedAt ?? 'unknown'}`;

  const fetchVersions = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try { setRecords(await applicationsApi.getVersionHistory(app.id)); }
    catch (err: unknown) { setLoadError(err); } finally { setLoading(false); }
  }, [app.id]);

  useEffect(() => { fetchVersions(); }, [fetchVersions]);

  /** R1 §4.2：「设为当前版本」——安全半边，只按快照恢复应用字段，不动任何设备。 */
  const handleSetCurrent = (key: string, record: VersionRecord) => {
    Modal.confirm({
      title: t('appDetail.history.setCurrentConfirm'),
      content: t('appDetail.history.setCurrentContent', { version: record.version ?? t('appDetail.unknown') }),
      okText: t('appDetail.history.setCurrentOk'),
      cancelText: t('appDetail.cancel'),
      onOk: async () => {
        setSettingKey(key);
        try {
          const res = await applicationsApi.setCurrentVersion(app.id, record.id!);
          message.success(t('appDetail.history.setCurrentDone', { version: res.version }));
          await Promise.all([fetchVersions(), onAppReload()]);
        } catch (err: unknown) {
          showApiError(err, t('appDetail.history.setCurrentFail'));
        } finally {
          setSettingKey(null);
        }
      },
    });
  };

  /** R1 §4.2：「下发到设备」——打开弹窗：拉部署行勾选面 + /releases 的
   * packageUrl 前置展示（P1-14 前置版：取代事后 packageUrlRestored warning，
   * getReleases 每版本行本就带 packageUrl，无需新读面）。 */
  const openDeployModal = async (record: VersionRecord) => {
    if (!record.id) return;
    setDeployTarget({ key: getVersionKey(record), versionId: record.id, version: record.version });
    setDeployRows(null);
    setDeployPkgUrl(undefined);
    setCheckedExecutors([]);
    try {
      const [deps, releases] = await Promise.all([
        deploymentsApi.list(app.id, 1, 100),
        // packageUrl 是确认前的提示信息，读取失败不阻断下发面（保持 undefined）
        applicationsApi.getReleases(app.id, 1, 200).catch(() => null),
      ]);
      const rows = deps.data ?? [];
      setDeployRows(rows);
      setCheckedExecutors([
        ...new Set(
          rows
            .filter((d) => d.status === 'running')
            .map((d) => d.executorId)
            .filter((x): x is string => !!x),
        ),
      ]);
      const release = releases ? (releases.data.find((r) => r.id === record.id) ?? null) : null;
      setDeployPkgUrl(release ? release.packageUrl : undefined);
    } catch (err: unknown) {
      // 部署行拉不到 = 无从安全勾选，如实报错并关闭弹窗（不静默空列表假装没设备）
      showApiError(err, t('appDetail.history.deployFail'));
      setDeployTarget(null);
    }
  };

  const closeDeployModal = () => {
    setDeployTarget(null);
    setDeployRows(null);
    setCheckedExecutors([]);
  };

  /** skipped 明细本地化（reason 稳定码 → 文案；detail 带状态/原因补充）。 */
  const skipReasonText = (s: DeployVersionResult['skipped'][number]): string =>
    s.reason === 'no_deployment'
      ? t('appDetail.history.skip.noDeployment')
      : s.reason === 'not_running'
        ? t('appDetail.history.skip.notRunning', { detail: s.detail ?? '' })
        : t('appDetail.history.skip.upgradeRejected', { detail: s.detail ?? '' });

  const confirmDeploy = async () => {
    if (!deployTarget || checkedExecutors.length === 0) return;
    setDeploying(true);
    try {
      const res = await applicationsApi.deployVersion(app.id, deployTarget.versionId, checkedExecutors);
      message.success(t('appDetail.history.deployDone', { version: res.version, count: res.upgraded.length }));
      if (res.skipped.length > 0) {
        message.warning(
          t('appDetail.history.deploySkipped', { count: res.skipped.length }) +
            res.skipped.map((s) => `${s.executorId ?? s.deploymentId ?? '?'}: ${skipReasonText(s)}`).join('；'),
        );
      }
      closeDeployModal();
      await Promise.all([fetchVersions(), onAppReload()]);
    } catch (err: unknown) {
      showApiError(err, t('appDetail.history.deployFail'));
    } finally {
      setDeploying(false);
    }
  };

  return (
    <Card variant="borderless" extra={<Button icon={<ReloadOutlined />} size="small" onClick={fetchVersions}>{t('appDetail.refresh')}</Button>}>
      {loadError ? (
        // UX-05：读取失败不再退化成「暂无版本历史」。
        <StateError
          error={loadError}
          onRetry={fetchVersions}
          title={t('appDetail.history.loadFail')}
        />
      ) : (
      <Table<VersionRecord>
        rowKey={(record) => getVersionKey(record)}
        columns={[
          {
            title: t('appDetail.col.version'), dataIndex: 'version', width: 140,
            render: (v: string | null, r: VersionRecord) => (
              <Space size={4}>
                {v ? <Tag color="blue">{v}</Tag> : <Tag>{t('appDetail.unknown')}</Tag>}
                {(r.deployCount ?? 1) > 1 && (
                  <Tooltip title={t('appDetail.deployedTimes', { count: r.deployCount })}>
                    <Tag color="default" style={{ fontSize: 11 }}>{t('appDetail.times', { count: r.deployCount })}</Tag>
                  </Tooltip>
                )}
              </Space>
            ),
          },
          { title: t('appDetail.col.commit'), dataIndex: 'commit', width: 100, render: (v: string | null) => v ? <Text code>{v.slice(0, 8)}</Text> : '-' },
          {
            title: t('appDetail.history.col.status'), dataIndex: 'status', width: 90,
            render: (v: string) => (
              // UX-06：状态列此前渲染裸枚举（released / deploying / failed…）。
              <Tag color={{ released: 'green', running: 'green', stopped: 'default', failed: 'red', deploying: 'blue' }[v] || 'default'}>
                {releaseStatusLabel(v, t) || '-'}
              </Tag>
            ),
          },
          {
            title: t('appDetail.col.executor'),
            dataIndex: 'executorAddress',
            ellipsis: true,
            // 用户报障（中台看不出是哪个执行器）：与 ReleasesTab 同口径——解析
            // 可读名，解析不到如实回落地址。
            render: (v: string | null) => {
              const name = nameOf({ executorAddress: v });
              if (!name) return v || '-';
              return (
                <Tooltip title={v ?? undefined}>
                  <span>{name}</span>
                </Tooltip>
              );
            },
          },
          {
            title: t('appDetail.col.deployedAt'), dataIndex: 'deployedAt', width: 170,
            render: (_: string | null, r: VersionRecord) => {
              const deployedAt = r.createdAt ?? r.deployedAt;
              return deployedAt ? formatDateTime(deployedAt) : '-';
            },
          },
          {
            title: t('appDetail.col.actions'), width: 176, align: 'center' as const,
            render: (_: unknown, record: VersionRecord) => {
              const currentRecord =
                records.find(r => r.version === app.version && (!app.gitCommit || !r.commit || r.commit === app.gitCommit)) ??
                records.find(r => r.version === app.version);
              const key = getVersionKey(record);
              const isCurrent = currentRecord && getVersionKey(currentRecord) === key;
              // P1-14：旧判据 `!!record.id && record.status !== 'released'` 对 legacy
              // 行（id 恒为 null）永远 false——即使该行 failed/deploying 也能点回滚，
              // 与后端 legacy 路径的守卫（无 deployedVersion 则 400）脱节。
              // 对齐后端：仅已发布版本可操作；legacy 行无版本快照 id，两个新动作
              // 均不支持（旧 rollback alias 仍可在服务端处理，UI 不再暴露）。
              const notReleased = record.id
                ? record.status !== 'released'
                : !record.version || ['failed', 'deploying', 'upgrading', 'pending'].includes(record.status);
              const hasSnapshot = !!record.id;
              const disabled = !hasSnapshot || notReleased || !isAdmin;
              const tooltip = !hasSnapshot
                ? t('appDetail.history.noSnapshot')
                : notReleased
                  ? t('appDetail.history.actionReleasedOnly')
                  : !isAdmin
                    ? t('appDetail.history.actionAdminOnly')
                    : undefined;
              if (isCurrent) return <Tag color="green">{t('appDetail.history.currentVersion')}</Tag>;
              // R1 §4.2：安全动作（设为当前版本，默认色）+ 危险动作（下发到设备，
              // danger 色）分立，恢复记录面不再隐式重启全部实例。
              return (
                <Space size={4}>
                  <Tooltip title={tooltip}>
                    <Button
                      size="small"
                      disabled={disabled}
                      loading={settingKey === key}
                      onClick={() => hasSnapshot && handleSetCurrent(key, record)}
                    >
                      {t('appDetail.history.setCurrent')}
                    </Button>
                  </Tooltip>
                  <Tooltip title={tooltip}>
                    <Button
                      size="small"
                      danger
                      disabled={disabled}
                      onClick={() => hasSnapshot && openDeployModal(record)}
                    >
                      {t('appDetail.history.deploy')}
                    </Button>
                  </Tooltip>
                </Space>
              );
            },
          },
        ]}
        dataSource={records}
        loading={loading} size="small"
        // UI 打磨：固定列合计 590 + 双动作列 176 + executor 弹性列最小宽，补 scroll.x 防窄屏挤压
        scroll={{ x: 880 }}
        pagination={{ pageSize: 20, showTotal: (n) => t('appDetail.count', { count: n }) }}
        locale={{ emptyText: t('appDetail.history.empty') }}
      />
      )}

      {/* R1 §4.2：下发到设备弹窗——按执行器勾选部署行（仅 RUNNING 可下发），
          packageUrl 前置展示取代事后 packageUrlRestored warning。 */}
      <AntdModal
        open={!!deployTarget}
        title={t('appDetail.history.deployTitle', { version: deployTarget?.version ?? '' })}
        okText={t('appDetail.history.deployOk')}
        okButtonProps={{ danger: true, disabled: checkedExecutors.length === 0 }}
        confirmLoading={deploying}
        cancelText={t('appDetail.cancel')}
        onCancel={closeDeployModal}
        onOk={confirmDeploy}
        destroyOnHidden
      >
        {deployPkgUrl !== undefined &&
          (deployPkgUrl === null ? (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              message={t('appDetail.history.deployPkgMissing')}
            />
          ) : (
            <Alert
              type="success"
              showIcon
              style={{ marginBottom: 12 }}
              message={t('appDetail.history.deployPkgPresent', { url: deployPkgUrl })}
            />
          ))}
        {deployRows === null ? (
          <Spin style={{ display: 'block', margin: '16px auto' }} />
        ) : deployRows.length === 0 ? (
          <Empty description={t('appDetail.history.deployEmpty')} />
        ) : (
          <>
            {deployRows.map((d) => {
              const name = nameOf(d);
              const label = name ? `${name} (${d.executorAddress})` : (d.executorAddress ?? d.id);
              // 仅 RUNNING 且带执行器 id 的行可勾选；其余行如实展示状态（不可下发）
              const canDispatch = d.status === 'running' && !!d.executorId;
              return (
                <div
                  key={d.id}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 0' }}
                >
                  <Checkbox
                    checked={!!d.executorId && checkedExecutors.includes(d.executorId)}
                    disabled={!canDispatch}
                    onChange={(e) => {
                      if (!d.executorId) return;
                      setCheckedExecutors((prev) =>
                        e.target.checked
                          ? [...new Set([...prev, d.executorId!])]
                          : prev.filter((x) => x !== d.executorId),
                      );
                    }}
                  >
                    {label}
                  </Checkbox>
                  <Tag color={RELEASE_DEPLOY_STATUS_COLOR[d.status] ?? 'default'}>
                    {releaseStatusLabel(d.status, t) ?? d.status}
                  </Tag>
                </div>
              );
            })}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('appDetail.history.deployHint')}
            </Typography.Text>
          </>
        )}
      </AntdModal>
    </Card>
  );
}

// ─── Releases（DEP-01 统一发布追溯）───────────────────────────────────────────
const RELEASE_DEPLOY_STATUS_LABELS = (t: (k: string) => string): Record<string, string> => ({
  pending: t('appDetail.releases.status.pending'), deploying: t('appDetail.releases.status.deploying'), running: t('appDetail.releases.status.running'), stopped: t('appDetail.releases.status.stopped'), failed: t('appDetail.releases.status.failed'), upgrading: t('appDetail.releases.status.upgrading'),
});
const RELEASE_TRIGGER_LABELS = (t: (k: string) => string): Record<string, string> => ({
  upgrade: t('appDetail.releases.trigger.upgrade'), manual: t('appDetail.releases.trigger.manual'), unknown: t('appDetail.releases.trigger.unknown'),
});

// R4（§4.1A）：部署事件类型 → 人类可读标签（后端 AppDeploymentEventType 九值，
// varchar 裸 token——枚举扩值时未知 token 原样展示，与 triggerLabel 同策：
// 宁可露出可搜索的 token 也不抹掉可诊断信息）。
const EVENT_TYPE_LABELS = (t: (k: string) => string): Record<string, string> => ({
  deploy_created: t('appDetail.events.type.deploy_created'),
  redeploy_reused: t('appDetail.events.type.redeploy_reused'),
  approval_approved: t('appDetail.events.type.approval_approved'),
  approval_rejected: t('appDetail.events.type.approval_rejected'),
  approval_cancelled: t('appDetail.events.type.approval_cancelled'),
  upgrade: t('appDetail.events.type.upgrade'),
  stop: t('appDetail.events.type.stop'),
  remove: t('appDetail.events.type.remove'),
  stuck_failed: t('appDetail.events.type.stuck_failed'),
});
// Tag 配色按「动作性质」分组：创建/复用=蓝、审批=橙、升级=青、停止=默认、
// 删除=红、扫死=火山红。未知 token 回退 default（后端新增枚举时中性展示）。
const EVENT_TYPE_COLOR: Record<string, string> = {
  deploy_created: 'blue',
  redeploy_reused: 'geekblue',
  approval_approved: 'orange',
  approval_rejected: 'volcano',
  approval_cancelled: 'orange',
  upgrade: 'cyan',
  stop: 'default',
  remove: 'red',
  stuck_failed: 'magenta',
};

/**
 * R4（§4.1A）：应用部署事件流表（不可变动作追溯）。独立加载/独立分页，
 * 挂在 ReleasesTab 版本表下方——版本表回答「现在有哪些版本」，事件流回答
 * 「谁在什么时候对哪台设备做了什么」，两张表数据源与生命周期互不耦合。
 *
 * 分页沿用 RACE-PAGE 同款序号守卫（翻页请求乱序时旧页数据不覆盖新页）。
 */
function DeploymentEventsTable({ app }: { app: Application }) {
  const [events, setEvents] = useState<AppDeploymentEventRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  // 服务端过滤（上轮遗留：事件量极大时深翻页代价高）——eventType 单选；
  // undefined = 全部（不带参数，请求形状与旧后端逐字节一致）。
  const [eventTypeFilter, setEventTypeFilter] = useState<string | undefined>(undefined);
  const { t } = useTranslation();
  // 同 ReleasesTab：执行器可读名解析（事件行 executorAddress 是写入时的地址
  // 快照，executorId 优先、address 回落；解析不到如实回落地址，绝不编造）。
  const { nameOf } = useExecutorNames();
  const raceGuard = useRaceGuard();

  const fetchEvents = useCallback(async (p: number, eventType?: string) => {
    const seq = raceGuard.next();
    setLoading(true);
    setError(null);
    try {
      const res = await applicationsApi.getDeploymentEvents(app.id, p, 20, eventType ? { eventType } : undefined);
      if (!raceGuard.isLatest(seq)) return; // 过期响应：丢弃（RACE-PAGE 同款）
      setEvents(res.data ?? []);
      setTotal(res.total ?? 0);
      setPage(res.page ?? p);
    } catch (err: unknown) {
      if (!raceGuard.isLatest(seq)) return;
      setError(err);
    } finally {
      if (raceGuard.isLatest(seq)) setLoading(false);
    }
  }, [app.id, raceGuard]);

  // eventTypeFilter 进依赖：筛选变化 → 回第 1 页重拉（不再手动触发，双触发
  // 会发两个请求，raceGuard 只保序不保去重）。回第 1 页是因为旧页码对新
  // 结果集大概率越界（空页误导），且即便未越界「第 N 页的某类型事件」语义
  // 也已漂移。
  useEffect(() => { fetchEvents(1, eventTypeFilter); }, [fetchEvents, eventTypeFilter]);

  if (error) {
    // 事件流加载失败不拖垮版本表：区块内降级 StateError（重试 + 复制）。
    // 重试带当前筛选——失败的就是那次过滤请求，重试丢筛选会让「重试成功」
    // 显示未过滤数据，用户误以为过滤已生效。
    return (
      <Card variant="borderless" style={{ marginTop: 16 }} data-testid="events-card">
        <StateError
          error={error}
          onRetry={() => fetchEvents(1, eventTypeFilter)}
          title={t('appDetail.events.loadFail')}
        />
      </Card>
    );
  }

  const eventColumns = [
    {
      title: t('appDetail.events.col.time'),
      dataIndex: 'createdAt',
      width: 170,
      render: (v: string) => formatDateTime(v),
    },
    {
      title: t('appDetail.events.col.type'),
      dataIndex: 'eventType',
      width: 130,
      render: (v: string) => (
        <Tag color={EVENT_TYPE_COLOR[v] || 'default'} data-testid="event-type-tag">
          {EVENT_TYPE_LABELS(t)[v] || v}
        </Tag>
      ),
    },
    {
      title: t('appDetail.events.col.executor'),
      dataIndex: 'executorAddress',
      width: 180,
      ellipsis: true,
      render: (v: string | null, r: AppDeploymentEventRow) => {
        const name = nameOf({ executorId: r.executorId, executorAddress: v });
        if (!name) return v || '-';
        return (
          <Tooltip title={v ?? undefined}>
            <span>{name}</span>
          </Tooltip>
        );
      },
    },
    {
      title: t('appDetail.events.col.version'),
      dataIndex: 'deployedVersion',
      width: 110,
      render: (v: string | null) => (v ? <Tag color="blue">{v}</Tag> : '-'),
    },
    {
      title: t('appDetail.events.col.operator'),
      dataIndex: 'operator',
      width: 120,
      render: (v: string | null) =>
        v ? v : (
          <Tooltip title={t('appDetail.events.operatorSystem')}>
            <Text type="secondary">{t('appDetail.events.operatorSystemShort')}</Text>
          </Tooltip>
        ),
    },
    {
      title: t('appDetail.events.col.summary'),
      dataIndex: 'detail',
      ellipsis: true,
      render: (detail: Record<string, unknown> | null | undefined, r: AppDeploymentEventRow) => {
        const parts: string[] = [];
        // 已知键逐个如实翻译；detail 是 jsonb 开放结构，未知键原样 k=v
        if (detail) {
          for (const [k, val] of Object.entries(detail)) {
            if (val === null || val === undefined || val === '') continue;
            if (k === 'reason') parts.push(`${t('appDetail.events.detail.reason')}: ${String(val)}`);
            else if (k === 'runMode') parts.push(`${t('appDetail.events.detail.runMode')}: ${String(val)}`);
            else if (k === 'previousStatus') parts.push(`${t('appDetail.events.detail.previousStatus')}: ${RELEASE_DEPLOY_STATUS_LABELS(t)[String(val)] || String(val)}`);
            else if (k === 'deletedStatus') parts.push(`${t('appDetail.events.detail.deletedStatus')}: ${RELEASE_DEPLOY_STATUS_LABELS(t)[String(val)] || String(val)}`);
            else if (k === 'stopSignalDelivered') parts.push(
              val
                ? t('appDetail.events.detail.stopDelivered')
                : t('appDetail.events.detail.stopNotDelivered'),
            );
            else if (k === 'approvalRequired') {
              if (val) parts.push(t('appDetail.events.detail.approvalRequired'));
            } else {
              parts.push(`${k}=${String(val)}`);
            }
          }
        }
        // triggerType 是动作语义的补充（manual/upgrade/rollback/approval），
        // 放摘要末尾；机器路径（null）不展示——与 operator 的系统标注呼应。
        if (r.triggerType) parts.push(triggerLabel(r.triggerType, t) || r.triggerType);
        if (parts.length === 0) return <Text type="secondary">-</Text>;
        return parts.join(' · ');
      },
    },
  ];

  // 九值下拉选项复用 EVENT_TYPE_LABELS（标签唯一事实源——表格 Tag 与筛选
  // 下拉同一映射，不会出现「筛选里叫 A、表格里叫 B」）。
  const eventTypeOptions = Object.keys(EVENT_TYPE_LABELS(t)).map((v) => ({
    value: v,
    label: EVENT_TYPE_LABELS(t)[v],
  }));

  return (
    <Card
      variant="borderless"
      style={{ marginTop: 16 }}
      title={t('appDetail.events.title')}
      extra={(
        <Space>
          <Select
            allowClear
            placeholder={t('appDetail.events.filter.typeAll')}
            style={{ width: 150 }}
            value={eventTypeFilter}
            onChange={(v) => setEventTypeFilter(v)}
            options={eventTypeOptions}
            data-testid="event-type-filter"
          />
          <Button icon={<ReloadOutlined />} size="small" onClick={() => fetchEvents(page, eventTypeFilter)}>{t('appDetail.refresh')}</Button>
        </Space>
      )}
      data-testid="events-card"
    >
      <Table<AppDeploymentEventRow>
        rowKey={(e) => e.id}
        columns={eventColumns}
        dataSource={events}
        loading={loading}
        size="small"
        scroll={{ x: 920 }}
        data-testid="deployment-events-table"
        pagination={{
          current: page,
          pageSize: 20,
          total,
          showTotal: (n) => t('appDetail.count', { count: n }),
          onChange: (p) => fetchEvents(p, eventTypeFilter),
        }}
        locale={{ emptyText: t('appDetail.events.empty') }}
      />
    </Card>
  );
}

function ReleasesTab({ app }: { app: Application }) {
  const [rows, setRows] = useState<AppReleaseRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  // P8：版本行超上限静默截断标志——true 时在版本表上方渲染显式告警条。
  const [truncated, setTruncated] = useState(false);
  const { t } = useTranslation();
  // 用户报障（中台看不出是哪个执行器）：执行器可读名解析（口径见该 hook）。
  const { nameOf } = useExecutorNames();

  /**
   * RACE-PAGE（审计 P2，2026-10-17）：分页响应的序号守卫。
   *
   * 缺陷现场：快速点「下一页→上一页」时两个请求并发在飞，先发的可能后到
   * ——旧页数据覆盖新页，用户看到的是上一页的内容但页码显示当前页，必须
   * 再点一次才纠正。setRows/setTotal/setPage 三者还会被拆开写（中间态
   * 可能行数与总数不同步）。
   *
   * 现在每次请求领取一个自增序号，只有「最新那一发」的响应才被采纳；过期
   * 响应的 setLoading(false) 也不执行（否则会提前熄掉当前请求的 loading）。
   */
  const raceGuard = useRaceGuard();

  const fetchReleases = useCallback(async (p: number) => {
    const seq = raceGuard.next();
    setLoading(true);
    setError(null);
    try {
      const res = await applicationsApi.getReleases(app.id, p, 20);
      if (!raceGuard.isLatest(seq)) return; // 过期响应：丢弃
      setRows(res.data ?? []);
      setTotal(res.total ?? 0);
      setPage(res.page ?? p);
      // P8：截断标志随页落地（旧后端不带该键 → undefined → 如实按未截断）
      setTruncated(res.truncated ?? false);
    } catch (err: unknown) {
      if (!raceGuard.isLatest(seq)) return; // 过期失败同样不覆盖当前视图
      setError(err);
    } finally {
      if (raceGuard.isLatest(seq)) setLoading(false);
    }
  }, [app.id, raceGuard]);

  useEffect(() => { fetchReleases(1); }, [fetchReleases]);

  const columns = [
    {
      title: t('appDetail.col.version'), dataIndex: 'version', width: 150,
      render: (v: string | null, r: AppReleaseRow) => (
        <Space size={4}>
          {v ? <Tag color="blue" data-testid="release-version">{v}</Tag> : <Tag>{t('appDetail.unknown')}</Tag>}
          {r.synthetic && (
            <Tooltip title={t('appDetail.releases.syntheticTooltip')}>
              <Tag style={{ fontSize: 11 }}>{t('appDetail.releases.synthetic')}</Tag>
            </Tooltip>
          )}
          {r.deploymentCount > 1 && (
            <Tooltip title={t('appDetail.deployedTimes', { count: r.deploymentCount })}>
              <Tag color="default" style={{ fontSize: 11 }}>{t('appDetail.times', { count: r.deploymentCount })}</Tag>
            </Tooltip>
          )}
        </Space>
      ),
    },
    {
      title: t('appDetail.col.commit'), dataIndex: 'gitCommit', width: 110,
      render: (v: string | null) => (v ? <Text code>{v.slice(0, 8)}</Text> : '-'),
    },
    {
      title: t('appDetail.releases.col.deployStatus'), dataIndex: 'deploymentStatus', width: 100,
      render: (v: string | null) =>
        v ? (
          <Tag color={RELEASE_DEPLOY_STATUS_COLOR[v] || 'default'}>
            {RELEASE_DEPLOY_STATUS_LABELS(t)[v] || v}
          </Tag>
        ) : (
          <Text type="secondary">{t('appDetail.releases.notDeployed')}</Text>
        ),
    },
    {
      title: t('appDetail.releases.col.trigger'), dataIndex: 'triggerType', width: 100,
      render: (v: string | null) => (v ? <Tag>{RELEASE_TRIGGER_LABELS(t)[v] || v}</Tag> : '-'),
    },
    {
      title: t('appDetail.col.executor'),
      dataIndex: 'executorAddress',
      ellipsis: true,
      // 用户报障（中台看不出是哪个执行器）：此前只渲染 IP:端口。改为解析执行器
      // 注册时上报的可读名，解析不到则如实回落地址（不编造）。
      // 注：AppReleaseRow 没有 executorId，只能按 address 匹配。
      render: (v: string | null) => {
        const name = nameOf({ executorAddress: v });
        if (!name) return v || '-';
        return (
          <Tooltip title={v ?? undefined}>
            <span>{name}</span>
          </Tooltip>
        );
      },
    },
    {
      title: t('appDetail.col.deployedAt'), dataIndex: 'deployedAt', width: 170,
      render: (v: string | null, r: AppReleaseRow) => {
        const time = v ?? r.createdAt;
        return time ? formatDateTime(time) : '-';
      },
    },
    {
      // R3-A（部署模型评审 §4.3）：设备徽标——设备心跳上报的「谁在跑/保留这一版」。
      // 与「执行器」列（最近一次部署行的地址快照，推断）不同源：本列是设备事实。
      title: t('appDetail.releases.col.devices'),
      dataIndex: 'devices',
      width: 210,
      render: (_: unknown, r: AppReleaseRow) => {
        const devices = r.devices ?? [];
        // 旧后端（R3-A 前）/无任何设备上报：无徽标。与「未部署」区分——
        // 部署推断字段仍在（执行器列/部署状态列），此处如实显示占位。
        if (devices.length === 0) return <Text type="secondary">-</Text>;
        return (
          <Space size={4} wrap>
            {devices.map((d) => {
              // 名字以响应内嵌的 executorName 为准（后端聚合），缺失时回落
              // 本页清单索引，再回落 id 前缀——绝不显示「未知设备」编造。
              const name =
                d.executorName ||
                nameOf({ executorId: d.executorId }) ||
                d.executorId.slice(0, 8);
              const running = d.currentVersion === r.version;
              const label = running
                ? t('appDetail.releases.deviceRunning')
                : t('appDetail.releases.deviceRetained');
              return (
                <Tooltip
                  key={d.executorId}
                  title={
                    d.online
                      ? name
                      : t('appDetail.releases.deviceOfflineAt', {
                          time: d.lastHeartbeat
                            ? formatDateTime(d.lastHeartbeat)
                            : t('appDetail.releases.deviceOfflineUnknown'),
                        })
                  }
                >
                  {/* 离线置灰：设备不再上报后版本事实可能已过期（卸载/切换）， */}
                  {/* 不能继续与在线设备同权重展示 */}
                  <Tag
                    data-testid="release-device-badge"
                    color={d.online ? (running ? 'green' : 'blue') : 'default'}
                    style={
                      d.online
                        ? undefined
                        : { color: '#9ca3af', background: '#fafafa' }
                    }
                  >
                    {name} · {label}
                    {!d.online ? ` · ${t('appDetail.releases.deviceOffline')}` : ''}
                  </Tag>
                </Tooltip>
              );
            })}
          </Space>
        );
      },
    },
    {
      title: t('appDetail.releases.col.operator'), dataIndex: 'operator', width: 110,
      render: (v: string | null) =>
        v ? v : (
          <Tooltip title={t('appDetail.releases.operatorTooltip')}>
            <Text type="secondary">—</Text>
          </Tooltip>
        ),
    },
  ];

  if (error) {
    // UI-08：页内错误态标准块（重试 + 复制错误信息），整页不炸
    return (
      <Card variant="borderless">
        <StateError
          error={error}
          onRetry={() => fetchReleases(1)}
          title={t('appDetail.releases.loadFail')}
        />
      </Card>
    );
  }

  return (
    <div>
      {/* P8：版本行超 RELEASES_MAX_PAGE_SIZE 被静默截断——显式告知而非让用户
          把「看到的」当「全量」；完整动作史走事件流（不可变、分页无截断）。 */}
      {truncated && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={t('appDetail.releases.truncated.title')}
          description={t('appDetail.releases.truncated.desc')}
          action={(
            <Button
              size="small"
              data-testid="truncated-goto-events"
              onClick={() => document.getElementById('app-deployment-events')?.scrollIntoView({ behavior: 'smooth' })}
            >
              {t('appDetail.releases.truncated.gotoEvents')}
            </Button>
          )}
        />
      )}
      <Card variant="borderless" extra={<Button icon={<ReloadOutlined />} size="small" onClick={() => fetchReleases(page)}>{t('appDetail.refresh')}</Button>}>
        <Table<AppReleaseRow>
        rowKey={(r) => r.id ?? r.latestDeploymentId ?? `${r.version ?? 'unknown'}-${r.createdAt ?? 'none'}`}
        columns={columns}
        dataSource={rows}
        loading={loading}
        size="small"
        // UI 打磨：固定列合计 740 + devices 210 + executor 弹性列最小宽，补 scroll.x
        scroll={{ x: 1130 }}
        data-testid="releases-table"
        pagination={{
          current: page,
          pageSize: 20,
          total,
          showTotal: (n) => t('appDetail.count', { count: n }),
          onChange: (p) => fetchReleases(p),
        }}
          locale={{ emptyText: t('appDetail.releases.empty') }}
        />
      </Card>
      {/* R4（§4.1A）：事件流区块（不可变动作追溯）——锚点 id 供截断告警条跳转 */}
      <div id="app-deployment-events">
        <DeploymentEventsTable app={app} />
      </div>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────
export default function ApplicationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { t } = useTranslation();

  const [app, setApp] = useState<Application | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  // UX-05（本轮体验审查）：此前任何错误（含 500 / 网络抖动 / 超时）都
  // `message.error` + `nav('/applications')` **强制跳走**——用户正在看的页面
  // 突然消失、回到列表且滚动位置丢失，而真正的原因只是一条几秒后消失的 toast。
  // 只有「确实不存在」（404）才该离开；其余错误应在原位给出重试。
  const [loadError, setLoadError] = useState<unknown>(null);
  const [notFound, setNotFound] = useState(false);

  const activeTab = searchParams.get('tab') || 'overview';

  // NETOPT-7④（2026-09-20）：两个应用详情间导航（同路由 :id 组件不重挂）时新旧
  // fetchApp 并发——旧 id 的响应晚到会 setApp(旧应用)；旧 id 的 404 晚到会
  // setNotFound(true)+nav('/applications') 把用户从正在看的新页面踢走。序号守卫：
  // await 落地后（成功/404/其他错误/finally 四条路径）先比对再 setState，过期即弃。
  const fetchAppSeq = useRef(0);

  const fetchApp = useCallback(async () => {
    if (!id) return;
    const seq = ++fetchAppSeq.current;
    try {
      setLoading(true);
      setLoadError(null);
      setNotFound(false);
      const fetched = await applicationsApi.get(id);
      if (fetchAppSeq.current !== seq) return;
      setApp(fetched);
    } catch (err: unknown) {
      if (fetchAppSeq.current !== seq) return;
      // 404 = 资源确实不存在，跳回列表是合理归宿；其余错误留在页内重试。
      if (isNotFoundError(err)) {
        setNotFound(true);
        nav('/applications');
      } else {
        setLoadError(err);
      }
    } finally {
      if (fetchAppSeq.current === seq) setLoading(false);
    }
  }, [id, nav]);

  useEffect(() => { fetchApp(); }, [fetchApp]);

  const handleSyncTasks = async () => {
    if (!id) return;
    setSyncing(true);
    try {
      const result = await applicationsApi.syncTasks(id);
      message.success(t('appDetail.tasks.synced', { count: result.registeredCount }));
    } catch (err: unknown) { showApiError(err, t('appDetail.tasks.syncFail')); }
    finally { setSyncing(false); }
  };

  // UI-08：首屏加载以骨架屏替代裸 Spin
  if (loading) return <PageSkeleton variant="table" rows={6} style={{ padding: 24 }} />;
  // UX-05：读取失败（非 404）留在原位给重试，不再强制跳回列表。
  if (loadError) {
    return (
      <div style={{ padding: 24 }}>
        <StateError
          error={loadError}
          onRetry={fetchApp}
          title={t('appDetail.loadFail')}
          centered
        />
      </div>
    );
  }
  if (notFound || !app) return <Empty description={t('appDetail.notFound')} />;

  return (
    <div>
      {/* UI-03/UI-08：页头标准化（返回/刷新迁入 extra，面包屑声明二级层级） */}
      <PageHeader
        title={app.name}
        description={t('appDetail.description')}
        breadcrumb={[{ title: t('appDetail.breadcrumb.applications'), to: '/applications' }, { title: app.name }]}
        extra={
          <>
            <Button icon={<ArrowLeftOutlined />} onClick={() => nav('/applications')}>{t('appDetail.back')}</Button>
            <Button icon={<ReloadOutlined />} onClick={fetchApp}>{t('appDetail.refresh')}</Button>
            <Button type="primary" icon={<RocketOutlined />} onClick={() => setSearchParams({ tab: 'deployments' })}>
              {t('appDetail.newDeploy')}
            </Button>
          </>
        }
      />

      <Tabs
        activeKey={activeTab}
        onChange={(key) => setSearchParams({ tab: key })}
        destroyOnHidden={false}
        items={[
          { key: 'overview', label: t('appDetail.tab.overview'), children: <OverviewTab app={app} /> },
          {
            key: 'deployments',
            label: <span><RocketOutlined /> {t('appDetail.tab.deployments')}</span>,
            children: <AppDeploymentPage applicationId={app.id} appEntrypoint={app.entrypoint} />,
          },
          {
            key: 'tasks',
            label: t('appDetail.tab.tasks'),
            children: <TasksTab appId={app.id} syncing={syncing} onSync={handleSyncTasks} />,
          },
          {
            key: 'versions',
            label: <span><HistoryOutlined /> {t('appDetail.tab.versions')}</span>,
            children: <VersionHistoryTab app={app} onAppReload={fetchApp} />,
          },
          // DEP-01：统一发布追溯（版本 × 最近一次部署一屏追溯）
          {
            key: 'releases',
            label: <span><HistoryOutlined /> {t('appDetail.tab.releases')}</span>,
            children: <ReleasesTab app={app} />,
          },
          {
            key: 'settings',
            label: t('appDetail.tab.settings'),
            children: <SettingsTab app={app} onUpdated={(updated) => setApp(updated)} />,
          },
          {
            key: 'ai',
            label: <span><RobotOutlined /> {t('appDetail.ai.title')}</span>,
            children: <AiAnalysisTab appId={app.id} />,
          },
        ]}
      />
    </div>
  );
}

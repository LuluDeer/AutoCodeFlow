import { useState, useEffect, useCallback } from 'react';
import {
  Descriptions, Badge, Card, Table, Button, Space, Tag, Typography, message, Modal, Spin, Empty,
  Row, Col, Collapse, Tooltip, Tabs, Form, Input, Select, Statistic, Alert,
} from 'antd';
import {
  ArrowLeftOutlined, SyncOutlined, ReloadOutlined, GithubOutlined,
  SaveOutlined, HistoryOutlined,
  RocketOutlined, RobotOutlined,
} from '@ant-design/icons';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { applicationsApi, Application, VersionHistoryEntry, AppReleaseRow } from '../api/applications';
import { aiApi, AppHealthReport } from '../api/ai';
import { tasksApi, Task } from '../api/tasks';
import AppDeploymentPage from './AppDeploymentPage';
import { getErrMsg, isFormValidationError } from '../utils/error';
import { useAuthStore, isAdminUser } from '../store/auth';
import PageHeader from '../components/PageHeader';
import PageSkeleton from '../components/PageSkeleton';
import StateError from '../components/StateError';

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
      setError(getErrMsg(err, 'AI 分析失败，请检查 AI 配置是否正确'));
    } finally {
      setLoading(false);
    }
  }, [appId]);

  return (
    <Card
      title={<span><RobotOutlined /> AI 健康分析</span>}
      extra={(
        <Tooltip title={isAdmin ? undefined : '仅管理员可执行 AI 分析'}>
          <Button icon={<ReloadOutlined />} onClick={runAnalysis} loading={loading} disabled={!isAdmin}>重新分析</Button>
        </Tooltip>
      )}
    >
      {!report && !loading && !error && (
        <Empty
          description="点击「重新分析」让 AI 分析该应用的健康状态"
          image={<RobotOutlined style={{ fontSize: 48, color: '#1677ff' }} />}
        >
          <Tooltip title={isAdmin ? undefined : '仅管理员可执行 AI 分析'}>
            <Button type="primary" icon={<RobotOutlined />} onClick={runAnalysis} disabled={!isAdmin}>开始分析</Button>
          </Tooltip>
        </Empty>
      )}
      {loading && <div style={{ textAlign: 'center', padding: 40 }}><Spin tip="AI 分析中…" size="large" /></div>}
      {error && <Alert type="error" title={error} showIcon />}
      {report && !loading && (
        <div>
          <Row gutter={16} style={{ marginBottom: 24 }}>
            <Col span={8}>
              <Card size="small">
                <Statistic title="关联任务数" value={report.stats.totalTasks} />
              </Card>
            </Col>
            <Col span={8}>
              <Card size="small">
                <Statistic
                  title="平均成功率"
                  value={report.stats.avgSuccessRate}
                  suffix="%"
                  styles={{ content: { color: report.stats.avgSuccessRate >= 90 ? '#3f8600' : report.stats.avgSuccessRate >= 70 ? '#d48806' : '#cf1322' } }}
                />
              </Card>
            </Col>
            <Col span={8}>
              <Card size="small">
                <Statistic title="平均耗时" value={report.stats.avgDuration ? `${(report.stats.avgDuration / 1000).toFixed(1)}s` : '-'} />
              </Card>
            </Col>
          </Row>
          {(report.stats.criticalTasks?.length ?? 0) > 0 && (
            <Card size="small" title="高失败率任务" style={{ marginBottom: 16 }}>
              {report.stats.criticalTasks.map((name) => (
                <div key={name} style={{ marginBottom: 4 }}>
                  <Tag color="red">低成功率</Tag>
                  <span>{name}</span>
                </div>
              ))}
            </Card>
          )}
          {report.analysis && (
            <Alert
              type="info"
              message="AI 分析结论"
              description={<pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{report.analysis}</pre>}
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

const STATUS_COLORS: Record<string, string> = {
  active: 'green', deploying: 'blue', failed: 'red',
};
const STATUS_LABELS: Record<string, string> = {
  active: '正常', deploying: '部署中', failed: '失败',
};

const RUNTIME_OPTIONS = [
  { value: 'python', label: 'Python' },
  { value: 'node', label: 'Node.js' },
  { value: 'shell', label: 'Shell' },
];

const GIT_URL_RE = /^(https?:\/\/[\w.@:/~_-]+\.git|git@[\w.-]+:[\w./_-]+\.git)$/;

// ─── Overview Tab ─────────────────────────────────────────────────────────────
function OverviewTab({ app }: { app: Application }) {
  return (
    <Space orientation="vertical" size={16} style={{ width: '100%' }}>
      <Card title="应用信息">
        <Descriptions bordered size="small" column={{ xs: 1, sm: 2, md: 3 }}>
          <Descriptions.Item label="版本"><Tag color="blue">{app.version}</Tag></Descriptions.Item>
          <Descriptions.Item label="运行时"><Tag>{app.runtime}</Tag></Descriptions.Item>
          <Descriptions.Item label="状态">
            <Tag color={STATUS_COLORS[app.status] || 'default'}>{STATUS_LABELS[app.status] || app.status}</Tag>
          </Descriptions.Item>
          {app.description && (
            <Descriptions.Item label="描述" span={3}>{app.description}</Descriptions.Item>
          )}
          {app.gitRepo && (
            <Descriptions.Item label="Git 仓库" span={2}>
              <Space>
                <GithubOutlined />
                <Text copyable={{ text: app.gitRepo }}>
                  <a href={app.gitRepo.startsWith('http') ? app.gitRepo : '#'} target="_blank" rel="noopener noreferrer">
                    {app.gitRepo}
                  </a>
                </Text>
              </Space>
            </Descriptions.Item>
          )}
          {app.gitBranch && <Descriptions.Item label="分支"><Tag>{app.gitBranch}</Tag></Descriptions.Item>}
          {app.gitCommit && (
            <Descriptions.Item label="Commit"><Text code>{app.gitCommit.slice(0, 8)}</Text></Descriptions.Item>
          )}
          {app.entrypoint && (
            <Descriptions.Item label="入口文件"><Text code>{app.entrypoint}</Text></Descriptions.Item>
          )}
          <Descriptions.Item label="创建时间">
            {app.createdAt ? new Date(app.createdAt).toLocaleString('zh-CN') : '-'}
          </Descriptions.Item>
          <Descriptions.Item label="更新时间">
            {app.updatedAt ? new Date(app.updatedAt).toLocaleString('zh-CN') : '-'}
          </Descriptions.Item>
        </Descriptions>

        {app.env && Object.keys(app.env).length > 0 && (
          <Collapse ghost style={{ marginTop: 12 }}>
            <Collapse.Panel header={`环境变量 (${Object.keys(app.env).length} 项)`} key="env">
              <Descriptions bordered size="small" column={1}>
                {Object.entries(app.env).map(([k, v]) => (
                  <Descriptions.Item key={k} label={<Text code>{k}</Text>}>{v}</Descriptions.Item>
                ))}
              </Descriptions>
            </Collapse.Panel>
          </Collapse>
        )}
      </Card>

      {app.manifest && (
        <Card title="应用清单 (manifest.json)">
          <Collapse ghost>
            <Collapse.Panel header="查看详情" key="manifest">
              <pre style={{
                // UI-02：清单 pre 块双主题（同 SSE 日志区变量）
                background: 'var(--log-bg)', color: 'var(--log-text)', padding: 16,
                borderRadius: 8, maxHeight: 300, overflow: 'auto', fontSize: 13,
                fontFamily: 'var(--font-mono)',
              }}>
                {JSON.stringify(app.manifest, null, 2)}
              </pre>
            </Collapse.Panel>
          </Collapse>
        </Card>
      )}
    </Space>
  );
}

// ─── Tasks Tab ─────────────────────────────────────────────────────────────────
function TasksTab({ appId, syncing, onSync }: { appId: string; syncing: boolean; onSync: () => void }) {
  const nav = useNavigate();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(false);
  const isAdmin = useIsAdmin();

  const fetchTasks = useCallback(async () => {
    setLoading(true);
    try {
      const res = await tasksApi.list({ page: 1, pageSize: 100, applicationId: appId });
      setTasks(res.items ?? []);
    } catch (err: unknown) { message.error(getErrMsg(err, '加载任务列表失败')); } finally { setLoading(false); }
  }, [appId]);

  useEffect(() => { fetchTasks(); }, [fetchTasks]);

  return (
    <Card
      variant="borderless"
      extra={
        <Space>
          <Tooltip title={isAdmin ? '重新解析 manifest.json 并注册任务' : '仅管理员可同步任务'}>
            <Button loading={syncing} icon={<SyncOutlined />} onClick={onSync} size="small" disabled={!isAdmin}>同步任务</Button>
          </Tooltip>
          <Button type="primary" size="small" onClick={() => nav(`/tasks/new?applicationId=${appId}`)}>新建任务</Button>
          <Button icon={<ReloadOutlined />} size="small" onClick={fetchTasks}>刷新</Button>
        </Space>
      }
    >
      {tasks.length === 0 && !loading ? (
        <Empty description="该应用暂无关联任务">
          <Button type="primary" size="small" onClick={() => nav(`/tasks/new?applicationId=${appId}`)}>创建任务</Button>
        </Empty>
      ) : (
        <Table<Task>
          columns={[
            {
              title: '任务名',
              dataIndex: 'name',
              render: (n: string, r: Task) => <a onClick={() => nav(`/tasks/${r.id}`)}>{n}</a>,
            },
            {
              title: '状态', dataIndex: 'status', width: 100,
              render: (s: string) => (
                <Badge status={s === 'active' ? 'success' : s === 'paused' ? 'warning' : 'default'}
                  text={s === 'active' ? '运行中' : s === 'paused' ? '已暂停' : s} />
              ),
            },
            {
              title: '触发', key: 'trigger', width: 90,
              render: (_: unknown, r: Task) => <Tag>{r.triggerType}</Tag>,
            },
            { title: '运行时', dataIndex: 'runtime', width: 80, render: (v: string) => v ? <Tag color="blue">{v}</Tag> : '-' },
          ]}
          dataSource={tasks}
          rowKey="id" loading={loading} size="small" pagination={{ pageSize: 10 }}
        />
      )}
    </Card>
  );
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────
function SettingsTab({ app, onUpdated }: { app: Application; onUpdated: (a: Application) => void }) {
  const [form] = Form.useForm();
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
      message.success('已保存');
      onUpdated(updated);
    } catch (err: unknown) {
      if (isFormValidationError(err)) return;
      message.error('保存失败');
    } finally { setSaving(false); }
  };

  return (
    <Card title="编辑应用" style={{ maxWidth: 620 }}>
      <Form form={form} layout="vertical">
        {/* name 为不可变标识（UpdateApplicationDto 不接受 name），只读展示 */}
        <Form.Item label="名称" tooltip="应用名称为全局唯一标识，创建后不可修改">
          <Input value={app.name} disabled />
        </Form.Item>
        <Form.Item name="description" label="描述">
          <Input.TextArea rows={2} />
        </Form.Item>
        <Space style={{ display: 'flex' }} size="middle">
          <Form.Item name="version" label="版本" rules={[{ required: true, message: '请输入版本号' }]}>
            <Input placeholder="1.0.0" style={{ width: 160 }} />
          </Form.Item>
          <Form.Item name="runtime" label="运行时" rules={[{ required: true }]}>
            <Select options={RUNTIME_OPTIONS} style={{ width: 140 }} />
          </Form.Item>
        </Space>
        <Form.Item name="gitRepo" label="Git 仓库"
          rules={[{ pattern: GIT_URL_RE, message: '格式不正确，需以 .git 结尾' }]}>
          <Input placeholder="https://github.com/user/repo.git" />
        </Form.Item>
        <Space style={{ display: 'flex' }} size="middle">
          <Form.Item name="gitBranch" label="分支">
            <Input placeholder="main" style={{ width: 180 }} />
          </Form.Item>
          <Form.Item name="gitCommit" label="Commit">
            <Input placeholder="HEAD" style={{ width: 200 }} />
          </Form.Item>
        </Space>
        <Form.Item name="entrypoint" label="入口文件">
          <Input placeholder="src/tasks/index.js" />
        </Form.Item>
        <Form.Item>
          <Tooltip title={isAdmin ? undefined : '仅管理员可修改应用设置'}>
            <Button type="primary" icon={<SaveOutlined />} onClick={handleSave} loading={saving} disabled={!isAdmin}>保存修改</Button>
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
  const [rollingBack, setRollingBack] = useState<string | null>(null);
  const isAdmin = useIsAdmin();

  const getVersionKey = (record: VersionRecord) => record.id ?? record.deploymentId ?? `${record.version ?? 'unknown'}-${record.commit ?? 'none'}-${record.createdAt ?? record.deployedAt ?? 'unknown'}`;

  const fetchVersions = useCallback(async () => {
    setLoading(true);
    try { setRecords(await applicationsApi.getVersionHistory(app.id)); }
    catch (err: unknown) { message.error(getErrMsg(err, '加载版本历史失败')); } finally { setLoading(false); }
  }, [app.id]);

  useEffect(() => { fetchVersions(); }, [fetchVersions]);

  const handleRollback = async (targetId: string, version: string | null) => {
    Modal.confirm({
      title: '确认回滚',
      content: `将回滚到版本 ${version ?? '未知'}，所有运行中的实例将同步升级，确定继续？`,
      okText: '确认回滚',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        setRollingBack(targetId);
        try {
          const res = await applicationsApi.rollback(app.id, targetId);
          message.success(`已回滚到 ${res.rolledBackTo ?? version}，影响 ${res.total ?? 0} 台实例`);
          await Promise.all([fetchVersions(), onAppReload()]);
        } catch (err: unknown) {
          message.error(getErrMsg(err, '回滚失败，请重试'));
        } finally {
          setRollingBack(null);
        }
      },
    });
  };

  return (
    <Card variant="borderless" extra={<Button icon={<ReloadOutlined />} size="small" onClick={fetchVersions}>刷新</Button>}>
      <Table<VersionRecord>
        rowKey={(record) => getVersionKey(record)}
        columns={[
          {
            title: '版本', dataIndex: 'version', width: 140,
            render: (v: string | null, r: VersionRecord) => (
              <Space size={4}>
                {v ? <Tag color="blue">{v}</Tag> : <Tag>未知</Tag>}
                {(r.deployCount ?? 1) > 1 && (
                  <Tooltip title={`该版本共部署 ${r.deployCount} 次`}>
                    <Tag color="default" style={{ fontSize: 11 }}>{r.deployCount}次</Tag>
                  </Tooltip>
                )}
              </Space>
            ),
          },
          { title: 'Commit', dataIndex: 'commit', width: 100, render: (v: string | null) => v ? <Text code>{v.slice(0, 8)}</Text> : '-' },
          {
            title: '状态', dataIndex: 'status', width: 90,
            render: (v: string) => (
              <Tag color={{ released: 'green', running: 'green', stopped: 'default', failed: 'red', deploying: 'blue' }[v] || 'default'}>{v}</Tag>
            ),
          },
          { title: '执行器', dataIndex: 'executorAddress', ellipsis: true },
          {
            title: '部署时间', dataIndex: 'deployedAt', width: 170,
            render: (_: string | null, r: VersionRecord) => {
              const deployedAt = r.createdAt ?? r.deployedAt;
              return deployedAt ? new Date(deployedAt).toLocaleString('zh-CN') : '-';
            },
          },
          {
            title: '操作', width: 90, align: 'center' as const,
            render: (_: unknown, record: VersionRecord) => {
              const currentRecord =
                records.find(r => r.version === app.version && (!app.gitCommit || !r.commit || r.commit === app.gitCommit)) ??
                records.find(r => r.version === app.version);
              const key = getVersionKey(record);
              const isCurrent = currentRecord && getVersionKey(currentRecord) === key;
              const rollbackDisabled = !!record.id && record.status !== 'released';
              if (isCurrent) return <Tag color="green">当前版本</Tag>;
              return (
                <Tooltip title={rollbackDisabled ? '仅已发布版本可回滚' : !isAdmin ? '仅管理员可回滚' : undefined}>
                  <Button
                    size="small"
                    danger
                    disabled={rollbackDisabled || !isAdmin}
                    loading={rollingBack === key}
                    onClick={() => handleRollback(key, record.version)}
                  >
                    回滚
                  </Button>
                </Tooltip>
              );
            },
          },
        ]}
        dataSource={records}
        loading={loading} size="small"
        pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 个版本` }}
        locale={{ emptyText: '暂无版本历史' }}
      />
    </Card>
  );
}

// ─── Releases（DEP-01 统一发布追溯）───────────────────────────────────────────
const RELEASE_DEPLOY_STATUS_COLORS: Record<string, string> = {
  running: 'green', stopped: 'default', failed: 'red', deploying: 'blue', upgrading: 'blue', pending: 'default',
};
const RELEASE_DEPLOY_STATUS_LABELS: Record<string, string> = {
  pending: '等待中', deploying: '部署中', running: '运行中', stopped: '已停止', failed: '失败', upgrading: '升级中',
};
const RELEASE_TRIGGER_LABELS: Record<string, string> = {
  upgrade: '滚动升级', manual: '手动部署', unknown: '未知',
};

function ReleasesTab({ app }: { app: Application }) {
  const [rows, setRows] = useState<AppReleaseRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const fetchReleases = useCallback(async (p: number) => {
    setLoading(true);
    setError(null);
    try {
      const res = await applicationsApi.getReleases(app.id, p, 20);
      setRows(res.data ?? []);
      setTotal(res.total ?? 0);
      setPage(res.page ?? p);
    } catch (err: unknown) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [app.id]);

  useEffect(() => { fetchReleases(1); }, [fetchReleases]);

  const columns = [
    {
      title: '版本', dataIndex: 'version', width: 150,
      render: (v: string | null, r: AppReleaseRow) => (
        <Space size={4}>
          {v ? <Tag color="blue" data-testid="release-version">{v}</Tag> : <Tag>未知</Tag>}
          {r.synthetic && (
            <Tooltip title="该部署记录未保存版本快照（历史数据合成行）">
              <Tag style={{ fontSize: 11 }}>合成</Tag>
            </Tooltip>
          )}
          {r.deploymentCount > 1 && (
            <Tooltip title={`该版本共部署 ${r.deploymentCount} 次`}>
              <Tag color="default" style={{ fontSize: 11 }}>{r.deploymentCount}次</Tag>
            </Tooltip>
          )}
        </Space>
      ),
    },
    {
      title: 'Commit', dataIndex: 'gitCommit', width: 110,
      render: (v: string | null) => (v ? <Text code>{v.slice(0, 8)}</Text> : '-'),
    },
    {
      title: '部署状态', dataIndex: 'deploymentStatus', width: 100,
      render: (v: string | null) =>
        v ? (
          <Tag color={RELEASE_DEPLOY_STATUS_COLORS[v] || 'default'}>
            {RELEASE_DEPLOY_STATUS_LABELS[v] || v}
          </Tag>
        ) : (
          <Text type="secondary">未部署</Text>
        ),
    },
    {
      title: '触发方式', dataIndex: 'triggerType', width: 100,
      render: (v: string | null) => (v ? <Tag>{RELEASE_TRIGGER_LABELS[v] || v}</Tag> : '-'),
    },
    { title: '执行器', dataIndex: 'executorAddress', ellipsis: true, render: (v: string | null) => v || '-' },
    {
      title: '部署时间', dataIndex: 'deployedAt', width: 170,
      render: (v: string | null, r: AppReleaseRow) => {
        const t = v ?? r.createdAt;
        return t ? new Date(t).toLocaleString('zh-CN') : '-';
      },
    },
    {
      title: '操作人', dataIndex: 'operator', width: 110,
      render: (v: string | null) =>
        v ? v : (
          <Tooltip title="当前所有写入路径均未记录部署操作人（application_versions.createdBy 未填充），来源扩展属后续任务">
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
          title="加载版本追溯失败"
        />
      </Card>
    );
  }

  return (
    <Card variant="borderless" extra={<Button icon={<ReloadOutlined />} size="small" onClick={() => fetchReleases(page)}>刷新</Button>}>
      <Table<AppReleaseRow>
        rowKey={(r) => r.id ?? r.latestDeploymentId ?? `${r.version ?? 'unknown'}-${r.createdAt ?? 'none'}`}
        columns={columns}
        dataSource={rows}
        loading={loading}
        size="small"
        data-testid="releases-table"
        pagination={{
          current: page,
          pageSize: 20,
          total,
          showTotal: (t) => `共 ${t} 个版本`,
          onChange: (p) => fetchReleases(p),
        }}
        locale={{ emptyText: '暂无发布记录（该应用还没有版本快照或部署历史）' }}
      />
    </Card>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────
export default function ApplicationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [app, setApp] = useState<Application | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const activeTab = searchParams.get('tab') || 'overview';

  const fetchApp = useCallback(async () => {
    if (!id) return;
    try {
      setLoading(true);
      setApp(await applicationsApi.get(id));
    } catch {
      message.error('加载失败');
      nav('/applications');
    } finally { setLoading(false); }
  }, [id, nav]);

  useEffect(() => { fetchApp(); }, [fetchApp]);

  const handleSyncTasks = async () => {
    if (!id) return;
    setSyncing(true);
    try {
      const result = await applicationsApi.syncTasks(id);
      message.success(`已同步 ${result.registeredCount} 个任务`);
    } catch (err: unknown) { message.error(getErrMsg(err, '同步失败')); }
    finally { setSyncing(false); }
  };

  // UI-08：首屏加载以骨架屏替代裸 Spin
  if (loading) return <PageSkeleton variant="table" rows={6} style={{ padding: 24 }} />;
  if (!app) return <Empty description="应用不存在" />;

  return (
    <div>
      {/* UI-03/UI-08：页头标准化（返回/刷新迁入 extra，面包屑声明二级层级） */}
      <PageHeader
        title={app.name}
        description="应用配置、版本与部署管理"
        breadcrumb={[{ title: '应用管理', to: '/applications' }, { title: app.name }]}
        extra={
          <>
            <Button icon={<ArrowLeftOutlined />} onClick={() => nav('/applications')}>返回</Button>
            <Button icon={<ReloadOutlined />} onClick={fetchApp}>刷新</Button>
            <Button type="primary" icon={<RocketOutlined />} onClick={() => setSearchParams({ tab: 'deployments' })}>
              新建部署
            </Button>
          </>
        }
      />

      <Tabs
        activeKey={activeTab}
        onChange={(key) => setSearchParams({ tab: key })}
        destroyOnHidden={false}
        items={[
          { key: 'overview', label: '概览', children: <OverviewTab app={app} /> },
          {
            key: 'deployments',
            label: <span><RocketOutlined /> 部署实例</span>,
            children: <AppDeploymentPage applicationId={app.id} />,
          },
          {
            key: 'tasks',
            label: '关联任务',
            children: <TasksTab appId={app.id} syncing={syncing} onSync={handleSyncTasks} />,
          },
          {
            key: 'versions',
            label: <span><HistoryOutlined /> 版本历史</span>,
            children: <VersionHistoryTab app={app} onAppReload={fetchApp} />,
          },
          // DEP-01：统一发布追溯（版本 × 最近一次部署一屏追溯）
          {
            key: 'releases',
            label: <span><HistoryOutlined /> 版本追溯</span>,
            children: <ReleasesTab app={app} />,
          },
          {
            key: 'settings',
            label: '设置',
            children: <SettingsTab app={app} onUpdated={(updated) => setApp(updated)} />,
          },
          {
            key: 'ai',
            label: <span><RobotOutlined /> AI 健康分析</span>,
            children: <AiAnalysisTab appId={app.id} />,
          },
        ]}
      />
    </div>
  );
}

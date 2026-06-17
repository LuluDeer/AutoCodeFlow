import { useState, useEffect, useCallback } from 'react';
import {
  Descriptions, Badge, Card, Table, Button, Space, Tag, Typography, message, Modal, Spin, Empty,
  Row, Col, Collapse, Tooltip, Tabs, Form, Input, Select, Progress, Statistic, Alert,
} from 'antd';
import {
  ArrowLeftOutlined, SyncOutlined, ReloadOutlined, GithubOutlined,
  SaveOutlined, HistoryOutlined,
  RocketOutlined, RobotOutlined,
} from '@ant-design/icons';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { applicationsApi, Application } from '../api/applications';
import { aiApi, AppHealthReport } from '../api/ai';
import { tasksApi, Task } from '../api/tasks';
import AppDeploymentPage from './AppDeploymentPage';
import { getErrMsg, isFormValidationError } from '../utils/error';

// ─── AI Analysis Tab ────────────────────────────────────────────────────────────
function AiAnalysisTab({ appId }: { appId: string }) {
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<AppHealthReport | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      extra={<Button icon={<ReloadOutlined />} onClick={runAnalysis} loading={loading}>重新分析</Button>}
    >
      {!report && !loading && !error && (
        <Empty
          description="点击「重新分析」让 AI 分析该应用的健康状态"
          image={<RobotOutlined style={{ fontSize: 48, color: '#1677ff' }} />}
        >
          <Button type="primary" icon={<RobotOutlined />} onClick={runAnalysis}>开始分析</Button>
        </Empty>
      )}
      {loading && <div style={{ textAlign: 'center', padding: 40 }}><Spin tip="AI 分析中…" size="large" /></div>}
      {error && <Alert type="error" message={error} showIcon />}
      {report && !loading && (
        <div>
          <Row gutter={16} style={{ marginBottom: 24 }}>
            <Col span={8}>
              <Card size="small">
                <Statistic title="关联任务数" value={report.taskCount} />
              </Card>
            </Col>
            <Col span={8}>
              <Card size="small">
                <Statistic
                  title="成功率"
                  value={(report.successRate * 100).toFixed(1)}
                  suffix="%"
                  valueStyle={{ color: report.successRate >= 0.9 ? '#3f8600' : report.successRate >= 0.7 ? '#d48806' : '#cf1322' }}
                />
              </Card>
            </Col>
            <Col span={8}>
              <Card size="small">
                <Statistic title="平均耗时" value={report.avgDuration ? `${(report.avgDuration / 1000).toFixed(1)}s` : '-'} />
              </Card>
            </Col>
          </Row>
          {report.successRate < 1 && (
            <Progress
              percent={Math.round(report.successRate * 100)}
              strokeColor={report.successRate >= 0.9 ? '#52c41a' : report.successRate >= 0.7 ? '#faad14' : '#ff4d4f'}
              style={{ marginBottom: 16 }}
            />
          )}
          {report.failedTasks.length > 0 && (
            <Card size="small" title="高失败率任务" style={{ marginBottom: 16 }}>
              {report.failedTasks.map(t => (
                <div key={t.id} style={{ marginBottom: 4 }}>
                  <Tag color="red">{(t.failureRate * 100).toFixed(1)}%</Tag>
                  <span>{t.name}</span>
                </div>
              ))}
            </Card>
          )}
          {report.aiAnalysis && (
            <Alert
              type="info"
              message="AI 分析结论"
              description={<pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{report.aiAnalysis}</pre>}
              showIcon
              icon={<RobotOutlined />}
            />
          )}
        </div>
      )}
    </Card>
  );
}

const { Title, Text } = Typography;

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
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
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
                background: '#1e1e1e', color: '#d4d4d4', padding: 16,
                borderRadius: 8, maxHeight: 300, overflow: 'auto', fontSize: 13,
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
      bordered={false}
      extra={
        <Space>
          <Tooltip title="重新解析 manifest.json 并注册任务">
            <Button loading={syncing} icon={<SyncOutlined />} onClick={onSync} size="small">同步任务</Button>
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

  useEffect(() => {
    form.setFieldsValue({
      name: app.name, description: app.description, version: app.version,
      runtime: app.runtime, gitRepo: app.gitRepo, gitBranch: app.gitBranch,
      gitCommit: app.gitCommit, entrypoint: app.entrypoint,
    });
  }, [app, form]);

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      setSaving(true);
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
        <Form.Item name="name" label="名称"
          rules={[{ required: true }, { pattern: /^[a-zA-Z0-9_-]+$/, message: '只允许字母、数字、下划线、连字符' }]}>
          <Input />
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
          <Button type="primary" icon={<SaveOutlined />} onClick={handleSave} loading={saving}>保存修改</Button>
        </Form.Item>
      </Form>
    </Card>
  );
}

// ─── Version History ─────────────────────────────────────────────────────────
type VersionRecord = { deploymentId: string; version: string | null; commit: string | null; status: string; deployedAt: string | null; executorAddress: string; };

function VersionHistoryTab({ appId }: { appId: string }) {
  const [records, setRecords] = useState<VersionRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [rollingBack, setRollingBack] = useState<string | null>(null);

  const fetchVersions = useCallback(async () => {
    setLoading(true);
    try { setRecords(await applicationsApi.getVersionHistory(appId)); }
    catch (err: unknown) { message.error(getErrMsg(err, '加载版本历史失败')); } finally { setLoading(false); }
  }, [appId]);

  useEffect(() => { fetchVersions(); }, [fetchVersions]);

  const handleRollback = async (deploymentId: string, version: string | null) => {
    Modal.confirm({
      title: '确认回滚',
      content: `将回滚到版本 ${version ?? '未知'}，所有运行中的实例将同步升级，确定继续？`,
      okText: '确认回滚',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        setRollingBack(deploymentId);
        try {
          const res = await applicationsApi.rollback(appId, deploymentId);
          message.success(`已回滚到 ${res.rolledBackTo ?? version}，影响 ${res.total ?? 0} 台实例`);
          fetchVersions();
        } catch (err: unknown) {
          message.error(getErrMsg(err, '回滚失败，请重试'));
        } finally {
          setRollingBack(null);
        }
      },
    });
  };

  return (
    <Card bordered={false} extra={<Button icon={<ReloadOutlined />} size="small" onClick={fetchVersions}>刷新</Button>}>
      <Table<VersionRecord>
        rowKey="deploymentId"
        columns={[
          { title: '版本', dataIndex: 'version', width: 120, render: (v: string | null) => v ? <Tag color="blue">{v}</Tag> : <Tag>未知</Tag> },
          { title: 'Commit', dataIndex: 'commit', width: 100, render: (v: string | null) => v ? <Text code>{v.slice(0, 8)}</Text> : '-' },
          {
            title: '状态', dataIndex: 'status', width: 90,
            render: (v: string) => (
              <Tag color={{ running: 'green', stopped: 'default', failed: 'red', deploying: 'blue' }[v] || 'default'}>{v}</Tag>
            ),
          },
          { title: '执行器', dataIndex: 'executorAddress', ellipsis: true },
          { title: '部署时间', dataIndex: 'deployedAt', width: 170, render: (v: string | null) => v ? new Date(v).toLocaleString('zh-CN') : '-' },
          {
            title: '操作', width: 90, align: 'center' as const,
            render: (_: unknown, record: VersionRecord) => (
              <Button
                size="small"
                danger
                loading={rollingBack === record.deploymentId}
                onClick={() => handleRollback(record.deploymentId, record.version)}
              >
                回滚
              </Button>
            ),
          },
        ]}
        dataSource={records}
        loading={loading} size="small"
        pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 条` }}
        locale={{ emptyText: '暂无版本历史' }}
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
    } catch (err: unknown) {
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

  if (loading) return <div style={{ textAlign: 'center', padding: 80 }}><Spin size="large" /></div>;
  if (!app) return <Empty description="应用不存在" />;

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => nav('/applications')}>返回</Button>
        <Button icon={<ReloadOutlined />} onClick={fetchApp}>刷新</Button>
      </Space>

      <Row justify="space-between" align="middle" style={{ marginBottom: 16 }}>
        <Col>
          <Space align="center">
            {app.gitRepo && <GithubOutlined style={{ fontSize: 20 }} />}
            <Title level={4} style={{ margin: 0 }}>{app.name}</Title>
            <Tag color={STATUS_COLORS[app.status] || 'default'}>
              {STATUS_LABELS[app.status] || app.status}
            </Tag>
            {app.gitBranch && <Tag>{app.gitBranch}</Tag>}
            <Tag color="blue">{app.version}</Tag>
          </Space>
        </Col>
        <Col>
          <Button type="primary" icon={<RocketOutlined />} onClick={() => setSearchParams({ tab: 'deployments' })}>
            新建部署
          </Button>
        </Col>
      </Row>

      <Tabs
        activeKey={activeTab}
        onChange={(key) => setSearchParams({ tab: key })}
        destroyInactiveTabPane={false}
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
            children: <VersionHistoryTab appId={app.id} />,
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

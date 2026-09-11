import { useState, useEffect, useCallback, useRef } from 'react';
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
import { useTranslation } from 'react-i18next';
import '../i18n';
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
  const { t } = useTranslation();
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
          image={<RobotOutlined style={{ fontSize: 48, color: '#1677ff' }} />}
        >
          <Tooltip title={isAdmin ? undefined : t('appDetail.ai.adminOnly')}>
            <Button type="primary" icon={<RobotOutlined />} onClick={runAnalysis} disabled={!isAdmin}>{t('appDetail.ai.start')}</Button>
          </Tooltip>
        </Empty>
      )}
      {loading && <div style={{ textAlign: 'center', padding: 40 }}><Spin tip={t('appDetail.ai.analyzing')} size="large" /></div>}
      {error && <Alert type="error" title={error} showIcon />}
      {report && !loading && (
        <div>
          <Row gutter={16} style={{ marginBottom: 24 }}>
            <Col span={8}>
              <Card size="small">
                <Statistic title={t('appDetail.ai.stat.tasks')} value={report.stats.totalTasks} />
              </Card>
            </Col>
            <Col span={8}>
              <Card size="small">
                <Statistic
                  title={t('appDetail.ai.stat.successRate')}
                  value={report.stats.avgSuccessRate}
                  suffix="%"
                  styles={{ content: { color: report.stats.avgSuccessRate >= 90 ? '#3f8600' : report.stats.avgSuccessRate >= 70 ? '#d48806' : '#cf1322' } }}
                />
              </Card>
            </Col>
            <Col span={8}>
              <Card size="small">
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
              message={t('appDetail.ai.conclusion')}
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
          <Descriptions.Item label={t('appDetail.field.runtime')}><Tag>{app.runtime}</Tag></Descriptions.Item>
          <Descriptions.Item label={t('appDetail.field.status')}>
            <Tag color={STATUS_COLORS[app.status] || 'default'}>{STATUS_LABELS(t)[app.status] || app.status}</Tag>
          </Descriptions.Item>
          {app.description && (
            <Descriptions.Item label={t('appDetail.field.description')} span={3}>{app.description}</Descriptions.Item>
          )}
          {app.gitRepo && (
            <Descriptions.Item label={t('appDetail.field.gitRepo')} span={2}>
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
          {app.gitBranch && <Descriptions.Item label={t('appDetail.field.gitBranch')}><Tag>{app.gitBranch}</Tag></Descriptions.Item>}
          {app.gitCommit && (
            <Descriptions.Item label={t('appDetail.field.commit')}><Text code>{app.gitCommit.slice(0, 8)}</Text></Descriptions.Item>
          )}
          {app.entrypoint && (
            <Descriptions.Item label={t('appDetail.field.entrypoint')}><Text code>{app.entrypoint}</Text></Descriptions.Item>
          )}
          <Descriptions.Item label={t('appDetail.field.createdAt')}>
            {app.createdAt ? new Date(app.createdAt).toLocaleString('zh-CN') : '-'}
          </Descriptions.Item>
          <Descriptions.Item label={t('appDetail.field.updatedAt')}>
            {app.updatedAt ? new Date(app.updatedAt).toLocaleString('zh-CN') : '-'}
          </Descriptions.Item>
        </Descriptions>

        {app.env && Object.keys(app.env).length > 0 && (
          <Collapse ghost style={{ marginTop: 12 }}>
            <Collapse.Panel header={t('appDetail.env', { count: Object.keys(app.env).length })} key="env">
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
        <Card title={t('appDetail.manifest')}>
          <Collapse ghost>
            <Collapse.Panel header={t('appDetail.viewDetail')} key="manifest">
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
  const { t } = useTranslation();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(false);
  const isAdmin = useIsAdmin();
  const requestControllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  const fetchTasks = useCallback(async () => {
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    setLoading(true);
    try {
      const res = await tasksApi.list(
        { page: 1, pageSize: 100, applicationId: appId },
        controller.signal,
      );
      if (!controller.signal.aborted && mountedRef.current) {
        setTasks(res.items ?? []);
      }
    } catch (err: unknown) {
      if (!controller.signal.aborted && mountedRef.current) {
        message.error(getErrMsg(err, t('appDetail.tasks.loadFail')));
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
    fetchTasks();
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
          <Button icon={<ReloadOutlined />} size="small" onClick={fetchTasks}>{t('appDetail.refresh')}</Button>
        </Space>
      }
    >
      {tasks.length === 0 && !loading ? (
        <Empty description={t('appDetail.tasks.empty')}>
          <Button type="primary" size="small" onClick={() => nav(`/tasks/new?applicationId=${appId}`)}>{t('appDetail.tasks.createFirst')}</Button>
        </Empty>
      ) : (
        <Table<Task>
          columns={[
            {
              title: t('appDetail.tasks.col.name'),
              dataIndex: 'name',
              render: (n: string, r: Task) => <a onClick={() => nav(`/tasks/${r.id}`)}>{n}</a>,
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
              render: (_: unknown, r: Task) => <Tag>{r.triggerType}</Tag>,
            },
            { title: t('appDetail.tasks.col.runtime'), dataIndex: 'runtime', width: 80, render: (v: string) => v ? <Tag color="blue">{v}</Tag> : '-' },
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
      message.error(t('appDetail.settings.saveFail'));
    } finally { setSaving(false); }
  };

  return (
    <Card title={t('appDetail.settings.edit')} style={{ maxWidth: 620 }}>
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
  const [rollingBack, setRollingBack] = useState<string | null>(null);
  const isAdmin = useIsAdmin();
  const { t } = useTranslation();

  const getVersionKey = (record: VersionRecord) => record.id ?? record.deploymentId ?? `${record.version ?? 'unknown'}-${record.commit ?? 'none'}-${record.createdAt ?? record.deployedAt ?? 'unknown'}`;

  const fetchVersions = useCallback(async () => {
    setLoading(true);
    try { setRecords(await applicationsApi.getVersionHistory(app.id)); }
    catch (err: unknown) { message.error(getErrMsg(err, t('appDetail.history.loadFail'))); } finally { setLoading(false); }
  }, [app.id]);

  useEffect(() => { fetchVersions(); }, [fetchVersions]);

  const handleRollback = async (targetId: string, version: string | null) => {
    Modal.confirm({
      title: t('appDetail.history.rollbackConfirm'),
      content: t('appDetail.history.rollbackContent', { version: version ?? t('appDetail.unknown') }),
      okText: t('appDetail.history.rollbackOk'),
      okType: 'danger',
      cancelText: t('appDetail.cancel'),
      onOk: async () => {
        setRollingBack(targetId);
        try {
          const res = await applicationsApi.rollback(app.id, targetId);
          message.success(t('appDetail.history.rolledBack', { version: res.rolledBackTo ?? version ?? t('appDetail.unknown'), count: res.total ?? 0 }));
          await Promise.all([fetchVersions(), onAppReload()]);
        } catch (err: unknown) {
          message.error(getErrMsg(err, t('appDetail.history.rollbackFail')));
        } finally {
          setRollingBack(null);
        }
      },
    });
  };

  return (
    <Card variant="borderless" extra={<Button icon={<ReloadOutlined />} size="small" onClick={fetchVersions}>{t('appDetail.refresh')}</Button>}>
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
              <Tag color={{ released: 'green', running: 'green', stopped: 'default', failed: 'red', deploying: 'blue' }[v] || 'default'}>{v}</Tag>
            ),
          },
          { title: t('appDetail.col.executor'), dataIndex: 'executorAddress', ellipsis: true },
          {
            title: t('appDetail.col.deployedAt'), dataIndex: 'deployedAt', width: 170,
            render: (_: string | null, r: VersionRecord) => {
              const deployedAt = r.createdAt ?? r.deployedAt;
              return deployedAt ? new Date(deployedAt).toLocaleString('zh-CN') : '-';
            },
          },
          {
            title: t('appDetail.col.actions'), width: 90, align: 'center' as const,
            render: (_: unknown, record: VersionRecord) => {
              const currentRecord =
                records.find(r => r.version === app.version && (!app.gitCommit || !r.commit || r.commit === app.gitCommit)) ??
                records.find(r => r.version === app.version);
              const key = getVersionKey(record);
              const isCurrent = currentRecord && getVersionKey(currentRecord) === key;
              const rollbackDisabled = !!record.id && record.status !== 'released';
              if (isCurrent) return <Tag color="green">{t('appDetail.history.currentVersion')}</Tag>;
              return (
                <Tooltip title={rollbackDisabled ? t('appDetail.history.rollbackReleasedOnly') : !isAdmin ? t('appDetail.history.rollbackAdminOnly') : undefined}>
                  <Button
                    size="small"
                    danger
                    disabled={rollbackDisabled || !isAdmin}
                    loading={rollingBack === key}
                    onClick={() => handleRollback(key, record.version)}
                  >
                    {t('appDetail.history.rollback')}
                  </Button>
                </Tooltip>
              );
            },
          },
        ]}
        dataSource={records}
        loading={loading} size="small"
        pagination={{ pageSize: 20, showTotal: (n) => t('appDetail.count', { count: n }) }}
        locale={{ emptyText: t('appDetail.history.empty') }}
      />
    </Card>
  );
}

// ─── Releases（DEP-01 统一发布追溯）───────────────────────────────────────────
const RELEASE_DEPLOY_STATUS_COLORS: Record<string, string> = {
  running: 'green', stopped: 'default', failed: 'red', deploying: 'blue', upgrading: 'blue', pending: 'default',
};
const RELEASE_DEPLOY_STATUS_LABELS = (t: (k: string) => string): Record<string, string> => ({
  pending: t('appDetail.releases.status.pending'), deploying: t('appDetail.releases.status.deploying'), running: t('appDetail.releases.status.running'), stopped: t('appDetail.releases.status.stopped'), failed: t('appDetail.releases.status.failed'), upgrading: t('appDetail.releases.status.upgrading'),
});
const RELEASE_TRIGGER_LABELS = (t: (k: string) => string): Record<string, string> => ({
  upgrade: t('appDetail.releases.trigger.upgrade'), manual: t('appDetail.releases.trigger.manual'), unknown: t('appDetail.releases.trigger.unknown'),
});

function ReleasesTab({ app }: { app: Application }) {
  const [rows, setRows] = useState<AppReleaseRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const { t } = useTranslation();

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
          <Tag color={RELEASE_DEPLOY_STATUS_COLORS[v] || 'default'}>
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
    { title: t('appDetail.col.executor'), dataIndex: 'executorAddress', ellipsis: true, render: (v: string | null) => v || '-' },
    {
      title: t('appDetail.col.deployedAt'), dataIndex: 'deployedAt', width: 170,
      render: (v: string | null, r: AppReleaseRow) => {
        const time = v ?? r.createdAt;
        return time ? new Date(time).toLocaleString('zh-CN') : '-';
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
    <Card variant="borderless" extra={<Button icon={<ReloadOutlined />} size="small" onClick={() => fetchReleases(page)}>{t('appDetail.refresh')}</Button>}>
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
          showTotal: (n) => t('appDetail.count', { count: n }),
          onChange: (p) => fetchReleases(p),
        }}
        locale={{ emptyText: t('appDetail.releases.empty') }}
      />
    </Card>
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

  const activeTab = searchParams.get('tab') || 'overview';

  const fetchApp = useCallback(async () => {
    if (!id) return;
    try {
      setLoading(true);
      setApp(await applicationsApi.get(id));
    } catch {
      message.error(t('appDetail.loadFail'));
      nav('/applications');
    } finally { setLoading(false); }
  }, [id, nav, t]);

  useEffect(() => { fetchApp(); }, [fetchApp]);

  const handleSyncTasks = async () => {
    if (!id) return;
    setSyncing(true);
    try {
      const result = await applicationsApi.syncTasks(id);
      message.success(t('appDetail.tasks.synced', { count: result.registeredCount }));
    } catch (err: unknown) { message.error(getErrMsg(err, t('appDetail.tasks.syncFail'))); }
    finally { setSyncing(false); }
  };

  // UI-08：首屏加载以骨架屏替代裸 Spin
  if (loading) return <PageSkeleton variant="table" rows={6} style={{ padding: 24 }} />;
  if (!app) return <Empty description={t('appDetail.notFound')} />;

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
            children: <AppDeploymentPage applicationId={app.id} />,
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

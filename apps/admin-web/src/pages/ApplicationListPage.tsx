import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Table, Button, Space, Tag, Modal, Form, Input, Select, Upload, message,
  Popconfirm, Typography, Tooltip, Badge, Radio, Empty, Switch,
} from 'antd';
import {
  PlusOutlined, UploadOutlined, ReloadOutlined, GithubOutlined,
  SearchOutlined, FilterOutlined, EyeOutlined, RocketOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons';
import { applicationsApi, Application, deploymentsApi, AppDeployment } from '../api/applications';
import { executorsApi } from '../api/executors';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getErrMsg, isFormValidationError } from '../utils/error';
import { formatDateTime, formatRelativeTime } from '../utils/timeFormat';
import { useAuthStore, isAdminUser } from '../store/auth';
import PageHeader from '../components/PageHeader';
import PageSkeleton from '../components/PageSkeleton';
import StateError from '../components/StateError';
// UI-10：导入 i18n 实例（模块副作用完成初始化；树内用 useTranslation 读 key）
import '../i18n';

const { Text } = Typography;

/** UI-08：首屏 Skeleton 渲染判据——初次加载（无数据）且未出错时以骨架屏替代表格 Spin */
function shouldShowSkeleton(loading: boolean, error: unknown, count: number): boolean {
  return loading && count === 0 && !error;
}

/**
 * W3 RBAC（对齐 settings 页先例）：应用写面（创建/上传/编辑/删除/快速部署）
 * 后端已全链 @Roles(ADMIN)，读面（列表/详情）登录即可。
 * 普通用户：写按钮禁用并给出提示（读面保持可见），不发起会 403 的请求。
 */
function useIsAdmin() {
  const user = useAuthStore((s) => s.user);
  return isAdminUser(user);
}

const GIT_URL_RE = /^(https?:\/\/[\w.@:/~_-]+\.git|git@[\w.-]+:[\w./_-]+\.git)$/;

const runtimeOptions = [
  { label: 'Node.js', value: 'node' },
  { label: 'Python', value: 'python' },
  { label: 'Shell', value: 'shell' },
];

const statusColors: Record<string, string> = {
  active: 'green',
  deploying: 'blue',
  failed: 'red',
};

const statusLabels = (t: (k: string) => string): Record<string, string> => ({
  active: t('appList.status.active'),
  deploying: t('appList.status.deploying'),
  failed: t('appList.status.failed'),
});

interface AppWithStats extends Application {
  runningCount: number;
  totalDeployments: number;
  lastDeployedAt: string | null;
}

export default function ApplicationListPage() {
  const nav = useNavigate();
  const { t } = useTranslation();
  const isAdmin = useIsAdmin();
  const [apps, setApps] = useState<AppWithStats[]>([]);
  const [loading, setLoading] = useState(false);
  // UI-08：首屏加载失败不再只弹一次性 toast——记录错误并原位呈现「重试+复制」错误块
  const [loadError, setLoadError] = useState<unknown>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [editingApp, setEditingApp] = useState<Application | null>(null);
  const [form] = Form.useForm();
  const [uploadForm] = Form.useForm();
  const [searchText, setSearchText] = useState('');
  const [statusFilter, setStatusFilter] = useState<string | undefined>();
  const [runtimeFilter, setRuntimeFilter] = useState<string | undefined>();
  const [quickDeployApp, setQuickDeployApp] = useState<string | null>(null);
  const [quickDeployExecutors, setQuickDeployExecutors] = useState<{id: string; name: string; address: string; status: string}[]>([]);
  const [quickDeployForm] = Form.useForm();
  const [quickDeploying, setQuickDeploying] = useState(false);

  const fetchApps = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await applicationsApi.list();

      // Fetch all deployments in parallel per app to compute stats
      const deploymentResults = await Promise.allSettled(
        data.map((app) => deploymentsApi.list(app.id))
      );

      const enriched: AppWithStats[] = data.map((app, i) => {
        const result = deploymentResults[i];
        const deps: AppDeployment[] =
          result.status === 'fulfilled' ? result.value.data : [];

        const runningCount = deps.filter((d) => d.status === 'running').length;
        const sorted = [...deps].sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
        const lastDeployedAt =
          sorted.length > 0 ? (sorted[0].deployedAt ?? sorted[0].createdAt) : null;

        return { ...app, runningCount, totalDeployments: deps.length, lastDeployedAt };
      });

      setApps(enriched);
    } catch (err: unknown) {
      setLoadError(err);
      message.error(getErrMsg(err, t('appList.loadFail')));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchApps(); }, [fetchApps]);

  const filtered = useMemo(() => {
    return apps.filter((a) => {
      const matchSearch = !searchText ||
        a.name.toLowerCase().includes(searchText.toLowerCase()) ||
        (a.description?.toLowerCase().includes(searchText.toLowerCase()) ?? false);
      const matchStatus = !statusFilter || a.status === statusFilter;
      const matchRuntime = !runtimeFilter || a.runtime === runtimeFilter;
      return matchSearch && matchStatus && matchRuntime;
    });
  }, [apps, searchText, statusFilter, runtimeFilter]);

  const hasFilters = !!(searchText || statusFilter || runtimeFilter);

  const handleCreate = () => {
    setEditingApp(null);
    setModalOpen(true);
  };

  const handleEdit = (app: Application) => {
    setEditingApp(app);
    setModalOpen(true);
  };

  const handleDelete = async (id: string) => {
    try {
      await applicationsApi.delete(id);
      message.success(t('appList.deleted'));
      fetchApps();
    } catch (err: unknown) {
      message.error(getErrMsg(err, t('appList.deleteFail')));
    }
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      if (editingApp) {
        // name 为不可变标识：UpdateApplicationDto 未声明 name 字段，
        // 带上会被全局 ValidationPipe（forbidNonWhitelisted）以 400 拒绝
        delete (values as { name?: string }).name;
        await applicationsApi.update(editingApp.id, values);
        message.success(t('appList.updated'));
      } else {
        await applicationsApi.create(values);
        message.success(t('appList.created'));
      }
      setModalOpen(false);
      fetchApps();
    } catch (err: unknown) {
      if (isFormValidationError(err)) return;
      message.error(getErrMsg(err, t('appList.saveFail')));
    }
  };

  const handleUpload = async () => {
    try {
      const values = await uploadForm.validateFields();
      const formData = new FormData();
      formData.append('name', values.name);
      formData.append('runtime', values.runtime || 'node');
      if (values.file?.fileList?.[0]?.originFileObj) {
        formData.append('file', values.file.fileList[0].originFileObj);
      }
      await applicationsApi.upload(formData);
      message.success(t('appList.uploaded'));
      setUploadModalOpen(false);
      fetchApps();
    } catch (err: unknown) {
      if (isFormValidationError(err)) return;
      message.error(getErrMsg(err, t('appList.uploadFail')));
    }
  };

  const openQuickDeploy = async (appId: string) => {
    setQuickDeployApp(appId);
    quickDeployForm.resetFields();
    quickDeployForm.setFieldsValue({ runMode: 'once' });
    try {
      const res = await executorsApi.list();
      setQuickDeployExecutors(res.map(e => ({ id: e.id, name: e.appName, address: e.address, status: e.status })) ?? []);
    } catch {
      setQuickDeployExecutors([]);
      message.warning(t('appList.executorListFail'));
    }
  };

  const handleQuickDeploy = async () => {
    if (!quickDeployApp) return;
    try {
      const values = await quickDeployForm.validateFields();
      setQuickDeploying(true);
      await deploymentsApi.deploy(quickDeployApp, {
        executorId: values.executorId || undefined,
        runMode: values.runMode,
        startCommand: values.runMode === 'daemon' ? values.startCommand : undefined,
      });
      message.success(t('appList.deployCreated'));
      setQuickDeployApp(null);
      fetchApps();
    } catch (err: unknown) {
      if (isFormValidationError(err)) return;
      message.error(getErrMsg(err, t('appList.deployFail')));
    } finally {
      setQuickDeploying(false);
    }
  };

  const columns = [
    {
      title: t('appList.col.name'),
      dataIndex: 'name',
      key: 'name',
      sorter: (a: AppWithStats, b: AppWithStats) => a.name.localeCompare(b.name),
      render: (name: string, record: AppWithStats) => (
        <Space orientation="vertical" size={0}>
          <Space>
            {record.gitRepo && <GithubOutlined />}
            <a onClick={() => nav(`/applications/${record.id}`)}>
              <Text strong>{name}</Text>
            </a>
          </Space>
          {record.gitBranch && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t('appList.branch', { branch: record.gitBranch })}
            </Text>
          )}
        </Space>
      ),
    },
    {
      title: t('appList.col.version'),
      dataIndex: 'version',
      key: 'version',
      width: 90,
      render: (v: string) => <Tag>{v}</Tag>,
    },
    {
      title: t('appList.col.runtime'),
      dataIndex: 'runtime',
      key: 'runtime',
      width: 90,
      render: (v: string) => <Tag color="blue">{v}</Tag>,
    },
    {
      title: t('appList.col.status'),
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (s: string) => <Tag color={statusColors[s] || 'default'}>{statusLabels(t)[s] || s}</Tag>,
    },
    {
      title: t('appList.col.instances'),
      key: 'deployStats',
      width: 130,
      render: (_: unknown, record: AppWithStats) => {
        if (record.totalDeployments === 0) return <Text type="secondary">{t('appList.noDeploy')}</Text>;
        return (
          <Space>
            <Badge status="processing" />
            <Text>{t('appList.runningInstances', { running: record.runningCount, total: record.totalDeployments })}</Text>
          </Space>
        );
      },
    },
    {
      title: t('appList.col.lastDeploy'),
      key: 'lastDeployedAt',
      width: 110,
      render: (_: unknown, record: AppWithStats) => (
        <Tooltip title={record.lastDeployedAt ? formatDateTime(record.lastDeployedAt) : t('appList.notDeployed')}>
          <Text type={record.lastDeployedAt ? undefined : 'secondary'}>
            {formatRelativeTime(record.lastDeployedAt)}
          </Text>
        </Tooltip>
      ),
    },
    {
      title: t('appList.col.actions'),
      key: 'actions',
      width: 210,
      render: (_: unknown, record: AppWithStats) => (
        <Space>
          <Button
            type="link"
            size="small"
            icon={<EyeOutlined />}
            onClick={() => nav(`/applications/${record.id}`)}
          >
            {t('appList.action.detail')}
          </Button>
          <Tooltip title={isAdmin ? t('appList.deployHint') : t('appList.deployDisableHint')}>
            <Button
              type="link"
              size="small"
              icon={<RocketOutlined />}
              onClick={() => openQuickDeploy(record.id)}
              disabled={!isAdmin}
            >
              {t('appList.action.deploy')}
            </Button>
          </Tooltip>
          <Tooltip title={isAdmin ? t('appList.editHint') : t('appList.editDisableHint')}>
            <Button type="link" size="small" onClick={() => handleEdit(record)} disabled={!isAdmin}>{t('appList.action.edit')}</Button>
          </Tooltip>
          <Popconfirm
            title={t('appList.deleteConfirm')}
            description={t('appList.deleteConfirmDesc')}
            onConfirm={() => handleDelete(record.id)}
            okText={t('appList.action.delete')}
            okButtonProps={{ danger: true }}
            disabled={!isAdmin}
          >
            <Tooltip title={isAdmin ? t('appList.deleteHint') : t('appList.deleteDisableHint')}>
              <Button type="link" size="small" danger disabled={!isAdmin}>{t('appList.action.delete')}</Button>
            </Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      {/* UI-03/UI-08：页头标准化（原 Typography.Title+操作区迁入 PageHeader） */}
      <PageHeader
        title={t('appList.title')}
        extra={
          <>
            <Tooltip title={isAdmin ? undefined : t('appList.createDisableHint')}>
              <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate} disabled={!isAdmin}>
                {t('appList.create')}
              </Button>
            </Tooltip>
            <Tooltip title={isAdmin ? undefined : t('appList.uploadDisableHint')}>
              <Button icon={<UploadOutlined />} onClick={() => {
                setUploadModalOpen(true);
              }} disabled={!isAdmin}>
                {t('appList.uploadZip')}
              </Button>
            </Tooltip>
            <Button icon={<ReloadOutlined />} onClick={fetchApps} loading={loading}>{t('appList.refresh')}</Button>
          </>
        }
      />

      {/* UI-08：首屏错误态（重试+复制错误信息） */}
      {loadError !== null && !loading && (
        <StateError error={loadError} onRetry={fetchApps} style={{ marginBottom: 16 }} />
      )}

      {/* 搜索/筛选栏 */}
      <Space style={{ marginBottom: 16 }} wrap>
        <Input
          placeholder={t('appList.searchPlaceholder')}
          prefix={<SearchOutlined />}
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          allowClear
          style={{ width: 220 }}
        />
        <Select
          placeholder={t('appList.statusFilter')}
          allowClear
          style={{ width: 130 }}
          value={statusFilter}
          onChange={setStatusFilter}
          suffixIcon={<FilterOutlined />}
          options={[
            { value: 'active', label: t('appList.status.active') },
            { value: 'deploying', label: t('appList.status.deploying') },
            { value: 'failed', label: t('appList.status.failed') },
          ]}
        />
        <Select
          placeholder={t('appList.runtimeFilter')}
          allowClear
          style={{ width: 120 }}
          value={runtimeFilter}
          onChange={setRuntimeFilter}
          options={runtimeOptions}
        />
        {hasFilters && (
          <Button
            size="small"
            onClick={() => { setSearchText(''); setStatusFilter(undefined); setRuntimeFilter(undefined); }}
          >
            {t('appList.clearFilters')}
          </Button>
        )}
        {hasFilters && (
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            {t('appList.count', { filtered: filtered.length, total: apps.length })}
          </Typography.Text>
        )}
      </Space>

      <Table
        columns={columns}
        dataSource={filtered}
        rowKey="id"
        loading={false}
        locale={{
          emptyText: shouldShowSkeleton(loading, loadError, apps.length)
            ? <PageSkeleton variant="table" />
            : (loadError
              ? undefined
              : (hasFilters
                ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('appList.empty.noMatch')} />
                : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('appList.empty.none')} />)),
        }}
      />

      {/* Create/Edit Modal */}
      <Modal
        title={editingApp ? t('appList.modal.edit') : t('appList.modal.create')}
        open={modalOpen}
        onOk={handleSubmit}
        onCancel={() => setModalOpen(false)}
        afterOpenChange={(open) => {
          if (open) {
            if (editingApp) {
              form.setFieldsValue(editingApp);
            } else {
              form.resetFields();
              form.setFieldsValue({ runtime: 'node', version: '1.0.0' });
            }
          }
        }}
        width={600}
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="name"
            label={t('appList.field.name')}
            rules={[
              { required: true, message: t('appList.field.nameRequired') },
              { pattern: /^[a-zA-Z0-9_-]+$/, message: t('appList.field.namePattern') },
            ]}
            tooltip={{
              title: t('appList.field.nameTooltip'),
              icon: <InfoCircleOutlined />,
            }}
          >
            <Input placeholder="my-autocodeflow-app" disabled={!!editingApp} />
          </Form.Item>

          <Form.Item
            name="description"
            label={t('appList.field.desc')}
            tooltip={{
              title: t('appList.field.descTooltip'),
              icon: <InfoCircleOutlined />,
            }}
          >
            <Input.TextArea rows={2} placeholder={t('appList.field.descPlaceholder')} />
          </Form.Item>

          <Space style={{ display: 'flex' }} size="middle">
            <Form.Item
              name="version"
              label={t('appList.field.version')}
              rules={[{ required: true, message: t('appList.field.versionRequired') }]}
              tooltip={{
                title: t('appList.field.versionTooltip'),
                icon: <InfoCircleOutlined />,
              }}
            >
              <Input placeholder="1.0.0" style={{ width: 160 }} />
            </Form.Item>
            <Form.Item
              name="runtime"
              label={t('appList.field.runtime')}
              rules={[{ required: true, message: t('appList.field.runtimeRequired') }]}
              tooltip={{
                title: t('appList.field.runtimeTooltip'),
                icon: <InfoCircleOutlined />,
              }}
            >
              <Select options={runtimeOptions} style={{ width: 140 }} />
            </Form.Item>
          </Space>

          <Form.Item
            name="gitRepo"
            label={t('appList.field.gitRepo')}
            rules={[
              {
                pattern: GIT_URL_RE,
                message: t('appList.field.gitRepoPattern'),
              },
            ]}
            tooltip={{
              title: t('appList.field.gitRepoTooltip'),
              icon: <InfoCircleOutlined />,
            }}
          >
            <Input placeholder="https://github.com/user/repo.git" />
          </Form.Item>

          <Space style={{ display: 'flex' }} size="middle">
            <Form.Item
              name="gitBranch"
              label={t('appList.field.gitBranch')}
              tooltip={{
                title: t('appList.field.gitBranchTooltip'),
                icon: <InfoCircleOutlined />,
              }}
            >
              <Input placeholder="main" style={{ width: 200 }} />
            </Form.Item>
            <Form.Item
              name="gitCommit"
              label={t('appList.field.gitCommit')}
              tooltip={{
                title: t('appList.field.gitCommitTooltip'),
                icon: <InfoCircleOutlined />,
              }}
            >
              <Input placeholder="HEAD" style={{ width: 200 }} />
            </Form.Item>
          </Space>

          <Form.Item
            name="entrypoint"
            label={t('appList.field.entrypoint')}
            tooltip={{
              title: t('appList.field.entrypointTooltip'),
              icon: <InfoCircleOutlined />,
            }}
          >
            <Input placeholder="src/tasks/index.js" />
          </Form.Item>

          {/* DEP-04: 部署审批流开关——开启后该应用的新部署需第二人批准才派发 */}
          <Form.Item
            name="approvalRequired"
            label={t('appList.field.approvalRequired')}
            valuePropName="checked"
            tooltip={{
              title: t('appList.field.approvalRequiredTooltip'),
              icon: <InfoCircleOutlined />,
            }}
          >
            <Switch checkedChildren={t('appList.field.approvalOn')} unCheckedChildren={t('appList.field.approvalOff')} />
          </Form.Item>
        </Form>
      </Modal>

      {/* Upload Modal */}
      <Modal
        title={t('appList.upload.title')}
        open={uploadModalOpen}
        onOk={handleUpload}
        onCancel={() => setUploadModalOpen(false)}
        afterOpenChange={(open) => { if (open) uploadForm.resetFields(); }}
        destroyOnHidden
      >
        <Form form={uploadForm} layout="vertical">
          <Form.Item
            name="name"
            label={t('appList.field.name')}
            rules={[{ required: true, message: t('appList.field.nameRequired') }]}
            tooltip={{
              title: t('appList.upload.nameTooltip'),
              icon: <InfoCircleOutlined />,
            }}
          >
            <Input placeholder="my-app" />
          </Form.Item>
          <Form.Item
            name="runtime"
            label={t('appList.field.runtime')}
            initialValue="node"
            tooltip={{
              title: t('appList.upload.runtimeTooltip'),
              icon: <InfoCircleOutlined />,
            }}
          >
            <Select options={runtimeOptions} />
          </Form.Item>
          <Form.Item
            name="file"
            label={t('appList.upload.zip')}
            rules={[{ required: true, message: t('appList.upload.zipRequired') }]}
            valuePropName="fileList"
            tooltip={{
              title: t('appList.upload.zipTooltip'),
              icon: <InfoCircleOutlined />,
            }}
          >
            <Upload maxCount={1} beforeUpload={() => false} accept=".zip">
              <Button icon={<UploadOutlined />}>{t('appList.upload.choose')}</Button>
            </Upload>
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={t('appList.deploy.title')}
        open={quickDeployApp !== null}
        onOk={handleQuickDeploy}
        onCancel={() => setQuickDeployApp(null)}
        confirmLoading={quickDeploying}
        okText={t('appList.deploy.ok')}
        cancelText={t('appList.deploy.cancel')}
        destroyOnHidden
      >
        <Form form={quickDeployForm} layout="vertical">
          <Form.Item name="executorId" label={t('appList.deploy.executor')}>
            <Select
              placeholder={t('appList.deploy.executorPlaceholder')}
              allowClear
              options={quickDeployExecutors.map(e => ({ value: e.id, label: `${e.name} (${e.address})`, disabled: e.status !== 'online' }))}
              notFoundContent={t('appList.deploy.executorEmpty')}
            />
          </Form.Item>
          <Form.Item name="runMode" label={t('appList.deploy.runMode')} initialValue="once" rules={[{ required: true, message: t('appList.deploy.runModeRequired') }]}>
            <Radio.Group>
              <Radio value="once">{t('appList.deploy.modeOnce')}</Radio>
              <Radio value="daemon">{t('appList.deploy.modeDaemon')}</Radio>
              <Radio value="scheduled">{t('appList.deploy.modeScheduled')}</Radio>
            </Radio.Group>
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(prev, cur) => prev.runMode !== cur.runMode}>
            {({ getFieldValue }) =>
              getFieldValue('runMode') === 'daemon' ? (
                <Form.Item name="startCommand" label={t('appList.deploy.startCommand')} tooltip={t('appList.deploy.startCommandTooltip')}>
                  <Input placeholder="node dist/server.js" />
                </Form.Item>
              ) : null
            }
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

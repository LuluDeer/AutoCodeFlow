import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Table, Button, Space, Tag, Modal, Form, Input, Select, Upload, message,
  Popconfirm, Typography, Tooltip, Badge, Radio,
} from 'antd';
import {
  PlusOutlined, UploadOutlined, ReloadOutlined, GithubOutlined,
  SearchOutlined, FilterOutlined, EyeOutlined, RocketOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons';
import { applicationsApi, Application, deploymentsApi, AppDeployment } from '../api/applications';
import { executorsApi } from '../api/executors';
import { useNavigate } from 'react-router-dom';
import { getErrMsg, isFormValidationError } from '../utils/error';
import { formatDateTime, formatRelativeTime } from '../utils/timeFormat';
import { useAuthStore, isAdminUser } from '../store/auth';

const { Text } = Typography;

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

const statusLabels: Record<string, string> = {
  active: '正常',
  deploying: '部署中',
  failed: '失败',
};

interface AppWithStats extends Application {
  runningCount: number;
  totalDeployments: number;
  lastDeployedAt: string | null;
}

export default function ApplicationListPage() {
  const nav = useNavigate();
  const isAdmin = useIsAdmin();
  const [apps, setApps] = useState<AppWithStats[]>([]);
  const [loading, setLoading] = useState(false);
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
      message.error(getErrMsg(err, '加载应用列表失败'));
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
      message.success('应用已删除');
      fetchApps();
    } catch (err: unknown) {
      message.error(getErrMsg(err, '删除失败'));
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
        message.success('应用已更新');
      } else {
        await applicationsApi.create(values);
        message.success('应用已创建');
      }
      setModalOpen(false);
      fetchApps();
    } catch (err: unknown) {
      if (isFormValidationError(err)) return;
      message.error(getErrMsg(err, '保存失败'));
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
      message.success('应用上传成功');
      setUploadModalOpen(false);
      fetchApps();
    } catch (err: unknown) {
      if (isFormValidationError(err)) return;
      message.error(getErrMsg(err, '上传失败'));
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
      message.warning('获取执行器列表失败，请检查网络连接');
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
      message.success('部署已创建');
      setQuickDeployApp(null);
      fetchApps();
    } catch (err: unknown) {
      if (isFormValidationError(err)) return;
      message.error(getErrMsg(err, '部署失败：请确认有在线执行器可用'));
    } finally {
      setQuickDeploying(false);
    }
  };

  const columns = [
    {
      title: '名称',
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
              分支: {record.gitBranch}
            </Text>
          )}
        </Space>
      ),
    },
    {
      title: '版本',
      dataIndex: 'version',
      key: 'version',
      width: 90,
      render: (v: string) => <Tag>{v}</Tag>,
    },
    {
      title: '运行时',
      dataIndex: 'runtime',
      key: 'runtime',
      width: 90,
      render: (v: string) => <Tag color="blue">{v}</Tag>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (s: string) => <Tag color={statusColors[s] || 'default'}>{statusLabels[s] || s}</Tag>,
    },
    {
      title: '运行实例',
      key: 'deployStats',
      width: 130,
      render: (_: unknown, record: AppWithStats) => {
        if (record.totalDeployments === 0) return <Text type="secondary">暂无部署</Text>;
        return (
          <Space>
            <Badge status="processing" />
            <Text>{record.runningCount} / {record.totalDeployments} 台运行中</Text>
          </Space>
        );
      },
    },
    {
      title: '最后部署',
      key: 'lastDeployedAt',
      width: 110,
      render: (_: unknown, record: AppWithStats) => (
        <Tooltip title={record.lastDeployedAt ? formatDateTime(record.lastDeployedAt) : '尚未部署'}>
          <Text type={record.lastDeployedAt ? undefined : 'secondary'}>
            {formatRelativeTime(record.lastDeployedAt)}
          </Text>
        </Tooltip>
      ),
    },
    {
      title: '操作',
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
            详情
          </Button>
          <Tooltip title={isAdmin ? '快速新建部署' : '仅管理员可部署应用'}>
            <Button
              type="link"
              size="small"
              icon={<RocketOutlined />}
              onClick={() => openQuickDeploy(record.id)}
              disabled={!isAdmin}
            >
              新建部署
            </Button>
          </Tooltip>
          <Tooltip title={isAdmin ? '编辑' : '仅管理员可编辑应用'}>
            <Button type="link" size="small" onClick={() => handleEdit(record)} disabled={!isAdmin}>编辑</Button>
          </Tooltip>
          <Popconfirm
            title="确认删除此应用？"
            description="删除后无法恢复，请确认。"
            onConfirm={() => handleDelete(record.id)}
            okText="删除"
            okButtonProps={{ danger: true }}
            disabled={!isAdmin}
          >
            <Tooltip title={isAdmin ? '删除' : '仅管理员可删除应用'}>
              <Button type="link" size="small" danger disabled={!isAdmin}>删除</Button>
            </Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>应用管理</Typography.Title>
        <Space>
          <Tooltip title={isAdmin ? undefined : '仅管理员可创建应用'}>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate} disabled={!isAdmin}>
              创建应用
            </Button>
          </Tooltip>
          <Tooltip title={isAdmin ? undefined : '仅管理员可上传应用'}>
            <Button icon={<UploadOutlined />} onClick={() => {
              setUploadModalOpen(true);
            }} disabled={!isAdmin}>
              上传 ZIP
            </Button>
          </Tooltip>
          <Button icon={<ReloadOutlined />} onClick={fetchApps} loading={loading}>刷新</Button>
        </Space>
      </div>

      {/* 搜索/筛选栏 */}
      <Space style={{ marginBottom: 16 }} wrap>
        <Input
          placeholder="搜索应用名、描述"
          prefix={<SearchOutlined />}
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          allowClear
          style={{ width: 220 }}
        />
        <Select
          placeholder="状态筛选"
          allowClear
          style={{ width: 130 }}
          value={statusFilter}
          onChange={setStatusFilter}
          suffixIcon={<FilterOutlined />}
          options={[
            { value: 'active', label: '正常' },
            { value: 'deploying', label: '部署中' },
            { value: 'failed', label: '失败' },
          ]}
        />
        <Select
          placeholder="运行时"
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
            清除筛选
          </Button>
        )}
        {hasFilters && (
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            {filtered.length} / {apps.length} 条
          </Typography.Text>
        )}
      </Space>

      <Table
        columns={columns}
        dataSource={filtered}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10, showTotal: (t) => `共 ${t} 条` }}
      />

      {/* Create/Edit Modal */}
      <Modal
        title={editingApp ? '编辑应用' : '创建应用'}
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
            label="名称"
            rules={[
              { required: true, message: '请输入应用名称' },
              { pattern: /^[a-zA-Z0-9_-]+$/, message: '只允许字母、数字、下划线和连字符' },
            ]}
            tooltip={{
              title: '全局唯一标识符，建议使用英文，如 order-service。只允许字母、数字、下划线、连字符。创建后不可修改。',
              icon: <InfoCircleOutlined />,
            }}
          >
            <Input placeholder="my-autocodeflow-app" disabled={!!editingApp} />
          </Form.Item>

          <Form.Item
            name="description"
            label="描述"
            tooltip={{
              title: '简要说明该应用的用途，方便团队成员快速了解。',
              icon: <InfoCircleOutlined />,
            }}
          >
            <Input.TextArea rows={2} placeholder="例如：负责订单处理的后端服务" />
          </Form.Item>

          <Space style={{ display: 'flex' }} size="middle">
            <Form.Item
              name="version"
              label="版本"
              rules={[{ required: true, message: '请填写版本号' }]}
              tooltip={{
                title: '语义化版本号，如 1.0.0。通过 Webhook 触发时会自动更新此字段。',
                icon: <InfoCircleOutlined />,
              }}
            >
              <Input placeholder="1.0.0" style={{ width: 160 }} />
            </Form.Item>
            <Form.Item
              name="runtime"
              label="运行时"
              rules={[{ required: true, message: '请选择运行时' }]}
              tooltip={{
                title: '应用代码所使用的运行环境。执行器节点需已安装对应运行时。',
                icon: <InfoCircleOutlined />,
              }}
            >
              <Select options={runtimeOptions} style={{ width: 140 }} />
            </Form.Item>
          </Space>

          <Form.Item
            name="gitRepo"
            label="Git 仓库地址"
            rules={[
              {
                pattern: GIT_URL_RE,
                message: '格式不正确，支持 HTTPS（https://github.com/org/repo.git）或 SSH（git@github.com:org/repo.git）',
              },
            ]}
            tooltip={{
              title: '支持 HTTPS 格式（https://github.com/org/repo.git）和 SSH 格式（git@github.com:org/repo.git）。执行器拉取代码时使用。',
              icon: <InfoCircleOutlined />,
            }}
          >
            <Input placeholder="https://github.com/user/repo.git" />
          </Form.Item>

          <Space style={{ display: 'flex' }} size="middle">
            <Form.Item
              name="gitBranch"
              label="Git 分支"
              tooltip={{
                title: '部署时默认拉取的分支，通常为 main 或 master。',
                icon: <InfoCircleOutlined />,
              }}
            >
              <Input placeholder="main" style={{ width: 200 }} />
            </Form.Item>
            <Form.Item
              name="gitCommit"
              label="Git Commit"
              tooltip={{
                title: '锁定到特定 commit SHA，留空则使用分支最新提交。',
                icon: <InfoCircleOutlined />,
              }}
            >
              <Input placeholder="HEAD" style={{ width: 200 }} />
            </Form.Item>
          </Space>

          <Form.Item
            name="entrypoint"
            label="入口文件"
            tooltip={{
              title: '应用主入口路径，相对于仓库根目录，如 src/tasks/index.js。manifest.json 中可覆盖此配置。',
              icon: <InfoCircleOutlined />,
            }}
          >
            <Input placeholder="src/tasks/index.js" />
          </Form.Item>
        </Form>
      </Modal>

      {/* Upload Modal */}
      <Modal
        title="上传应用"
        open={uploadModalOpen}
        onOk={handleUpload}
        onCancel={() => setUploadModalOpen(false)}
        afterOpenChange={(open) => { if (open) uploadForm.resetFields(); }}
        destroyOnHidden
      >
        <Form form={uploadForm} layout="vertical">
          <Form.Item
            name="name"
            label="名称"
            rules={[{ required: true, message: '请输入应用名称' }]}
            tooltip={{
              title: '应用的唯一名称，建议与 ZIP 内 manifest.json 中的 appName 保持一致。',
              icon: <InfoCircleOutlined />,
            }}
          >
            <Input placeholder="my-app" />
          </Form.Item>
          <Form.Item
            name="runtime"
            label="运行时"
            initialValue="node"
            tooltip={{
              title: '应用运行时环境，需与代码所依赖的环境一致。',
              icon: <InfoCircleOutlined />,
            }}
          >
            <Select options={runtimeOptions} />
          </Form.Item>
          <Form.Item
            name="file"
            label="ZIP 文件"
            rules={[{ required: true, message: '请选择文件' }]}
            valuePropName="fileList"
            tooltip={{
              title: '将应用代码及 manifest.json 打包为 ZIP 后上传，执行器会自动解压并部署。',
              icon: <InfoCircleOutlined />,
            }}
          >
            <Upload maxCount={1} beforeUpload={() => false} accept=".zip">
              <Button icon={<UploadOutlined />}>选择 ZIP 文件</Button>
            </Upload>
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="快速新建部署"
        open={quickDeployApp !== null}
        onOk={handleQuickDeploy}
        onCancel={() => setQuickDeployApp(null)}
        confirmLoading={quickDeploying}
        okText="创建部署"
        cancelText="取消"
        destroyOnHidden
      >
        <Form form={quickDeployForm} layout="vertical">
          <Form.Item name="executorId" label="选择执行器">
            <Select
              placeholder="自动选择最空闲的执行器（推荐）"
              allowClear
              options={quickDeployExecutors.map(e => ({ value: e.id, label: `${e.name} (${e.address})`, disabled: e.status !== 'online' }))}
              notFoundContent="暂无可用执行器"
            />
          </Form.Item>
          <Form.Item name="runMode" label="运行模式" initialValue="once" rules={[{ required: true, message: '请选择运行模式' }]}>
            <Radio.Group>
              <Radio value="once">单次执行</Radio>
              <Radio value="daemon">常驻进程</Radio>
              <Radio value="scheduled">定时任务</Radio>
            </Radio.Group>
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(prev, cur) => prev.runMode !== cur.runMode}>
            {({ getFieldValue }) =>
              getFieldValue('runMode') === 'daemon' ? (
                <Form.Item name="startCommand" label="启动命令" tooltip="常驻进程的启动命令，如 node dist/server.js">
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

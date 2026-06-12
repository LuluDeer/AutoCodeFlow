import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Table, Button, Space, Tag, Modal, Form, Input, Select, Upload, message, Popconfirm, Typography, Input as AntInput,
} from 'antd';
import { PlusOutlined, UploadOutlined, ReloadOutlined, GithubOutlined, SearchOutlined, FilterOutlined } from '@ant-design/icons';
import { applicationsApi, Application } from '../api/applications';
import { useNavigate } from 'react-router-dom';

const { Text } = Typography;

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

export default function ApplicationListPage() {
  const nav = useNavigate();
  const [apps, setApps] = useState<Application[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [editingApp, setEditingApp] = useState<Application | null>(null);
  const [form] = Form.useForm();
  const [uploadForm] = Form.useForm();
  const [searchText, setSearchText] = useState('');
  const [statusFilter, setStatusFilter] = useState<string | undefined>();
  const [runtimeFilter, setRuntimeFilter] = useState<string | undefined>();

  const fetchApps = useCallback(async () => {
    setLoading(true);
    try {
      const data = await applicationsApi.list();
      setApps(data);
    } catch (err: any) {
      message.error(err?.response?.data?.message || 'Failed to load applications');
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
    form.resetFields();
    form.setFieldsValue({ runtime: 'node', version: '1.0.0' });
    setModalOpen(true);
  };

  const handleEdit = (app: Application) => {
    setEditingApp(app);
    form.setFieldsValue(app);
    setModalOpen(true);
  };

  const handleDelete = async (id: string) => {
    try {
      await applicationsApi.delete(id);
      message.success('Application deleted');
      fetchApps();
    } catch (err: any) {
      message.error(err?.response?.data?.message || 'Failed to delete');
    }
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      if (editingApp) {
        await applicationsApi.update(editingApp.id, values);
        message.success('Application updated');
      } else {
        await applicationsApi.create(values);
        message.success('Application created');
      }
      setModalOpen(false);
      fetchApps();
    } catch (err: any) {
      if (err?.errorFields) return;
      message.error(err?.response?.data?.message || 'Failed to save');
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
      message.success('Application uploaded');
      setUploadModalOpen(false);
      fetchApps();
    } catch (err: any) {
      if (err?.errorFields) return;
      message.error(err?.response?.data?.message || 'Upload failed');
    }
  };

  const columns = [
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      sorter: (a: Application, b: Application) => a.name.localeCompare(b.name),
      render: (name: string, record: Application) => (
        <Space>
          {record.gitRepo && <GithubOutlined />}
          <a onClick={() => nav(`/applications/${record.id}`)}>
            <Text strong>{name}</Text>
          </a>
        </Space>
      ),
    },
    {
      title: 'Version',
      dataIndex: 'version',
      key: 'version',
      width: 100,
      render: (v: string) => <Tag>{v}</Tag>,
    },
    {
      title: 'Runtime',
      dataIndex: 'runtime',
      key: 'runtime',
      width: 100,
      render: (v: string) => <Tag color="blue">{v}</Tag>,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 120,
      render: (s: string) => <Tag color={statusColors[s] || 'default'}>{statusLabels[s] || s}</Tag>,
    },
    {
      title: 'Description',
      dataIndex: 'description',
      key: 'description',
      ellipsis: true,
      render: (v: string) => v || '-',
    },
    {
      title: 'Created',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 180,
      sorter: (a: Application, b: Application) =>
        new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime(),
      render: (v: string) => v ? new Date(v).toLocaleString('zh-CN') : '-',
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 160,
      render: (_: unknown, record: Application) => (
        <Space>
          <Button type="link" size="small" onClick={() => handleEdit(record)}>编辑</Button>
          <Popconfirm title="确认删除此应用？" onConfirm={() => handleDelete(record.id)}>
            <Button type="link" size="small" danger>删除</Button>
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
          <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>
            创建应用
          </Button>
          <Button icon={<UploadOutlined />} onClick={() => {
            uploadForm.resetFields();
            setUploadModalOpen(true);
          }}>
            上传 ZIP
          </Button>
          <Button icon={<ReloadOutlined />} onClick={fetchApps} loading={loading}>刷新</Button>
        </Space>
      </div>

      {/* 搜索/筛选栏 */}
      <Space style={{ marginBottom: 16 }} wrap>
        <AntInput
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
        width={600}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="my-autocodeflow-app" />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={2} placeholder="应用描述" />
          </Form.Item>
          <Space style={{ display: 'flex' }} size="middle">
            <Form.Item name="version" label="版本" rules={[{ required: true }]}>
              <Input placeholder="1.0.0" style={{ width: 160 }} />
            </Form.Item>
            <Form.Item name="runtime" label="运行时" rules={[{ required: true }]}>
              <Select options={runtimeOptions} style={{ width: 140 }} />
            </Form.Item>
          </Space>
          <Form.Item name="gitRepo" label="Git 仓库">
            <Input placeholder="https://github.com/user/repo.git" />
          </Form.Item>
          <Space style={{ display: 'flex' }} size="middle">
            <Form.Item name="gitBranch" label="Git 分支">
              <Input placeholder="main" style={{ width: 200 }} />
            </Form.Item>
            <Form.Item name="gitCommit" label="Git Commit">
              <Input placeholder="HEAD" style={{ width: 200 }} />
            </Form.Item>
          </Space>
          <Form.Item name="entrypoint" label="入口文件">
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
        destroyOnClose
      >
        <Form form={uploadForm} layout="vertical">
          <Form.Item name="name" label="名称" rules={[{ required: true }]}>
            <Input placeholder="my-app" />
          </Form.Item>
          <Form.Item name="runtime" label="运行时" initialValue="node">
            <Select options={runtimeOptions} />
          </Form.Item>
          <Form.Item name="file" label="ZIP 文件" rules={[{ required: true, message: '请选择文件' }]} valuePropName="file">
            <Upload maxCount={1} beforeUpload={() => false} accept=".zip">
              <Button icon={<UploadOutlined />}>选择 ZIP 文件</Button>
            </Upload>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

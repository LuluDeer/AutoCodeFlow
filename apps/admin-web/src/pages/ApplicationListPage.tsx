import { useState, useEffect, useCallback } from 'react';
import {
  Table, Button, Space, Tag, Modal, Form, Input, Select, Upload, message, Popconfirm, Typography,
} from 'antd';
import { PlusOutlined, UploadOutlined, DeleteOutlined, ReloadOutlined, GithubOutlined } from '@ant-design/icons';
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

export default function ApplicationListPage() {
  const nav = useNavigate();
  const [apps, setApps] = useState<Application[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [editingApp, setEditingApp] = useState<Application | null>(null);
  const [form] = Form.useForm();
  const [uploadForm] = Form.useForm();

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
      render: (s: string) => <Tag color={statusColors[s] || 'default'}>{s}</Tag>,
    },
    {
      title: 'Description',
      dataIndex: 'description',
      key: 'description',
      ellipsis: true,
    },
    {
      title: 'Created',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 180,
      render: (v: string) => v ? new Date(v).toLocaleString() : '-',
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 160,
      render: (_: unknown, record: Application) => (
        <Space>
          <Button type="link" size="small" onClick={() => handleEdit(record)}>Edit</Button>
          <Popconfirm title="Delete this application?" onConfirm={() => handleDelete(record.id)}>
            <Button type="link" size="small" danger>Delete</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>
          Create Application
        </Button>
        <Button icon={<UploadOutlined />} onClick={() => {
          uploadForm.resetFields();
          setUploadModalOpen(true);
        }}>
          Upload ZIP
        </Button>
        <Button icon={<ReloadOutlined />} onClick={fetchApps}>Refresh</Button>
      </Space>

      <Table
        columns={columns}
        dataSource={apps}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
      />

      {/* Create/Edit Modal */}
      <Modal
        title={editingApp ? 'Edit Application' : 'Create Application'}
        open={modalOpen}
        onOk={handleSubmit}
        onCancel={() => setModalOpen(false)}
        width={600}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="Name" rules={[{ required: true, message: 'Please enter name' }]}>
            <Input placeholder="my-autocodeflow-app" />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={2} placeholder="Application description" />
          </Form.Item>
          <Space style={{ display: 'flex' }} size="middle">
            <Form.Item name="version" label="Version" rules={[{ required: true }]}>
              <Input placeholder="1.0.0" style={{ width: 160 }} />
            </Form.Item>
            <Form.Item name="runtime" label="Runtime" rules={[{ required: true }]}>
              <Select options={runtimeOptions} style={{ width: 140 }} />
            </Form.Item>
          </Space>
          <Form.Item name="gitRepo" label="Git Repository">
            <Input placeholder="https://github.com/user/repo.git" />
          </Form.Item>
          <Space style={{ display: 'flex' }} size="middle">
            <Form.Item name="gitBranch" label="Git Branch">
              <Input placeholder="main" style={{ width: 200 }} />
            </Form.Item>
            <Form.Item name="gitCommit" label="Git Commit">
              <Input placeholder="HEAD" style={{ width: 200 }} />
            </Form.Item>
          </Space>
          <Form.Item name="entrypoint" label="Entrypoint">
            <Input placeholder="src/tasks/index.js" />
          </Form.Item>
        </Form>
      </Modal>

      {/* Upload Modal */}
      <Modal
        title="Upload Application"
        open={uploadModalOpen}
        onOk={handleUpload}
        onCancel={() => setUploadModalOpen(false)}
      >
        <Form form={uploadForm} layout="vertical">
          <Form.Item name="name" label="Name" rules={[{ required: true }]}>
            <Input placeholder="my-app" />
          </Form.Item>
          <Form.Item name="runtime" label="Runtime" initialValue="node">
            <Select options={runtimeOptions} />
          </Form.Item>
          <Form.Item name="file" label="File" rules={[{ required: true }]} valuePropName="file">
            <Upload maxCount={1} beforeUpload={() => false} accept=".zip">
              <Button icon={<UploadOutlined />}>Select ZIP file</Button>
            </Upload>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
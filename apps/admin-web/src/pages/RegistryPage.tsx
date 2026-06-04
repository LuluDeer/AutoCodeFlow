import React, { useState } from 'react';
import {
  Tabs,
  Table,
  Tag,
  Button,
  Space,
  Typography,
  Card,
  Empty,
  message,
  Upload,
  Modal,
  Form,
  Input,
} from 'antd';
import {
  CloudUploadOutlined,
  PythonOutlined,
  NodeIndexOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { registryApi } from '../api/registry';

const { Title, Text } = Typography;

function PypiTab() {
  const [uploadOpen, setUploadOpen] = useState(false);
  const [form] = Form.useForm();

  const { data: packages = [], isLoading, refetch } = useQuery({
    queryKey: ['pypi-packages'],
    queryFn: registryApi.listPypiPackages,
  });

  const columns = [
    {
      title: '包名',
      dataIndex: 'name',
      key: 'name',
      render: (name: string) => (
        <Space>
          <Tag color="blue">PyPI</Tag>
          <Text strong>{name}</Text>
        </Space>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 160,
      render: (_: unknown, name: string) => (
        <Button
          size="small"
          href={`${import.meta.env.VITE_PYPI_URL || 'http://localhost:8003'}/simple/${name}/`}
          target="_blank"
        >
          查看文件
        </Button>
      ),
    },
  ];

  const handleUpload = async (values: { name: string; version: string; file: File }) => {
    const fd = new FormData();
    fd.append('name', values.name);
    fd.append('version', values.version);
    fd.append('content', values.file);
    try {
      await registryApi.uploadPypiPackage(fd);
      message.success('上传成功');
      setUploadOpen(false);
      refetch();
    } catch {
      message.error('上传失败');
    }
  };

  return (
    <>
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between' }}>
        <Title level={5} style={{ margin: 0 }}>Python 包（PyPI）</Title>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => refetch()}>刷新</Button>
          <Button type="primary" icon={<CloudUploadOutlined />} onClick={() => setUploadOpen(true)}>
            上传包
          </Button>
        </Space>
      </div>

      <Table
        loading={isLoading}
        dataSource={packages.map(name => ({ name, key: name }))}
        columns={columns}
        size="small"
        pagination={{ pageSize: 20 }}
        locale={{ emptyText: <Empty description="暂无包" /> }}
      />

      <Modal
        title="上传 PyPI 包"
        open={uploadOpen}
        onCancel={() => setUploadOpen(false)}
        onOk={() => form.submit()}
        okText="上传"
      >
        <Form form={form} layout="vertical" onFinish={handleUpload}>
          <Form.Item name="name" label="包名" rules={[{ required: true }]}>
            <Input placeholder="e.g. autoflow-sdk" />
          </Form.Item>
          <Form.Item name="version" label="版本" rules={[{ required: true }]}>
            <Input placeholder="e.g. 0.1.0" />
          </Form.Item>
          <Form.Item
            name="file"
            label="文件"
            rules={[{ required: true, message: '请选择文件' }]}
            getValueFromEvent={(e) => e?.fileList?.[0]?.originFileObj}
          >
            <Upload beforeUpload={() => false} maxCount={1} accept=".whl,.tar.gz">
              <Button icon={<CloudUploadOutlined />}>选择文件</Button>
            </Upload>
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}

function NpmTab() {
  const { data: packages = [], isLoading, refetch } = useQuery({
    queryKey: ['npm-packages'],
    queryFn: registryApi.listNpmPackages,
  });

  const columns = [
    {
      title: '包名',
      dataIndex: 'name',
      key: 'name',
      render: (name: string) => (
        <Space>
          <Tag color="green">npm</Tag>
          <Text strong>{name}</Text>
        </Space>
      ),
    },
    {
      title: '最新版本',
      dataIndex: 'latest',
      key: 'latest',
      render: (v: string) => v ? <Tag>{v}</Tag> : '-',
    },
    {
      title: '描述',
      dataIndex: 'description',
      key: 'description',
      ellipsis: true,
    },
    {
      title: '操作',
      key: 'action',
      width: 120,
      render: (_: unknown, row: { name: string }) => (
        <Button
          size="small"
          href={`${import.meta.env.VITE_NPM_URL || 'http://localhost:4873'}/-/web/detail/${row.name}`}
          target="_blank"
        >
          详情
        </Button>
      ),
    },
  ];

  return (
    <>
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between' }}>
        <Title level={5} style={{ margin: 0 }}>Node.js 包（npm）</Title>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => refetch()}>刷新</Button>
          <Button
            href={`${import.meta.env.VITE_NPM_URL || 'http://localhost:4873'}`}
            target="_blank"
          >
            打开 Verdaccio UI
          </Button>
        </Space>
      </div>
      <Table
        loading={isLoading}
        dataSource={packages.map(p => ({ ...p, key: p.name }))}
        columns={columns}
        size="small"
        pagination={{ pageSize: 20 }}
        locale={{ emptyText: <Empty description="暂无包" /> }}
      />
    </>
  );
}

export default function RegistryPage() {
  return (
    <div>
      <Title level={4}>包市场</Title>
      <Card>
        <Tabs
          defaultActiveKey="pypi"
          items={[
            {
              key: 'pypi',
              label: (
                <Space>
                  <PythonOutlined />
                  Python (PyPI)
                </Space>
              ),
              children: <PypiTab />,
            },
            {
              key: 'npm',
              label: (
                <Space>
                  <NodeIndexOutlined />
                  Node.js (npm)
                </Space>
              ),
              children: <NpmTab />,
            },
          ]}
        />
      </Card>
    </div>
  );
}

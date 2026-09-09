import { useState } from 'react';
import {
  Tabs, Table, Button, Upload, Form, Input, Modal, message, Space,
  Typography, Tag, Empty, Card,
} from 'antd';
import {
  UploadOutlined, ReloadOutlined, CodeOutlined, InboxOutlined,
} from '@ant-design/icons';
import { useRequest } from 'ahooks';
import { registryApi } from '../api/registry';
import { getErrMsg } from '../utils/error';
import PageHeader from '../components/PageHeader';
// UI-16：toast-only 页补齐页内错误态标准块（错误块 + 重试，对齐 TaskTemplatesPage 形态）
import StateError from '../components/StateError';

const { Text, Paragraph } = Typography;

// ─── PyPI tab ────────────────────────────────────────────────────────────────
function PypiTab() {
  const [uploadOpen, setUploadOpen] = useState(false);
  const [form] = Form.useForm();
  const [uploading, setUploading] = useState(false);

  const { data: packages = [], loading, error, refresh } = useRequest(registryApi.listPypiPackages);

  const handleUpload = async (values: { name: string; version: string; file: { fileList?: { originFileObj?: File }[] } }) => {
    const fileObj: File | undefined = values.file?.fileList?.[0]?.originFileObj;
    if (!fileObj) { message.error('请选择文件'); return; }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('name', values.name);
      fd.append('version', values.version);
      fd.append('content', fileObj, fileObj.name);
      await registryApi.uploadPypiPackage(fd);
      message.success('上传成功');
      setUploadOpen(false);
      form.resetFields();
      refresh();
    } catch (err: unknown) {
      message.error(getErrMsg(err, '上传失败'));
    } finally {
      setUploading(false);
    }
  };

  const columns = [
    { title: '包名', dataIndex: 'name', key: 'name', render: (n: string) => <Text code>{n}</Text> },
    {
      title: '安装命令', key: 'install',
      render: (_: unknown, record: { name: string }) => (
        <Text copyable={{ text: `pip install ${record.name} --index-url ${window.location.origin}/pypi/simple/` }}>
          <code>pip install {record.name}</code>
        </Text>
      ),
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <Button type="primary" icon={<UploadOutlined />} onClick={() => setUploadOpen(true)}>上传包</Button>
        <Button icon={<ReloadOutlined />} onClick={refresh}>刷新</Button>
      </Space>

      <Card size="small" style={{ marginBottom: 16, background: '#f6ffed', border: '1px solid #b7eb8f' }}>
        <Paragraph style={{ margin: 0 }}>
          <Text strong>配置 pip 使用私有源：</Text>
        </Paragraph>
        <Text copyable code>
          {`pip config set global.index-url ${window.location.origin}/pypi/simple/`}
        </Text>
      </Card>

      {/* UI-16：请求失败渲染 StateError 标准错误块（此前 api 层吞错，失败静默
          表现为「暂无 PyPI 包」空态——失败与空态语义分离） */}
      {error && (
        <StateError
          error={error}
          onRetry={refresh}
          title="PyPI 包列表加载失败"
          style={{ marginBottom: 16 }}
        />
      )}
      {!loading && !error && packages.length === 0 && (
        <Empty description="暂无 PyPI 包，点击上传添加第一个包" />
      )}
      {!loading && !error && packages.length > 0 && (
        <Table
          dataSource={packages.map(name => ({ name }))}
          columns={columns}
          rowKey="name"
          size="small"
          pagination={{ pageSize: 20 }}
        />
      )}

      <Modal
        title="上传 PyPI 包"
        open={uploadOpen}
        onCancel={() => setUploadOpen(false)}
        footer={null}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" onFinish={handleUpload}>
          <Form.Item name="name" label="包名" rules={[{ required: true, message: '请输入包名' }]}>
            <Input placeholder="my-package" />
          </Form.Item>
          <Form.Item name="version" label="版本" rules={[{ required: true, message: '请输入版本号' }]}>
            <Input placeholder="1.0.0" />
          </Form.Item>
          <Form.Item
            name="file"
            label="包文件 (.whl / .tar.gz)"
            rules={[{ required: true, message: '请选择文件' }]}
            valuePropName="fileList"
          >
            <Upload
              beforeUpload={() => false}
              maxCount={1}
              accept=".whl,.tar.gz,.gz"
            >
              <Button icon={<InboxOutlined />}>选择文件</Button>
            </Upload>
          </Form.Item>
          <Form.Item style={{ marginBottom: 0, textAlign: 'right' }}>
            <Space>
              <Button onClick={() => setUploadOpen(false)}>取消</Button>
              <Button type="primary" htmlType="submit" loading={uploading}>上传</Button>
            </Space>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

// ─── NPM tab ─────────────────────────────────────────────────────────────────
function NpmTab() {
  const [publishOpen, setPublishOpen] = useState(false);
  const { data: packages = [], loading, error, refresh } = useRequest(registryApi.listNpmPackages);

  const columns = [
    { title: '包名', dataIndex: 'name', key: 'name', render: (n: string) => <Text code>{n}</Text> },
    {
      title: '最新版本', dataIndex: 'latest', key: 'latest',
      render: (v: string) => v ? <Tag color="blue">{v}</Tag> : <Text type="secondary">-</Text>,
    },
    { title: '描述', dataIndex: 'description', key: 'description', render: (d: string) => d || '-' },
    {
      title: '安装命令', key: 'install',
      render: (_: unknown, row: { name: string }) => (
        <Text copyable={{ text: `npm install ${row.name}` }}>
          <code>npm install {row.name}</code>
        </Text>
      ),
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <Button type="primary" icon={<CodeOutlined />} onClick={() => setPublishOpen(true)}>发布说明</Button>
        <Button icon={<ReloadOutlined />} onClick={refresh}>刷新</Button>
      </Space>

      <Card size="small" style={{ marginBottom: 16, background: '#e6f7ff', border: '1px solid #91d5ff' }}>
        <Paragraph style={{ margin: 0 }}>
          <Text strong>配置 npm 使用私有源：</Text>
        </Paragraph>
        <Text copyable code>
          {`npm config set registry ${window.location.origin}/npm/`}
        </Text>
      </Card>

      {/* UI-16：npm Tab 同 PyPI——请求失败渲染 StateError 标准错误块 */}
      {error && (
        <StateError
          error={error}
          onRetry={refresh}
          title="npm 包列表加载失败"
          style={{ marginBottom: 16 }}
        />
      )}
      {!loading && !error && packages.length === 0 && (
        <Empty description="暂无 npm 包，使用 npm publish 发布" />
      )}
      {!loading && !error && packages.length > 0 && (
        <Table
          dataSource={packages}
          columns={columns}
          rowKey="name"
          size="small"
          pagination={{ pageSize: 20 }}
        />
      )}

      <Modal
        title="发布 npm 包"
        open={publishOpen}
        onCancel={() => setPublishOpen(false)}
        footer={<Button type="primary" onClick={() => setPublishOpen(false)}>知道了</Button>}
        destroyOnHidden
      >
        <Paragraph>在项目根目录执行以下命令发布到私有 npm registry：</Paragraph>
        <Paragraph>
          <Text strong>1. 设置 registry</Text>
          <br />
          <Text copyable code>
            {`npm config set registry ${window.location.origin}/npm/`}
          </Text>
        </Paragraph>
        <Paragraph>
          <Text strong>2. 登录</Text>
          <br />
          <Text copyable code>npm login</Text>
        </Paragraph>
        <Paragraph>
          <Text strong>3. 发布</Text>
          <br />
          <Text copyable code>npm publish</Text>
        </Paragraph>
      </Modal>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────
export default function RegistryPage() {
  return (
    <div>
      {/* UI-03/UI-08：页头标准化 */}
      <PageHeader
        title="包市场"
        description="私有 PyPI / npm 制品仓库；上传后可在任务与执行器侧引用。"
      />
      <Tabs
        defaultActiveKey="pypi"
        items={[
          { key: 'pypi', label: 'PyPI (Python)', children: <PypiTab /> },
          { key: 'npm', label: 'npm (Node.js)', children: <NpmTab /> },
        ]}
      />
    </div>
  );
}

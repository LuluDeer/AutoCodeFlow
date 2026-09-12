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
import { useTranslation } from 'react-i18next';
import PageHeader from '../components/PageHeader';
// UI-16：toast-only 页补齐页内错误态标准块（错误块 + 重试，对齐 TaskTemplatesPage 形态）
import StateError from '../components/StateError';
// UI-10：导入 i18n 实例（模块副作用完成初始化；树内用 useTranslation 读 key）
import '../i18n';

const { Text, Paragraph } = Typography;

// ─── PyPI tab ────────────────────────────────────────────────────────────────
function PypiTab() {
  const { t } = useTranslation();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [form] = Form.useForm();
  const [uploading, setUploading] = useState(false);

  const { data: packages = [], loading, error, refresh } = useRequest(registryApi.listPypiPackages);

  const handleUpload = async (values: { name: string; version: string; file: { fileList?: { originFileObj?: File }[] } }) => {
    const fileObj: File | undefined = values.file?.fileList?.[0]?.originFileObj;
    if (!fileObj) { message.error(t('registry.upload.chooseFile')); return; }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('name', values.name);
      fd.append('version', values.version);
      fd.append('content', fileObj, fileObj.name);
      await registryApi.uploadPypiPackage(fd);
      message.success(t('registry.upload.success'));
      setUploadOpen(false);
      form.resetFields();
      refresh();
    } catch (err: unknown) {
      message.error(getErrMsg(err, t('registry.upload.fail')));
    } finally {
      setUploading(false);
    }
  };

  const columns = [
    { title: t('registry.col.name'), dataIndex: 'name', key: 'name', render: (n: string) => <Text code>{n}</Text> },
    {
      title: t('registry.col.install'), key: 'install',
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
        <Button type="primary" icon={<UploadOutlined />} onClick={() => setUploadOpen(true)}>{t('registry.upload')}</Button>
        <Button icon={<ReloadOutlined />} onClick={refresh}>{t('registry.refresh')}</Button>
      </Space>

      <Card size="small" style={{ marginBottom: 16, background: '#f6ffed', border: '1px solid #b7eb8f' }}>
        <Paragraph style={{ margin: 0 }}>
          <Text strong>{t('registry.pypiHint')}</Text>
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
          title={t('registry.pypiErrorTitle')}
          style={{ marginBottom: 16 }}
        />
      )}
      {!loading && !error && packages.length === 0 && (
        <Empty description={t('registry.pypiEmpty')} />
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
        title={t('registry.pypiUploadTitle')}
        open={uploadOpen}
        onCancel={() => setUploadOpen(false)}
        footer={null}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" onFinish={handleUpload}>
          <Form.Item name="name" label={t('registry.field.name')} rules={[{ required: true, message: t('registry.field.nameRequired') }]}>
            <Input placeholder="my-package" />
          </Form.Item>
          <Form.Item name="version" label={t('registry.field.version')} rules={[{ required: true, message: t('registry.field.versionRequired') }]}>
            <Input placeholder="1.0.0" />
          </Form.Item>
          <Form.Item
            name="file"
            label={t('registry.field.file')}
            rules={[{ required: true, message: t('registry.field.fileRequired') }]}
            valuePropName="fileList"
          >
            <Upload
              beforeUpload={() => false}
              maxCount={1}
              accept=".whl,.tar.gz,.gz"
            >
              <Button icon={<InboxOutlined />}>{t('registry.chooseFile')}</Button>
            </Upload>
          </Form.Item>
          <Form.Item style={{ marginBottom: 0, textAlign: 'right' }}>
            <Space>
              <Button onClick={() => setUploadOpen(false)}>{t('registry.cancel')}</Button>
              <Button type="primary" htmlType="submit" loading={uploading}>{t('registry.uploadBtn')}</Button>
            </Space>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

// ─── NPM tab ─────────────────────────────────────────────────────────────────
function NpmTab() {
  const { t } = useTranslation();
  const [publishOpen, setPublishOpen] = useState(false);
  const { data: packages = [], loading, error, refresh } = useRequest(registryApi.listNpmPackages);

  const columns = [
    { title: t('registry.col.name'), dataIndex: 'name', key: 'name', render: (n: string) => <Text code>{n}</Text> },
    {
      title: t('registry.col.latest'), dataIndex: 'latest', key: 'latest',
      render: (v: string) => v ? <Tag color="blue">{v}</Tag> : <Text type="secondary">-</Text>,
    },
    { title: t('registry.col.desc'), dataIndex: 'description', key: 'description', render: (d: string) => d || '-' },
    {
      title: t('registry.col.install'), key: 'install',
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
        <Button type="primary" icon={<CodeOutlined />} onClick={() => setPublishOpen(true)}>{t('registry.publish')}</Button>
        <Button icon={<ReloadOutlined />} onClick={refresh}>{t('registry.refresh')}</Button>
      </Space>

      <Card size="small" style={{ marginBottom: 16, background: '#e6f7ff', border: '1px solid #91d5ff' }}>
        <Paragraph style={{ margin: 0 }}>
          <Text strong>{t('registry.npmHint')}</Text>
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
          title={t('registry.npmErrorTitle')}
          style={{ marginBottom: 16 }}
        />
      )}
      {!loading && !error && packages.length === 0 && (
        <Empty description={t('registry.npmEmpty')} />
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
        title={t('registry.npmPublishTitle')}
        open={publishOpen}
        onCancel={() => setPublishOpen(false)}
        footer={<Button type="primary" onClick={() => setPublishOpen(false)}>{t('registry.npmGotIt')}</Button>}
        destroyOnHidden
      >
        <Paragraph>{t('registry.npmPublishDesc')}</Paragraph>
        <Paragraph>
          <Text strong>{t('registry.npmStep1')}</Text>
          <br />
          <Text copyable code>
            {`npm config set registry ${window.location.origin}/npm/`}
          </Text>
        </Paragraph>
        <Paragraph>
          <Text strong>{t('registry.npmStep2')}</Text>
          <br />
          <Text copyable code>npm login</Text>
        </Paragraph>
        <Paragraph>
          <Text strong>{t('registry.npmStep3')}</Text>
          <br />
          <Text copyable code>npm publish</Text>
        </Paragraph>
      </Modal>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────
export default function RegistryPage() {
  const { t } = useTranslation();
  return (
    <div>
      {/* UI-03/UI-08：页头标准化 */}
      <PageHeader
        title={t('registry.title')}
        description={t('registry.description')}
      />
      <Tabs
        defaultActiveKey="pypi"
        items={[
          { key: 'pypi', label: t('registry.tab.pypi'), children: <PypiTab /> },
          { key: 'npm', label: t('registry.tab.npm'), children: <NpmTab /> },
        ]}
      />
    </div>
  );
}

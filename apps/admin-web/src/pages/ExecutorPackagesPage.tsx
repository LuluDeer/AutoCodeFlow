import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Table, Button, Input, Select, Space, Tag, Tooltip, Modal, Form,
  Upload, Checkbox, Alert, Typography, message, Badge, Card,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  UploadOutlined, CloudDownloadOutlined, SendOutlined, DeleteOutlined,
  ReloadOutlined, PlusOutlined, StopOutlined, CheckCircleOutlined,
} from '@ant-design/icons';
import {
  listPackages, uploadPackage, deletePackage, pushPackage,
  deprecatePackage, activatePackage, downloadPackage,
} from '../api/executor-packages';
import { executorsApi } from '../api/executors';
import { getErrMsg } from '../utils/error';
import { useTranslation } from 'react-i18next';
import PageHeader from '../components/PageHeader';
import PageSkeleton from '../components/PageSkeleton';
import StateError from '../components/StateError';
import { Empty as AntEmpty } from 'antd';
// UI-10：导入 i18n 实例（模块副作用完成初始化；树内用 useTranslation 读 key）
import '../i18n';

const { Text } = Typography;

interface PkgRow {
  id: string; name: string; version: string; type: string;
  platform?: string; status: string; fileSize?: number;
  uploadedBy?: string; createdAt: string; originalFilename?: string;
}
interface Executor { id: string; name: string; address: string; status: string; }
interface PushResult { executorId: string; address: string; success: boolean; error?: string; }

const STATUS_TAG = (t: (k: string) => string): Record<string, { color: string; label: string }> => ({
  active: { color: 'green', label: t('execPkg.status.active') },
  deprecated: { color: 'orange', label: t('execPkg.status.deprecated') },
  deleted: { color: 'red', label: t('execPkg.status.deleted') },
});

function fmtBytes(b?: number) {
  if (!b) return '-';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

export default function ExecutorPackagesPage() {
  const { t } = useTranslation();
  const statusTags = STATUS_TAG(t);
  const [rows, setRows] = useState<PkgRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 20;

  // UI-16 竞态守卫：筛选、分页、刷新或重试快速重入时，仅最新请求允许更新列表状态。
  const loadSeq = useRef(0);

  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadForm] = Form.useForm();
  const [uploading, setUploading] = useState(false);

  const [pushTarget, setPushTarget] = useState<PkgRow | null>(null);
  const [executors, setExecutors] = useState<Executor[]>([]);
  const [pushAll, setPushAll] = useState(true);
  const [selectedExecutors, setSelectedExecutors] = useState<string[]>([]);
  const [pushing, setPushing] = useState(false);
  const [pushResults, setPushResults] = useState<PushResult[] | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setLoadError(null);
    try {
      const res = await listPackages({
        page, pageSize: PAGE_SIZE,
        name: search || undefined,
        type: typeFilter || undefined,
        status: statusFilter || undefined,
      });
      if (seq !== loadSeq.current) return;
      setRows(res.items.map(pkg => ({ ...pkg, status: pkg.isLatest ? 'active' : 'deprecated' })));
      setTotal(res.total);
      setLoadError(null);
    } catch (err: unknown) {
      if (seq !== loadSeq.current) return;
      setLoadError(err);
      message.error(getErrMsg(err, t('execPkg.loadFail')));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [page, search, typeFilter, statusFilter, t]);

  useEffect(() => {
    load();
    // 与 AppDeploymentPage 对齐：依赖变化/卸载时作废本 effect 发起的旧请求。
    return () => { loadSeq.current += 1; };
  }, [load]);

  const handleUpload = async (values: Record<string, unknown>) => {
    const fileList = (values.file as { fileList?: { originFileObj: File }[] })?.fileList;
    const fileObj: File | undefined = fileList?.[0]?.originFileObj;
    if (!fileObj) { message.error(t('execPkg.upload.chooseFile')); return; }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', fileObj);
      fd.append('name', values.name as string);
      fd.append('version', values.version as string);
      fd.append('type', values.type as string);
      fd.append('platform', values.platform as string);
      if (values.description) fd.append('description', values.description as string);
      await uploadPackage(fd);
      message.success(t('execPkg.upload.success'));
      setUploadOpen(false);
      uploadForm.resetFields();
      load();
    } catch (err: unknown) { message.error(getErrMsg(err, t('execPkg.upload.fail'))); } finally { setUploading(false); }
  };

  const handleOpenPush = async (pkg: PkgRow) => {
    setPushTarget(pkg);
    setPushResults(null);
    setPushAll(true);
    setSelectedExecutors([]);
    try {
      const list = await executorsApi.list();
      setExecutors(list.map(e => ({ id: e.id, name: e.appName, address: e.address, status: e.status })));
    } catch { setExecutors([]); } // executor list failure is non-critical, silently fall back to empty
  };

  const handlePush = async () => {
    if (!pushTarget) return;
    setPushing(true);
    try {
      const ids = pushAll ? undefined : selectedExecutors;
      const results = await pushPackage(pushTarget.id, ids);
      setPushResults(results);
    } catch (e: unknown) {
      setPushResults([{ executorId: '', address: '', success: false, error: (e as Error).message }]);
    } finally { setPushing(false); }
  };

  const handleDelete = (id: string) => {
    Modal.confirm({
      title: t('execPkg.deleteConfirm'),
      content: t('execPkg.deleteConfirmDesc'),
      okText: t('execPkg.delete'), okType: 'danger', cancelText: t('execPkg.cancel'),
      onOk: async () => { await deletePackage(id); load(); },
    });
  };

  const handleStatusToggle = async (pkg: PkgRow) => {
    try {
      if (pkg.status === 'active') await deprecatePackage(pkg.id);
      else await activatePackage(pkg.id);
      load();
    } catch (err: unknown) { message.error(getErrMsg(err, t('execPkg.operateFail'))); }
  };

  // download 路由在 JwtAuthGuard 后，<a href> 无法携带 Authorization（会 401），
  // 改为带 JWT 的 axios blob 请求下载
  const handleDownload = async (pkg: PkgRow) => {
    setDownloadingId(pkg.id);
    try {
      await downloadPackage(pkg.id, pkg.originalFilename ?? `${pkg.name}-${pkg.version}`);
    } catch (err: unknown) {
      message.error(getErrMsg(err, t('execPkg.downloadFail')));
    } finally {
      setDownloadingId(null);
    }
  };

  const onlineExecutors = executors.filter(e => e.status === 'online');

  const columns: ColumnsType<PkgRow> = [
    {
      title: t('execPkg.col.name'), dataIndex: 'name',
      render: (n: string, r: PkgRow) => (
        <Space orientation="vertical" size={0}>
          <Text strong>{n}</Text>
          {r.originalFilename && <Text type="secondary" style={{ fontSize: 12 }}>{r.originalFilename}</Text>}
        </Space>
      ),
    },
    { title: t('execPkg.col.version'), dataIndex: 'version', width: 100, render: (v: string) => <Tag color="blue">{v}</Tag> },
    { title: t('execPkg.col.type'), dataIndex: 'type', width: 90, render: (v: string) => <Tag>{v}</Tag> },
    { title: t('execPkg.col.platform'), dataIndex: 'platform', width: 90, render: (v?: string) => v ?? '-' },
    { title: t('execPkg.col.size'), dataIndex: 'fileSize', width: 90, render: (v?: number) => fmtBytes(v) },
    {
      title: t('execPkg.col.status'), dataIndex: 'status', width: 100,
      render: (v: string) => {
        const s = statusTags[v] ?? { color: 'default', label: v };
        return <Tag color={s.color}>{s.label}</Tag>;
      },
    },
    {
      title: t('execPkg.col.createdAt'), dataIndex: 'createdAt', width: 160,
      render: (v: string) => new Date(v).toLocaleString('zh-CN'),
    },
    { title: t('execPkg.col.uploadedBy'), dataIndex: 'uploadedBy', width: 100, render: (v?: string) => v ?? '-' },
    {
      title: t('execPkg.col.actions'), key: 'actions', width: 160, align: 'center' as const,
      render: (_: unknown, row: PkgRow) => (
        <Space size="small">
          <Tooltip title={t('execPkg.action.download')}>
            <Button size="small" icon={<CloudDownloadOutlined />}
              loading={downloadingId === row.id} onClick={() => handleDownload(row)} />
          </Tooltip>
          <Tooltip title={t('execPkg.action.push')}>
            <Button size="small" icon={<SendOutlined />} type="primary"
              disabled={row.status !== 'active'} onClick={() => handleOpenPush(row)} />
          </Tooltip>
          <Tooltip title={row.status === 'active' ? t('execPkg.action.deprecate') : t('execPkg.action.activate')}>
            <Button size="small"
              icon={row.status === 'active' ? <StopOutlined /> : <CheckCircleOutlined />}
              onClick={() => handleStatusToggle(row)} />
          </Tooltip>
          <Tooltip title={t('execPkg.delete')}>
            <Button size="small" danger icon={<DeleteOutlined />} onClick={() => handleDelete(row.id)} />
          </Tooltip>
        </Space>
      ),
    },
  ];

  return (
    <div>
      {/* UI-03/UI-08：页头标准化（原 Typography.Title+操作区迁入 PageHeader） */}
      <PageHeader
        title={t('execPkg.title')}
        description={t('execPkg.description')}
        extra={<Button type="primary" icon={<PlusOutlined />} onClick={() => setUploadOpen(true)}>{t('execPkg.uploadNew')}</Button>}
      />

      {loadError !== null && !loading && (
        <StateError
          error={loadError}
          title={t('execPkg.error.title')}
          onRetry={load}
          style={{ marginBottom: 16 }}
        />
      )}

      <Space style={{ marginBottom: 16 }} wrap>
        <Input.Search
          placeholder={t('execPkg.searchPlaceholder')} value={search} allowClear style={{ width: 200 }}
          onChange={e => { setSearch(e.target.value); setPage(1); }}
          onSearch={() => load()}
        />
        <Select
          placeholder={t('execPkg.filter.type')} value={typeFilter || undefined} allowClear style={{ width: 120 }}
          onChange={v => { setTypeFilter(v ?? ''); setPage(1); }}
          options={[
            { value: 'node', label: 'Node.js' }, { value: 'python', label: 'Python' },
            { value: 'java', label: 'Java' }, { value: 'shell', label: 'Shell' },
          ]}
        />
        <Select
          placeholder={t('execPkg.filter.status')} value={statusFilter || undefined} allowClear style={{ width: 120 }}
          onChange={v => { setStatusFilter(v ?? ''); setPage(1); }}
          options={[{ value: 'active', label: t('execPkg.status.active') }, { value: 'deprecated', label: t('execPkg.status.deprecated') }]}
        />
        <Button icon={<ReloadOutlined />} onClick={load}>{t('execPkg.refresh')}</Button>
        <Text type="secondary">{t('execPkg.count', { count: total })}</Text>
      </Space>

      <Table<PkgRow>
        rowKey="id" columns={columns} dataSource={rows} loading={false} size="small"
        pagination={{
          current: page, pageSize: PAGE_SIZE, total, onChange: setPage,
          showTotal: (totalCount) => t('execPkg.countRows', { count: totalCount }),
        }}
        locale={{
          // UI-08：首屏加载（无数据）以骨架屏替代表格 Spin；错误态不误显示空态
          emptyText: loading && rows.length === 0
            ? <PageSkeleton variant="table" rows={4} />
            : loadError
              ? null
              : <AntEmpty image={AntEmpty.PRESENTED_IMAGE_SIMPLE} description={t('execPkg.empty')} />,
        }}
      />

      {/* 上传弹窗 */}
      <Modal
        title={t('execPkg.upload.title')} open={uploadOpen} onCancel={() => setUploadOpen(false)}
        footer={null} destroyOnHidden
      >
        <Form form={uploadForm} layout="vertical" onFinish={handleUpload} style={{ marginTop: 8 }}>
          <Form.Item name="file" label={t('execPkg.upload.field.file')} valuePropName="fileList" rules={[{ required: true, message: t('execPkg.upload.chooseFile') }]}>
            <Upload beforeUpload={() => false} maxCount={1} accept=".zip,.tar.gz,.whl,.jar">
              <Button icon={<UploadOutlined />}>{t('execPkg.upload.chooseFileBtn')}</Button>
            </Upload>
          </Form.Item>
          <Space style={{ display: 'flex' }} size="middle">
            <Form.Item name="name" label={t('execPkg.upload.field.name')} rules={[{ required: true, message: t('execPkg.upload.field.nameRequired') }]} style={{ flex: 1 }}>
              <Input placeholder="python-runner" />
            </Form.Item>
            <Form.Item name="version" label={t('execPkg.upload.field.version')} rules={[{ required: true, message: t('execPkg.upload.field.versionRequired') }]} style={{ flex: 1 }}>
              <Input placeholder="1.0.0" />
            </Form.Item>
          </Space>
          <Space style={{ display: 'flex' }} size="middle">
            <Form.Item name="type" label={t('execPkg.upload.field.type')} initialValue="node" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select options={[
                { value: 'node', label: 'Node.js' }, { value: 'python', label: 'Python' },
                { value: 'java', label: 'Java' }, { value: 'shell', label: 'Shell' },
              ]} />
            </Form.Item>
            <Form.Item name="platform" label={t('execPkg.upload.field.platform')} initialValue="linux" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select options={[
                { value: 'linux', label: 'Linux' }, { value: 'windows', label: 'Windows' },
                { value: 'macos', label: 'macOS' }, { value: 'all', label: t('execPkg.upload.platformAll') },
              ]} />
            </Form.Item>
          </Space>
          <Form.Item name="description" label={t('execPkg.upload.field.description')}>
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0, textAlign: 'right' }}>
            <Space>
              <Button onClick={() => setUploadOpen(false)}>{t('execPkg.cancel')}</Button>
              <Button type="primary" htmlType="submit" loading={uploading}>{t('execPkg.upload.confirm')}</Button>
            </Space>
          </Form.Item>
        </Form>
      </Modal>

      {/* 推送弹窗 */}
      <Modal
        title={
          pushTarget
            ? t('execPkg.push.titleWithPkg', { name: pushTarget.name, version: pushTarget.version })
            : t('execPkg.push.title')
        }
        open={!!pushTarget}
        onCancel={() => setPushTarget(null)}
        footer={
          pushResults ? (
            <Space>
              <Button onClick={() => setPushResults(null)}>{t('execPkg.push.retry')}</Button>
              <Button type="primary" onClick={() => setPushTarget(null)}>{t('execPkg.close')}</Button>
            </Space>
          ) : (
            <Space>
              <Button onClick={() => setPushTarget(null)}>{t('execPkg.cancel')}</Button>
              <Button
                type="primary" icon={<SendOutlined />} loading={pushing} onClick={handlePush}
                disabled={!pushAll && selectedExecutors.length === 0}
              >
                {t('execPkg.push.start')}
              </Button>
            </Space>
          )
        }
        destroyOnHidden
      >
        {!pushResults ? (
          <Space orientation="vertical" style={{ width: '100%' }} size="middle">
            <Alert
              title={t('execPkg.push.alert')}
              type="info" showIcon
            />
            <Checkbox checked={pushAll} onChange={e => setPushAll(e.target.checked)}>
              {t('execPkg.push.pushAll', { count: onlineExecutors.length })}
            </Checkbox>
            {!pushAll && (
              <Card size="small" style={{ background: '#fafafa' }}>
                <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
                  {t('execPkg.push.selectTarget')}
                </Text>
                {onlineExecutors.length === 0 ? (
                  <Text type="secondary">{t('execPkg.push.noOnline')}</Text>
                ) : (
                  <Space orientation="vertical" size={4}>
                    {onlineExecutors.map(ex => (
                      <Checkbox
                        key={ex.id}
                        checked={selectedExecutors.includes(ex.id)}
                        onChange={e => setSelectedExecutors(sel =>
                          e.target.checked ? [...sel, ex.id] : sel.filter(id => id !== ex.id)
                        )}
                      >
                        <Space size="small">
                          <Text strong>{ex.name}</Text>
                          <Badge status="success" />
                          <Text type="secondary" style={{ fontSize: 12 }}>{ex.address}</Text>
                        </Space>
                      </Checkbox>
                    ))}
                  </Space>
                )}
              </Card>
            )}
          </Space>
        ) : (
          <Space orientation="vertical" style={{ width: '100%' }}>
            <Text strong>{t('execPkg.push.resultTitle')}</Text>
            {pushResults.map((r, i) => (
              <Alert
                key={i}
                type={r.success ? 'success' : 'error'}
                showIcon
                title={
                  <>
                    <Text strong>{r.address || t('execPkg.push.task')}</Text>
                    {r.error && <Text type="danger"> — {r.error}</Text>}
                  </>
                }
              />
            ))}
          </Space>
        )}
      </Modal>
    </div>
  );
}

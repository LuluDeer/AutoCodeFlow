import { useState, useEffect, useCallback } from 'react';
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
import PageHeader from '../components/PageHeader';
import PageSkeleton from '../components/PageSkeleton';
import { Empty as AntEmpty } from 'antd';

const { Text } = Typography;

interface PkgRow {
  id: string; name: string; version: string; type: string;
  platform?: string; status: string; fileSize?: number;
  uploadedBy?: string; createdAt: string; originalFilename?: string;
}
interface Executor { id: string; name: string; address: string; status: string; }
interface PushResult { executorId: string; address: string; success: boolean; error?: string; }

const STATUS_TAG: Record<string, { color: string; label: string }> = {
  active: { color: 'green', label: '活跃' },
  deprecated: { color: 'orange', label: '已弃用' },
  deleted: { color: 'red', label: '已删除' },
};

function fmtBytes(b?: number) {
  if (!b) return '-';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

export default function ExecutorPackagesPage() {
  const [rows, setRows] = useState<PkgRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 20;

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
    setLoading(true);
    try {
      const res = await listPackages({
        page, pageSize: PAGE_SIZE,
        name: search || undefined,
        type: typeFilter || undefined,
        status: statusFilter || undefined,
      });
      setRows(res.items.map(pkg => ({ ...pkg, status: pkg.isLatest ? 'active' : 'deprecated' })));
      setTotal(res.total);
    } catch (err: unknown) { message.error(getErrMsg(err, '加载失败')); } finally { setLoading(false); }
  }, [page, search, typeFilter, statusFilter]);

  useEffect(() => { load(); }, [load]);

  const handleUpload = async (values: Record<string, unknown>) => {
    const fileList = (values.file as { fileList?: { originFileObj: File }[] })?.fileList;
    const fileObj: File | undefined = fileList?.[0]?.originFileObj;
    if (!fileObj) { message.error('请选择文件'); return; }
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
      message.success('上传成功');
      setUploadOpen(false);
      uploadForm.resetFields();
      load();
    } catch (err: unknown) { message.error(getErrMsg(err, '上传失败')); } finally { setUploading(false); }
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
      title: '确认删除',
      content: '此操作不可撤销，确认删除此包？',
      okText: '删除', okType: 'danger', cancelText: '取消',
      onOk: async () => { await deletePackage(id); load(); },
    });
  };

  const handleStatusToggle = async (pkg: PkgRow) => {
    try {
      if (pkg.status === 'active') await deprecatePackage(pkg.id);
      else await activatePackage(pkg.id);
      load();
    } catch (err: unknown) { message.error(getErrMsg(err, '操作失败')); }
  };

  // download 路由在 JwtAuthGuard 后，<a href> 无法携带 Authorization（会 401），
  // 改为带 JWT 的 axios blob 请求下载
  const handleDownload = async (pkg: PkgRow) => {
    setDownloadingId(pkg.id);
    try {
      await downloadPackage(pkg.id, pkg.originalFilename ?? `${pkg.name}-${pkg.version}`);
    } catch (err: unknown) {
      message.error(getErrMsg(err, '下载失败'));
    } finally {
      setDownloadingId(null);
    }
  };

  const onlineExecutors = executors.filter(e => e.status === 'online');

  const columns: ColumnsType<PkgRow> = [
    {
      title: '包名', dataIndex: 'name',
      render: (n: string, r: PkgRow) => (
        <Space orientation="vertical" size={0}>
          <Text strong>{n}</Text>
          {r.originalFilename && <Text type="secondary" style={{ fontSize: 12 }}>{r.originalFilename}</Text>}
        </Space>
      ),
    },
    { title: '版本', dataIndex: 'version', width: 100, render: (v: string) => <Tag color="blue">{v}</Tag> },
    { title: '类型', dataIndex: 'type', width: 90, render: (v: string) => <Tag>{v}</Tag> },
    { title: '平台', dataIndex: 'platform', width: 90, render: (v?: string) => v ?? '-' },
    { title: '大小', dataIndex: 'fileSize', width: 90, render: (v?: number) => fmtBytes(v) },
    {
      title: '状态', dataIndex: 'status', width: 100,
      render: (v: string) => {
        const s = STATUS_TAG[v] ?? { color: 'default', label: v };
        return <Tag color={s.color}>{s.label}</Tag>;
      },
    },
    {
      title: '上传时间', dataIndex: 'createdAt', width: 160,
      render: (v: string) => new Date(v).toLocaleString('zh-CN'),
    },
    { title: '上传者', dataIndex: 'uploadedBy', width: 100, render: (v?: string) => v ?? '-' },
    {
      title: '操作', key: 'actions', width: 160, align: 'center' as const,
      render: (_: unknown, row: PkgRow) => (
        <Space size="small">
          <Tooltip title="下载">
            <Button size="small" icon={<CloudDownloadOutlined />}
              loading={downloadingId === row.id} onClick={() => handleDownload(row)} />
          </Tooltip>
          <Tooltip title="推送到调度机">
            <Button size="small" icon={<SendOutlined />} type="primary"
              disabled={row.status !== 'active'} onClick={() => handleOpenPush(row)} />
          </Tooltip>
          <Tooltip title={row.status === 'active' ? '弃用此包' : '激活此包'}>
            <Button size="small"
              icon={row.status === 'active' ? <StopOutlined /> : <CheckCircleOutlined />}
              onClick={() => handleStatusToggle(row)} />
          </Tooltip>
          <Tooltip title="删除">
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
        title="执行器包管理"
        description="管理执行器运行时包，支持上传、版本管理和一键推送到调度机节点"
        extra={<Button type="primary" icon={<PlusOutlined />} onClick={() => setUploadOpen(true)}>上传新包</Button>}
      />

      <Space style={{ marginBottom: 16 }} wrap>
        <Input.Search
          placeholder="搜索包名…" value={search} allowClear style={{ width: 200 }}
          onChange={e => { setSearch(e.target.value); setPage(1); }}
          onSearch={() => load()}
        />
        <Select
          placeholder="类型" value={typeFilter || undefined} allowClear style={{ width: 120 }}
          onChange={v => { setTypeFilter(v ?? ''); setPage(1); }}
          options={[
            { value: 'node', label: 'Node.js' }, { value: 'python', label: 'Python' },
            { value: 'java', label: 'Java' }, { value: 'shell', label: 'Shell' },
          ]}
        />
        <Select
          placeholder="状态" value={statusFilter || undefined} allowClear style={{ width: 120 }}
          onChange={v => { setStatusFilter(v ?? ''); setPage(1); }}
          options={[{ value: 'active', label: '活跃' }, { value: 'deprecated', label: '已弃用' }]}
        />
        <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
        <Text type="secondary">共 {total} 个包</Text>
      </Space>

      <Table<PkgRow>
        rowKey="id" columns={columns} dataSource={rows} loading={false} size="small"
        pagination={{
          current: page, pageSize: PAGE_SIZE, total, onChange: setPage,
          showTotal: t => `共 ${t} 条`,
        }}
        locale={{
          // UI-08：首屏加载（无数据）以骨架屏替代表格 Spin；空态引导上传
          emptyText: loading && rows.length === 0
            ? <PageSkeleton variant="table" rows={4} />
            : <AntEmpty image={AntEmpty.PRESENTED_IMAGE_SIMPLE} description="暂无包，点击「上传新包」添加第一个" />,
        }}
      />

      {/* 上传弹窗 */}
      <Modal
        title="上传执行器包" open={uploadOpen} onCancel={() => setUploadOpen(false)}
        footer={null} destroyOnHidden
      >
        <Form form={uploadForm} layout="vertical" onFinish={handleUpload} style={{ marginTop: 8 }}>
          <Form.Item name="file" label="包文件" valuePropName="fileList" rules={[{ required: true, message: '请选择文件' }]}>
            <Upload beforeUpload={() => false} maxCount={1} accept=".zip,.tar.gz,.whl,.jar">
              <Button icon={<UploadOutlined />}>选择文件</Button>
            </Upload>
          </Form.Item>
          <Space style={{ display: 'flex' }} size="middle">
            <Form.Item name="name" label="包名" rules={[{ required: true, message: '请输入包名' }]} style={{ flex: 1 }}>
              <Input placeholder="python-runner" />
            </Form.Item>
            <Form.Item name="version" label="版本号" rules={[{ required: true, message: '请输入版本号' }]} style={{ flex: 1 }}>
              <Input placeholder="1.0.0" />
            </Form.Item>
          </Space>
          <Space style={{ display: 'flex' }} size="middle">
            <Form.Item name="type" label="类型" initialValue="node" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select options={[
                { value: 'node', label: 'Node.js' }, { value: 'python', label: 'Python' },
                { value: 'java', label: 'Java' }, { value: 'shell', label: 'Shell' },
              ]} />
            </Form.Item>
            <Form.Item name="platform" label="平台" initialValue="linux" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select options={[
                { value: 'linux', label: 'Linux' }, { value: 'windows', label: 'Windows' },
                { value: 'macos', label: 'macOS' }, { value: 'all', label: '通用' },
              ]} />
            </Form.Item>
          </Space>
          <Form.Item name="description" label="描述（可选）">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0, textAlign: 'right' }}>
            <Space>
              <Button onClick={() => setUploadOpen(false)}>取消</Button>
              <Button type="primary" htmlType="submit" loading={uploading}>确认上传</Button>
            </Space>
          </Form.Item>
        </Form>
      </Modal>

      {/* 推送弹窗 */}
      <Modal
        title={
          pushTarget
            ? `推送包到调度机 — ${pushTarget.name}@${pushTarget.version}`
            : '推送包'
        }
        open={!!pushTarget}
        onCancel={() => setPushTarget(null)}
        footer={
          pushResults ? (
            <Space>
              <Button onClick={() => setPushResults(null)}>重新推送</Button>
              <Button type="primary" onClick={() => setPushTarget(null)}>关闭</Button>
            </Space>
          ) : (
            <Space>
              <Button onClick={() => setPushTarget(null)}>取消</Button>
              <Button
                type="primary" icon={<SendOutlined />} loading={pushing} onClick={handlePush}
                disabled={!pushAll && selectedExecutors.length === 0}
              >
                开始推送
              </Button>
            </Space>
          )
        }
        destroyOnHidden
      >
        {!pushResults ? (
          <Space orientation="vertical" style={{ width: '100%' }} size="middle">
            <Alert
              title="推送后，目标调度机将主动下载此包并完成自动更新。"
              type="info" showIcon
            />
            <Checkbox checked={pushAll} onChange={e => setPushAll(e.target.checked)}>
              推送到全部在线调度机（共 {onlineExecutors.length} 台在线）
            </Checkbox>
            {!pushAll && (
              <Card size="small" style={{ background: '#fafafa' }}>
                <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
                  选择目标调度机：
                </Text>
                {onlineExecutors.length === 0 ? (
                  <Text type="secondary">暂无在线调度机</Text>
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
            <Text strong>推送结果：</Text>
            {pushResults.map((r, i) => (
              <Alert
                key={i}
                type={r.success ? 'success' : 'error'}
                showIcon
                title={
                  <>
                    <Text strong>{r.address || '推送任务'}</Text>
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

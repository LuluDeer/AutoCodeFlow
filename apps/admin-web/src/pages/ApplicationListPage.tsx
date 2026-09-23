import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Table, Button, Space, Tag, Modal, Form, Input, Select, Upload, message,
  Typography, Tooltip, Badge, Empty, Switch,
} from 'antd';
import {
  PlusOutlined, UploadOutlined, ReloadOutlined, GithubOutlined,
  SearchOutlined, FilterOutlined, EyeOutlined, RocketOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons';
import { applicationsApi, Application, deploymentsApi, AppDeployment } from '../api/applications';
import { executorsApi } from '../api/executors';
import { useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getErrMsg, isFormValidationError } from '../utils/error';
import { normFileList } from '../utils/upload';
import { formatDateTime, formatRelativeTime } from '../utils/timeFormat';
// D-P2-02b（设计审计 2026-09-22）：runtime 读面走唯一事实源 runtimeLabel
// （与筛选下拉同源；未知值回退原始 token）。
import { runtimeLabel } from '../utils/runtime-label';
import { useAuthStore, isAdminUser } from '../store/auth';
import PageHeader from '../components/PageHeader';
import PageSkeleton from '../components/PageSkeleton';
import StateError from '../components/StateError';
import DeployModeFields from '../components/DeployModeFields';
// UI-10：导入 i18n 实例（模块副作用完成初始化；树内用 useTranslation 读 key）
import '../i18n';

const { Text } = Typography;

/** UI-08：首屏 Skeleton 渲染判据——初次加载（无数据）且未出错时以骨架屏替代表格 Spin */
function shouldShowSkeleton(loading: boolean, error: unknown, count: number): boolean {
  return loading && count === 0 && !error;
}

/**
 * O-6：对 items 按 batchSize 并发执行 fn，返回与入参等长的 settled 结果。
 *
 * 此前 `Promise.allSettled(data.map(app => deploymentsApi.list(app.id)))` 对 N 个应用
 * 瞬间发出 N 个请求——应用数 50+ 时既打满浏览器同域并发（约 6，其余排队），又可能触发
 * 后端 429。这里用固定大小 worker 池把在途请求压到 batchSize（取 6），同时保留
 * allSettled 的「单应用失败不拖垮整列」语义（结果按 settled 形态返回）。
 */
async function mapWithSettledConcurrency<T, R>(
  items: T[],
  batchSize: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(batchSize, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i]) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
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

// F-2 + P1-12：整包 zip 上传体积上限。大包直传容易超时且无进度条，先在前端拦截并提示。
// P1-12：前端此前写死 50MB，而后端 multer limits.fileSize = 200 MiB
// （application.controller.ts:210）——用户在 50~200MB 之间会被前端先拦下、
// 误以为后端也只收 50MB。对齐到后端上限 200 MiB（跨包无法共享常量，这里显式
// 注明来源行，后端改了请同步）。
const MAX_ZIP_UPLOAD_BYTES = 200 * 1024 * 1024; // 200 MiB（对齐 multer limits）
const MAX_ZIP_UPLOAD_LABEL = '200MB';

/**
 * 应用列表统计部署数时每页取多少条。
 *
 * 对齐后端上限：`app-deployment.controller.ts` 的 ListDeploymentsQueryDto 声明
 * `@Max(100)`，超过会被 400 拒绝——不能随手写 500。
 *
 * 为什么不是默认的 20：统计口径是「这个应用有几个部署在跑/失败」，用 20 会让
 * 部署行多的应用分母偏小、且运行中实例可能落在窗口外而漏计（详见 fetchApps 注释）。
 * 取到上限 100 后，只有部署数 >100 的应用才可能漏计，而这类应用的**分母**仍由
 * 响应的 total 保证正确（不会谎报"均未运行"以外的错误总数）。
 */
const DEPLOYMENT_STATS_PAGE_SIZE = 100;

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
  /** P1-13：失败部署数——部署失败后列表页仍显示"运行中"的假象要靠它破。 */
  failedCount: number;
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
  // F-2：整包 zip 上传期间禁用确定按钮并给 loading，避免重复点击触发多次上传
  //（与 ExecutorPackagesPage 的 uploading 模式对齐）。
  const [uploading, setUploading] = useState(false);

  const fetchApps = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await applicationsApi.list();

      // Fetch all deployments in parallel per app to compute stats.
      // O-6：用并发池（batchSize=6）替换全量 allSettled，避免应用多时瞬间打爆并发/限流。
      //
      // 用户报障（中台显示不可信）：此前用 `deploymentsApi.list(app.id)` 的**默认
      // pageSize=20**，且统计只数当前这一页（`deps.length` / `deps.filter(...)`），
      // 于是部署行超过 20 条的应用分母恒为 20；更糟的是 `runningCount` 也只数最新
      // 20 行——**一个正在运行但排在 20 行之外的实例会让整列显示"25 个部署均未运行"**，
      // 这是应用列表页（看应用的第一屏）对"我的应用在跑吗"给出错误答案。
      // 修法：① 显式取后端上限 100（controller 的 @Max(100)）；② 分母用响应里
      // 本就有的 `total`（真实总数），而不是当前页长度。
      const deploymentResults = await mapWithSettledConcurrency(
        data,
        6,
        (app) => deploymentsApi.list(app.id, 1, DEPLOYMENT_STATS_PAGE_SIZE),
      );

      const enriched: AppWithStats[] = data.map((app, i) => {
        const result = deploymentResults[i];
        const deps: AppDeployment[] =
          result.status === 'fulfilled' ? result.value.data : [];

        const runningCount = deps.filter((d) => d.status === 'running').length;
        const failedCount = deps.filter((d) => d.status === 'failed').length;
        const sorted = [...deps].sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
        const lastDeployedAt =
          sorted.length > 0 ? (sorted[0].deployedAt ?? sorted[0].createdAt) : null;

        return {
          ...app,
          runningCount,
          failedCount,
          // 真实总数（响应 total），不是本页条数——否则 >100 个部署时又会被截断
          // 成 100。取不到 total（异常/旧后端）时如实回落本页条数。
          totalDeployments:
            result.status === 'fulfilled' && typeof result.value.total === 'number'
              ? result.value.total
              : deps.length,
          lastDeployedAt,
        };
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

  /**
   * P0-3（UX-AUDIT-2026-09-21）：删除前先取影响面，用 Modal 如实列出后果。
   *
   * 原实现是裸 Popconfirm（"确认删除此应用？/ 删除后无法恢复"），而真实后果有三条，
   * 其中**最危险的一条用户完全不知道**：引用它的任务不会消失，只是 applicationId
   * 被 `onDelete: "SET NULL"` 置空——任务照旧按 cron 调度，但代码来源已断，此后
   * 每次执行都失败，而排查入口（应用详情页）已经不存在了。
   *
   * 影响面拉取失败**不阻断删除**（预览是增强，不是闸门）：降级为原有的通用确认，
   * 并在文案里提示"影响面未能获取"。否则一次接口抖动会让管理员彻底删不掉东西。
   */
  const handleDeleteClick = async (app: Application) => {
    let impact: Awaited<ReturnType<typeof applicationsApi.removalImpact>> | null = null;
    try {
      impact = await applicationsApi.removalImpact(app.id);
    } catch {
      impact = null;
    }
    const lines: string[] = [];
    if (impact) {
      if (impact.tasksLosingSource > 0) {
        lines.push(t('appList.deleteImpact.tasks', { count: impact.tasksLosingSource }));
      }
      if (impact.deploymentCount > 0) {
        lines.push(t('appList.deleteImpact.deployments', { count: impact.deploymentCount }));
      }
      if (impact.packageFileWillBeDeleted) {
        lines.push(t('appList.deleteImpact.package'));
      }
      if (lines.length === 0) lines.push(t('appList.deleteImpact.none'));
    } else {
      lines.push(t('appList.deleteImpact.unavailable'));
    }
    Modal.confirm({
      title: t('appList.deleteConfirm'),
      content: (
        <div>
          <p style={{ marginBottom: 8 }}>{t('appList.deleteConfirmDesc')}</p>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {lines.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </div>
      ),
      okText: t('appList.deleteOk'),
      okButtonProps: { danger: true },
      cancelText: t('appList.deploy.cancel'),
      onOk: () => handleDelete(app.id),
    });
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
      // 上传即产生版本：随包提交版本号，后端据此抬 application.version 并落 application_versions 快照。
      if (values.version) {
        formData.append('version', String(values.version).trim());
      }
      const file = values.file as { originFileObj?: File }[] | undefined;
      if (file?.[0]?.originFileObj) {
        formData.append('file', file[0].originFileObj);
      }
      setUploading(true);
      await applicationsApi.upload(formData);
      message.success(t('appList.uploaded'));
      setUploadModalOpen(false);
      uploadForm.resetFields();
      fetchApps();
    } catch (err: unknown) {
      if (isFormValidationError(err)) return;
      message.error(getErrMsg(err, t('appList.uploadFail')));
    } finally {
      setUploading(false);
    }
  };

  // F-2：beforeUpload 仍返回 false（手动经 FormData 提交），但先做体积拦截；
  // 超限文件直接从选择列表剔除并提示，不进入表单 fileList。
  const beforeZipUpload = (file: File) => {
    if (file.size > MAX_ZIP_UPLOAD_BYTES) {
      message.error(t('appList.upload.tooLarge', { size: MAX_ZIP_UPLOAD_LABEL }));
      return Upload.LIST_IGNORE;
    }
    return false;
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
      const created = await deploymentsApi.deploy(quickDeployApp, {
        executorId: values.executorId || undefined,
        runMode: values.runMode,
        startCommand: values.runMode === 'daemon' ? values.startCommand : undefined,
      });
      // P0（UX-AUDIT-2026-09-21 §P0-2）：审批流的应用，后端**只落待审批行、
      // 不派发**（app-deployment.service.ts 的 `if (app.approvalRequired)` 分支
      // 直接 return）。此前这里无条件弹「部署已创建」——在一个更常用的入口上
      // 谎报成功：用户看到绿色提示就关窗走人，实际什么都不会被派发，一行
      // pending_approval 静静等人批准，而用户不会去审批页（界面刚说创建好了）。
      // 判定必须与详情页 AppDeploymentPage.handleDeploy 同源，否则同一接口
      // 两个入口给出两种结论。
      if (created?.approvalStatus === 'pending_approval') {
        message.info(t('appDeploy.msg.deployPendingApproval'));
      } else {
        message.success(t('appDeploy.msg.deployStarted'));
      }
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
        // UI 打磨：名称单行 ellipsis——弹性列内 minWidth:0 + display:block 让省略号生效
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            {record.gitRepo && <GithubOutlined style={{ flex: 'none' }} />}
            {/* F-33（DEEP_REVIEW 0ef3bbe）：原 <a onClick> 无 href，改 <Link>（键盘可达 + 真实 href） */}
            <Link to={`/applications/${record.id}`} style={{ minWidth: 0 }}>
              <Text strong style={{ display: 'block' }} ellipsis={{ tooltip: name }}>
                {name}
              </Text>
            </Link>
          </div>
          {record.gitBranch && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t('appList.branch', { branch: record.gitBranch })}
            </Text>
          )}
        </div>
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
      render: (v: string) => <Tag color="blue">{runtimeLabel(v, t)}</Tag>,
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
        // P1-13：旧实现无条件显示绿色"运行中 X/Y"——部署全部失败后仍显示绿色，
        // 用户以为服务正常。runningCount===0 且有部署时：
        //   · 有失败行 → 红色 Badge + 失败数；
        //   · 无失败（如全部 stopped）→ 中性 Badge，不再冒充运行中。
        if (record.runningCount === 0) {
          const status: 'error' | 'default' = record.failedCount > 0 ? 'error' : 'default';
          const text = record.failedCount > 0
            ? t('appList.deployFailed', { failed: record.failedCount, total: record.totalDeployments })
            : t('appList.deployNotRunning', { total: record.totalDeployments });
          return (
            <Space>
              <Badge status={status} />
              <Text type={record.failedCount > 0 ? 'danger' : 'secondary'}>{text}</Text>
            </Space>
          );
        }
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
            {formatRelativeTime(record.lastDeployedAt, t)}
          </Text>
        </Tooltip>
      ),
    },
    {
      title: t('appList.col.actions'),
      key: 'actions',
      width: 210,
      fixed: 'right' as const,
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
          <Tooltip title={isAdmin ? t('appList.deleteHint') : t('appList.deleteDisableHint')}>
            {/* P0-3：改为先取影响面再弹 Modal（Popconfirm 装不下逐条后果） */}
            <Button
              type="link"
              size="small"
              danger
              disabled={!isAdmin}
              onClick={() => void handleDeleteClick(record)}
            >
              {t('appList.action.delete')}
            </Button>
          </Tooltip>
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
        loading={loading}
        scroll={{ x: 1000 }}
        // D-P2-10（设计审计）：主表此前无 pagination prop，antd 默认分页不带
        // 总数——用户看不到一共多少应用。补 showTotal（客户端筛选后的总数）。
        pagination={{
          showSizeChanger: true,
          showTotal: (n) => t('appList.total', { count: n }),
        }}
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
        confirmLoading={uploading}
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
            name="version"
            label={t('appList.field.version')}
            tooltip={{
              title: t('appList.upload.versionTooltip'),
              icon: <InfoCircleOutlined />,
            }}
          >
            <Input placeholder="1.0.1" />
          </Form.Item>
          <Form.Item
            name="file"
            label={t('appList.upload.zip')}
            rules={[{ required: true, message: t('appList.upload.zipRequired') }]}
            valuePropName="fileList"
            getValueFromEvent={normFileList}
            tooltip={{
              title: t('appList.upload.zipTooltip'),
              icon: <InfoCircleOutlined />,
            }}
          >
            <Upload maxCount={1} beforeUpload={beforeZipUpload} accept=".zip">
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
          {/* P1-15：runMode 字段 + 模式说明复用共享组件（旧实现此处无任何模式说明）。 */}
          <DeployModeFields buttonStyle="outline" />
        </Form>
      </Modal>
    </div>
  );
}

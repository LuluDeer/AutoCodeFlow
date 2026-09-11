import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Table, Button, Tag, Space, Typography, message, Modal, Select,
  Badge, Tooltip, Alert, Empty, Popconfirm, Form, Progress, Radio, Input,
} from 'antd';
import type { BadgeProps } from 'antd';
import {
  RocketOutlined, StopOutlined, ReloadOutlined, PlusOutlined,
  ThunderboltOutlined, UpCircleOutlined, CheckOutlined, CloseOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import { deploymentsApi, AppDeployment, applicationsApi } from '../api/applications';
import { executorsApi, Executor } from '../api/executors';
import { getErrMsg, isFormValidationError } from '../utils/error';
import StateError from '../components/StateError';
import { useAuthStore } from '../store/auth';

const { Text } = Typography;

const STATUS_CONFIG: Record<string, { color: string; label: string; badge: BadgeProps['status'] }> = {
  running: { color: 'green', label: '运行中', badge: 'success' },
  stopped: { color: 'default', label: '已停止', badge: 'default' },
  deploying: { color: 'blue', label: '部署中', badge: 'processing' },
  failed: { color: 'red', label: '失败', badge: 'error' },
  pending: { color: 'orange', label: '等待中', badge: 'warning' },
  upgrading: { color: 'cyan', label: '升级中', badge: 'processing' },
};

/** DEP-04: 审批状态展示配置（null=非审批路径不渲染） */
const APPROVAL_CONFIG: Record<string, { color: string; label: string }> = {
  pending_approval: { color: 'gold', label: '待审批' },
  approved: { color: 'green', label: '已批准' },
  rejected: { color: 'red', label: '已拒绝' },
  cancelled: { color: 'default', label: '已撤销' },
};

function ExecutorCard({ executor }: { executor: Executor }) {
  const load = executor.runningTaskCount ?? 0;
  const maxLoad = executor.maxConcurrentTasks ?? 10;
  const loadPercent = Math.min(100, Math.round((load / maxLoad) * 100));
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0' }}>
      <Badge status={executor.status === 'online' ? 'success' : 'default'} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 500, fontSize: 13}}>{executor.appName}</div>
        <div style={{ fontSize: 11, color: '#888' }}>{executor.address}</div>
      </div>
      <div style={{ width: 80, textAlign: 'right' }}>
        <div style={{ fontSize: 11, color: '#888' }}>{load}/{maxLoad}任务</div>
        <Progress
          percent={loadPercent}
          size="small"
          showInfo={false}
          strokeColor={loadPercent > 80 ? '#ff4d4f' : loadPercent > 60 ? '#fa8c16' : '#52c41a'}
        />
      </div>
    </div>
  );
}

export default function AppDeploymentPage({ applicationId }: { applicationId: string }) {
  const [deployments, setDeployments] = useState<AppDeployment[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [executors, setExecutors] = useState<Executor[]>([]);
  const [loading, setLoading] = useState(false);
  // UI-16：列表加载失败的错误态（页内呈现 + 重试入口，替代纯 toast）
  const [loadError, setLoadError] = useState<unknown>(null);
  const [deployModalOpen, setDeployModalOpen] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [upgradingAll, setUpgradingAll] = useState(false);
  const [deployForm] = Form.useForm();
  const [runMode, setRunMode] = useState<'once' | 'daemon' | 'scheduled'>('once');
  // R5 RBAC：安装向导为 ADMIN-only，普通用户隐藏入口
  // W3：部署写面（deploy/stop/upgrade/upgrade-all）后端已 @Roles(ADMIN)，按钮级禁用
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const me = useAuthStore((s) => s.user);
  // DEP-04: 拒绝理由 Modal（拒绝建议留痕；approve/cancel 无需理由）
  const [rejectTarget, setRejectTarget] = useState<AppDeployment | null>(null);
  const [rejectForm] = Form.useForm();
  const [rejecting, setRejecting] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null);

  // W7 竞态守卫：fetchAll 无取消机制，翻页/轮询并发时旧响应可覆盖新页数据。
  // 每次调用自增 fetchSeq，仅最后一次请求允许 setState；cleanup（卸载或翻页）
  // 置 cancelled，让已 in-flight 的旧响应在 resolve 后被丢弃。
  const fetchSeq = useRef(0);
  const fetchAll = useCallback(async () => {
    const seq = ++fetchSeq.current;
    setLoading(true);
    try {
      const [deps, execs] = await Promise.all([
        deploymentsApi.list(applicationId, page),
        executorsApi.list(),
      ]);
      if (seq !== fetchSeq.current) return; // 已有更新的请求/卸载，丢弃过期响应
      setDeployments(deps.data);
      setTotal(deps.total);
      setExecutors(execs);
      // UI-16：加载成功后清除上一次的页内错误态
      setLoadError(null);
    } catch (err: unknown) {
      if (seq !== fetchSeq.current) return;
      // UI-16：列表加载失败改在页内呈现（含重试/复制），不再只弹一闪而过的 toast
      setLoadError(err);
    } finally {
      if (seq === fetchSeq.current) setLoading(false);
    }
  }, [applicationId, page]);

  useEffect(() => {
    fetchAll();
    // W7：卸载/翻页时自增序号，让本 effect 发起的请求结果作废
    return () => { const { current } = fetchSeq; fetchSeq.current = current + 1; };
  }, [fetchAll]);

  // Auto-poll while any deployment is in progress
  useEffect(() => {
    const inProgress = deployments.some(d => d.status === 'deploying' || d.status === 'upgrading' || d.status === 'pending');
    if (!inProgress) return;
    const timer = setInterval(() => { fetchAll(); }, 3000);
    return () => clearInterval(timer);
  }, [deployments, fetchAll]);

  const handleDeploy = async () => {
    try {
      const values = await deployForm.validateFields();
      setDeploying(true);
      // executorId: undefined => server auto-picks least loaded
      const created = await deploymentsApi.deploy(applicationId, { executorId: values.executorId || undefined, runMode: values.runMode || 'once', startCommand: values.startCommand });
      // DEP-04: 开启审批流的应用，deploy 冻结为待审批行（后端未派发）
      if (created?.approvalStatus === 'pending_approval') {
        message.info('部署请求已提交审批，等待第二位管理员批准后才会派发');
      } else {
        message.success('部署已启动');
      }
      setDeployModalOpen(false);
      deployForm.resetFields();
      setTimeout(fetchAll, 1500);
    } catch (err: unknown) {
      if (isFormValidationError(err)) return;
      message.error(getErrMsg(err, '部署失败'));
    } finally {
      setDeploying(false);
    }
  };

  // DEP-04: 审批三动作（后端第二人规则兜底；前端对提交者本人禁用批准/拒绝）
  const handleApprove = async (id: string) => {
    setActingId(id);
    try {
      await deploymentsApi.approve(id);
      message.success('已批准，部署开始派发');
      fetchAll();
    } catch (err: unknown) {
      message.error(getErrMsg(err, '批准失败'));
    } finally {
      setActingId(null);
    }
  };

  const handleReject = async () => {
    if (!rejectTarget) return;
    setRejecting(true);
    try {
      const values = await rejectForm.validateFields();
      await deploymentsApi.reject(rejectTarget.id, values.reason || undefined);
      message.success('已拒绝该部署请求');
      setRejectTarget(null);
      rejectForm.resetFields();
      fetchAll();
    } catch (err: unknown) {
      if (isFormValidationError(err)) return;
      message.error(getErrMsg(err, '拒绝失败'));
    } finally {
      setRejecting(false);
    }
  };

  const handleCancel = async (id: string) => {
    setActingId(id);
    try {
      await deploymentsApi.cancel(id);
      message.success('已撤销部署请求');
      fetchAll();
    } catch (err: unknown) {
      message.error(getErrMsg(err, '撤销失败'));
    } finally {
      setActingId(null);
    }
  };

  const handleStop = async (id: string) => {
    try {
      await deploymentsApi.stop(id);
      message.success('已停止');
      fetchAll();
    } catch (err: unknown) {
      message.error(getErrMsg(err, '操作失败'));
    }
  };

  const handleUpgrade = async (id: string) => {
    try {
      await deploymentsApi.upgrade(id);
      message.success('升级已启动，稍后自动完成');
      setTimeout(fetchAll, 2000);
    } catch (err: unknown) {
      message.error(getErrMsg(err, '升级失败'));
    }
  };

  const handleUpgradeAll = async () => {
    const runningCount = deployments.filter(d => d.status === 'running').length;
    if (runningCount === 0) {
      message.warning('当前没有运行中的实例需要升级');
      return;
    }
    setUpgradingAll(true);
    try {
      const result = await applicationsApi.upgradeAll(applicationId);
      message.success(`已触发 ${result.succeeded}/${result.total} 个实例升级`);
      setTimeout(fetchAll, 2000);
    } catch (err: unknown) {
      message.error(getErrMsg(err, '批量升级失败'));
    } finally {
      setUpgradingAll(false);
    }
  };

  const onlineExecutors = executors.filter(e => e.status === 'online');
  // DEP-04：待审批行数（审批待办 Alert 与状态徽标共用同一口径）
  const pendingApprovalCount = deployments.filter(
    d => d.approvalStatus === 'pending_approval',
  ).length;
  // Executors already occupied by an active deployment of this application
  const occupiedExecutorIds = new Set(
    deployments
      .filter(d => d.status === 'deploying' || d.status === 'running' || d.status === 'upgrading' || d.status === 'pending')
      .map(d => d.executorId)
      .filter(Boolean) as string[]
  );
  const availableExecutors = onlineExecutors.filter(e => !occupiedExecutorIds.has(e.id));

  const openDeployModal = () => {
    deployForm.resetFields();
    setRunMode('once');
    setDeployModalOpen(true);
  };

  const columns = [
    {
      title: '执行器',
      key: 'executor',
      render: (_: unknown, r: AppDeployment) => (
        <Space direction="vertical" size={0}>
          <Text strong style={{ fontSize: 13}}>{r.executorAddress || r.executorId}</Text>
          {r.deployedVersion && <Tag color="blue" style={{ fontSize: 11 }}>v{r.deployedVersion}</Tag>}
          {r.statusMessage && (
            <Text type="secondary" style={{ fontSize: 11 }}>{r.statusMessage}</Text>
          )}
        </Space>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (s: string, r: AppDeployment) => {
        const cfg = STATUS_CONFIG[s] || { color: 'default', label: s, badge: 'default' };
        return (
          <Space direction="vertical" size={0}>
            <Badge status={cfg.badge} text={<Tag color={cfg.color} style={{ border: 'none', background: `${cfg.color}15` }}>{cfg.label}</Tag>} />
            {/* DEP-04: 审批状态徽标（待审批/已批准/已拒绝/已撤销） */}
            {r.approvalStatus && APPROVAL_CONFIG[r.approvalStatus] && (
              <Tag color={APPROVAL_CONFIG[r.approvalStatus].color} style={{ fontSize: 11 }}>
                {APPROVAL_CONFIG[r.approvalStatus].label}
              </Tag>
            )}
          </Space>
        );
      },
    },
    {
      title: '运行模式',
      dataIndex: 'runMode',
      width: 90,
      render: (v: string) => {
        const map: Record<string, { color: string; label: string }> = {
          once: { color: 'default', label: '单次' },
          daemon: { color: 'blue', label: '常驻' },
          scheduled: { color: 'green', label: '定时' },
        };
        const cfg = map[v] || { color: 'default', label: v || '单次' };
        return <Tag color={cfg.color}>{cfg.label}</Tag>;
      },
    },
    {
      title: '部署时间',
      dataIndex: 'deployedAt',
      width: 150,
      render: (v: string, r: AppDeployment) => {
        const d = v || r.createdAt;
        if (!d) return '-';
        const diff = Date.now() - new Date(d).getTime();
        const mins = Math.floor(diff / 60000);
        const text = mins< 1? '刚刚' : mins < 60 ? `${mins}分钟前` : `${Math.floor(mins / 60)}小时前`;
        return (
          <Tooltip title={new Date(d).toLocaleString('zh-CN')}>
            <Text type="secondary" style={{ fontSize: 12 }}>{text}</Text>
          </Tooltip>
        );
      },
    },
    {
      title: '操作',
      width: 200,
      render: (_: unknown, r: AppDeployment) => {
        // DEP-04: 待审批行——出口只有审批三动作（后端对 upgrade/stop 返回 409）
        if (r.approvalStatus === 'pending_approval') {
          const isRequester = me?.id != null && r.approvalMeta?.requestedBy != null && me.id === r.approvalMeta.requestedBy;
          const requesterName = r.approvalMeta?.requestedByName;
          const secondPersonHint = isAdmin
            ? isRequester
              ? '第二人规则：不能审批自己提交的部署请求'
              : requesterName
                ? `提交人：${requesterName}`
                : undefined
            : '仅管理员可审批';
          return (
            <Space size={4}>
              <Tooltip title={secondPersonHint}>
                <Button
                  size="small"
                  type="primary"
                  icon={<CheckOutlined />}
                  loading={actingId === r.id}
                  disabled={!isAdmin || isRequester}
                  onClick={() => handleApprove(r.id)}
                >
                  批准
                </Button>
              </Tooltip>
              <Tooltip title={secondPersonHint}>
                <Button
                  size="small"
                  danger
                  icon={<CloseOutlined />}
                  disabled={!isAdmin || isRequester}
                  onClick={() => { rejectForm.resetFields(); setRejectTarget(r); }}
                >
                  拒绝
                </Button>
              </Tooltip>
              {isRequester && (
                <Popconfirm
                  title="确认撤销自己的部署请求？"
                  onConfirm={() => handleCancel(r.id)}
                  okText="撤销"
                >
                  <Button size="small" icon={<UndoOutlined />} loading={actingId === r.id}>
                    撤回
                  </Button>
                </Popconfirm>
              )}
            </Space>
          );
        }
        return (
        <Space size={4}>
          {r.status === 'running' && (
            <Tooltip title={isAdmin ? undefined : '仅管理员可升级部署'}>
              <Button
                size="small"
                icon={<ReloadOutlined />}
                onClick={() => handleUpgrade(r.id)}
                disabled={!isAdmin}
              >
                升级
              </Button>
            </Tooltip>
          )}
          {(r.status === 'running' || r.status === 'deploying') && (
            <Popconfirm
              title="确认停止？"
              onConfirm={() => handleStop(r.id)}
              okText="停止" okButtonProps={{ danger: true }}
              disabled={!isAdmin}
            >
              <Tooltip title={isAdmin ? undefined : '仅管理员可停止部署'}>
                <Button size="small" danger icon={<StopOutlined />} disabled={!isAdmin}>停止</Button>
              </Tooltip>
            </Popconfirm>
          )}
          {(r.status === 'stopped' || r.status === 'failed') && (
            <Tooltip title={isAdmin ? undefined : '仅管理员可部署应用'}>
              <Button
                size="small"
                type="primary"
                icon={<RocketOutlined />}
                onClick={() => { deployForm.setFieldValue('executorId', r.executorId); setDeployModalOpen(true); }}
                disabled={!isAdmin}
              >
                重新部署
              </Button>
            </Tooltip>
          )}
        </Space>
        );
      },
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Space>
          <Text strong>部署实例</Text>
          {deployments.length > 0 && (
            <Tag color="blue">
              {deployments.filter(d => d.status === 'running').length} 运行中 / {deployments.length} 共计
            </Tag>
          )}
        </Space>
        <Space>
          <Button icon={<ReloadOutlined />} size="small" onClick={fetchAll}>刷新</Button>
          {deployments.filter(d => d.status === 'running').length > 0 && (
            <Popconfirm
              title={`升级所有运行中实例 (${deployments.filter(d => d.status === 'running').length} 台)`}
              description="将对所有运行中实例触发 git pull + 重启"
              onConfirm={handleUpgradeAll}
              okText="确认升级" okButtonProps={{ icon: <UpCircleOutlined /> }}
              disabled={!isAdmin}
            >
              <Tooltip title={isAdmin ? undefined : '仅管理员可升级部署'}>
                <Button
                  icon={<UpCircleOutlined />}
                  loading={upgradingAll}
                  size="small"
                  disabled={!isAdmin}
                >
                  升级所有
                </Button>
              </Tooltip>
            </Popconfirm>
          )}
          <Tooltip title={isAdmin ? undefined : '仅管理员可部署应用'}>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={openDeployModal}
              disabled={onlineExecutors.length === 0 || !isAdmin}
            >
              新建部署
            </Button>
          </Tooltip>
        </Space>
      </div>

      {onlineExecutors.length === 0 && (
        <Alert
          type="warning"
          title="无可用执行器"
          description="需要至少一个在线执行器才能部署。请先安装并启动执行器。"
          action={isAdmin ? <Button size="small" href="/executors/install">安装执行器</Button> : undefined}
          style={{ marginBottom: 16 }}
        />
      )}

      {/* DEP-04: 审批待办提示（管理员视角；普通用户只读可见请求在等待） */}
      {pendingApprovalCount > 0 ? (
        <Alert
          type="warning"
          showIcon
          message={
            isAdmin
              ? `有 ${pendingApprovalCount} 个部署请求等待审批（第二人规则：提交者本人不能审批）`
              : '有部署请求正在等待管理员审批，批准后才会派发到执行器'
          }
          style={{ marginBottom: 16 }}
        />
      ) : null}

      {loadError ? (
        <StateError
          error={loadError}
          title="部署列表加载失败"
          onRetry={() => void fetchAll()}
          style={{ marginBottom: 16 }}
        />
      ) : null}

      {deployments.length === 0 && !loading && !loadError ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="该应用尚未部署"
        >
          <Tooltip title={isAdmin ? undefined : '仅管理员可部署应用'}>
            <Button
              type="primary"
              icon={<RocketOutlined />}
              onClick={openDeployModal}
              disabled={onlineExecutors.length === 0 || !isAdmin}
            >
              立即部署
            </Button>
          </Tooltip>
        </Empty>
      ) : (
        <Table
          rowKey="id"
          columns={columns}
          dataSource={deployments}
          loading={loading}
          size="small"
          pagination={{ current: page, pageSize: 20, total, onChange: (p) => setPage(p), showTotal: (t: number) => `共 ${t} 条` }}
        />
      )}

      {/* 部署弹窗 */}
      <Modal
        title="新建部署"
        open={deployModalOpen}
        onCancel={() => setDeployModalOpen(false)}
        onOk={handleDeploy}
        confirmLoading={deploying}
        okText="立即部署"
        okButtonProps={{ icon: <RocketOutlined /> }}
        width={540}
      >
        <Alert
          type="info"
          icon={<ThunderboltOutlined />}
          showIcon
          message="智能调度：留空则自动选择负载最低的执行器"
          style={{ marginBottom: 16 }}
        />

        <Form form={deployForm} layout="vertical" onValuesChange={(changed) => { if (changed.runMode) setRunMode(changed.runMode); }}>
          <Form.Item name="runMode" label="运行模式" initialValue="once">
            <Radio.Group buttonStyle="solid">
              <Radio.Button value="once">单次执行</Radio.Button>
              <Radio.Button value="daemon">常驻进程</Radio.Button>
              <Radio.Button value="scheduled">定时任务</Radio.Button>
            </Radio.Group>
          </Form.Item>
          {runMode === 'daemon' && (
            <Form.Item name="startCommand" label="启动命令" tooltip="常驻进程的启动命令，如 node dist/server.js">
              <Input placeholder="node dist/server.js" />
            </Form.Item>
          )}
          <Form.Item
            name="executorId"
            label="选择执行器"
          >
            <Select
              placeholder="自动选择最空闲的执行器（推荐）"
              allowClear
              dropdownRender={(menu) => (
                <>
                  {availableExecutors.length > 0 && (
                    <div style={{ padding: '8px 12px', borderBottom: '1px solid #f0f0f0' }}>
                      <Text type="secondary" style={{ fontSize: 12 }}>可用执行器 ({availableExecutors.length} 台，已过滤占用中)</Text>
                    </div>
                  )}
                  {menu}
                </>
              )}
            >
              {availableExecutors.map(e => (
                <Select.Option key={e.id} value={e.id}>
                  <ExecutorCard executor={e} />
                </Select.Option>
              ))}
            </Select>
          </Form.Item>
        </Form>

        {availableExecutors.length > 0 && (
          <div style={{ background: '#f9fafb', borderRadius: 8, padding: 12}}>
            <Text type="secondary" style={{ fontSize: 12}}>可用执行器概况（已过滤占用中）</Text>
            {availableExecutors.slice(0, 4).map(e => (
              <ExecutorCard key={e.id} executor={e} />
            ))}
            {availableExecutors.length > 4 && (
              <Text type="secondary" style={{ fontSize: 12 }}>...还有 {availableExecutors.length - 4} 台</Text>
            )}
          </div>
        )}
      </Modal>

      {/* DEP-04: 拒绝理由 Modal（reason 可选 ≤200，随审批留痕与审计落库） */}
      <Modal
        title="拒绝部署请求"
        open={!!rejectTarget}
        onOk={handleReject}
        onCancel={() => setRejectTarget(null)}
        confirmLoading={rejecting}
        okText="确认拒绝"
        okButtonProps={{ danger: true, icon: <CloseOutlined /> }}
      >
        {rejectTarget && (
          <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
            拒绝后该部署请求将终止（不会派发到执行器 {rejectTarget.executorAddress}），提交人可重新发起。
          </Text>
        )}
        <Form form={rejectForm} layout="vertical">
          <Form.Item
            name="reason"
            label="拒绝理由（可选）"
            rules={[{ max: 200, message: '理由不能超过 200 字' }]}
          >
            <Input.TextArea rows={3} maxLength={200} showCount placeholder="例如：未走变更评审" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
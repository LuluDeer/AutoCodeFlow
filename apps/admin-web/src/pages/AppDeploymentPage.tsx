import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Table, Button, Tag, Space, Typography, message, Modal, Select,
  Badge, Tooltip, Alert, Empty, Popconfirm, Form, Progress, Radio, Input, theme,
} from 'antd';
import {
  RocketOutlined, StopOutlined, ReloadOutlined, PlusOutlined,
  ThunderboltOutlined, UpCircleOutlined, CheckOutlined, CloseOutlined,
  UndoOutlined, DeleteOutlined,
  CopyOutlined,
} from '@ant-design/icons';
import { deploymentsApi, AppDeployment, applicationsApi } from '../api/applications';
import { formatRelativeTime } from '../utils/timeFormat';
import DeployModeFields from '../components/DeployModeFields';
import { executorsApi, Executor } from '../api/executors';
import { getErrMsg, isFormValidationError } from '../utils/error';
// D-P1-2（设计审计 2026-09-22）：失败详情复制改走统一剪贴板封装（非安全上下文
// 降级 execCommand，并按返回值如实提示——此前 navigator.clipboard 静默 catch，
// 失败零反馈，排障者点了复制却粘出空串）。
import { copyText } from '../utils/clipboard';
// F-26（DEEP_REVIEW 0ef3bbe）：locale 单一来源，不再硬编码 zh-CN
import { currentLocale } from '../utils/locale';
import { useTranslation } from 'react-i18next';
import '../i18n';
import StateError from '../components/StateError';
import { useAuthStore } from '../store/auth';

const { Text } = Typography;

const STATUS_CONFIG = (t: (k: string) => string): Record<string, { color: string; label: string }> => ({
  running: { color: 'green', label: t('appDeploy.status.running') },
  stopped: { color: 'default', label: t('appDeploy.status.stopped') },
  deploying: { color: 'blue', label: t('appDeploy.status.deploying') },
  failed: { color: 'red', label: t('appDeploy.status.failed') },
  pending: { color: 'orange', label: t('appDeploy.status.pending') },
  upgrading: { color: 'cyan', label: t('appDeploy.status.upgrading') },
});

/** DEP-04: 审批状态展示配置（null=非审批路径不渲染） */
const APPROVAL_CONFIG = (t: (k: string) => string): Record<string, { color: string; label: string }> => ({
  pending_approval: { color: 'gold', label: t('appDeploy.approval.pending') },
  approved: { color: 'green', label: t('appDeploy.approval.approved') },
  rejected: { color: 'red', label: t('appDeploy.approval.rejected') },
  cancelled: { color: 'default', label: t('appDeploy.approval.cancelled') },
});
/** P1-9：灰度发布阶段展示配置（与后端 RolloutState 枚举对齐）。 */
const ROLLOUT_CONFIG: Record<string, { color: string; label: (t: (k: string) => string) => string }> = {
  pending: { color: 'blue', label: (t) => t('appDeploy.rollout.state.pending') },
  probing: { color: 'orange', label: (t) => t('appDeploy.rollout.state.probing') },
  promoted: { color: 'green', label: (t) => t('appDeploy.rollout.state.promoted') },
  failed: { color: 'red', label: (t) => t('appDeploy.rollout.state.failed') },
  rolled_back: { color: 'volcano', label: (t) => t('appDeploy.rollout.state.rolledBack') },
};

function ExecutorCard({ executor }: { executor: Executor }) {
  const { t } = useTranslation();
  // F-15（DEEP_REVIEW 0ef3bbe）：次要文字/用量色走 antd token，暗色主题自适应。
  const { token } = theme.useToken();
  const load = executor.runningTaskCount ?? 0;
  const maxLoad = executor.maxConcurrentTasks ?? 10;
  const loadPercent = Math.min(100, Math.round((load / maxLoad) * 100));
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0' }}>
      <Badge status={executor.status === 'online' ? 'success' : 'default'} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 500, fontSize: 13}}>{executor.appName}</div>
        <div style={{ fontSize: 11, color: token.colorTextTertiary }}>{executor.address}</div>
      </div>
      <div style={{ width: 80, textAlign: 'right' }}>
        <div style={{ fontSize: 11, color: token.colorTextTertiary }}>{t('appDeploy.executor.taskCount', { load, maxLoad })}</div>
        <Progress
          percent={loadPercent}
          size="small"
          showInfo={false}
          strokeColor={loadPercent > 80 ? token.colorError : loadPercent > 60 ? token.colorWarning : token.colorSuccess}
        />
      </div>
    </div>
  );
}

/**
 * P1-8（UX-AUDIT-2026-09-21）：失败详情可展开 + 一键复制。
 *
 * 旧实现用单行 ellipsis tooltip 渲染 statusMessage；而 executor-node 非 0 退出现在
 * 会把 app.log 尾部（最长 ~2000 字符堆栈）一并上报。单行省略等于把根因藏进
 * tooltip——用户必须 hover 才能看到，且无法复制去排查。这里改为：默认折叠前
 * ~180 字符，可展开多行，旁附复制按钮（clipboard 不可用时静默）。
 */
function DeployStatusMessage({ text }: { text: string }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const COLLAPSED_LEN = 180;
  const long = text.length > COLLAPSED_LEN;
  const shown = long && !expanded ? `${text.slice(0, COLLAPSED_LEN)}...` : text;
  const onCopy = async () => {
    // D-P1-2：copyText 返回是否**真正**复制成功（非安全上下文降级 execCommand），
    // 成功才报成功，失败明确报错——不再静默吞掉 clipboard 拒绝。
    const ok = await copyText(text);
    if (ok) message.success(t('appDeploy.statusMessage.copied'));
    else message.error(t('common.copyFailed'));
  };
  return (
    <div style={{ minWidth: 0 }}>
      <Text
        type="secondary"
        style={{ fontSize: 11, display: 'block', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
      >
        {shown}
      </Text>
      <Space size={2} style={{ marginTop: 2 }}>
        {long && (
          <Button
            type="link"
            size="small"
            style={{ fontSize: 11, padding: 0, height: 'auto' }}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? t('appDeploy.statusMessage.collapse') : t('appDeploy.statusMessage.expand')}
          </Button>
        )}
        <Button
          type="text"
          size="small"
          icon={<CopyOutlined />}
          style={{ fontSize: 11, padding: 0 }}
          onClick={() => void onCopy()}
        >
          {t('appDeploy.statusMessage.copy')}
        </Button>
      </Space>
    </div>
  );
}
export default function AppDeploymentPage({ applicationId }: { applicationId: string }) {
  const { t } = useTranslation();
  // F-15（DEEP_REVIEW 0ef3bbe）：分隔线/浅填充走 antd token，暗色主题自适应。
  const { token } = theme.useToken();
  const statusConfig = STATUS_CONFIG(t);
  const approvalConfig = APPROVAL_CONFIG(t);
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
  // P1-9：全部升级的灰度策略选择（Popconfirm 装不下 Radio，改 Modal）
  const [rolloutModalOpen, setRolloutModalOpen] = useState(false);
  const [rolloutStrategy, setRolloutStrategy] = useState<'full' | 'canary'>('full');
  const [deployForm] = Form.useForm();
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

  // F-34（DEEP_REVIEW 0ef3bbe）：轮询拍只拉**部署列表**——执行器清单（下拉候选
  // 与占用判断）在秒级轮询窗口内几乎不变，原先每 3s 全量 GET /executors 属浪费；
  // 且后台拍不置 loading，避免表格 spinner 每 3s 闪一次。
  const fetchDeployments = useCallback(async () => {
    const seq = ++fetchSeq.current;
    try {
      const deps = await deploymentsApi.list(applicationId, page);
      if (seq !== fetchSeq.current) return; // 已有更新的请求/卸载，丢弃过期响应
      setDeployments(deps.data);
      setTotal(deps.total);
      // UI-16：加载成功后清除上一次的页内错误态
      setLoadError(null);
    } catch (err: unknown) {
      if (seq !== fetchSeq.current) return;
      setLoadError(err);
    }
  }, [applicationId, page]);

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

  // NETOPT-7③（2026-09-20）：deploy/upgrade/upgrade-all 成功后的延时刷新不再直接
  // `setTimeout(fetchAll, …)`——fetchAll 是 useCallback([applicationId, page])，
  // 定时器持有动作时刻的旧闭包：1.5-2s 窗口内翻页，定时器会以旧 page 重发请求，
  // 且调用时自增 fetchSeq 使自己成为最新序号，旧页数据覆盖新页（分页器停在新页）；
  // 卸载后定时器照发（cleanup 自增的 seq 被 fetchAll 调用时再次自增作废）。
  // 改为经 ref 每次渲染同步到最新 fetchAll，timer 登记表在卸载时统一 clear。
  const fetchAllRef = useRef(fetchAll);
  useEffect(() => { fetchAllRef.current = fetchAll; });
  const refreshTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const scheduleDelayedRefresh = useCallback((delayMs: number) => {
    const timer = setTimeout(() => {
      refreshTimersRef.current = refreshTimersRef.current.filter((t) => t !== timer);
      void fetchAllRef.current();
    }, delayMs);
    refreshTimersRef.current.push(timer);
  }, []);
  useEffect(() => () => {
    for (const timer of refreshTimersRef.current) clearTimeout(timer);
    refreshTimersRef.current = [];
  }, []);

  // Auto-poll while any deployment is in progress
  useEffect(() => {
    const inProgress = deployments.some(d => d.status === 'deploying' || d.status === 'upgrading' || d.status === 'pending');
    if (!inProgress) return;
    const timer = setInterval(() => {
      // F-34（DEEP_REVIEW 0ef3bbe）：标签页不可见时跳过本拍请求（对齐
      // ExecutionsPage 15s 兜底轮询的 document.visibilityState 守卫——
      // 定时器保留，回到前台后下一拍自动恢复），避免后台 Tab 空转打接口。
      if (document.visibilityState === 'visible') void fetchDeployments();
    }, 3000);
    return () => clearInterval(timer);
  }, [deployments, fetchDeployments]);

  const handleDeploy = async () => {
    try {
      const values = await deployForm.validateFields();
      setDeploying(true);
      // executorId: undefined => server auto-picks least loaded
      const created = await deploymentsApi.deploy(applicationId, { executorId: values.executorId || undefined, runMode: values.runMode || 'once', startCommand: values.startCommand });
      // DEP-04: 开启审批流的应用，deploy 冻结为待审批行（后端未派发）
      if (created?.approvalStatus === 'pending_approval') {
        message.info(t('appDeploy.msg.deployPendingApproval'));
      } else {
        message.success(t('appDeploy.msg.deployStarted'));
      }
      setDeployModalOpen(false);
      deployForm.resetFields();
      scheduleDelayedRefresh(1500);
    } catch (err: unknown) {
      if (isFormValidationError(err)) return;
      message.error(getErrMsg(err, t('appDeploy.msg.deployFail')));
    } finally {
      setDeploying(false);
    }
  };

  // DEP-04: 审批三动作（后端第二人规则兜底；前端对提交者本人禁用批准/拒绝）
  const handleApprove = async (id: string) => {
    setActingId(id);
    try {
      await deploymentsApi.approve(id);
      message.success(t('appDeploy.msg.approveSuccess'));
      fetchAll();
    } catch (err: unknown) {
      message.error(getErrMsg(err, t('appDeploy.msg.approveFail')));
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
      message.success(t('appDeploy.msg.rejectSuccess'));
      setRejectTarget(null);
      rejectForm.resetFields();
      fetchAll();
    } catch (err: unknown) {
      if (isFormValidationError(err)) return;
      message.error(getErrMsg(err, t('appDeploy.msg.rejectFail')));
    } finally {
      setRejecting(false);
    }
  };

  const handleCancel = async (id: string) => {
    setActingId(id);
    try {
      await deploymentsApi.cancel(id);
      message.success(t('appDeploy.msg.cancelSuccess'));
      fetchAll();
    } catch (err: unknown) {
      message.error(getErrMsg(err, t('appDeploy.msg.cancelFail')));
    } finally {
      setActingId(null);
    }
  };

  const handleStop = async (id: string) => {
    try {
      await deploymentsApi.stop(id);
      message.success(t('appDeploy.msg.stopped'));
      fetchAll();
    } catch (err: unknown) {
      message.error(getErrMsg(err, t('appDeploy.msg.stopFail')));
    }
  };

  // 用户报障：失败的部署记录删不掉。后端 DELETE :id 只接受终态行
  // （failed/stopped），在途/运行中/待审批返回 409——错误文案由后端给出，
  // 此处如实透传（getErrMsg 取响应 message）。
  const handleDelete = async (id: string) => {
    try {
      await deploymentsApi.remove(id);
      message.success(t('appDeploy.msg.deleted'));
      fetchAll();
    } catch (err: unknown) {
      message.error(getErrMsg(err, t('appDeploy.msg.deleteFail')));
    }
  };

  const handleUpgrade = async (id: string) => {
    try {
      await deploymentsApi.upgrade(id);
      message.success(t('appDeploy.msg.upgradeStarted'));
      scheduleDelayedRefresh(2000);
    } catch (err: unknown) {
      message.error(getErrMsg(err, t('appDeploy.msg.upgradeFail')));
    }
  };

  const handleUpgradeAll = async (strategy: 'full' | 'canary') => {
    const runningCount = deployments.filter(d => d.status === 'running').length;
    if (runningCount === 0) {
      message.warning(t('appDeploy.msg.noRunningUpgrade'));
      return;
    }
    setUpgradingAll(true);
    try {
      // P1-9：后端 upgrade-all 早已支持 body.rollout，前端此前从不传——灰度发布无入口。
      const result = await applicationsApi.upgradeAll(
        applicationId,
        strategy === 'canary' ? { strategy: 'canary', percentage: 20 } : undefined,
      );
      message.success(t('appDeploy.msg.upgradeAllDone', { succeeded: result.succeeded, total: result.total }));
      scheduleDelayedRefresh(2000);
      setRolloutModalOpen(false);
    } catch (err: unknown) {
      message.error(getErrMsg(err, t('appDeploy.msg.upgradeAllFail')));
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
    setDeployModalOpen(true);
  };

  const columns = [
    {
      title: t('appDeploy.col.executor'),
      key: 'executor',
      render: (_: unknown, r: AppDeployment) => (
        // UI 打磨：弹性列内 minWidth:0 + display:block，长地址/状态信息单行省略
        <div style={{ minWidth: 0 }}>
          <Text strong style={{ fontSize: 13, display: 'block' }} ellipsis={{ tooltip: r.executorAddress || r.executorId }}>
            {r.executorAddress || r.executorId}
          </Text>
          {r.deployedVersion && <Tag color="blue" style={{ fontSize: 11 }}>v{r.deployedVersion}</Tag>}
          {r.statusMessage && <DeployStatusMessage text={r.statusMessage} />}
        </div>
      ),
    },
    {
      title: t('appDeploy.col.status'),
      dataIndex: 'status',
      width: 120,
      render: (s: string, r: AppDeployment) => {
        // UI 打磨：状态列收敛为单层 Tag（去掉 Badge+Tag 双重编码，宽 100→120 防审批徽标换行挤压）
        const cfg = statusConfig[s] || { color: 'default', label: s };
        return (
          <Space direction="vertical" size={0}>
            {/* D-P2-08（设计审计）：删掉无效 `background: ${cfg.color}15`——antd
                预设色名拼成 'green15' 是非法 CSS，浏览器整段丢弃，底色从未生效；
                让 Tag 自身配色（color=）生效即可。 */}
            <Tag color={cfg.color} style={{ border: 'none', marginInlineEnd: 0 }}>
              {cfg.label}
            </Tag>
            {/* DEP-04: 审批状态徽标（待审批/已批准/已拒绝/已撤销） */}
            {r.approvalStatus && approvalConfig[r.approvalStatus] && (
              <Tag color={approvalConfig[r.approvalStatus].color} style={{ fontSize: 11 }}>
                {approvalConfig[r.approvalStatus].label}
              </Tag>
            )}
            {/* P1-9: 灰度发布状态（后端 RolloutState：pending/probing/promoted/failed/rolled_back）。
                旧实现部署表完全不展示灰度阶段——灰度发布在 UI 上不可见。 */}
            {r.rolloutState && ROLLOUT_CONFIG[r.rolloutState as keyof typeof ROLLOUT_CONFIG] && (
              <Tag
                color={ROLLOUT_CONFIG[r.rolloutState as keyof typeof ROLLOUT_CONFIG].color}
                style={{ fontSize: 11 }}
              >
                {ROLLOUT_CONFIG[r.rolloutState as keyof typeof ROLLOUT_CONFIG].label(t)}
              </Tag>
            )}
          </Space>
        );
      },
    },
    {
      title: t('appDeploy.col.runMode'),
      dataIndex: 'runMode',
      width: 90,
      render: (v: string) => {
        const map: Record<string, { color: string; label: string }> = {
          once: { color: 'default', label: t('appDeploy.runMode.once') },
          daemon: { color: 'blue', label: t('appDeploy.runMode.daemon') },
          scheduled: { color: 'green', label: t('appDeploy.runMode.scheduled') },
        };
        const cfg = map[v] || { color: 'default', label: v || t('appDeploy.runMode.once') };
        return <Tag color={cfg.color}>{cfg.label}</Tag>;
      },
    },
    {
      title: t('appDeploy.col.deployedAt'),
      dataIndex: 'deployedAt',
      width: 150,
      render: (v: string, r: AppDeployment) => {
        const d = v || r.createdAt;
        if (!d) return '-';
        // P2-9：旧实现手搓了一套相对时间（mins<1/<60 两档），与仓库共享
        // formatRelativeTime（含天/月档、统一 i18n 键 time.relative.*）不一致。
        // 改用共享工具，Tooltip 仍保留绝对时间。
        return (
          <Tooltip title={new Date(d).toLocaleString(currentLocale())}>
            <Text type="secondary" style={{ fontSize: 12 }}>{formatRelativeTime(d, t)}</Text>
          </Tooltip>
        );
      },
    },
    {
      title: t('appDeploy.col.actions'),
      width: 200,
      render: (_: unknown, r: AppDeployment) => {
        // DEP-04: 待审批行——出口只有审批三动作（后端对 upgrade/stop 返回 409）
        if (r.approvalStatus === 'pending_approval') {
          const isRequester = me?.id != null && r.approvalMeta?.requestedBy != null && me.id === r.approvalMeta.requestedBy;
          const requesterName = r.approvalMeta?.requestedByName;
          const secondPersonHint = isAdmin
            ? isRequester
              ? t('appDeploy.op.secondPersonSelf')
              : requesterName
                ? t('appDeploy.op.submitter', { name: requesterName })
                : undefined
            : t('appDeploy.op.adminOnlyApprove');
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
                  {t('appDeploy.action.approve')}
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
                  {t('appDeploy.action.reject')}
                </Button>
              </Tooltip>
              {isRequester && (
                <Popconfirm
                  title={t('appDeploy.op.cancelConfirm')}
                  onConfirm={() => handleCancel(r.id)}
                  okText={t('appDeploy.action.cancel')}
                >
                  <Button size="small" icon={<UndoOutlined />} loading={actingId === r.id}>
                    {t('appDeploy.action.withdraw')}
                  </Button>
                </Popconfirm>
              )}
            </Space>
          );
        }
        return (
        <Space size={4}>
          {r.status === 'running' && (
            <Tooltip title={isAdmin ? undefined : t('appDeploy.op.adminOnlyUpgrade')}>
              <Button
                size="small"
                icon={<ReloadOutlined />}
                onClick={() => handleUpgrade(r.id)}
                disabled={!isAdmin}
              >
                {t('appDeploy.action.upgrade')}
              </Button>
            </Tooltip>
          )}
          {(r.status === 'running' || r.status === 'deploying') && (
            <Popconfirm
              title={t('appDeploy.op.stopConfirm')}
              onConfirm={() => handleStop(r.id)}
              okText={t('appDeploy.action.stop')} okButtonProps={{ danger: true }}
              disabled={!isAdmin}
            >
              <Tooltip title={isAdmin ? undefined : t('appDeploy.op.adminOnlyStop')}>
                <Button size="small" danger icon={<StopOutlined />} disabled={!isAdmin}>{t('appDeploy.action.stop')}</Button>
              </Tooltip>
            </Popconfirm>
          )}
          {(r.status === 'stopped' || r.status === 'failed') && (
            <>
              <Tooltip
                title={
                  isAdmin
                    ? t('appDeploy.redeploy.reuseHint')
                    : t('appDeploy.op.adminOnlyDeploy')
                }
              >
                <Button
                  size="small"
                  type="primary"
                  icon={<RocketOutlined />}
                  onClick={() => { deployForm.setFieldValue('executorId', r.executorId); setDeployModalOpen(true); }}
                  disabled={!isAdmin}
                >
                  {t('appDeploy.action.redeploy')}
                </Button>
              </Tooltip>
              {/* 用户报障：终态记录此前无任何删除出口，重试几次就叠几行。
                  仅终态行渲染（在途/运行中的行后端也会 409）。 */}
              <Popconfirm
                title={t('appDeploy.op.deleteConfirm')}
                onConfirm={() => handleDelete(r.id)}
                okText={t('appDeploy.action.delete')}
                okButtonProps={{ danger: true }}
                disabled={!isAdmin}
              >
                <Tooltip title={isAdmin ? t('appDeploy.op.deleteHint') : t('appDeploy.op.adminOnlyDelete')}>
                  <Button size="small" danger icon={<DeleteOutlined />} disabled={!isAdmin}>
                    {t('appDeploy.action.delete')}
                  </Button>
                </Tooltip>
              </Popconfirm>
            </>
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
          <Text strong>{t('appDeploy.title')}</Text>
          {deployments.length > 0 && (
            <Tag color="blue">
              {t('appDeploy.metric.runningTotal', { running: deployments.filter(d => d.status === 'running').length, total: deployments.length })}
            </Tag>
          )}
        </Space>
        <Space>
          <Button icon={<ReloadOutlined />} size="small" onClick={fetchAll}>{t('appDeploy.action.refresh')}</Button>
          {deployments.filter(d => d.status === 'running').length > 0 && (
            <Tooltip title={isAdmin ? undefined : t('appDeploy.op.adminOnlyUpgrade')}>
              {/* P1-9：灰度策略需 Radio 选择，Popconfirm 装不下——改开策略 Modal */}
              <Button
                icon={<UpCircleOutlined />}
                size="small"
                disabled={!isAdmin}
                onClick={() => { setRolloutStrategy('full'); setRolloutModalOpen(true); }}
              >
                {t('appDeploy.action.upgradeAll')}
              </Button>
            </Tooltip>
          )}
          <Tooltip title={isAdmin ? undefined : t('appDeploy.op.adminOnlyDeploy')}>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={openDeployModal}
              disabled={onlineExecutors.length === 0 || !isAdmin}
            >
              {t('appDeploy.action.create')}
            </Button>
          </Tooltip>
        </Space>
      </div>

      {onlineExecutors.length === 0 && (
        <Alert
          type="warning"
          title={t('appDeploy.alert.noExecutorTitle')}
          description={t('appDeploy.alert.noExecutorDesc')}
          action={isAdmin ? <Button size="small" href="/executors/install">{t('appDeploy.action.installExecutor')}</Button> : undefined}
          style={{ marginBottom: 16 }}
        />
      )}

      {/* DEP-04: 审批待办提示（管理员视角；普通用户只读可见请求在等待） */}
      {pendingApprovalCount > 0 ? (
        <Alert
          type="warning"
          showIcon
          title={
            isAdmin
              ? t('appDeploy.alert.pendingApprovalAdmin', { count: pendingApprovalCount })
              : t('appDeploy.alert.pendingApprovalUser')
          }
          style={{ marginBottom: 16 }}
        />
      ) : null}

      {loadError ? (
        <StateError
          error={loadError}
          title={t('appDeploy.loadError')}
          onRetry={() => void fetchAll()}
          style={{ marginBottom: 16 }}
        />
      ) : null}

      {deployments.length === 0 && !loading && !loadError ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={t('appDeploy.empty')}
        >
          <Tooltip title={isAdmin ? undefined : t('appDeploy.op.adminOnlyDeploy')}>
            <Button
              type="primary"
              icon={<RocketOutlined />}
              onClick={openDeployModal}
              disabled={onlineExecutors.length === 0 || !isAdmin}
            >
              {t('appDeploy.action.deployNow')}
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
          scroll={{ x: 720 }}
          pagination={{ current: page, pageSize: 20, total, onChange: (p) => setPage(p), showTotal: (n: number) => t('appDeploy.count', { count: n }) }}
        />
      )}

      {/* 部署弹窗 */}
      <Modal
        title={t('appDeploy.modal.create')}
        open={deployModalOpen}
        onCancel={() => setDeployModalOpen(false)}
        onOk={handleDeploy}
        confirmLoading={deploying}
        okText={t('appDeploy.action.deployNow')}
        okButtonProps={{ icon: <RocketOutlined /> }}
        width={540}
      >
        <Alert
          type="info"
          icon={<ThunderboltOutlined />}
          showIcon
          title={t('appDeploy.modal.smartScheduling')}
          style={{ marginBottom: 16 }}
        />

        <Form form={deployForm} layout="vertical">
          {/* P1-15：runMode 字段 + 模式说明抽到共享组件 DeployModeFields，
              与列表页快速部署复用同一份说明文案。 */}
          <DeployModeFields buttonStyle="solid" />
          <Form.Item
            name="executorId"
            label={t('appDeploy.field.selectExecutor')}
          >
            <Select
              placeholder={t('appDeploy.placeholder.autoExecutor')}
              allowClear
              dropdownRender={(menu) => (
                <>
                  {availableExecutors.length > 0 && (
                    <div style={{ padding: '8px 12px', borderBottom: `1px solid ${token.colorBorderSecondary}` }}>
                      <Text type="secondary" style={{ fontSize: 12 }}>{t('appDeploy.executor.availableHeader', { count: availableExecutors.length })}</Text>
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
          <div style={{ background: token.colorFillQuaternary, borderRadius: 8, padding: 12}}>
            <Text type="secondary" style={{ fontSize: 12}}>{t('appDeploy.executor.overview')}</Text>
            {availableExecutors.slice(0, 4).map(e => (
              <ExecutorCard key={e.id} executor={e} />
            ))}
            {availableExecutors.length > 4 && (
              <Text type="secondary" style={{ fontSize: 12 }}>{t('appDeploy.executor.more', { count: availableExecutors.length - 4 })}</Text>
            )}
          </div>
        )}
      </Modal>

      {/* DEP-04: 拒绝理由 Modal（reason 可选 ≤200，随审批留痕与审计落库） */}
      <Modal
        title={t('appDeploy.reject.title')}
        open={!!rejectTarget}
        onOk={handleReject}
        onCancel={() => setRejectTarget(null)}
        confirmLoading={rejecting}
        okText={t('appDeploy.reject.confirm')}
        okButtonProps={{ danger: true, icon: <CloseOutlined /> }}
        width={540}
      >
        {rejectTarget && (
          <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
            {t('appDeploy.reject.description', { executor: rejectTarget.executorAddress })}
          </Text>
        )}
        <Form form={rejectForm} layout="vertical">
          <Form.Item
            name="reason"
            label={t('appDeploy.reject.reasonLabel')}
            rules={[{ max: 200, message: t('appDeploy.reject.reasonMax') }]}
          >
            <Input.TextArea rows={3} maxLength={200} showCount placeholder={t('appDeploy.reject.reasonPlaceholder')} />
          </Form.Item>
        </Form>
      </Modal>

      {/* P1-9：全部升级策略 Modal（全量 / 灰度 20%） */}
      <Modal
        title={t('appDeploy.rollout.modalTitle')}
        open={rolloutModalOpen}
        onOk={() => void handleUpgradeAll(rolloutStrategy)}
        onCancel={() => setRolloutModalOpen(false)}
        confirmLoading={upgradingAll}
        okText={t('appDeploy.action.confirmUpgrade')}
        okButtonProps={{ icon: <UpCircleOutlined /> }}
        width={520}
      >
        <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
          {t('appDeploy.op.upgradeAllDesc')}
        </Text>
        <Radio.Group
          value={rolloutStrategy}
          onChange={(e) => setRolloutStrategy(e.target.value)}
          style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
        >
          <Radio value="full">
            <Text strong>{t('appDeploy.rollout.full')}</Text>
            <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
              {t('appDeploy.rollout.fullDesc')}
            </Text>
          </Radio>
          <Radio value="canary">
            <Text strong>{t('appDeploy.rollout.canary')}</Text>
            <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
              {t('appDeploy.rollout.canaryDesc')}
            </Text>
          </Radio>
        </Radio.Group>
      </Modal>
    </div>
  );
}

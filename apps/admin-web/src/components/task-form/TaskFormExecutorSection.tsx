/**
 * REFACTOR-TASKFORM-05：「执行器策略与超时重试」分区（原 TaskFormPage 内联区块
 * 原样迁出）。
 *
 * 覆盖：执行器调度模式单选（auto/group/pinned/broadcast，含 UI-06 ③ 互斥禁用
 * 态）/ pinned 的 executorId / group+tags 选择器 / NF-04 亲和与反亲和约束
 * （全模式挂载）/ FEAT-22 v2 部署约束模式 / CORE-04 超时与超时策略、预警阈值 /
 * maxRetry、retryDelay / CORE-02 可重试错误白名单 / 优先级 / NF-02 上游依赖。
 *
 * Form.Item 依赖外层 <Form> 上下文——本组件必须渲染在 TaskFormPage 的 <Form>
 * 内部（与原先内联形态一致），字段路径不变。executorMode 是页面自持 state
 * （编辑态由 deriveExecutorMode 推导、提交链路消费），经 props 受控下传。
 */
import { Alert, Card, Divider, Form, InputNumber, Radio, Select, Space, Tag, theme, Tooltip, Typography } from 'antd';
import { InfoCircleOutlined, ClusterOutlined, RocketOutlined, ApartmentOutlined, PushpinOutlined, LockOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import '../../i18n';
import { TIMEOUT_WARN_RATIO_MAX, TIMEOUT_ACTION_OPTIONS } from '../../pages/timeout-policy';
import { RETRYABLE_ERROR_OPTIONS } from '../../pages/retry-policy';
import { TASK_PRIORITY_OPTIONS } from '../../utils/priority';
import type { TaskFormExecutorOption } from '../../hooks/useTaskFormReferenceData';
import { LAYOUT_TOKENS } from '../../theme/tokens';

const { Text } = Typography;

// Executor dispatch modes exposed to the user
const EXECUTOR_MODE_OPTIONS = (t: (k: string) => string) => [
  {
    value: 'auto',
    label: t('taskForm.executor.auto'),
    desc: t('taskForm.executor.autoDesc'),
    icon: <ClusterOutlined />,
  },
  {
    value: 'group',
    label: t('taskForm.executor.group'),
    desc: t('taskForm.executor.groupDesc'),
    icon: <ApartmentOutlined />,
  },
  {
    value: 'pinned',
    label: t('taskForm.executor.pinned'),
    desc: t('taskForm.executor.pinnedDesc'),
    icon: <PushpinOutlined />,
  },
  {
    value: 'broadcast',
    label: t('taskForm.executor.broadcast'),
    desc: t('taskForm.executor.broadcastDesc'),
    icon: <RocketOutlined />,
  },
];

// CORE-02/CORE-04：外部工具文件只承载 value 契约，展示文案统一按 value 走 i18n
const TIMEOUT_ACTION_LABELS = (t: (k: string) => string): Record<string, string> => ({
  kill: t('taskForm.timeoutAction.kill'),
  kill_retry: t('taskForm.timeoutAction.killRetry'),
  notify_only: t('taskForm.timeoutAction.notifyOnly'),
});

const PRIORITY_LABELS = (t: (k: string) => string): Record<string, string> => ({
  1: t('taskForm.priority.low'),
  2: t('taskForm.priority.normal'),
  3: t('taskForm.priority.high'),
  4: t('taskForm.priority.critical'),
});

export type ExecutorDispatchMode = 'auto' | 'group' | 'pinned' | 'broadcast';

export default function TaskFormExecutorSection({
  executorMode,
  onExecutorModeChange,
  executors,
  groups,
  allTags,
  taskOptions,
  editId,
}: {
  /** 执行器调度模式（页面自持 state，受控下传；提交链路消费同一 state） */
  executorMode: ExecutorDispatchMode;
  onExecutorModeChange: (m: ExecutorDispatchMode) => void;
  /** pinned 候选（useTaskFormReferenceData 加载，含离线标注） */
  executors: TaskFormExecutorOption[];
  groups: string[];
  allTags: string[];
  /** NF-02：上游依赖候选（useTaskFormReferenceData 加载；渲染时按 editId 排除自身） */
  taskOptions: { id: string; name: string }[];
  /** 编辑态任务 id（上游依赖候选需排除自身） */
  editId?: string;
}) {
  const { t } = useTranslation();
  const { token } = theme.useToken();

  // UI-06 ③：互斥禁用态。broadcast 下 pinned 选择器禁用；pinned 下广播项禁用。
  // 数据层互斥由 deriveExecutorMode/buildExecutorPayload 保证（N17/N28），
  // 这里把冲突挡在输入期，不再等提交报错。
  const broadcastDisabledByPin = executorMode === 'pinned';
  const pinDisabledByBroadcast = executorMode === 'broadcast';

  const sectionTitleStyle = { margin: '0 0 4px' };

  return (
    <div id="sec-executor" data-testid="section-executor" role="region" aria-label={t('taskForm.section.executor')} style={{ scrollMarginTop: LAYOUT_TOKENS.anchorScrollOffset }}>
      <Typography.Title level={5} style={sectionTitleStyle}>{t('taskForm.section.executor')}</Typography.Title>
      <Card style={{ marginBottom: 20 }}>
        <Form.Item
          label={
            <Space size={4}>
              <span>{t('taskForm.executor.strategy')}</span>
              {(broadcastDisabledByPin || pinDisabledByBroadcast) && (
                <Tooltip title={t('taskForm.executor.mutexTooltip')}>
                  <LockOutlined style={{ color: token.colorWarning }} data-testid="executor-mutex-lock" />
                </Tooltip>
              )}
            </Space>
          }
          required
          tooltip={{ title: t('taskForm.executor.strategyTooltip'), icon: <InfoCircleOutlined /> }}
        >
          <Radio.Group
            value={executorMode}
            onChange={e => onExecutorModeChange(e.target.value)}
            style={{ width: '100%' }}
          >
            <Space orientation="vertical" style={{ width: '100%' }}>
              {EXECUTOR_MODE_OPTIONS(t).map(o => (
                <Radio
                  key={o.value}
                  value={o.value}
                  disabled={o.value === 'broadcast' && broadcastDisabledByPin}
                  style={{
                    border: `1px solid ${executorMode === o.value ? token.colorPrimary : token.colorBorder}`,
                    borderRadius: 8,
                    padding: '10px 14px',
                    width: '100%',
                    background: executorMode === o.value ? token.colorPrimaryBg : token.colorBgContainer,
                    transition: 'all 0.2s',
                  }}
                >
                  <Space>
                    {o.icon}
                    <span style={{ fontWeight: 500 }}>{o.label}</span>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {o.value === 'broadcast' && broadcastDisabledByPin
                        ? t('taskForm.executor.broadcastBlocked')
                        : o.desc}
                    </Text>
                  </Space>
                </Radio>
              ))}
            </Space>
          </Radio.Group>
        </Form.Item>

        {executorMode === 'pinned' && (
          <Form.Item name="executorId" label={t('taskForm.field.executorId')} required
            rules={[{ required: true, message: t('taskForm.field.executorId.required') }]}
            tooltip={{ title: t('taskForm.field.executorId.tooltip'), icon: <InfoCircleOutlined /> }}>
            <Select
              placeholder={t('taskForm.field.executorId.placeholder')}
              showSearch
              optionFilterProp="label"
              options={executors.map(e => ({
                value: e.id,
                label: `${e.appName}  (${e.address})${e.status === 'online' ? '' : ` ${t('taskForm.executor.offline')}`}`,
              }))}
            />
          </Form.Item>
        )}

        {executorMode === 'group' && (
          <>
            <Form.Item name="executorGroup" label={t('taskForm.field.executorGroup')}
              tooltip={{ title: t('taskForm.field.executorGroup.tooltip'), icon: <InfoCircleOutlined /> }}>
              <Select placeholder={t('taskForm.field.executorGroup.placeholder')} allowClear
                options={groups.map(g => ({ value: g, label: g }))} />
            </Form.Item>
            <Form.Item name="executorTags" label={t('taskForm.field.executorTags')}
              tooltip={{ title: t('taskForm.field.executorTags.tooltip'), icon: <InfoCircleOutlined /> }}>
              <Select
                mode="multiple"
                placeholder={t('taskForm.field.executorTags.placeholder')}
                allowClear
                options={allTags.map(tag => ({ value: tag, label: <Tag>{tag}</Tag> }))}
              />
            </Form.Item>
          </>
        )}

        {/* NF-04: affinity constraints are orthogonal to auto/group/broadcast
            and remain mounted in every mode so edit/save cannot clear a
            value merely because a mode-specific branch is not visible.
            Pinned dispatch bypasses all tag filters, so these controls are
            disabled there while their stored values are retained for a
            later switch back to a filtering mode. */}
        <Form.Item
          name="executorAffinityTags"
          label={t('taskForm.field.affinityTags')}
          tooltip={{
            title: t('taskForm.field.affinityTags.tooltip'),
            icon: <InfoCircleOutlined />,
          }}
        >
          <Select
            mode="multiple"
            allowClear
            disabled={executorMode === 'pinned'}
            placeholder={t('taskForm.field.affinityTags.placeholder')}
            options={allTags.map(tag => ({ value: tag, label: <Tag>{tag}</Tag> }))}
          />
        </Form.Item>
        <Form.Item
          name="executorAntiAffinityTags"
          label={t('taskForm.field.antiAffinityTags')}
          tooltip={{
            title: t('taskForm.field.antiAffinityTags.tooltip'),
            icon: <InfoCircleOutlined />,
          }}
        >
          <Select
            mode="multiple"
            allowClear
            disabled={executorMode === 'pinned'}
            placeholder={t('taskForm.field.antiAffinityTags.placeholder')}
            options={allTags.map(tag => ({ value: tag, label: <Tag>{tag}</Tag> }))}
          />
        </Form.Item>
        {/* FEAT-22 v2：任务级部署约束模式——与亲和约束同款的全模式挂载
            + pinned 禁用（pin 语义就是"只在这一台跑"，部署约束在 pin 下
            不参与；禁用仅表意，值保留，切回后继续生效）。 */}
        <Form.Item
          name="deploymentPolicy"
          label={t('taskForm.field.deploymentPolicy')}
          // 创建态默认「跟随全局」（编辑态由 setFieldsValue 覆盖）。
          initialValue="global"
          tooltip={{
            title: t('taskForm.field.deploymentPolicy.tooltip'),
            icon: <InfoCircleOutlined />,
          }}
        >
          <Select
            allowClear={false}
            disabled={executorMode === 'pinned'}
            options={[
              { value: 'global', label: t('taskForm.field.deploymentPolicy.followGlobal') },
              { value: 'strict', label: t('taskForm.field.deploymentPolicy.strict') },
              { value: 'prefer', label: t('taskForm.field.deploymentPolicy.prefer') },
            ]}
          />
        </Form.Item>
        {executorMode === 'pinned' && (
          <Alert
            type="info"
            showIcon
            title={t('taskForm.alert.pinnedAffinity')}
            data-testid="pinned-affinity-disabled"
            style={{ marginBottom: 16 }}
          />
        )}

        {pinDisabledByBroadcast && (
          <Alert
            type="warning"
            showIcon
            data-testid="broadcast-pin-cleared"
            title={t('taskForm.alert.broadcastPin')}
            style={{ marginBottom: 16 }}
          />
        )}

        <Divider style={{ margin: '16px 0' }} />

        <Form.Item name="timeout" label={<>{t('taskForm.field.timeout')} <Text type="secondary" style={{ fontSize: 12 }}>{t('taskForm.field.timeout.unit')}</Text></>} tooltip={{ title: t('taskForm.field.timeout.tooltip'), icon: <InfoCircleOutlined /> }}>
          {/*
            P0（UX-AUDIT-2026-09-21 §P0-6）：下限必须是 0（= 不限时）。

            后端 CreateTaskDto 是 `@Min(0)` 且描述明写 "0 = no limit"，
            timeout-policy.util 也以 `timeoutSec <= 0` 判"不限时"。此前
            前端写 min={10}，而编辑态回填是 `task.timeoutSeconds ?? task.timeout`
            ——存量 timeout=0（不限时）的任务打开编辑页显示 0，antd 在失焦时
            按 min 钳到 **10**：一个原本不限时的长任务被无声改成 10 秒超时，
            保存后执行必被杀。反向地，用户也无法表达"不限时"。
          */}
          <InputNumber min={0} max={86400} style={{ width: 160 }} placeholder="300" />
        </Form.Item>

        {/* CORE-04: 超时策略分级——超时后动作三选一。kill 为既有树杀
            语义；kill_retry 超时终态后按任务重试预算 re-enqueue 一次；
            notify_only 仅保证超时告警（执行器自身硬超时仍在，进程仍会
            被执行器杀掉——并非"永不超时"）。 */}
        <Form.Item
          name="timeoutAction"
          label={<>{t('taskForm.field.timeoutAction')} <Text type="secondary" style={{ fontSize: 12 }}>{t('taskForm.field.timeoutAction.hint')}</Text></>}
          // 缺省 kill 由 Form.initialValues 统一提供，与同组 timeout/maxRetry/
          // retryDelay/priority 一致。此处再声明 initialValue 会与之冲突
          // （antd 告警：Form already set 'initialValues' with path
          // 'timeoutAction'），两值相同故语义不变，仅为消除冗余声明。
          tooltip={{ title: t('taskForm.field.timeoutAction.tooltip'), icon: <InfoCircleOutlined /> }}
        >
          <Radio.Group optionType="button" buttonStyle="solid">
            {TIMEOUT_ACTION_OPTIONS.map((o) => (
              <Radio.Button key={o.value} value={o.value}>{TIMEOUT_ACTION_LABELS(t)[o.value]}</Radio.Button>
            ))}
          </Radio.Group>
        </Form.Item>

        {/* CORE-04: 超时预警——运行时长达到 超时时间×阈值% 时发一次
            WARNING 通知（每个执行至多一次）。留空 = 不启用。 */}
        <Form.Item
          name="timeoutWarnRatio"
          label={<>{t('taskForm.field.timeoutWarnRatio')} <Text type="secondary" style={{ fontSize: 12 }}>{t('taskForm.field.timeoutWarnRatio.hint')}</Text></>}
          tooltip={{ title: t('taskForm.field.timeoutWarnRatio.tooltip'), icon: <InfoCircleOutlined /> }}
        >
          <InputNumber min={0} max={TIMEOUT_WARN_RATIO_MAX} style={{ width: 160 }} placeholder={t('taskForm.field.timeoutWarnRatio.placeholder')} />
        </Form.Item>

        <Form.Item name="maxRetry" label={<>{t('taskForm.field.maxRetry')} <Text type="secondary" style={{ fontSize: 12 }}>{t('taskForm.field.maxRetry.hint')}</Text></>}>
          <InputNumber min={0} max={10} style={{ width: 120 }} />
        </Form.Item>

        <Form.Item name="retryDelay" label={<>{t('taskForm.field.retryDelay')} <Text type="secondary" style={{ fontSize: 12 }}>{t('taskForm.field.retryDelay.hint')}</Text></>}>
          <InputNumber min={0} style={{ width: 160 }} />
        </Form.Item>

        {/* CORE-02: 可重试错误类型白名单——留空 = 全部可重试（既有语义）；
            勾选后仅白名单内的失败（错误消息子串或失败分类，大小写不敏感）
            会重试。timeout 类失败另有防双派发守卫，永不自动重试。 */}
        <Form.Item
          name="retryableErrors"
          label={<>{t('taskForm.field.retryableErrors')} <Text type="secondary" style={{ fontSize: 12 }}>{t('taskForm.field.retryableErrors.hint')}</Text></>}
          tooltip={{ title: t('taskForm.field.retryableErrors.tooltip'), icon: <InfoCircleOutlined /> }}
        >
          <Select
            mode="multiple"
            allowClear
            placeholder={t('taskForm.field.retryableErrors.placeholder')}
            // P3-2：选项只携带 i18n 键，标签在此统一 t() 解析——
            // 不再有硬编码中文兜底，英文界面不可能再漏出中文选项。
            options={RETRYABLE_ERROR_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
          />
        </Form.Item>

        <Form.Item name="priority" label={<>{t('taskForm.field.priority')} <Text type="secondary" style={{ fontSize: 12 }}>{t('taskForm.field.priority.hint')}</Text></>}>
          <Select
            style={{ width: 200 }}
            options={TASK_PRIORITY_OPTIONS.map((o) => ({ value: o.value, label: PRIORITY_LABELS(t)[String(o.value)] }))}
          />
        </Form.Item>

        {/* NF-02: 上游依赖（编排）。后端 tasks.dependencies jsonb =
            Record<taskId, taskName>；上游全部最近执行 SUCCESS 时由
            admin-api 自动扇出触发本任务（triggerDependentTasks，
            环检测/深度上限在 create/update 侧强制）。 */}
        <Form.Item
          name="upstreamDependencies"
          label={t('taskForm.field.upstreamDependencies')}
          tooltip={{
            title:
              t('taskForm.field.upstreamDependencies.tooltip'),
            icon: <InfoCircleOutlined />,
          }}
        >
          <Select
            mode="multiple"
            showSearch
            allowClear
            placeholder={t('taskForm.field.upstreamDependencies.placeholder')}
            options={taskOptions
              .filter((t) => t.id !== editId)
              .map((t) => ({ value: t.id, label: t.name }))}
            filterOption={(input, opt) =>
              (opt?.label as string)?.toLowerCase().includes(input.toLowerCase())
            }
          />
        </Form.Item>
      </Card>
    </div>
  );
}

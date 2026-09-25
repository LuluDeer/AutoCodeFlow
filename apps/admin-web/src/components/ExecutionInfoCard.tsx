/**
 * REFACTOR-EXEC-01：执行信息卡（原 ExecutionDetailPage 内联 Card 原样迁出）。
 *
 * 职责：执行状态读面——任务名/触发/执行器/时间线/退出码/traceId/失败分类/
 * 解释器留痕快照。纯展示组件：除 data 外零外部状态，解释器上下文与失败
 * 分类映射在组件内自行派生（提取自 data.result / data.failureReason）。
 */
import { Card, Descriptions, Tag, Typography, Button, Space, Alert } from 'antd';
import { CopyOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { message } from '../utils/toast';
import { copyText } from '../utils/clipboard';
import { formatDateTime, formatDuration } from '../utils/timeFormat';
// python_task_multiversion（FR-12 / AC-12a）：执行记录里 `result.interpreter` 的
// 防御式读取层。**必须**走它而不是直接 `data.result.interpreter`——result 是 jsonb
// 自由列且该留痕只有新执行器才写，历史记录可能是 null/{}/脏值，直接取属性会把
// 排障入口页打成白屏（详见 interpreter-context.ts 头注释）。
import {
  extractInterpreterContext,
  interpreterNeedsOfflinePrefill,
  INTERPRETER_REASON_T_KEY,
} from '../pages/interpreter-context';
import type { TaskExecution } from '../api/tasks';

const { Text } = Typography;

const TRIGGER_LABEL = (t: (k: string) => string): Record<string, string> => ({
  manual: t('execDetail.trigger.manual'), cron: t('execDetail.trigger.cron'), fixed_rate: t('execDetail.trigger.fixedRate'),
  dependency: t('execDetail.trigger.dependency'), misfire: t('execDetail.trigger.misfire'),
});

const FAILURE_REASON_MAP = (t: (k: string) => string): Record<string, { color: string; label: string; hint: string }> => ({
  package_fetch_failed: { color: 'gold', label: t('execDetail.failure.packageFetchFailed'), hint: t('execDetail.failure.packageFetchFailedHint') },
  // BUG-10 细化分类
  git_fetch_failed: { color: 'gold', label: t('execDetail.failure.gitFetchFailed'), hint: t('execDetail.failure.gitFetchFailedHint') },
  dependency_install_failed: { color: 'gold', label: t('execDetail.failure.dependencyInstallFailed'), hint: t('execDetail.failure.dependencyInstallFailedHint') },
  runtime_missing: { color: 'gold', label: t('execDetail.failure.runtimeMissing'), hint: t('execDetail.failure.runtimeMissingHint') },
  // EXP-01（本轮体验审查）：沙箱已配置但不可用（bwrap 缺失 / Windows 上配了
  // TASK_SANDBOX=bwrap / 用户命名空间被禁）。执行器 fail-closed 拒绝无沙箱运行，
  // 属「环境/配置」族故同为 gold；处置动作是装 bubblewrap 或取消 TASK_SANDBOX，
  // 与 runtime_missing（装运行时本体）不同，故独立分类而非并入。
  sandbox_unavailable: { color: 'gold', label: t('execDetail.failure.sandboxUnavailable'), hint: t('execDetail.failure.sandboxUnavailableHint') },
  // python_task_multiversion：解释器不可用。与 runtime_missing 同属
  // 「环境/配置」族，故同为 gold；刻意不在默认重试集内——重跑不会让 3.7 变得
  // 可下载，必须由运维修环境（前端只是如实展示分类，重试白名单由任务配置决定）。
  interpreter_unavailable: { color: 'gold', label: t('execDetail.failure.interpreterUnavailable'), hint: t('execDetail.failure.interpreterUnavailableHint') },
  script_error: { color: 'red', label: t('execDetail.failure.scriptError'), hint: t('execDetail.failure.scriptErrorHint') },
  timeout: { color: 'orange', label: t('execDetail.failure.timeout'), hint: t('execDetail.failure.timeoutHint') },
  executor_offline: { color: 'volcano', label: t('execDetail.failure.executorOffline'), hint: t('execDetail.failure.executorOfflineHint') },
  executor_restart: { color: 'volcano', label: t('execDetail.failure.executorRestart'), hint: t('execDetail.failure.executorRestartHint') },
  stale_recovered: { color: 'volcano', label: t('execDetail.failure.staleRecovered'), hint: t('execDetail.failure.staleRecoveredHint') },
  killed: { color: 'default', label: t('execDetail.failure.killed'), hint: t('execDetail.failure.killedHint') },
  // P0-4（UX-AUDIT-2026-09-21）：引用的应用已删除 → 环境/配置类（gold），处置动作
  // 是"重新指定代码来源"，与 package_fetch_failed（查网络/地址）不同故独立分类。
  application_missing: { color: 'gold', label: t('execDetail.failure.applicationMissing'), hint: t('execDetail.failure.applicationMissingHint') },
  // P0-8（UX-AUDIT-2026-09-21）：从未派发 → volcano（与 executor_offline 同族，
  // 都是"任务没能到达执行器"），但提示明确区分：它没有任何日志可看。
  never_dispatched: { color: 'volcano', label: t('execDetail.failure.neverDispatched'), hint: t('execDetail.failure.neverDispatchedHint') },
  unknown: { color: 'default', label: t('execDetail.failure.unknown'), hint: t('execDetail.failure.unknownHint') },
});

/** UI-09：执行信息 Descriptions 响应式列数（xs 单列 / sm 2 列 / md 3 列）。
 *  跨列项（失败分类/错误信息）放在下方**独立的单列 Descriptions** 中渲染：
 *  既保证整行宽度，又避免窄屏 xs 单列时跨列项超出列数。
 *
 *  历史注记：当年这么写是因为 `Descriptions.Item.span` 只接受 number，传响应式
 *  对象无效。**antd 6.6.5 起该限制已解除**——span 现支持
 *  `number | 'filled' | { [breakpoint]: number }`（见 antd/es/descriptions/Item.d.ts），
 *  故"整行"现可直接写 `span="filled"`（TaskDetailPage 的三个跨列项已按此迁移）。
 *  本组件维持"独立单列块"的形态**不是**因为 API 限制，而是布局选择：主网格
 *  是 9+ 项的密集三列，错误信息块语义上属于独立段落，拆开可避免主网格出现
 *  参差不齐的空行。改动此处前请一并更新 ui09-mobile-pages.test.tsx 的断言。 */
export const UI09_DESCRIPTIONS_COLUMN = { xs: 1, sm: 2, md: 3 } as const;

export default function ExecutionInfoCard({ taskId, data }: {
  taskId: string;
  data: TaskExecution | undefined;
}) {
  const { t } = useTranslation();
  const triggerLabels = TRIGGER_LABEL(t);
  const failureReasonMap = FAILURE_REASON_MAP(t);

  const failureReason = data?.failureReason
    ? failureReasonMap[data.failureReason] || {
        color: 'default',
        label: data.failureReason,
        hint: t('execDetail.failure.unrecognizedHint'),
      }
    : undefined;

  // python_task_multiversion：解释器留痕归一（防御式，见 interpreter-context.ts）。
  // 任何异常形状都退化为 null，本卡只是少展示一块信息，绝不因此抛错。
  const interpreterCtx = useMemo(
    () => extractInterpreterContext(data?.result),
    [data?.result],
  );
  // 「3.7 需离线预填」指引的可见性（判据见 interpreterNeedsOfflinePrefill）
  const interpreterOfflinePrefill = interpreterNeedsOfflinePrefill(interpreterCtx);

  return (
    <Card title={t('execDetail.card.info')} style={{ marginBottom: 16 }}>
      <Descriptions column={UI09_DESCRIPTIONS_COLUMN} size="small">
        <Descriptions.Item label={t('execDetail.field.taskName')}>
          {/* F-33（DEEP_REVIEW 0ef3bbe）：原 <a onClick> 无 href，改 <Link>（键盘可达 + 真实 href） */}
          <Link to={`/tasks/${taskId}`}>{data?.taskName}</Link>
        </Descriptions.Item>
        <Descriptions.Item label={t('execDetail.field.trigger')}>
          {triggerLabels[data?.triggerType || ''] ?? data?.triggerType ?? '-'}
        </Descriptions.Item>
        <Descriptions.Item label={t('execDetail.field.executor')}>
          {data?.executorAddress ? (
            <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{data.executorAddress}</span>
          ) : '-'}
        </Descriptions.Item>
        <Descriptions.Item label={t('execDetail.field.taskVersion')}>{data?.taskVersion || '-'}</Descriptions.Item>
        <Descriptions.Item label={t('execDetail.field.retryCount')}>{data?.retryCount ?? 0}</Descriptions.Item>
        <Descriptions.Item label={t('execDetail.field.startTime')}>
          {data?.startTime ? formatDateTime(data.startTime) : '-'}
        </Descriptions.Item>
        <Descriptions.Item label={t('execDetail.field.endTime')}>
          {data?.endTime ? formatDateTime(data.endTime) : '-'}
        </Descriptions.Item>
        <Descriptions.Item label={t('execDetail.field.duration')}>
          {data?.duration != null ? formatDuration(data.duration, t) : '-'}
        </Descriptions.Item>
        <Descriptions.Item label={t('execDetail.field.exitCode')}>
          {data?.exitCode != null ? (
            <Text type={data.exitCode !== 0 ? 'danger' : undefined} code>
              {data.exitCode}
            </Text>
          ) : '-'}
        </Descriptions.Item>
        {/* OBS-01: traceId 有值时展示追踪标识 + 复制按钮。Jaeger/Tempo 跳转
            链接留配置项（collector 未部署，不硬编码 URL）——后续接入时在此
            追加 <a href={`${TRACE_BASE_URL}/search?service=autoflow&tags=${encodeURIComponent(`traceId=${data.traceId}`)}`}>。
            复制出的 trace-id 可直接粘贴到 Jaeger/Tempo 检索框。 */}
        {data?.traceId && (
          <Descriptions.Item label={t('execDetail.field.traceId')}>
            <Space size={4}>
              <Text code style={{ fontSize: 12 }} data-testid="execution-trace-id">
                {data.traceId}
              </Text>
              <Button
                type="text"
                size="small"
                icon={<CopyOutlined />}
                aria-label={t('execDetail.copyTraceId')}
                data-testid="copy-trace-id"
                onClick={async () => {
                  // D-P1-2（设计审计 2026-09-22）：非安全上下文下 navigator.clipboard
                  // 为 undefined，旧写法同步 TypeError 且 .then 链根本不建立——成功失败
                  // 均无提示。改走 copyText（降级 execCommand），按返回值如实提示。
                  const ok = await copyText(data.traceId!);
                  if (ok) message.success(t('execDetail.traceIdCopied'));
                  else message.error(t('execDetail.copyFail'));
                }}
              />
            </Space>
          </Descriptions.Item>
        )}
      </Descriptions>
      {/* UI 打磨：失败分类/错误信息独占整行——单独用一个单列 Descriptions 渲染，
          长错误信息不再被挤在 1/3 列宽里。（注：antd 6.6.5 起 span 已支持
          'filled'/断点对象，此处拆分为布局选择而非 API 限制，详见上方常量注释。） */}
      {(failureReason || data?.errorMessage) && (
        <Descriptions column={1} size="small" style={{ marginTop: 4 }}>
          {failureReason && (
            <Descriptions.Item label={t('execDetail.field.failureCategory')}>
              <Space wrap>
                <Tag color={failureReason.color}>{failureReason.label}</Tag>
                <Text type="secondary">{failureReason.hint}</Text>
              </Space>
            </Descriptions.Item>
          )}
          {data?.errorMessage && (
            <Descriptions.Item label={t('execDetail.field.errorMessage')}>
              <Text type="danger" style={{ wordBreak: 'break-word' }}>{data.errorMessage}</Text>
            </Descriptions.Item>
          )}
        </Descriptions>
      )}
      {/* python_task_multiversion（AC-12a）：结构化解释器留痕。
          后端 DTO 可能尚未回传 `result`——整块以 interpreterCtx !== null 为唯一
          门控，历史执行/非解释器类失败下此块**根本不渲染**（不留空壳），页面
          其余部分完全不受影响。 */}
      {interpreterCtx && (
        // 「3.7 需离线预填」专项指引：requested < 3.8 或 reason=not_downloadable
        // 时置顶（判据独立于 reason 文案，见 interpreterNeedsOfflinePrefill）。
        <div data-testid="execution-interpreter" style={{ marginTop: 8 }}>
          {interpreterOfflinePrefill && (
            <Alert
              type="warning"
              showIcon
              data-testid="interpreter-offline-prefill"
              title={t('execDetail.interpreter.offlinePrefillTitle')}
              description={
                <span>
                  {t('execDetail.interpreter.offlinePrefillDesc')}{' '}
                  {/* E-2：补「前往执行器配置」跳转，运维无需自行翻文档找入口 */}
                  <Link to="/executors">{t('execDetail.interpreter.offlinePrefillGoExecutors')}</Link>
                </span>
              }
              style={{ marginBottom: 12 }}
            />
          )}
          <Descriptions
            column={UI09_DESCRIPTIONS_COLUMN}
            size="small"
            title={t('execDetail.interpreter.title')}
          >
            <Descriptions.Item label={t('execDetail.interpreter.requested')}>
              {/* 逐项独立兜底：某个字段没留痕只影响它自己那一格，
                  不让一个 null 把整块快照变成空白。 */}
              {interpreterCtx.requested ?? (
                <Text type="secondary">{t('execDetail.interpreter.missing')}</Text>
              )}
            </Descriptions.Item>
            <Descriptions.Item label={t('execDetail.interpreter.resolved')}>
              {interpreterCtx.resolved ? (
                <Text code style={{ fontSize: 12, wordBreak: 'break-all' }}>
                  {interpreterCtx.resolved}
                </Text>
              ) : (
                <Text type="secondary">{t('execDetail.interpreter.missing')}</Text>
              )}
            </Descriptions.Item>
            <Descriptions.Item label={t('execDetail.interpreter.reason')}>
              {/* 未收录的 reason 原样展示 token——宁可露出 `some_new_reason`
                  也不要显示"未知原因"把可诊断信息抹掉（与 failureReason 同策）。 */}
              {interpreterCtx.reason ? (
                <Space size={4}>
                  <Tag color="gold">{interpreterCtx.reason}</Tag>
                  <Text type="secondary">
                    {INTERPRETER_REASON_T_KEY[interpreterCtx.reason]
                      ? t(INTERPRETER_REASON_T_KEY[interpreterCtx.reason])
                      : interpreterCtx.reason}
                  </Text>
                </Space>
              ) : (
                <Text type="secondary">{t('execDetail.interpreter.missing')}</Text>
              )}
            </Descriptions.Item>
            <Descriptions.Item label={t('execDetail.interpreter.pool')} span={UI09_DESCRIPTIONS_COLUMN.md}>
              {interpreterCtx.pool ? (
                <Space orientation="vertical" size={2} style={{ width: '100%' }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {t('execDetail.interpreter.poolDir')}：
                    {interpreterCtx.pool.installDir || '-'}
                  </Text>
                  {interpreterCtx.pool.versions.length > 0 ? (
                    <Space orientation="vertical" size={2} style={{ width: '100%' }}>
                      {/* poolVersions：缓存版本清单的小标题（此前是零渲染点的死键） */}
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {t('execDetail.interpreter.poolVersions')}：
                      </Text>
                      <Space size={4} wrap>
                        {interpreterCtx.pool.versions.map((v) => (
                          <Tag key={v} style={{ fontFamily: 'var(--font-mono)' }}>{v}</Tag>
                        ))}
                      </Space>
                    </Space>
                  ) : (
                    <Text type="secondary">{t('execDetail.interpreter.poolEmpty')}</Text>
                  )}
                </Space>
              ) : (
                <Text type="secondary">{t('execDetail.interpreter.missing')}</Text>
              )}
            </Descriptions.Item>
            {/* detail 常是部署指引原文（可能较长），独占整行并保留换行 */}
            {interpreterCtx.detail && (
              <Descriptions.Item
                label={t('execDetail.interpreter.detail')}
                span={UI09_DESCRIPTIONS_COLUMN.md}
              >
                <Text style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {interpreterCtx.detail}
                </Text>
              </Descriptions.Item>
            )}
          </Descriptions>
        </div>
      )}
      {/* python_task_multiversion（P2-1）：failureReason 已归类为
          interpreter_unavailable、却没有结构化快照（旧执行器 / 尚未实现
          result 通道的执行器版本）时，给一条明确说明而不是整块消失——否则
          运维在解释器类失败下既看不到快照卡也看不到任何解释。正常路径
          （非解释器类失败 / 有快照）不渲染，保持"不留空壳"的原决策。 */}
      {!interpreterCtx && data?.failureReason === 'interpreter_unavailable' && (
        <Alert
          type="warning"
          showIcon
          data-testid="execution-interpreter-no-snapshot"
          style={{ marginTop: 8 }}
          title={t('execDetail.interpreter.noSnapshot')}
        />
      )}
    </Card>
  );
}

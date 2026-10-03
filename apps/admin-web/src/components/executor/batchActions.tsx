/**
 * B-13：批量操作 confirm 流程的公共实现——从 BatchActionBar 抽出。
 *
 * 消费方两处，语义必须逐字节一致：
 *  - 批量操作条（BatchActionBar）：勾选多台后经操作条按钮触发；
 *  - 卡片视图快捷按钮（ExecutorCardGrid 的 onReloadConfig/onRotateToken）：
 *    此前仅 setSelectedRowKeys([ex.id]) 弹批量条（要多跳一步再点一次），
 *    现直接以单台集合走同一 confirm 流程，保持「单按钮直达」语义。
 *
 * 抽取原则：confirm 弹窗内容、pushable 过滤（ARCH-33 pull 判据）、runBatch
 * 执行、逐台/汇总反馈全部收敛在此；调用方仅注入 loading 开关（onStart/
 * onSettle）、rotate 结果弹窗回调（onTokenSummary）与完成回调（onDone）。
 */
import { Alert, Tag, Typography } from 'antd';
import { Modal as confirmModal } from '../../utils/modal';
import { message } from '../../utils/toast';
import type { Executor } from '../../api/executors';
import { executorsApi } from '../../api/executors';
import { getErrMsg, showApiError } from '../../utils/error';
// ARCH-33（ADR-016）：pull 控制面可用性判据（UI-18 判据的修订版）
import { isControlPlaneUnavailable } from '../../utils/control-plane';
import '../../i18n';

const { Text } = Typography;

type TFunc = (k: string, opts?: Record<string, unknown>) => string;

export interface BatchOutcome {
  executor: Executor;
  ok: boolean;
  /** rotate 成功时的明文 token（Modal 一次性展示） */
  token?: string;
  error?: string;
}

export interface BatchSummary {
  total: number;
  succeeded: number;
  failed: number;
  outcomes: BatchOutcome[];
}

/** 并行执行单台操作并收集逐台结果（allSettled：单台失败不中断其余） */
export async function runBatch(
  executors: Executor[],
  action: (ex: Executor) => Promise<{ token?: string }>,
  fallbackMsg?: string,
): Promise<BatchSummary> {
  const settled = await Promise.allSettled(
    executors.map(async (ex) => {
      const res = await action(ex);
      return { executor: ex, ok: true, token: res?.token } as BatchOutcome;
    }),
  );
  const outcomes: BatchOutcome[] = settled.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : {
          executor: executors[i],
          ok: false,
          error: getErrMsg(r.reason, fallbackMsg),
        },
  );
  return {
    total: executors.length,
    succeeded: outcomes.filter((o) => o.ok).length,
    failed: outcomes.filter((o) => !o.ok).length,
    outcomes,
  };
}

/** 汇总反馈：全成功/全失败/部分失败（部分失败逐台 error，成功台不重复打扰） */
export function reportBatchSummary(summary: BatchSummary, okText: string, t: TFunc): void {
  if (summary.failed === 0) {
    message.success(t('batchAction.finish.success', { action: okText, ok: summary.succeeded, total: summary.total }));
  } else if (summary.succeeded === 0) {
    message.error(t('batchAction.finish.fail', { action: okText, error: summary.outcomes.find((o) => !o.ok)?.error ?? t('batchAction.allFail') }));
  } else {
    message.warning(t('batchAction.finish.partial', { action: okText, ok: summary.succeeded, fail: summary.failed }));
    summary.outcomes.filter((o) => !o.ok).forEach((o) => {
      message.error(t('batchAction.partFailItem', { name: o.executor.appName, error: o.error }));
    });
  }
}

export interface BatchConfirmParams {
  /** 本轮操作的目标集合（reload 调用方传在线台；rotate 传全部选中台） */
  executors: Executor[];
  t: TFunc;
  /** 确认后、请求前（批量条置 loading） */
  onStart?: () => void;
  /** 本轮结束（成功/失败都调）——批量条解除 loading */
  onSettle?: () => void;
  /** rotate 有成功台时回调（summary 含明文 token，结果弹窗一次性展示） */
  onTokenSummary?: (summary: BatchSummary) => void;
  /** 汇总反馈完成后（批量条 onDone 清空选择） */
  onDone?: () => void;
}

/**
 * 批量/单台配置热更新 confirm——空配置体推送（执行器按服务端默认配置
 * reload），在线台才可执行；pull 且协议 <2 的执行器剔除（静默忽略 commands
 * 字段比失败更危险，见 ARCH-33 注释）。
 */
export function confirmBatchReloadConfig(params: BatchConfirmParams): void {
  const { executors, t, onStart, onSettle, onDone } = params;
  if (executors.length === 0) {
    message.warning(t('batchAction.noneOnline'));
    return;
  }
  // UI-18 → ARCH-33（ADR-016）修订：判据是「pull **且** 协议 < 2」——
  // v2 之前的 pull 执行器会静默忽略 commands 字段，必须剔除。
  const pushable = executors.filter((ex) => !isControlPlaneUnavailable(ex));
  const skippedPull = executors.length - pushable.length;
  if (pushable.length === 0) {
    message.warning(t('batchAction.reloadPullOnly'));
    return;
  }
  confirmModal.confirm({
    title: t('batchAction.reloadConfirmTitle', { count: pushable.length }),
    content: skippedPull > 0
      ? `${t('batchAction.reloadConfirmContent')} ${t('batchAction.reloadSkipPull', { count: skippedPull })}`
      : t('batchAction.reloadConfirmContent'),
    okText: t('batchAction.confirmPush'),
    cancelText: t('batchAction.cancel'),
    onOk: async () => {
      onStart?.();
      try {
        const summary = await runBatch(pushable, async (ex) => {
          await executorsApi.reloadConfig(ex.id, {});
          return {};
        }, t('batchAction.operateFail'));
        reportBatchSummary(summary, t('batchAction.batchReload'), t);
        onDone?.();
      } catch (err) {
        showApiError(err, t('batchAction.reloadFail'));
      } finally {
        onSettle?.();
      }
    },
  });
}

/**
 * 批量/单台 Token 轮换 confirm——高危二次确认，列出受影响执行器并明示
 * 「执行器将短暂重新注册」；确认后并行执行，成功台的明文 token 经
 * onTokenSummary 一次性展示（结果弹窗由调用方持有）。
 */
export function confirmBatchRotateToken(params: BatchConfirmParams): void {
  const { executors, t, onStart, onSettle, onTokenSummary, onDone } = params;
  if (executors.length === 0) return;
  confirmModal.confirm({
    title: t('batchAction.rotateConfirmTitle', { count: executors.length }),
    width: 560,
    content: (
      <div>
        <Alert
          type="warning"
          showIcon
          title={t('batchAction.highrisk.title')}
          description={t('batchAction.highrisk.desc')}
          style={{ marginBottom: 12 }}
        />
        <div style={{ maxHeight: 200, overflowY: 'auto' }}>
          {executors.map((ex) => (
            <div key={ex.id} style={{ padding: '2px 0' }}>
              <Text strong>{ex.appName}</Text>{' '}
              <Text type="secondary" style={{ fontSize: 12 }}>{ex.address}</Text>{' '}
              {ex.status !== 'online' && <Tag color="orange">{t('batchAction.offline')}</Tag>}
            </div>
          ))}
        </div>
      </div>
    ),
    okText: t('batchAction.confirmRotate'),
    okButtonProps: { danger: true },
    cancelText: t('batchAction.cancel'),
    onOk: async () => {
      onStart?.();
      try {
        const summary = await runBatch(executors, (ex) => executorsApi.rotateToken(ex.id), t('batchAction.operateFail'));
        if (summary.succeeded > 0) {
          // 新 token 一次性展示（关闭后不再显示——与单台轮换同语义）
          onTokenSummary?.(summary);
        }
        reportBatchSummary(summary, t('batchAction.batchRotate'), t);
        onDone?.();
      } catch (err) {
        showApiError(err, t('batchAction.rotateFail'));
      } finally {
        onSettle?.();
      }
    },
  });
}

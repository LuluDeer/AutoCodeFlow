/**
 * UI-07 ③：批量操作条（ADMIN 门控对齐 W2 既有前端门控模式）。
 *
 * 两个 ADMIN-only 操作，均复用既有单台端点（POST /executors/:id/reload-config、
 * /executors/:id/rotate-token），Promise.allSettled 并行 + 逐台结果反馈：
 * - 批量配置热更新：空配置体推送（执行器按服务端默认配置 reload——单台
 *   配置热更新表单的空表单等价语义），在线台才可执行；
 * - 批量 Token 轮换：高危——二次确认 Modal 列出受影响执行器并明示
 *   「执行器将短暂重新注册」；确认后并行执行，逐台新 token 收集展示一次。
 *
 * 门控语义：isAdmin=false 时本组件整体不渲染（由父级控制），组件内部仍
 * 保留 isAdmin 入参防御（测试断言门控用）。
 */
import { useState } from 'react';
import { Alert, Button, Modal, Space, Typography, Tag, message } from 'antd';
import { ControlOutlined, KeyOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import type { Executor } from '../../api/executors';
import { executorsApi } from '../../api/executors';
import { getErrMsg } from '../../utils/error';
import '../../i18n';

const { Text } = Typography;

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

interface BatchActionBarProps {
  selected: Executor[];
  isAdmin: boolean;
  onDone: () => void;
}

export default function BatchActionBar({ selected, isAdmin, onDone }: BatchActionBarProps) {
  const { t } = useTranslation();
  const [batchLoading, setBatchLoading] = useState(false);
  const [tokenResult, setTokenResult] = useState<BatchSummary | null>(null);

  // 保留结果弹窗：轮换完成后 onDone 会清空选择（selected 变空会触发本组件
  // 早退卸载），tokenResult 一次性展示不能跟着消失——故仅在「无结果待展示」
  // 时早退。
  if (tokenResult === null && (!isAdmin || selected.length === 0)) return null;

  const online = selected.filter((ex) => ex.status === 'online');

  const finish = (summary: BatchSummary, okText: string) => {
    if (summary.failed === 0) {
      message.success(t('batchAction.finish.success', { action: okText, ok: summary.succeeded, total: summary.total }));
    } else if (summary.succeeded === 0) {
      message.error(t('batchAction.finish.fail', { action: okText, error: summary.outcomes.find((o) => !o.ok)?.error ?? t('batchAction.allFail') }));
    } else {
      message.warning(t('batchAction.finish.partial', { action: okText, ok: summary.succeeded, fail: summary.failed }));
      // 部分失败时逐台 error 反馈（成功台不重复打扰）
      summary.outcomes.filter((o) => !o.ok).forEach((o) => {
        message.error(t('batchAction.partFailItem', { name: o.executor.appName, error: o.error }));
      });
    }
    setBatchLoading(false);
    onDone();
  };

  const handleBatchReloadConfig = () => {
    if (batchLoading || online.length === 0) {
      message.warning(t('batchAction.noneOnline'));
      return;
    }
    Modal.confirm({
      title: t('batchAction.reloadConfirmTitle', { count: online.length }),
      content: t('batchAction.reloadConfirmContent'),
      okText: t('batchAction.confirmPush'),
      cancelText: t('batchAction.cancel'),
      onOk: async () => {
        setBatchLoading(true);
        try {
          const summary = await runBatch(online, async (ex) => {
            await executorsApi.reloadConfig(ex.id, {});
            return {};
          }, t('batchAction.operateFail'));
          finish(summary, t('batchAction.batchReload'));
        } catch (err) {
          message.error(getErrMsg(err, t('batchAction.reloadFail')));
          setBatchLoading(false);
        }
      },
    });
  };

  const handleBatchRotateToken = () => {
    if (batchLoading) return;
    Modal.confirm({
      title: t('batchAction.rotateConfirmTitle', { count: selected.length }),
      width: 560,
      content: (
        <div>
          <Alert
            type="warning"
            showIcon
            message={t('batchAction.highrisk.title')}
            description={t('batchAction.highrisk.desc')}
            style={{ marginBottom: 12 }}
          />
          <div style={{ maxHeight: 200, overflowY: 'auto' }}>
            {selected.map((ex) => (
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
        setBatchLoading(true);
        try {
          const summary = await runBatch(selected, (ex) => executorsApi.rotateToken(ex.id), t('batchAction.operateFail'));
          if (summary.succeeded > 0) {
            // 新 token 一次性展示（关闭后不再显示——与单台轮换同语义）
            setTokenResult(summary);
          }
          finish(summary, t('batchAction.batchRotate'));
        } catch (err) {
          message.error(getErrMsg(err, t('batchAction.rotateFail')));
          setBatchLoading(false);
        }
      },
    });
  };

  return (
    <>
      <Space
        data-testid="executor-batch-bar"
        size={8}
        wrap
        style={{ marginBottom: 12, padding: '6px 12px', background: '#fafafa', borderRadius: 6 }}
      >
        <Text type="secondary" style={{ fontSize: 12 }}>
          {t('batchAction.selected', { count: selected.length })}
        </Text>
        <Button
          size="small"
          icon={<ControlOutlined />}
          loading={batchLoading}
          disabled={batchLoading || online.length === 0}
          onClick={handleBatchReloadConfig}
        >
          {t('batchAction.batchReload')}
        </Button>
        <Button
          size="small"
          danger
          icon={<KeyOutlined />}
          loading={batchLoading}
          disabled={batchLoading}
          onClick={handleBatchRotateToken}
        >
          {t('batchAction.batchRotate')}
        </Button>
        {online.length < selected.length && (
          <Text type="warning" style={{ fontSize: 12 }}>
            {t('batchAction.onlineHint', { count: online.length })}
          </Text>
        )}
      </Space>

      <Modal
        title={t('batchAction.rotateResultTitle')}
        open={tokenResult !== null}
        width={640}
        footer={<Button type="primary" onClick={() => setTokenResult(null)}>{t('batchAction.savedClose')}</Button>}
        onCancel={() => setTokenResult(null)}
      >
        {tokenResult && (
          <div style={{ maxHeight: 360, overflowY: 'auto' }}>
            {tokenResult.outcomes.map((o) => (
              <div key={o.executor.id} style={{ padding: '6px 0', borderBottom: '1px solid #f0f0f0' }}>
                <Space>
                  <Text strong>{o.executor.appName}</Text>
                  {o.ok ? (
                    o.token
                      ? <Text code copyable={{ text: o.token }} style={{ fontSize: 12 }}>{o.token.slice(0, 8)}…</Text>
                      : <Text type="secondary">{t('batchAction.succeeded')}</Text>
                  ) : (
                    <Tag color="red">{t('batchAction.failedItem', { error: o.error })}</Tag>
                  )}
                </Space>
              </div>
            ))}
          </div>
        )}
      </Modal>
    </>
  );
}

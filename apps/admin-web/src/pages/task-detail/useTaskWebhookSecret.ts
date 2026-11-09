/**
 * FEAT-21：任务 webhook 入站触发的**管理子域**（原 `TaskDetailPage` 内联实现，
 * R6「TaskDetailPage 四子域 hook」切法 (a) 的第一刀，纯搬移 / 零行为变更）。
 *
 * 这是四个子域里最独立的一个：只依赖 `id`（路由参数）与 `t`（错误文案），
 * 与页面其它 state 之间**没有任何读写交叉**——页面拿到返回值后只做解构，
 * JSX 与控制流原样不动。
 *
 * 承载：
 *   · `webhookStatus` / `webhookStatusError`：三态读面（已启用 / 未启用 /
 *     **未知**）。读取失败必须与「确实未启用」区分开，见下方 E4 注释。
 *   · `issuedSecret`：enable/rotate 响应里**一次性**出现的明文密钥，关闭弹窗
 *     即丢弃（后端读面永不回传）。
 *   · `webhookBusy`：三个写操作的互斥串行标记（防重复提交）。
 *
 * 身份稳定性：`loadWebhookStatus` 仍是 `useCallback([id])`——页面里的
 * 「状态读取 effect」与「读取失败重试按钮」都依赖它，身份不稳定会导致
 * 无限重拉。
 */
import { useCallback, useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import { tasksApi } from '../../api/tasks';
import type { TaskWebhookSecretIssued, TaskWebhookStatus } from '../../api/tasks';
import { showApiError } from '../../utils/error';
import '../../i18n';

/** webhook 写操作的互斥标记（null = 空闲；任一在途即禁用全部三个按钮）。 */
export type WebhookBusy = null | 'enable' | 'rotate' | 'disable';

export interface TaskWebhookSecret {
  webhookStatus: TaskWebhookStatus | null;
  webhookStatusError: unknown;
  issuedSecret: TaskWebhookSecretIssued | null;
  setIssuedSecret: Dispatch<SetStateAction<TaskWebhookSecretIssued | null>>;
  webhookBusy: WebhookBusy;
  loadWebhookStatus: () => void;
  handleWebhookEnable: () => Promise<void>;
  handleWebhookRotate: () => Promise<void>;
  handleWebhookDisable: () => Promise<void>;
}

export function useTaskWebhookSecret(id: string | undefined): TaskWebhookSecret {
  const { t } = useTranslation();

  // FEAT-21: 任务 webhook 管理。secret 只在 enable/rotate 响应中一次性出现，
  // 关闭弹窗即丢弃——后端读面永不回传。
  const [webhookStatus, setWebhookStatus] = useState<TaskWebhookStatus | null>(null);
  // E4（审计轮 #15）：读取失败必须与「确实未启用」区分开。旧实现 catch 里
  // `setWebhookStatus(null)`，于是**已启用**的任务在 GET 失败时显示
  // 「未启用 + 启用按钮」；而后端对已启用任务再次 enable 会**轮换密钥**
  // （task.controller.ts:980「对已启用的任务再次启用会轮换密钥」），误点一次
  // 就让外部集成的签名全部 401，而 UI 全程没有任何提示。
  const [webhookStatusError, setWebhookStatusError] = useState<unknown>(null);
  const [issuedSecret, setIssuedSecret] = useState<TaskWebhookSecretIssued | null>(null);

  // 防重复提交（排查清单 #2）：webhook 三个写操作此前无任何 in-flight 标记，
  // 双击「启用/轮换」会连发两次请求——rotate 尤其有害：每次调用都吊销旧密钥并
  // 签发新密钥，第一发的明文弹窗会被第二发覆盖，用户保存的密钥其实已失效。
  // 互斥串行（任一在途即禁用全部三个按钮），与 killingId/togglingId 同款纪律。
  const [webhookBusy, setWebhookBusy] = useState<WebhookBusy>(null);

  const loadWebhookStatus = useCallback(() => {
    if (!id) return;
    tasksApi.webhookStatus(id)
      .then((s) => {
        setWebhookStatus(s);
        setWebhookStatusError(null);
      })
      .catch((err: unknown) => {
        setWebhookStatus(null);
        setWebhookStatusError(err ?? new Error('webhook status unavailable'));
      });
  }, [id]);

  useEffect(() => {
    loadWebhookStatus();
  }, [loadWebhookStatus]);

  const handleWebhookEnable = async () => {
    if (!id || webhookBusy) return;
    setWebhookBusy('enable');
    try {
      setIssuedSecret(await tasksApi.webhookEnable(id));
      loadWebhookStatus();
    } catch (err) {
      showApiError(err, t('taskDetail.webhook.title'));
    } finally {
      setWebhookBusy(null);
    }
  };

  const handleWebhookRotate = async () => {
    if (!id || webhookBusy) return;
    setWebhookBusy('rotate');
    try {
      setIssuedSecret(await tasksApi.webhookRotate(id));
      loadWebhookStatus();
    } catch (err) {
      showApiError(err, t('taskDetail.webhook.title'));
    } finally {
      setWebhookBusy(null);
    }
  };

  const handleWebhookDisable = async () => {
    if (!id || webhookBusy) return;
    setWebhookBusy('disable');
    try {
      await tasksApi.webhookDisable(id);
      setWebhookStatus((prev) => (prev ? { ...prev, enabled: false } : prev));
    } catch (err) {
      showApiError(err, t('taskDetail.webhook.title'));
    } finally {
      setWebhookBusy(null);
    }
  };

  return {
    webhookStatus,
    webhookStatusError,
    issuedSecret,
    setIssuedSecret,
    webhookBusy,
    loadWebhookStatus,
    handleWebhookEnable,
    handleWebhookRotate,
    handleWebhookDisable,
  };
}

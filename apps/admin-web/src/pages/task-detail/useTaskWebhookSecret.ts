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
 * 无限重拉。它返回 Promise<void>：写操作 await 它来把 busy 保持到刷新落定。
 * 读取带单调序号 + 任务身份双守卫：写响应落定后自增序号，更早的 GET
 * （含页面初次加载那次）晚到也无权提交；路由 id 变化同理。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
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
  loadWebhookStatus: () => Promise<void>;
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
  // busyRef 补上同一 tick 内的二次点击：setState 尚未生效时 ref 已经挡住。
  const [webhookBusy, setWebhookBusy] = useState<WebhookBusy>(null);
  const busyRef = useRef<WebhookBusy>(null);

  // 单调序号 + 任务身份双守卫：
  //  · 每次 GET 领一个 seq；写操作成功后 seq 自增，更早的 GET（含初次加载）
  //    即使晚到也不得覆盖写响应里的 enabled=true。
  //  · routeRef 在渲染期同步路由 id；旧任务响应不得落到新任务上。
  //  · statusOwnerRef 记录当前 state 归属的 id；路由切换瞬间按「未知」渲染，
  //    不把上一任务的 status/error 借给新任务。
  const routeRef = useRef({ id, seq: 0 });
  const statusOwnerRef = useRef<string | undefined>(undefined);
  routeRef.current.id = id;
  const visibleStatus = statusOwnerRef.current === id ? webhookStatus : null;
  const visibleError = statusOwnerRef.current === id ? webhookStatusError : null;

  const applyStatus = useCallback((
    taskId: string,
    status: TaskWebhookStatus | null,
    error?: unknown,
  ) => {
    statusOwnerRef.current = taskId;
    setWebhookStatus(status);
    setWebhookStatusError(error ?? null);
  }, []);

  const loadWebhookStatus = useCallback(async (): Promise<void> => {
    const taskId = id;
    if (!taskId) return;
    const seq = ++routeRef.current.seq;
    try {
      const s = await tasksApi.webhookStatus(taskId);
      if (seq !== routeRef.current.seq || taskId !== routeRef.current.id) return;
      applyStatus(taskId, s);
    } catch (err: unknown) {
      if (seq !== routeRef.current.seq || taskId !== routeRef.current.id) return;
      applyStatus(taskId, null, err ?? new Error('webhook status unavailable'));
    }
  }, [applyStatus, id]);

  useEffect(() => {
    loadWebhookStatus();
  }, [loadWebhookStatus]);

  // 写响应是权威事实源：先自增 seq 作废更早的 GET，再立即落 enabled=true。
  // 刷新 GET 发起后由调用方 await，busy 一直保持到它 settled。
  const commitWriteStatus = useCallback((taskId: string, status: TaskWebhookStatus) => {
    routeRef.current.seq += 1;
    applyStatus(taskId, status);
  }, [applyStatus]);

  const runSecretWrite = useCallback(async (
    kind: 'enable' | 'rotate',
    write: (taskId: string) => Promise<TaskWebhookSecretIssued>,
  ) => {
    const taskId = id;
    if (!taskId || busyRef.current) return;
    busyRef.current = kind;
    setWebhookBusy(kind);
    try {
      const issued = await write(taskId);
      if (taskId !== routeRef.current.id) return;
      commitWriteStatus(taskId, { enabled: true, url: issued.url });
      setIssuedSecret(issued);
      await loadWebhookStatus();
    } catch (err) {
      showApiError(err, t('taskDetail.webhook.title'));
    } finally {
      busyRef.current = null;
      setWebhookBusy(null);
    }
  }, [commitWriteStatus, id, loadWebhookStatus, t]);

  const handleWebhookEnable = useCallback(
    () => runSecretWrite('enable', tasksApi.webhookEnable),
    [runSecretWrite],
  );
  const handleWebhookRotate = useCallback(
    () => runSecretWrite('rotate', tasksApi.webhookRotate),
    [runSecretWrite],
  );

  const handleWebhookDisable = async () => {
    const taskId = id;
    if (!taskId || busyRef.current) return;
    busyRef.current = 'disable';
    setWebhookBusy('disable');
    try {
      await tasksApi.webhookDisable(taskId);
      if (taskId !== routeRef.current.id) return;
      // 停用同样作废在途 GET，否则旧的 enabled=true 会把按钮放回来。
      commitWriteStatus(taskId, { enabled: false, url: visibleStatus?.url ?? '' });
    } catch (err) {
      showApiError(err, t('taskDetail.webhook.title'));
    } finally {
      busyRef.current = null;
      setWebhookBusy(null);
    }
  };

  return {
    webhookStatus: visibleStatus,
    webhookStatusError: visibleError,
    issuedSecret,
    setIssuedSecret,
    webhookBusy,
    loadWebhookStatus,
    handleWebhookEnable,
    handleWebhookRotate,
    handleWebhookDisable,
  };
}

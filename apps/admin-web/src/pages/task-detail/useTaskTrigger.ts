/**
 * 「手动触发」子域（原 `TaskDetailPage` 内联实现，R6「TaskDetailPage 四子域
 * hook」切法 (a) 的第三刀，纯搬移 / 零行为变更）。
 *
 * 承载：`triggerModalOpen`（弹窗开关）、`triggerParams`（**运行时**参数，与任务的
 * 默认参数是两份，见下）、`triggering`（在途），以及两个 handler
 * （`handleTrigger` = 开弹窗并预填，`handleTriggerConfirm` = 提交触发）。
 * 页面拿到返回值后只做解构，JSX 与控制流原样不动。
 *
 * ## `refreshExecs` 为什么是**参数**而不是 hook 内部自己拿（本刀的核心判断）
 *
 * 触发成功后要延迟刷新执行列表，而「刷新」这件事**不是本子域独有**：
 *
 * | 调用点 | 所属域 | 用的名字 |
 * |---|---|---|
 * | `handleTriggerConfirm` | **本子域**（触发） | `refreshExecs` |
 * | `handleRollbackConfirm` | 版本回滚子域 | `refreshTask` |
 * | `handlePause` / `handleResume` | 页面（生命周期） | `refreshTask` |
 * | `handleKill` | 页面（执行历史） | `refreshExecs` |
 * | 加载失败「重试」按钮 / 执行历史「刷新」按钮 | 页面（JSX） | 各一 |
 *
 * 页面里那两个名字的实现**逐字相同**（都是 `() => void invalidateTaskData(queryClient)`，
 * 只差变量名），即「invalidate 哪几组 queryKey」这条策略由 `invalidateTaskData`
 * 唯一持有，页面只是它的调用点。⇒ 若把刷新塞进本 hook，只有两种后果，都不接受：
 *   ① hook 反向 import 页面（或页面把 queryClient 传进来让 hook 自己拼 key）——
 *      那是**反向依赖**，页面从"编排者"降级成"被 hook 调用的一层"，是伪拆分；
 *   ② 把 invalidate 策略抄一份进 hook —— 同一策略两处真相，与 `invalidateTaskData`
 *      的「一处 invalidate 全站一致」设计直接冲突（见 `api/queries.ts` 注释）。
 *
 * 故按方法学「**Facade 持共享、协作者拿引用**」：`refreshExecs` 仍由页面持有
 * （它同时服务于本子域 / 生命周期 / 执行历史三处），**作为参数注入**本 hook。
 * 注入的是**引用**而不是"回调句柄约定"——页面每次渲染都重建这个函数，本 hook
 * 每次渲染拿到的都是最新那份，与搬移前 `handleTriggerConfirm` 闭包捕获的
 * 是同一个对象（搬移前它也是每次渲染重建的）。**没有加 useCallback**：原实现
 * 就没有，加了反而会改变 `setTimeout` 里捕获的函数身份。
 *
 * ## `defaultParams` 也是注入的（而不是 hook 自己 `useTaskDetail(id)`）
 *
 * 预填源是**页面已经拿到的那份 task**（`useTaskDetail` 的返回值）。让本 hook 再
 * 调一次 `useTaskDetail(id)` 会命中同一 queryKey、不产生额外请求，但会让「这一页
 * 的任务数据」出现两个读取点 —— 棘轮式的隐性成本：将来给 query 换 option
 * （staleTime/重试策略）时，两处必须同时记得改。⇒ 传值 `task?.params`，本 hook
 * 只负责「原样浅拷贝后塞进弹窗」。
 *
 * ## A-11R：预填**原样回填**，不做 `String(v)`
 *
 * 强制字符串化会在 UI 这一跳丢掉类型（服务端存布尔 `true`、弹窗里变成 `"true"`、
 * 提交后又落库成字符串）。`ParamsEditor` 按值推断类型，配合原样传递即可完整往返。
 *
 * ## 时序（三条互不可换，逐字照搬）
 *
 *   ① `handleTrigger`：**先**填参数、**再**开弹窗（同一拍内两次 setState，React 18
 *      自动批处理，用户看到的是"带着默认参数的弹窗"）；
 *   ② `handleTriggerConfirm`：成功才关弹窗 + `setTimeout(refreshExecs, 1500)`；
 *      失败**保持弹窗打开**（用户改参数可重试，关掉等于丢输入）；
 *   ③ `finally` 清在途标记 —— 与 ② 的成败无关。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { tasksApi } from '../../api/tasks';
import { showApiError } from '../../utils/error';
import { message } from '../../utils/toast';
import '../../i18n';

/**
 * O-4：触发执行后延迟多久刷新执行列表。
 *
 * 触发接口返回只代表「已入队」，执行记录由调度器异步落库——立即 invalidate
 * 大概率拿到「还没有新记录」的旧列表。此处给一个缓冲期再 invalidate，使新执行
 * 有机会出现在列表里。抽常量并注释依据，避免魔法数字散落（AppDeploymentPage
 * 同处亦用相近量级）。后续若后端触发接口改为同步返回 executionId，可直接
 * invalidate 并按 id 聚焦，无需再等待。
 *
 * 常量随子域一起搬进来（原 `TaskDetailPage.tsx` 顶层，唯一消费点就是本 hook）。
 */
const TRIGGER_REFRESH_DELAY_MS = 1500;

export interface TaskTrigger {
  triggerModalOpen: boolean;
  setTriggerModalOpen: (open: boolean) => void;
  triggerParams: Record<string, unknown>;
  setTriggerParams: (params: Record<string, unknown>) => void;
  triggering: boolean;
  /** 打开触发弹窗并按任务默认参数预填（页面「立即触发」/「手动触发」两个按钮共用）。 */
  handleTrigger: () => void;
  /** 提交触发；`Ok` 按钮与弹窗确认都走它。 */
  handleTriggerConfirm: () => Promise<void>;
}

export function useTaskTrigger(
  id: string | undefined,
  /** 预填源：页面持有的 `task?.params`（未加载完成时为 undefined）。 */
  defaultParams: Record<string, unknown> | undefined,
  /** 页面持有的共享刷新（见头注「Facade 持共享、协作者拿引用」）。 */
  refreshExecs: () => void,
): TaskTrigger {
  const { t } = useTranslation();
  const [triggerModalOpen, setTriggerModalOpen] = useState(false);
  const [triggerParams, setTriggerParams] = useState<Record<string, unknown>>({});
  const [triggering, setTriggering] = useState(false);

  const handleTrigger = () => {
    // 预填默认参数，让用户可以按需覆盖（原样回填，不 String(v)）。
    setTriggerParams({ ...(defaultParams ?? {}) });
    setTriggerModalOpen(true);
  };

  const handleTriggerConfirm = async () => {
    setTriggering(true);
    try {
      // 只传非空参数
      const params = Object.fromEntries(
        Object.entries(triggerParams).filter(([k]) => k.trim())
      );
      await tasksApi.trigger(id!, Object.keys(params).length > 0 ? params : undefined);
      message.success(t('taskDetail.triggerSuccess'));
      setTriggerModalOpen(false);
      setTimeout(refreshExecs, TRIGGER_REFRESH_DELAY_MS);
    } catch (err: unknown) {
      showApiError(err, t('taskDetail.triggerFail'));
    } finally {
      setTriggering(false);
    }
  };

  return {
    triggerModalOpen,
    setTriggerModalOpen,
    triggerParams,
    setTriggerParams,
    triggering,
    handleTrigger,
    handleTriggerConfirm,
  };
}

/**
 * E-1（F-5 收口）：任务定义导出的**交互子域**（「导出定义」按钮的 state + handler）。
 *
 * ## 为什么外提而不是写在 TaskDetailPage 里
 *
 * `TaskDetailPage.tsx` 在体量棘轮上已到顶（`scripts/source-size-baseline.json`：
 * nonCommentLines 1039 / 最长函数体 1012，只许降不许升 ⇒ 加行即红）。而「导出」
 * 是一个**零页面 state 共享**的子域（不读 task 之外任何东西、不 refresh 任何
 * query），正是 R6 切法 (a) 的标准形状——与 `useTaskWebhookSecret` /
 * `useTaskTrigger` 同款。页面侧只留「一次解构 + 一个按钮」。
 *
 * ## 连点保护为什么必须用 ref 而不是 state
 *
 * `exporting` 这个 state **要等下一次渲染才可见**：双击的两次 click 可能落在
 * **同一 tick**（甚至在首帧重渲染完成前），第二击读到的仍是旧闭包里的
 * `exporting === false` ⇒ 两个请求同时飞出去。`inFlightRef` 是同步写入的闸门，
 * 第二次调用立刻短路。`exporting` 只负责**界面**（按钮 loading/禁用态），
 * 两道防线各管一件事，不是冗余：
 *   · ref 闸门管「同一 tick 的第二击」（唯一能真正拦住请求的那道）；
 *   · loading/disabled 管「用户看到正在导出、别再点」（antd 的 handleClick
 *     在 innerLoading 时也会 preventDefault，是第三道）。
 *
 * ## 失败口径
 *
 * 走既有 `showApiError`：全局拦截器已对 403/404/429/5xx 弹过 toast 并打了
 * `__toastedByClient` 标，本层再调是**幂等**的（已打标直接 return）——不会双弹。
 * 文案用 `taskDetail.exportFailed`（本地异常/无响应时才露出的兜底）。
 */
import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { tasksApi } from '../../api/tasks';
import { showApiError } from '../../utils/error';
import '../../i18n';

export interface TaskDefinitionExport {
  /** 导出在途：按钮 loading + 禁用（纯界面态；请求闸门见 `inFlightRef`）。 */
  exporting: boolean;
  /** 点「导出定义」：调 api → 触发浏览器保存；失败走 showApiError，finally 复位。 */
  exportTask: () => Promise<void>;
}

/**
 * @param id       路由参数（`useParams().id`），缺失时（深链坏 id）直接短路。
 * @param taskName 任务名——只在响应缺失 `Content-Disposition` 时用于回落文件名。
 */
export function useTaskDefinitionExport(
  id: string | undefined,
  taskName: string | undefined,
): TaskDefinitionExport {
  const { t } = useTranslation();
  const [exporting, setExporting] = useState(false);
  // 同步闸门：见文件头注「连点保护为什么必须用 ref」。
  const inFlightRef = useRef(false);

  const exportTask = useCallback(async () => {
    if (!id || inFlightRef.current) return;
    inFlightRef.current = true;
    setExporting(true);
    try {
      await tasksApi.exportDefinition(id, taskName);
    } catch (err) {
      showApiError(err, t('taskDetail.exportFailed'));
    } finally {
      inFlightRef.current = false;
      setExporting(false);
    }
  }, [id, taskName, t]);

  return { exporting, exportTask };
}

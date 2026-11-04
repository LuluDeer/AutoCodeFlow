/**
 * R7 刀 4（提交编排 · H3 = 段 H + 段 I）：`submitTaskForm` 里「调 API + 成功副作用
 * + 成功后导航」与「错误映射 + `finally`」两段从 `TaskFormPage.tsx` 原样迁出为独立
 * hook（纯搬移 / 零行为变更）。行号两套都要记（本仓纪律：凡「某函数 N 行」都要注明
 * 是哪一版读数）：
 *   · **盘点表口径**（`r7-taskform-plan.md` §3，针对 1,360 行的原始页面）：段 H = L813-867（31
 *     非注释行，密度 29.0）、段 I = L868-904（22 非注释行，密度 68.2）；
 *   · **搬移前那次读数**（三刀之后页面 1,193 行）：段 H = L675-736（`setSaving(true)` 起的
 *     `try` 体两分支）、段 I = L737-773（`catch` 与 `finally`）。
 * 两套区间描述的是同一段代码，只是页面被前面的刀缩短过。
 *
 * ## 为什么 H/I 必须同批
 *
 * 段 I 的 `catch` 读的是段 H 里 `try` 的**同一个异常源**（`tasksApi.update/create`
 * 的 reject），`finally` 里的 `setSaving(false)` 与段 H 起点的 `setSaving(true)` 是
 * 一对**配对的生命周期**。把 H 搬走而 I 留下（或反之），`saving` 的置位/复位会分属
 * 两个 owner——`setSaving(true)` 在 hook、`setSaving(false)` 在页面 ⇒ 任何一方
 * 提前 `return`（409 分支的 `return` 正是这种路径）都会让「提交中」态永久卡住，
 * 按钮 loading 不再复原。⇒ 两段只能落在同一个模块，且 `try/catch/finally` 的三段
 * 骨架**逐字保留**（本文件里它仍是同一个 `try` 语句，没有任何重构）。
 *
 * ## 三条有生产缺陷修复史的语义（搬移时必须逐条核对，已核对）
 *
 * 1. **`2f821cc1`（P1，F-1）：保存成功后被自家守卫拦下。**
 *    机制是**顺序**而非判断：`clearFormDirty()` 必须**先于** `nav(...)` 同步执行
 *    （前者内部先翻 `dirtyRef.current = false` 再 `setDirty(false)`，导航判定读
 *    ref ⇒ 同一 tick 内立即读到 false）。段 H 两个分支里 `clearFormDirty()` 与
 *    `nav(...)` 的**先后次序、相对 `message.success` 的位置**在本文件与搬移前
 *    逐字一致（编辑分支：success → cronNote → clearFormDirty → nav；创建分支：
 *    success → cronNote → setSavedRuntime → setCreatedTaskId → clearFormDirty →
 *    nav → scroll）。`clearFormDirty` 的**实现**（ref 先翻、`glueDirty` 刻意不清）
 *    仍归页面所有，本 hook 只在同一位置调用它——不改它的语义。
 * 2. **`7d66a9b0`（P3 清单）：两处魔法/裸 ID。**
 *    ①创建成功后滚 Glue 用 `scrollToSectionWhenReady(glueAnchorId)`（rAF 两连 +
 *    有界存在性轮询），**不是** `setTimeout(50)`；②`catch` 里把依赖类校验错误
 *    文案中的裸 taskId 经 `humanizeDependencyTaskIds(..., depNameSnapshotRef.current)`
 *    替换为任务名（映射不到保持原文）。两处调用形态与搬移前逐字一致；锚点 id 由
 *    页面按 `glueAnchorId` 传入（hook 不知道 DOM 锚点语义，与 `GATE_SECTION_ANCHOR`
 *    同一分层原则）。
 * 3. **DRAFT-01：成功即清草稿 / 失败不清。**
 *    两个分支都是 `discardDraft() → setDraftValues(null) → setDraftNoticeDismissed(true)`
 *    三连，且都在 `nav(...)` **之前**（先清后跳，跳转途中不会再落盘）；`catch` 里
 *    **一条草稿语句都没有**——提交失败不动草稿（`task-form-draft` 的「提交失败不清
 *    草稿：可再次成功提交」用例钉住这条）。`draftValues === null` 同时让 `useDraft`
 *    的 `enabled` 立刻为假，防抖窗口内的残留写入不会再发生。
 *
 * ## 409 乐观锁分支（逐字保留）
 *
 * `task-form-optimistic-lock`（4 例）钉住的是「编辑态 409 ⇒ 弹专门文案、**不跳转**」：
 * 状态码判定沿用 `client.ts` 的 `__status` 打标约定（拦截器 reject 的是
 * `response.data`，`response.status` 已剥掉），并保留对「直传 axios error」的兜底
 * 取 `response.status`；命中条件是 `isEdit && conflictStatus === 409`，行为是
 * `message.error(t('taskForm.submit.conflict'), 6)` 后 `return`（＝留在表单页，
 * 用户刷新即拿到最新值重试）。**`??` 的短路顺序、`6` 秒停留时长、`return` 而非
 * `throw` 全部照搬**，一个字符未改。
 *
 * ## 依赖面参数化（16 个页面量 ⇒ 一个显式入参对象，零闭包捕获）
 *
 * 盘点（`artifacts/rounds/r7-taskform-plan.md` §3 段 H）列的 16 个页面量全部落在
 * `UseTaskFormSubmitOptions` 上，按三个语义组排列，**页面 state 一个都不从闭包里借**：
 *
 * | 组 | 量 | 为什么必须由页面给 |
 * |---|---|---|
 * | 提交目标 | `isEdit` / `editId` / `loadedUpdatedAt` | 路由与乐观锁戳；`loadedUpdatedAt` 是**渲染期 state**，传值即快照，正是 A4 想要的 |
 * | 成功副作用 | `queryClient` / `nav` / `discardDraft` / `setDraftValues` / `setDraftNoticeDismissed` / `setSavedRuntime` / `setCreatedTaskId` / `clearFormDirty` / `glueAnchorId` | 全是页面/子域的所有权：缓存失效器、路由器、草稿三件套、Glue 回填、脏守卫、DOM 锚点 |
 * | 失败与生命周期 | `depNameSnapshotRef` / `setSaving` | ref 按**对象**传（`.current` 在失败那一刻读，改传值会拿到渲染快照）；`saving` 是页面的渲染量 |
 *
 * 其中 `t` / `message` 两项不是页面 state 而是**模块单例**，故由本 hook 自行取用而非入参：
 * `t`（`useTranslation()`，与兄弟 hook `useTaskFormPayload` 同策）、`message`
 * （`utils/toast` 的主题化出口）。做成入参只会是恒等转发参数（同一模块实例，不可能
 * 传进别的值）。⇒ **14 项入参 + 2 项模块单例 = 盘点表里的 16 项，一项不缺**。
 * 另有 1 个**兄弟 hook 产物** `buildSubmissionPayload`（`useTaskFormPayload` 产出，
 * 页面转手传入）——它不是页面量，单独列在入参表末尾以便与本表区分。
 *
 * ## 刻意**不**搬的部分（留在页面）
 *
 * - 段 A-D 前置闸门（已 `useTaskFormValidation`）、段 E cron 原地规范化 + 段 G payload
 *   组装（已 `useTaskFormPayload`）：本 hook 接收它们的**产物**（`values` 活 store 引用
 *   与 `payload` 构建器），不自己取表单 store。
 * - 段 F（G-2 离线舰队二次确认）：`Modal.confirm` 是 UI 交互，留在页面；因此
 *   `setSaving(true)` 的时点仍是「二次确认通过之后」，与搬移前一致。
 * - `handleSubmit` 的同步 ref 互斥锁（UIUX-F-43）：它守的是 `validateFields` 的 await
 *   窗口，属于入口层，留在页面。
 */
import type { RefObject } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { NavigateFunction } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { tasksApi } from '../../api/tasks';
import { invalidateTaskData } from '../../api/queries';
import { message } from '../../utils/toast';
import { getErrMsg } from '../../utils/error';
import { humanizeDependencyTaskIds } from '../task-dependencies';
import { scrollToSectionWhenReady } from '../../utils/scroll-when-ready';
import type { components } from '../../types/generated/api-types';
import type { SubmissionPayload } from './useTaskFormPayload';
import type { TaskFormGateValues } from './useTaskFormValidation';
import '../../i18n';

/** 页面量（14 项）：提交目标 3 + 成功副作用 9 + 失败与生命周期 2（见头注释表）。 */
export interface UseTaskFormSubmitOptions {
  /** 兄弟 hook 产物（非页面量）：段 G 的 8 层 `apply*Payload` 组装（纯函数，不写 store） */
  buildSubmissionPayload: (values: TaskFormGateValues) => SubmissionPayload;
  /** 编辑态？——决定走 update 还是 create（也是 409 分支的命中条件之一） */
  isEdit: boolean;
  /** 编辑目标 id（创建态为 undefined） */
  editId: string | undefined;
  /** A4 乐观锁：编辑态加载时刻的 `updatedAt`；null＝不带该字段＝服务端跳过检查 */
  loadedUpdatedAt: string | null;
  /** 任务/执行/metrics 查询面失效器（A4 / NETOPT-10-8） */
  queryClient: QueryClient;
  /** 成功后导航（router 的 `navigate` 引用） */
  nav: NavigateFunction;
  /** DRAFT-01：丢弃草稿并取消挂起防抖写入 */
  discardDraft: () => void;
  /** DRAFT-01：草稿快照置 null（同时关掉 `useDraft` 的 enabled） */
  setDraftValues: (value: Record<string, unknown> | null) => void;
  /** DRAFT-01：「已恢复草稿」提示不再出现 */
  setDraftNoticeDismissed: (value: boolean) => void;
  /** Glue 编辑器的语言回填源（创建成功后取 payload.runtime） */
  setSavedRuntime: (value: string) => void;
  /** 创建成功后 Glue 的落库目标 */
  setCreatedTaskId: (value: string | null) => void;
  /** P1（F-1）：先翻 `dirtyRef` 再翻 `dirty`——**必须在 nav 之前**调用 */
  clearFormDirty: () => void;
  /** 提交中互斥（按钮 loading + 草稿禁写） */
  setSaving: (value: boolean) => void;
  /** P3（F-8）：id→任务名快照——**ref 对象**，失败时读 `.current`（见头注释） */
  depNameSnapshotRef: RefObject<Record<string, string>>;
  /** Glue 分区锚点 id（`SECTION_IDS[4]`；由页面拥有，hook 不解释其语义） */
  glueAnchorId: string;
}

/** 一次提交的入参：E 已规范化过的活 store 引用 + 规范化提示语。 */
export interface RunSubmissionInput {
  /** 段 E 已在其上原地规范化的 **antd 活 store 引用**（非克隆，勿二次取值） */
  values: TaskFormGateValues;
  /** 段 E 的「cron/维护窗口已规范化」提示语（无规范化＝null） */
  cronNormalizeNote: string | null;
}

/** 返回值：一个事件处理链路里的异步函数（页面在二次确认之后现调）。 */
export interface TaskFormSubmitController {
  /**
   * 段 H + 段 I：调 API → 成功副作用 → 导航；失败走专门映射；`finally` 复位 saving。
   * 抛错一律在此消化（与搬移前相同：本函数**不向外抛**）。
   */
  runSubmission: (input: RunSubmissionInput) => Promise<void>;
}

export function useTaskFormSubmit({
  isEdit,
  editId,
  loadedUpdatedAt,
  queryClient,
  nav,
  discardDraft,
  setDraftValues,
  setDraftNoticeDismissed,
  setSavedRuntime,
  setCreatedTaskId,
  clearFormDirty,
  setSaving,
  depNameSnapshotRef,
  glueAnchorId,
  buildSubmissionPayload,
}: UseTaskFormSubmitOptions): TaskFormSubmitController {
  const { t } = useTranslation();

  /**
   * 段 H（搬移前 L675-736 / 盘点表 L813-867）+ 段 I（搬移前 L737-773 / 盘点表 L868-904）：
   * `try/catch/finally` 骨架与两个分支的
   * **语句顺序**逐字保留（头注释「三条有缺陷修复史的语义」是这段的阅读入口）。
   *
   * `values` 必须是页面从 `runPreSubmitGates()` 拿到、并由段 E 原地规范化过的
   * **同一个引用**——本 hook 不 import `FormInstance`、不调 `getFieldsValue`。
   */
  const runSubmission = async ({
    values,
    cronNormalizeNote,
  }: RunSubmissionInput): Promise<void> => {
    setSaving(true);
    try {
      // 段 G（R7 刀 3 起在 useTaskFormPayload）：8 层 apply*Payload 的嵌套顺序
      // 与逐层理由见该函数注释（applySecretsPayload 最外层、applyDependenciesPayload
      // 转载体键、两个版本/来源层必须紧贴 buildExecutorPayload）。传的是上面那个
      // 活 store 引用（E 已在其上原地规范化），不做二次取值。
      const payload = buildSubmissionPayload(values);
      if (isEdit && editId) {
        // A4（乐观锁）：带读取时刻的 updatedAt 做并发检查——服务端发现行已被
        // 并发修改即 409（见下方 catch 的专门分支）。null = 未曾加载到版本戳
        // （老接口/加载失败），不带该字段 = 服务端跳过检查，保持向后兼容。
        await tasksApi.update(editId, {
          ...payload,
          expectedUpdatedAt: loadedUpdatedAt ?? undefined,
        } as Parameters<typeof tasksApi.update>[1]);
        // A4（第三轮审计）：失效任务/执行/metrics 面——30s staleTime 内跳转
        // 到详情/列表时不再渲染过期数据。
        await invalidateTaskData(queryClient);
        // DRAFT-01：提交成功即清除草稿（本次输入已落库，再"恢复"它是干扰）。
        // 与 dirty 守卫的语义一致：成功后不再需要拦截离开。
        discardDraft();
        setDraftValues(null);
        setDraftNoticeDismissed(true);
        message.success(t('taskForm.submit.updated'));
        if (cronNormalizeNote) message.info(cronNormalizeNote);
        // P1（F-1，commit 2f821cc1）：nav 前清脏——否则 useBlocker(dirty||glueDirty)
        // 把保存成功后自己的跳转拦下来，成功 toast 与「有未保存的更改」同屏。ref
        // 先于 nav 同步翻转（见页面 clearFormDirty 注释），glueDirty 语义保持。
        clearFormDirty();
        nav(`/tasks/${editId}`);
      } else {
        const created = await tasksApi.create(
          payload as components["schemas"]["CreateTaskDto"],
        );
        await invalidateTaskData(queryClient);
        // DRAFT-01：创建成功即清除草稿（同编辑态，见上）。
        discardDraft();
        setDraftValues(null);
        setDraftNoticeDismissed(true);
        message.success(t('taskForm.submit.created'));
        if (cronNormalizeNote) message.info(cronNormalizeNote);
        setSavedRuntime(
          typeof payload.runtime === 'string' ? payload.runtime : 'python',
        );
        setCreatedTaskId(created.id);
        // P1（F-1，commit 2f821cc1）：与编辑分支同款清脏（原为 setDirty(false)）。
        clearFormDirty();
        // P2（F-4，本轮审计）：创建成功后跳到新任务的**编辑页**（replace 导航，
        // 不把已失效的 /tasks/new 留在历史里）。此前停留 /tasks/new：刷新丢全部
        // 上下文、再次点击提交撞任务名唯一约束 409。编辑页重新拉取刚创建的
        // 任务并回填，Glue 分区照常可编（编辑态 taskId 已存在），「完成，前往
        // 任务详情」按钮（taskForm.glue.done）同样在位——产品流最平滑的落点。
        // createdTaskId/setSavedRuntime 保留：若导航被守卫拦下（当前不可达，
        // 防御），既有「停留本页编 Glue」回退路径仍完整。
        nav(`/tasks/${created.id}/edit`, { replace: true });
        // 创建成功后滚到 Glue 区块（原 step3 语义：创建后进入 Glue 编排）。
        // F-4 后主路径是跳编辑页；滚动作为守卫拦截时的回退语义保留。
        // BUGFIX（P3，commit 7d66a9b0 清单）：原 setTimeout(50) 是「赌渲染在
        // 50ms 内完成」的魔法延时——改为 rAF 两连等渲染提交 + 目标存在性轮询
        // （有界），见 utils/scroll-when-ready。
        scrollToSectionWhenReady(glueAnchorId);
      }
    } catch (err: unknown) {
      // A4（乐观锁冲突，409）：另一标签页/调用方已抢先修改同一任务——留在
      // 表单页**不跳转**，给出「刷新后重试」的专门指引（比通用失败文案更可
      // 操作：用户刷新表单即可拿到最新值再改）。状态码判定沿用 client.ts 的
      // `__status` 打标约定（拦截器 reject 的是 response.data，原始
      // response.status 已剥掉；旧路径兜底直传 axios error 的调用方）。
      const conflictStatus =
        err !== null && typeof err === 'object'
          ? ((err as Record<string, unknown>)['__status'] ??
            (err as { response?: { status?: unknown } })?.response?.status)
          : undefined;
      if (isEdit && conflictStatus === 409) {
        message.error(t('taskForm.submit.conflict'), 6);
        return;
      }
      // client.ts 的错误拦截器 reject 的是**普通对象**（err.response?.data || err），
      // 不是 Error 实例——`err instanceof Error` 对后端 400 恒 false，于是
      // assertCodeSourceConsistent / assertRuntimeVersionValid 返回的可操作
      // 文案被泛化的「创建失败」吞掉。getErrMsg 同时覆盖两种形状（与本文件
      // 模板保存等兄弟 catch 同策）。
      //
      // P3（F-8，commit 7d66a9b0 清单）：依赖类校验错误（循环依赖/依赖不存在等）
      // 的消息里裸拼 taskId（UUID，后端侧不改）——用表单已知的 id→任务名快照
      // （depNameSnapshotRef：依赖候选 + 编辑态回填两路播种）替换为任务名；
      // 映射不到保持原文，绝不编造。
      message.error(
        humanizeDependencyTaskIds(
          getErrMsg(
            err,
            isEdit ? t('taskForm.submit.updateFail') : t('taskForm.submit.createFail'),
          ),
          depNameSnapshotRef.current,
        ),
      );
    } finally {
      setSaving(false);
    }
  };

  return { runSubmission };
}

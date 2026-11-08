/**
 * 「版本历史 / 回滚」子域（原 `TaskDetailPage` 内联实现，R6「TaskDetailPage 四子域
 * hook」切法 (a) 的第四刀，纯搬移 / 零行为变更）。
 *
 * 承载 A5（第二轮审计）补的那条功能空洞——后端 `versions` / `compareVersions` /
 * `rollbackToVersion` 三端点此前前端零调用：
 *
 *   列表（版本号 / 时间 / 创建者）→ 勾选两个版本出 diff → 每行「回滚到此版本」
 *   带确认弹窗 → 成功后刷新任务面 + 版本列表。
 *
 * 8 个 state：`versionDrawerOpen` / `versions` / `versionsLoading` / `pickedVersionIds` /
 * `versionDiff` / `diffLoading` / `rollbackTarget` / `rollingBack`；
 * 3 个 handler：`loadVersions` / `handleCompareVersions` / `handleRollbackConfirm`；
 * 外加 1 个 effect（抽屉打开 ⇒ 重置上次会话的勾选与 diff 再拉列表）。
 *
 * ## `refreshTask` 为什么是**参数**而不是 hook 内部自己拿（本刀的核心判断）
 *
 * 回滚成功后要刷新任务面（回滚改写了任务配置），而「刷新」**不是本子域独有**：
 *
 * | 调用点 | 所属域 | 用的名字 |
 * |---|---|---|
 * | `handleRollbackConfirm` | **本子域** | `refreshTask` |
 * | `handleTriggerConfirm` | 手动触发子域 | `refreshExecs` |
 * | `handlePause` / `handleResume` | 页面（生命周期） | `refreshTask` |
 * | `handleKill` | 页面（执行历史） | `refreshExecs` |
 * | 加载失败「重试」按钮 / 执行历史「刷新」按钮 | 页面（JSX） | 各一 |
 *
 * 页面里那两个名字的实现**逐字相同**（都是 `() => void invalidateTaskData(queryClient)`，
 * 只差变量名），即「invalidate 哪几组 queryKey」这条策略由 `invalidateTaskData`
 * 唯一持有，页面只是它的调用点。⇒ 若把刷新塞进本 hook，只有两种后果，都不接受：
 *   ① hook 反向 import 页面（或页面把 queryClient 传进来让 hook 自己拼 key）——
 *      那是**反向依赖**，页面从「编排者」降级成「被 hook 调用的一层」，是伪拆分；
 *   ② 把 invalidate 策略抄一份进 hook —— 同一策略两处真相，与 `invalidateTaskData`
 *      的「一处 invalidate 全站一致」设计直接冲突（见 `api/queries.ts` 注释）。
 *
 * 故按方法学「**Facade 持共享、协作者拿引用**」：`refreshTask` 仍由页面持有
 * （它同时服务于本子域 / 触发子域 / 生命周期 / 执行历史四处），**作为参数注入**
 * 本 hook。注入的是**引用**而不是"回调句柄约定"——页面每次渲染都重建这个函数，
 * 本 hook 每次渲染拿到的都是最新那份，与搬移前闭包捕获的是同一个对象
 * （搬移前 `handleRollbackConfirm` 也是每次渲染重建的）。**没有加 useCallback**：
 * 原实现就没有。
 *
 * ## `loadVersions` 的 `useCallback` **必须**留着（不是可选优化）
 *
 * 抽屉的 effect 依赖 `[versionDrawerOpen, loadVersions]`。若 `loadVersions` 每次
 * 渲染换身份，effect 就会在抽屉打开期间**每次渲染都重拉一次版本列表**（拉列表
 * 又 setState ⇒ 又渲染 ⇒ 又拉：无限循环）。原实现是 `useCallback(..., [id, t])`，
 * 本 hook 逐字保留 —— 含 `t`：语言切换时 `t` 换身份，effect 随之重跑（这是既有
 * 行为，`language-switch-*` 那类 spec 依赖它）。
 *
 * ## effect 的调用位置：**刻意落在原来的位置**，不与其他 hook 归拢到文件头
 *
 * 本 hook 由页面在「原来那段版本逻辑的位置」调用（`refreshTask` 定义之后、
 * `useTaskDetail` 之前）。理由不是洁癖——`TaskDetailPage` 里 effect 的执行顺序是
 * 「webhook hook 内部 effect → glueDirty beforeunload → 版本抽屉」。若把本 hook
 * 提到文件头与另两个子域 hook 并排，版本 effect 就会跑到 beforeunload 之前。
 * 两者在首帧都是空转（`versionDrawerOpen=false` / `!glueDirty` 早退），但
 * 「顺序变了且没人说得清会不会有影响」是拆分本身不该引入的风险面 ⇒ 位置保持原样，
 * 副作用顺序与搬移前逐条一致（同 `ConfigPage` C 批 / B 批「effect 调用点不动」的先例）。
 *
 * ## 刻意**未搬**的两块（停止拆分的理由，留痕以免下一个人重复评估）
 *
 *   · `versionColumns`（页面里 ~52 行 `Table` 列定义）与 `diffRows`（3 行派生）：
 *     它们是**视图模型**（用 `t` / `isAdmin` / `setRollbackTarget` / `token` 拼 JSX），
 *     不是「state + handler」。搬进本 hook 会让 hook 反向依赖 `isAdmin` / `token`
 *     这两个页面上下文，并把「本 hook 只管数据与请求」这条不变量打破。它们属于
 *     另一条债轴（`TaskListPage` 的 `columns` 外提 = 纯声明文件，不是 hook），
 *     应各自一刀，不与本刀混做。
 *   · `drawerA11y`（`useDrawerA11y`）：它是**通用 a11y 工具**，本页之外无消费点，
 *     但与本子域的数据流无关（同一 hook 也给将来的其它抽屉用）。留在页面。
 */
import { useCallback, useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import { tasksApi } from '../../api/tasks';
import type { TaskVersion, VersionDiff } from '../../api/tasks';
import { showApiError } from '../../utils/error';
import { message } from '../../utils/toast';
import '../../i18n';

export interface TaskVersionRollback {
  versionDrawerOpen: boolean;
  setVersionDrawerOpen: (open: boolean) => void;
  versions: TaskVersion[];
  versionsLoading: boolean;
  /**
   * R171（P2-2）：**版本列表**的读取失败原因（null = 没失败）。
   *
   * 缺陷现场：`loadVersions` 的 catch 只有 `setVersions([])` + 一条 toast ⇒
   * 抽屉立刻落到 Table 的空态「暂无版本记录」，与「这个任务**真的**没有版本」
   * 完全同形。用户在需要回滚的时刻读到这条空态，结论往往是「回滚不了，算了」
   * ——而事实是「没读到，重试一次也许就有」。这是本仓反复出现的同一类缺陷：
   * **读失败被渲染成没有数据**。
   *
   * 修法：清空列表（防跨任务串数据）+ 单独记错。抽屉据 `versionsError` 渲染
   * `StateError`（含重试 `loadVersions`），只有**真空数组**才显示 empty。
   */
  versionsError: unknown;
  pickedVersionIds: string[];
  setPickedVersionIds: Dispatch<SetStateAction<string[]>>;
  versionDiff: VersionDiff | null;
  setVersionDiff: Dispatch<SetStateAction<VersionDiff | null>>;
  /**
   * R170：**本次**对比的失败原因（null = 没失败）。
   *
   * ## 为什么必须清掉旧 `versionDiff`（这不是洁癖，是防「回滚错版本」）
   *
   * 此前 `handleCompareVersions` 的 catch **只弹 toast、不清 `versionDiff`**
   * ⇒ 用户先对比 A↔B（成功），再对比 C↔D（失败）时，面板**继续显示 A↔B 的差异**，
   * 而卡片标题只有「版本差异」四个字、**不带版本号** ⇒ 用户会把 A↔B 的差异
   * 当成 C↔D 的差异来读，并据此**点回滚**。这是「读 A 显示 B」里代价最高的一种：
   * 它直接喂给一个不可逆动作（回滚）。
   *
   * 修法：失败时**清空** `versionDiff`（宁可什么都没有，也不给错的），
   * 并把错误显式交给面板渲染成 `StateError`（含重试），而不是只闪一条 toast。
   */
  versionDiffError: unknown;
  diffLoading: boolean;
  /** 回滚确认弹窗的目标版本（null = 关闭）。 */
  rollbackTarget: TaskVersion | null;
  setRollbackTarget: Dispatch<SetStateAction<TaskVersion | null>>;
  rollingBack: boolean;
  loadVersions: () => void;
  handleCompareVersions: () => Promise<void>;
  handleRollbackConfirm: () => Promise<void>;
}

export function useTaskVersionRollback(
  id: string | undefined,
  /** 页面持有的共享刷新（见头注「Facade 持共享、协作者拿引用」）。 */
  refreshTask: () => void,
): TaskVersionRollback {
  const { t } = useTranslation();

  // A5（第二轮审计）：版本历史 Drawer——后端 versions / rollbackToVersion /
  // compareVersions 三端点此前前端零调用（功能空洞）。装配：
  //   列表（版本号/时间/创建者）→ 勾选两个版本 compareVersions 出 diff 键值表
  //   → 每行「回滚到此版本」带确认 Modal（说明覆盖影响）→ 成功后刷新任务+列表。
  const [versionDrawerOpen, setVersionDrawerOpen] = useState(false);
  const [versions, setVersions] = useState<TaskVersion[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  // R171（P2-2）：版本列表的读取失败（见接口注释「读失败 ≠ 没有版本」）。
  const [versionsError, setVersionsError] = useState<unknown>(null);
  // 最多勾两个：超出时保留最近两次勾选（rowSelection onChange 里裁剪）。
  const [pickedVersionIds, setPickedVersionIds] = useState<string[]>([]);
  const [versionDiff, setVersionDiff] = useState<VersionDiff | null>(null);
  const [versionDiffError, setVersionDiffError] = useState<unknown>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  // 回滚确认弹窗的目标版本（null = 关闭）。
  const [rollbackTarget, setRollbackTarget] = useState<TaskVersion | null>(null);
  const [rollingBack, setRollingBack] = useState(false);

  // 直接走 tasksApi + 本地 state（与 webhookStatus 同款模式）：queries.ts 未提供
  // 版本 hooks，且版本数据只在 Drawer 打开时需要。
  const loadVersions = useCallback(() => {
    if (!id) return;
    setVersionsLoading(true);
    // 每次（重）拉先清掉上次的失败——否则重试成功后错误块仍留在屏上。
    setVersionsError(null);
    tasksApi.versions(id)
      .then(setVersions)
      .catch((err: unknown) => {
        // R171（P2-2）：清空 + 记错**两件事都要做**。只清空（旧实现）就把
        // 「没读到」写成了「没有版本」；只记错则会把上一个任务的版本留在屏上。
        setVersions([]);
        setVersionsError(err);
        showApiError(err, t('taskDetail.version.loadFail'));
      })
      .finally(() => setVersionsLoading(false));
  }, [id, t]);

  useEffect(() => {
    if (versionDrawerOpen) {
      // 每次打开重置上次会话的勾选与 diff，避免跨任务/跨会话串数据。
      setPickedVersionIds([]);
      setVersionDiff(null);
      loadVersions();
    }
  }, [versionDrawerOpen, loadVersions]);

  const handleCompareVersions = async () => {
    if (!id || pickedVersionIds.length !== 2) return;
    setDiffLoading(true);
    setVersionDiffError(null);
    try {
      setVersionDiff(
        await tasksApi.compareVersions(id, pickedVersionIds[0], pickedVersionIds[1]),
      );
    } catch (err: unknown) {
      // R170：**先清掉上一次的 diff**，再记错。留着旧 diff 会让用户把上一对的差异
      // 当成这一对的来读，并据此点「回滚」—— 那是不可逆动作上最贵的一种假事实。
      setVersionDiff(null);
      setVersionDiffError(err);
      showApiError(err, t('taskDetail.version.diffFail'));
    } finally {
      setDiffLoading(false);
    }
  };

  const handleRollbackConfirm = async () => {
    if (!id || !rollbackTarget) return;
    setRollingBack(true);
    try {
      await tasksApi.rollbackToVersion(id, rollbackTarget.id);
      message.success(
        t('taskDetail.version.rollbackSuccess', { version: rollbackTarget.version }),
      );
      setRollbackTarget(null);
      setVersionDiff(null);
      setPickedVersionIds([]);
      // 回滚改写任务配置并追加新版本——任务面 + 版本列表双刷新。
      refreshTask();
      loadVersions();
    } catch (err: unknown) {
      showApiError(err, t('taskDetail.version.rollbackFail'));
    } finally {
      setRollingBack(false);
    }
  };

  return {
    versionDrawerOpen,
    setVersionDrawerOpen,
    versions,
    versionsLoading,
    versionsError,
    pickedVersionIds,
    setPickedVersionIds,
    versionDiff,
    setVersionDiff,
    versionDiffError,
    diffLoading,
    rollbackTarget,
    setRollbackTarget,
    rollingBack,
    loadVersions,
    handleCompareVersions,
    handleRollbackConfirm,
  };
}

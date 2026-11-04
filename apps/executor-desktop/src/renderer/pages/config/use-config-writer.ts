import { useEffect, useState } from 'react';
import { restartRequiredFieldsDiffer } from '../../../main/config-restart';
import { ipcErrorMessage } from '../../ipc-error';
import type { CfgText } from './io-result';
import { classifySaveResult, planSave, saveStatusOf, type SaveStatus } from './save-plan';

/**
 * 设置页的**配置写路径**（R7-B 第三刀）：`save` / `requestSave` + 它们的 5 个
 * 异步状态 + Ctrl/Cmd+S 的键盘绑定。
 *
 * ## ① `requestSaveRef` 的归属：**ref 身份与 render-time 赋值留在页面**
 *
 * 拆分前（`ConfigPage`）：
 *
 *     const requestSaveRef = useRef(requestSave);
 *     requestSaveRef.current = requestSave;   // ← render 期赋值
 *     useEffect(() => { … if (isDirty) void requestSaveRef.current() … }, [isDirty]);
 *
 * `requestSave` 每次渲染都是新闭包，而监听只挂一次（deps 只有 `isDirty`）⇒ 那个
 * ref 的语义是"**每次 render 都刷新成最新的 requestSave**，让挂载时注册的那一个
 * 监听器永远调到最新闭包"。这条语义有三个必要条件，它们分别落在谁身上：
 *
 *   | 条件 | 位置 | 理由 |
 *   |---|---|---|
 *   | ref **对象身份**跨渲染稳定 | 页面 `useRef` | React 只对组件（fiber）的 hook 槽位保证复用；ref 由页面创建 ⇒ 身份天然稳定，hook 收到的永远是同一个对象 |
 *   | **每次 render 都重新赋值** | 页面（紧接 hook 调用之后） | 这是"刷新"本身；谁创建闭包谁赋值，写点唯一 |
 *   | 读的时候**穿透 ref** 拿 `.current` | 本 hook（`onKeyDown` 体内） | 若在 hook 体里 `const rs = requestSaveRef.current` 缓存成局部量，监听器就被冻结在挂载那一帧——"每次 render 刷新"立刻失效 |
 *
 * **为什么赋值点不搬进 hook**：不是"hook 的 render 早于页面的"（自定义 hook 的
 * 函数体是在页面 render **内部**、于调用点处执行的，两者同属一次 render pass，
 * 页面在其后对 ref 的任何写入，对"提交后才触发的监听器"都不可观测），而是
 * **写点唯一性**：hook 若自己也赋值、页面又赋一次，同一 ref 就有两个写者，
 * 结果取决于两行代码的先后——那是"顺序恰好对"而不是"结构上只有一个写者"。
 * 反过来，hook 只读、页面只写，`requestSaveRef.current` 的取值在任何时刻都
 * 只有一个来源。
 *
 * 这条判断的**可执行证据**在 `writer-layer.selftest.mjs` §④：用两个不同 `form`
 * 连做两次渲染、只让页面那行赋值，然后触发**第一次渲染注册的**监听器，断言
 * `saveConfig` 收到的是**第二次渲染**的载荷——监听器被冻结在挂载帧的话该断言红。
 *
 * ## ② effect 声明顺序仍是语义 ⇒ 本 hook 的调用点被钉在原位
 *
 * 拆分前实测 9 个 `useEffect`（见 `use-config-source.ts` 头注的表）。本 hook 收
 * **#8 Ctrl/Cmd+S + Alt+1..5 键盘**（实测 2026-11-04，`grep -n 'useEffect('`），
 * 且 hook 体内只声明这 1 条 ⇒ 页面把它放在原 #8 那一行（`requestSaveRef` 处），
 * 9 个 effect 的声明序号逐位不变。Alt+1..5 的"分区表 + setActive"归页面，故以
 * `onSwitchSection(序号)` 注入（页面用 `useCallback([])` 保证身份稳定，否则
 * 本 effect 的 deps 会每渲染变一次 ⇒ 监听器被反复解绑重挂，行为等价但不再是
 * "只挂一次"）。
 *
 * ## ③ 状态归属：写路径原子随写路径走，展示面留在页面
 *
 * `saving` / `checkingSaveImpact` / `saveImpact` / `saveError` 只由写路径推进
 *（`save` 的 try/catch/finally、`requestSave` 的三态判定），故归本 hook。
 * 页面仍**写** `saveError`（`discardChanges()` 清错误行）与 `saveImpact`
 *（确认弹窗的"取消"）——它们是页面的展示面，故把 setter 一并以返回值交回页面，
 * 而不是让页面为此再造一份状态（两份真相必然有一份先腐烂）。
 *
 * **`saved`（"已保存"提示）不搬**，尽管它看起来同类：它既是页面 #6
 * `agentStatus` effect 的依赖（`[active, saved]`，保存后重拉托管状态），又被
 * 页面的 `set()` 在**每次编辑**时清除——两处都在本 hook 调用点**之前**。搬进
 * hook 会让 `[active, saved]` 在渲染期读到后声明的 `const`（TDZ 直接
 * ReferenceError），而把调用点前移又会打乱 effect 声明序号。⇒ 状态留页面、
 * 只把 setter 注入（与 `setSavedForm` / `refreshPyEnv` 同一形态）。
 * 实测证据：本刀第一次实现把它搬进 hook，`typecheck:renderer` 立刻报
 * `TS2448 Block-scoped variable 'saved' used before its declaration`（第 435 行
 * 的 `[active, saved]`）——**这是真门禁抓到的真崩溃，不是风格问题**。
 *
 * ## 无法单测的部分（如实交代）
 *
 * `useEffect` 的**时序本身**（"监听只挂一次、每次都调到最新闭包"）需要跑 effect
 * 的 React 渲染器，本仓没有，装一个等于引入新框架。故：
 *   · **赋值/读取的结构**由 `writer-layer.selftest.mjs` §①§② 钉住（hook 里
 *     `requestSaveRef.current` 只读不写、且在 `onKeyDown` 体内读；页面恰好一处
 *     赋值）；
 *   · **刷新语义的行为后果**由同文件 §④ 的两次渲染 + 冻结监听器实验承担（不需要
 *     React：hook 体被真实的转译产物驱动，`useState`/`useEffect` 用最小调度器）；
 *   · **真机仍需手点**设置页的"保存配置"与 Ctrl+S（尤其确认弹窗三态）。
 * 判定分支已全部搬进纯函数（`planSave` / `saveStatusOf` / `classifySaveResult`），
 * 时序里不再夹带分支 ⇒ "时序错"与"判定错"可分开定位。
 */

declare const window: Window & {
  electronAPI: {
    saveConfig: (cfg: Record<string, unknown>) => Promise<{ ok: boolean; reloadError?: string }>;
    getStatus?: () => Promise<{ running: boolean }>;
  };
  location: { reload: () => void };
};

/** 页面注入的依赖：配置真值源与展示面状态归页面，本 hook 只持有写路径原子。 */
export interface ConfigWriterDeps {
  /** 文案取值（语言在页面求值一次，与既有 N-04 口径一致）。 */
  t: CfgText;
  /** 当前草稿（保存载荷的唯一来源）。 */
  form: Record<string, unknown>;
  /** 当前基线（重启判据 + 语言变化判据都比它）。 */
  savedForm: Record<string, unknown>;
  /** 是否脏（页面派生量；`requestSave` 的 noop 闸 + 键盘闸都用它）。 */
  isDirty: boolean;
  /** 保存成功后把基线推进到本次提交的草稿。 */
  setSavedForm: (cfg: Record<string, unknown>) => void;
  /**
   * 「已保存」提示的开关（**状态本身归页面**：`saved` 是 #6 agentStatus effect
   * 的依赖，且页面的 `set()` 每次编辑都要清除它——两者都在本 hook 调用点**之前**，
   * 搬进 hook 会变成"渲染期读后声明的变量"（TDZ ReferenceError）。写路径只**写**
   * 它，故以 setter 注入。）
   */
  setSaved: (value: boolean) => void;
  /** EXP-06：保存成功后重取 Python 环境诊断（页面拥有该状态）。 */
  refreshPyEnv: () => void;
  /**
   * 页面持有的 `requestSaveRef`（**身份由页面保证稳定**）：本 hook 只在
   * `onKeyDown` 体内读 `.current`，绝不赋值、也不缓存成局部量——见头注①。
   */
  requestSaveRef: { current: () => Promise<void> };
  /** i18n-DESK-01：语言真的变了才重载窗口（页面注入，模块作用域函数 ⇒ 身份稳定）。 */
  languageChangeReloadsUi: (before: unknown, after: unknown) => boolean;
  /** Alt+1..5：按序号切分区（分区表与 `setActive` 都在页面）。 */
  onSwitchSection: (index: number) => void;
}

export interface ConfigWriter {
  saving: boolean;
  checkingSaveImpact: boolean;
  saveImpact: 'running' | 'unknown' | null;
  saveError: string | null;
  /** 确认弹窗的"取消"出口（页面 JSX 里 `setSaveImpact(null)`）。 */
  setSaveImpact: (value: 'running' | 'unknown' | null) => void;
  /** 展示面回写口：`discardChanges()` 要清保存失败行。 */
  setSaveError: (value: string | null) => void;
  save: () => Promise<void>;
  requestSave: () => Promise<void>;
}

export function useConfigWriter(deps: ConfigWriterDeps): ConfigWriter {
  const {
    t, form, savedForm, isDirty,
    setSavedForm, setSaved, refreshPyEnv, requestSaveRef, languageChangeReloadsUi, onSwitchSection,
  } = deps;

  const [saving, setSaving] = useState(false);
  const [checkingSaveImpact, setCheckingSaveImpact] = useState(false);
  const [saveImpact, setSaveImpact] = useState<'running' | 'unknown' | null>(null);
  // D 修正：保存失败必须可见（原实现 reject 后按钮永久 disabled）
  const [saveError, setSaveError] = useState<string | null>(null);

  async function save() {
    if (!isDirty) {
      setSaveImpact(null);
      return;
    }
    setSaveImpact(null);
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const r = await window.electronAPI.saveConfig(form);
      const outcome = classifySaveResult(r);
      if (outcome.kind === 'rejected') {
        // 主进程可能返回 ok:false（载荷形状被拒——防御路径）。不能把它当成功，
        // 否则会显示"✓ 已保存，配置已生效"而其实什么都没写。
        setSaveError(t('cfg.error.saveRejected'));
      } else if (outcome.kind === 'reloadFailed') {
        // 配置已落盘，但执行器热重载可能失败——此时不能报"已生效"，
        // 否则用户以为执行器在跑，实际已停在停止态。
        setSavedForm(form);
        setSaveError(t('cfg.error.reloadFailed', outcome.message));
      } else {
        setSavedForm(form);
        setSaved(true);
        setTimeout(() => setSaved(false), 3000);
        // EXP-06：保存成功后立刻重取 Python 环境诊断——用户刚改的就是 uvPath /
        // 解释器池 / 下载预算这些值，诊断块必须如实反映"改完之后的实际生效值"。
        // 只在成功分支调用：失败时保留上一次的诊断（比清空更有参考价值）。
        refreshPyEnv();
        // i18n-DESK-01：界面语言**不是热切换**的（渲染层文案在模块作用域求值，
        // 只求值一次）——语言真的变了就重载本窗口，重载即用新语言重新跑一遍启动
        // 流程。重载后「已保存」提示自然消失：界面本身已是新语言，无需再提示。
        if (languageChangeReloadsUi(savedForm.uiLanguage, form.uiLanguage)) {
          window.location.reload();
          return;
        }
      }
    } catch (err) {
      // D 修正：原实现未包 try——saveConfig reject 会让 saving 永久为 true，
      // 「保存配置」按钮永久禁用且用户完全无感知，只能重启应用。
      setSaveError(t('cfg.error.saveFailed', ipcErrorMessage(err)));
    } finally {
      setSaving(false);
    }
  }

  async function requestSave() {
    // 仅重载渲染层/热同步主进程的字段（语言、日志级别、通知、Agent 档位等）
    // 不需要动执行器。此前只要执行器在跑就一律弹"保存会立即重启执行器"，
    // 与本进程真实的 finalizeConfigSave 判据不一致，属于虚惊。
    const needsRestart = restartRequiredFieldsDiffer(savedForm, form);
    const gate = planSave({ isDirty, saving, checkingSaveImpact, needsRestart, status: 'unprobed' });
    if (gate === 'noop') return;
    setSaveImpact(null);
    if (gate === 'save') {
      await save();
      return;
    }
    setCheckingSaveImpact(true);
    try {
      // 状态无法确认时保守提示，不把运行中的任务当作空闲任务处理。
      const status: SaveStatus = await saveStatusOf(window.electronAPI.getStatus);
      const plan = planSave({ isDirty: true, saving: false, checkingSaveImpact: false, needsRestart: true, status });
      if (plan === 'save') await save();
      else setSaveImpact(plan === 'confirm-running' ? 'running' : 'unknown');
    } catch {
      // 状态取不到/保存链路抛错：保守提示（原实现的 catch 覆盖同一段）。
      setSaveImpact('unknown');
    } finally {
      setCheckingSaveImpact(false);
    }
  }

  // UI V5：Ctrl/Cmd+S 走既有 requestSave（未保存时才动作）；Alt+1..5 切分区。
  // requestSave 每次渲染都会重建，用 ref 取最新闭包，监听只挂一次——故这里
  // **只在事件体内读 `.current`**（头注①的第三个必要条件）。
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      const modifier = e.ctrlKey || e.metaKey;
      if (modifier && !e.altKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        if (isDirty) void requestSaveRef.current();
        return;
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && /^[1-5]$/.test(e.key)) {
        e.preventDefault();
        onSwitchSection(Number(e.key) - 1);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // 三个依赖里只有 `isDirty` 会变（另两个由页面保证身份稳定）⇒ 重挂时机
    // 与拆分前 `[isDirty]` 完全一致。
  }, [isDirty, requestSaveRef, onSwitchSection]);

  return {
    saving, checkingSaveImpact, saveImpact, saveError,
    setSaveImpact, setSaveError,
    save, requestSave,
  };
}

/**
 * R7 刀 2（前置闸门 · H1 = 段 A+B+C+D）：`submitTaskForm` 九段里**提交前**的四道
 * 拦截闸门，从 `TaskFormPage.tsx` 原样迁出为一个独立 hook（纯搬移 / 零行为变更）。
 *
 * ## 为什么是这四段
 *
 * 九段里只有 A/B/C/D 是「**读表单 → 判定 → 拦下或放行**」，且依赖面最窄：
 * 只读 `form`（`validateFields` / `getFieldsValue(true)` / `scrollToField`）
 * + 两个页面派生量（`executorMode`、`zipApplicationMissing`），
 * 产出只有 toast + 播报文本 + 一个锚点 ⇒ **零时序、零 effect、零 ref、零写表单**。
 * 相比段 E（原地改 antd 活 store）、段 G（payload 组装）、段 H（依赖 16 个页面量）、
 * 段 I（密度 68.2 含 409 分支），这四段是 290 行里唯一「搬走不会动到任何竞态」的块。
 *
 * ## 核心设计点：**拦截结果返回协议**（替代四段各自的 `return`）
 *
 * 原实现里 A/B/C/D 都以 `return` 提前退出 `submitTaskForm`，且各自**就地**调
 * `setValidationAnnouncement(...)`（页面 state）+ `message.error(...)` + `scrollToSection(...)`
 * （页面 DOM 工具）。四段搬走后不能再直接「就地 return」——否则调用方的控制流会碎成
 * 「不知道哪条闸门拦的」。因此本节把四段的提前退出归一成**一个可判别的返回对象**：
 *
 * ```ts
 * type PreSubmitGateResult =
 *   | { blocked: true;  gate: <哪条闸门>; section: <哪一类字段> | null; announcement: string | null }
 *   | { blocked: false; gate: null; section: null; announcement: ''; values: <活 store> };
 * ```
 *
 * 四个字段各管一件事，且**没有一个字段是"顺手带出来"的**：
 *
 * - `blocked`：唯一的**控制流**信号。调用方只写一次 `if (gate.blocked) return`，
 *   不需要知道 A/B/C/D 谁拦的 —— 这正是「把 N 个提前退出归一成一个出口」。
 * - `gate`：**机读的拦截来源**（`'form' | 'missing' | 'secretKeys' | 'paramsSize'`）。
 *   调用方当前不按它分支（不需要），但它是这套协议里**唯一能被测试与日志钉住**的
 *   字段：四段合并成一个 Promise 后，「是校验失败还是 secrets 键非法」否则只能靠
 *   匹配文案反推。**不许**把它降级成布尔，否则四段的可观测性一起丢掉。
 * - `section`：**语义分区**（`basic` / `trigger` / `executor` / `params`），不是 DOM id。
 *   映射到 `SECTION_IDS[i]` 并执行滚动的职责留在页面 —— 闸门知道「哪一类字段错了」，
 *   页面知道「这块内容在哪个锚点上」，两者不该互相知道对方。`null` = 不滚动
 *   （段 A 已经用 `form.scrollToField` 精确滚到出错字段本身，不能再叠一次分区滚动）。
 * - `announcement`：**UI-12 播报区要显示的内容**，三态且三态都真实存在：
 *   `string` = 播出这句话（失败原因）；`''` = **清除**（四道闸门全过的放行路径）；
 *   `null` = **保持不动**（段 A 的两种「没有字段级错误」分支：原先就是直接 return，
 *   从没碰过播报区，硬写 `''` 会多出一个原实现没有的清屏动作）。
 *
 * 页面侧因此只剩 4 行胶水（`setValidationAnnouncement` 与 `scrollToSection` **仍留在
 * 页面**：前者是 React state、后者是 DOM 工具，都不该进纯逻辑层）：
 *
 * ```ts
 * const gate = await runPreSubmitGates();
 * if (gate.announcement !== null) setValidationAnnouncement(gate.announcement);
 * if (gate.blocked) { if (gate.section) scrollToSection(ANCHOR[gate.section]); return; }
 * const values = gate.values;
 * ```
 *
 * ## 放行时**必须**把 `values` 交出去（不是顺手优化，是硬要求）
 *
 * 原实现的 `const values = form.getFieldsValue(true)` 落在段 B 的第一行，
 * 而它同时是段 C/D/E/G 的**唯一数据源**。四段搬走后若不把 `values` 带回来，
 * 页面就得再取一次 —— 而 `getFieldsValue(true)` 返回的是 **antd 的活 store 本体**
 * （`@rc-component/form` 的 `useForm`：`mergedNameList === true` 时直接 `return this.store`，
 * **不克隆**），段 E 的 `values.cronExpression = ...` / `w.start = ...` 是**原地改写**，
 * 必须在**同一个引用**上发生。故本 hook 放行时把该引用原样返回（**不展开、不克隆**），
 * 页面后续的 E/G 段照旧在活 store 上工作 —— 顺序与引用同一性都与搬移前逐字一致。
 *
 * 也正因如此，**段 E 不随本刀搬**：E 的原地改写与 G 的读必须落在同一个 `values`
 * 引用上，而 E 的副作用面（改活 store）与「校验」是两种语义；混进本 hook 会让
 * 「本 hook 只读」这条不变量失效，也会让 E/G 被拆到两个 hook 里各跑一次。
 *
 * ## 身份稳定性
 *
 * `runPreSubmitGates` 是**事件处理器链路**里的异步函数（点提交才调用），页面在
 * `submitTaskForm` 内部现调，不进任何 effect 依赖数组 ⇒ 无需 `useCallback` 固定身份。
 * 每次渲染重建只捕获当次渲染的 `form` / `executorMode` / `zipApplicationMissing`，
 * 与原 `submitTaskForm` 的闭包新鲜度完全相同（它也是每次渲染重建的）。
 *
 * ## 不变式（搬动不得破坏）
 *
 * 1. 本 hook **不写**表单字段、**不写** `dirty`、**不碰** `saving`、**不碰** ref ——
 *    四段原本就只读。唯一的写是 `message.error`（浮层）与 `form.scrollToField`（滚动）。
 * 2. 四道闸门的**顺序不可换**：validateFields → 必填兜底 → secrets 键名 → params 体积。
 *    secrets 必须在 params 之前（凭据分区先报），params 必须在 cron 规范化（段 E）之前
 *    （体积按**规范前**的原始值算，改后算会与后端口径错位）。
 * 3. 拦截时**不得**发起任何请求、**不得**改 `saving` —— 这是「提交前闸门」的定义。
 */
import type { FormInstance } from 'antd';
import { useTranslation } from 'react-i18next';
import { message } from '../../utils/toast';
import { showApiError } from '../../utils/error';
import { findInvalidSecretKeys } from '../../utils/secretKeyPolicy';
import type { ExecutorMode } from '../executor-mode';
import '../../i18n';

/**
 * F-10（UIAUDIT P3-3）：params 体积上限（64KB）的前端镜像，随闸门一起迁出。
 * 单一事实源在后端 admin-api `task/params-size.util.ts` 的 TASK_PARAMS_MAX_BYTES，
 * create/update/trigger/webhook 四入口统一按 JSON utf8 字节数 400；此处值必须
 * 与其保持一致（口径：JSON.stringify(params) 的 utf8 字节数）。
 */
export const TASK_PARAMS_MAX_BYTES = 65_536;

/**
 * 闸门读到的表单值：`form.getFieldsValue(true)` 的返回类型（**活 store 引用**）。
 * 刻意收成 `Record<string, unknown>` 而不是 `any`：闸门只做存在性判定与一次
 * `typeof === 'object'` 收窄，写成 unknown 能让「闸门不会把表单值当业务类型用」这件事
 * 由类型系统守住（页面侧的 E/G 段仍按原样读写同一引用）。
 */
export type TaskFormGateValues = Record<string, unknown>;

/**
 * 闸门失败时要滚到的**语义分区**（页面映射为 `SECTION_IDS[i]`，见 hook 头注释）。
 * 刻意不用 DOM id：闸门不该知道页面把哪个 div 放在哪。
 */
export type GateSection = 'basic' | 'trigger' | 'executor' | 'params';

/** 拦截来源（机读 id，用于测试与日志；见头注释「gate 字段」）。 */
export type PreSubmitGateId = 'form' | 'missing' | 'secretKeys' | 'paramsSize';

/** 拦截结果返回协议（判别联合：`blocked` 是唯一控制流信号）。 */
export type PreSubmitGateResult =
  | {
      blocked: true;
      gate: PreSubmitGateId;
      section: GateSection | null;
      /** `string` = 播出该句；`null` = 播报区保持原样（原实现这两条分支从未碰它） */
      announcement: string | null;
    }
  | {
      blocked: false;
      gate: null;
      section: null;
      /** 四道闸门全过 ⇒ 清除播报区（原实现此处为 `setValidationAnnouncement('')`） */
      announcement: '';
      /** antd 活 store 本体（非克隆）——段 E/G 依赖同一引用，见头注释 */
      values: TaskFormGateValues;
    };

/** 入参：闸门只读这些（**不写**表单字段 / 不写 dirty / 不碰 ref）。 */
export interface UseTaskFormValidationOptions {
  /** 本页的 antd 表单实例（validateFields / getFieldsValue(true) / scrollToField） */
  form: FormInstance;
  /** 执行器策略（自持 state，不在字段树里）：段 B 判定 `pinned` 必填 executorId */
  executorMode: ExecutorMode;
  /** zip 来源未选应用（页面派生量）：段 B 的最后一条兜底必填 */
  zipApplicationMissing: boolean;
}

/** 返回值：一个异步闸门（页面在 `submitTaskForm` 里现调）。 */
export interface TaskFormGateController {
  /** 跑完 A/B/C/D 四道闸门；`blocked=false` 时一并交出表单活 store 引用 */
  runPreSubmitGates: () => Promise<PreSubmitGateResult>;
}

export function useTaskFormValidation({
  form,
  executorMode,
  zipApplicationMissing,
}: UseTaskFormValidationOptions): TaskFormGateController {
  const { t } = useTranslation();

  // P0 (R8) 兜底保留为双保险：单页全挂载后 validateFields() 天然覆盖全部字段，
  // 以下 missing 收集逻辑在正常情况下永远为空集，仅作为防线存在。
  const runPreSubmitGates = async (): Promise<PreSubmitGateResult> => {
    // ── 段 A（L616-665 / 33 行 / 密度 54.5）：validateFields + 校验失败错误映射 ──
    try {
      await form.validateFields();
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'errorFields' in err) {
        // UI-12：antd 只在字段旁标红（读屏不主动播报），此处补一条可播报摘要。
        //
        // 但**只有**这条 aria-live 区域是不够的：它是 1×1px 的
        // screen-reader-only 元素（见下方 style），视力正常的用户提交失败后
        // 屏幕**毫无变化**——尤其当出错的字段在滚动视口之外时（本表单是单页
        // 多区块的长表单），用户会以为"按钮没反应"而反复点击。
        //
        // 故补两条可见反馈：一条浮层提示（与其它校验路径一致），以及滚到第一个
        // 出错字段。两者都不改判定逻辑，只是把已经发生的失败**显式呈现**出来。
        const fields = (err as { errorFields?: { errors?: string[]; name?: (string | number)[] }[] })
          .errorFields ?? [];
        const firstError = fields[0]?.errors?.[0];
        if (firstError) {
          // 原文案在「播报」与「浮层」两处逐字相同 ⇒ 收成一个局部量再复用，
          // 返回给页面的就是同一句（协议见头注释的 announcement 三态）。
          const failureText = t('taskForm.validate.failed', {
            firstError,
            more: fields.length > 1 ? t('taskForm.validate.more', { count: fields.length }) : '',
          });
          message.error(failureText);
          // 滚到第一个出错字段（antd 的 name 路径 → 该字段的 DOM 节点）。
          // 段 A 自己滚到字段级，故 section 返回 null（不叠分区滚动）。
          const namePath = fields[0]?.name;
          if (namePath && namePath.length > 0) {
            form.scrollToField(namePath, { behavior: 'smooth', block: 'center' });
          }
          return { blocked: true, gate: 'form', section: null, announcement: failureText };
        }
        // 没有可读的字段级错误时也要给一条反馈，绝不静默 return。
        // 原实现在这条分支上**没有**碰播报区 ⇒ announcement 返回 null（保持原样）。
        message.error(t('taskForm.validate.fail'));
        return { blocked: true, gate: 'form', section: null, announcement: null };
      }
      // UX-11（本轮体验审查）：此前手写 `err instanceof Error ? err.message : ...`。
      // 它比直接取 `e.message` 好，但仍绕过了全站归一：axios 错误的 `message`
      // 是 "Request failed with status code 400" 这类英文技术串，真正的业务
      // 原因在 `response.data.message` 里。getErrMsg 同时覆盖这两种形状，且
      // 原文件本就导入了它（同页其它错误路径已在用）——同页两套文案
      // 才是问题所在。
      showApiError(err, t('taskForm.validate.fail'));
      return { blocked: true, gate: 'form', section: null, announcement: null };
    }

    // ── 段 B（L666-693 / 24 行 / 密度 45.8）：必填兜底收集 ──────────────────
    // 注：活 store 引用，放行时原样交回页面（段 E/G 必须在同一引用上工作）。
    const values = form.getFieldsValue(true) as TaskFormGateValues;
    const missing: { label: string; section: GateSection }[] = [];
    if (!values.name) missing.push({ label: t('taskForm.field.name'), section: 'basic' });
    if (!values.runtime) missing.push({ label: t('taskForm.field.runtime'), section: 'basic' });
    if (!values.entrypoint) {
      missing.push({ label: t('taskForm.field.entrypoint'), section: 'basic' });
    }
    if (values.triggerType === 'cron' && !values.cronExpression) {
      missing.push({ label: t('taskForm.field.cron'), section: 'trigger' });
    }
    if (values.triggerType === 'fixed_rate' && !values.fixedRate) {
      missing.push({ label: t('taskForm.field.fixedRate'), section: 'trigger' });
    }
    if (executorMode === 'pinned' && !values.executorId) {
      missing.push({ label: t('taskForm.field.executorId'), section: 'executor' });
    }
    // python_task_multiversion（FR-18）：zip 来源必须关联应用。缺了它后端
    // assertCodeSourceConsistent 会 400，但那时用户只看到一条接口错误；
    // 在这里拦下并滚到字段旁，与其它必填项一致的体验。
    if (zipApplicationMissing) {
      missing.push({ label: t('taskForm.field.applicationId.zipRequired'), section: 'basic' });
    }
    if (missing.length > 0) {
      const missingList = missing.map((m) => m.label).join(t('common.listSep.comma'));
      message.error(t('taskForm.missing', { list: missingList }));
      // UI-12：同步播报到 role="status" 区域（视觉路径=浮层 + 锚点滚动）。
      // 播报文本经协议回页面（`announcement`），滚动分区取**第一条**缺项（原为
      // `missing[0].anchor`，即同一语义）。
      return {
        blocked: true,
        gate: 'missing',
        section: missing[0].section,
        announcement: t('taskForm.missingShort', { list: missingList }),
      };
    }

    // ── 段 C（L694-708 / 10 行 / 密度 30）：secrets 键名镜像校验 ──────────────
    // F-7（UIUX 审计 P2-6）：secrets 键名镜像校验。后端 IsSecretKeyMapConstraint
    // 对载荷里**每个键**（含 null=删除叶子的键）做规则判定，任一不合法整批 400
    // ——此处用同一套规则（utils/secretKeyPolicy.ts，源码守卫钉住两侧一致）
    // 在提交前拦下并滚到凭据分区，避免「既有合法键的修改被一并拒收」的体验。
    // 行内即时红字在 SecretsEditor；这里是绕过 UI（粘贴/程序化）时的最后闸门。
    if (values.secrets && typeof values.secrets === 'object') {
      const badSecretKeys = findInvalidSecretKeys(values.secrets as Record<string, unknown>);
      if (badSecretKeys.length > 0) {
        const badList = badSecretKeys.map((b) => `"${b.key}"`).join(t('common.listSep.comma'));
        message.error(t('taskForm.secrets.invalidKeys', { list: badList }));
        return {
          blocked: true,
          gate: 'secretKeys',
          section: 'params',
          announcement: t('taskForm.secrets.invalidKeysShort', { list: badList }),
        };
      }
    }

    // ── 段 D（L709-729 / 15 行 / 密度 40）：params 64KB 前端预检 ──────────────
    // F-10（UIAUDIT P3-3）：params 体积 64KB 前端预检。后端
    // admin-api task/params-size.util 的 TASK_PARAMS_MAX_BYTES=65_536 对
    // create/update/trigger/webhook 四个入口统一 400（taskParamsByteSize 按
    // JSON utf8 字节数计）；此前超限只在提交后收到一条裸 400。这里以同一口径
    // （JSON.stringify utf8 字节，TextEncoder）在提交前拦下并滚到参数分区。
    if (values.params != null) {
      let byteSize: number;
      try {
        byteSize = new TextEncoder().encode(JSON.stringify(values.params) ?? '').length;
      } catch {
        // 循环引用等序列化失败：后端同样按「不可序列化=超限」处理，交后端 400。
        byteSize = Number.POSITIVE_INFINITY;
      }
      if (byteSize > TASK_PARAMS_MAX_BYTES) {
        const sizeText = Number.isFinite(byteSize) ? String(byteSize) : '∞';
        message.error(
          t('taskForm.params.tooLarge', { size: sizeText, max: String(TASK_PARAMS_MAX_BYTES) }),
        );
        return {
          blocked: true,
          gate: 'paramsSize',
          section: 'params',
          announcement: t('taskForm.params.tooLargeShort', {
            size: sizeText,
            max: String(TASK_PARAMS_MAX_BYTES),
          }),
        };
      }
    }

    // 四道闸门全过：播报区清除（原 `setValidationAnnouncement('')` 由协议承担），
    // 活 store 引用原样交出（段 E 的原地改写必须落在这个引用上）。
    return { blocked: false, gate: null, section: null, announcement: '', values };
  };

  return { runPreSubmitGates };
}

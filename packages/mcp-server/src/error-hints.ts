/**
 * R145：**已知后端错误码 → 成因 + 下一步**（写给**模型**读，不是写给终端用户）。
 *
 * ## 治的是什么
 *
 * R143 让 `trigger_task` 能带 `consumeNextFirePoint`，但被拒时 MCP 只把后端的 HTTP
 * 错误透传出去：模型看到的是 `API error (409): <后端文案>`——**为什么**被拒、
 * **下一步**该做什么，全在它自己猜。CLI 侧早有这层（`packages/acf-cli/src/
 * error-code.ts`），MCP 侧没有。
 *
 * 口径与 CLI 一致：**未知码 / 无码一律不追加任何文本**（`formatBackendErrorHint`
 * 返回 `null` ⇒ 调用方既有输出逐字节不变）。理由同 CLI：猜一个原因比不说更容易
 * 误导，而历史文案被大量用例钉住。
 *
 * ## 事实源与对应关系（改这张表**前**先核这四处）
 *
 * | 事实 | 位置 |
 * |---|---|
 * | 错误码字典（`status` / `zh` / `en`）——真值源 | `apps/admin-api/src/common/errors/catalog/task.ts:131-153`（`TASK_FIRE_POINT_NOT_CRON` / `_UNRESOLVABLE` / `_ALREADY_CONSUMED`） |
 * | 前端 i18n 生成物（**生成，勿手改**） | `apps/admin-web/src/locales/generated/error-codes.{zh,en}.ts:358-360` |
 * | CLI 的**分类**口径（6 类：conflict / validation / …） | `packages/acf-cli/src/error-code.ts:106`（`ALREADY_` ⇒ conflict）、`:123`（`_NOT_CRON` / `FIRE_POINT_UNRESOLVABLE` ⇒ validation） |
 * | 后端抛点（`params` 的真实形状） | `apps/admin-api/src/modules/task/task.service.ts:2881-2945`（`{ triggerType }` / `{ cronExpression }` / `{ firePointAt }`） |
 *
 * 复核命令（本表与后端漂移时先跑这三条，再改本表）：
 *
 * ```bash
 * grep -n "TASK_FIRE_POINT_" apps/admin-api/src/common/errors/catalog/task.ts
 * grep -n "TASK_FIRE_POINT_" apps/admin-web/src/locales/generated/error-codes.zh.ts
 * grep -n "FIRE_POINT" packages/acf-cli/src/error-code.ts
 * ```
 *
 * ## 为什么是「MCP 包内第二份」，而不是直接读上面某一份
 *
 * 三个候选都被否决，逐个说明（这是取舍，不是偏好）：
 *
 * ① **读 `apps/admin-web/src/locales/generated/*`** ——不可行，不只是"耦合"：
 *    本包 `tsconfig.json` 是 `rootDir: ./src`，跨树相对导入直接 TS6059（同一条约束
 *    已记在 `tools/shared.ts` 的 MCP-DTO-ALIGN 注释里）；且本包发布物只有 `dist`
 *    （`package.json` 的 `files`），运行时 `dist/error-hints.js` 解析不到另一个 app
 *    的 `src`。要能读就得改构建/发布形态——代价远大于三条文案。
 * ② **读 `apps/admin-api/.../catalog/task.ts`** ——同上，且那是 NestJS 应用的内部
 *    源码，不是可发布依赖。
 * ③ **复用 `packages/acf-cli/src/error-code.ts`** ——CLI 给的是**按类别的一句话**
 *    （`CATEGORY_HINTS`），不是按码的成因；对 `consumeNextFirePoint` 这种"被拒了该
 *    怎么办"的具体问题，`"re-read it with acf ... get"` 是错的建议（重读不会让登记
 *    变可消耗）。跨包相对导入同样违反 `rootDir`。
 *
 * ⇒ 本表是**显式的第二份**，只收「裸 HTTP 状态会误导」的码（当前 3 条，均为 A6b），
 * **刻意不做全量码表**：三百多个码逐条写成因必然腐化（CLI 头注同款结论）。
 * `category` 与 CLI 的 6 类口径对齐，便于并排核对。**新增/改名错误码时两边都要看。**
 *
 * 语言：**英文**。MCP 的全部工具文案与错误面（401/403/404 的 next-step）都是英文，
 * 输出对象是模型；中文文案的真值源是码表 `zh` 字段 + 前端生成物（那是**用户界面**
 * 的事实源）。这里不是再抄一份中文，而是补"为什么 + 下一步"这一层说明。
 */

/** 与 CLI `ApiErrorCategory`（error-code.ts:22-28）对齐的两个子集，仅覆盖本表用到的类。 */
export type BackendErrorCategory = "conflict" | "validation";

/** 错误体里的 `params`（形状由后端抛点决定，未断言前一律当作可选）。 */
export type ErrorCodeParams = Record<string, unknown> | undefined;

export interface BackendErrorHint {
  /** 与 CLI 分类口径一致（conflict = 状态冲突，重读再决定；validation = 改入参就能过）。 */
  readonly category: BackendErrorCategory;
  /** 为什么被拒（写给模型：把它当成因果解释，而不是另一句报错）。 */
  readonly cause: (params: ErrorCodeParams) => string;
  /** 下一步做什么（具体到工具与字段；重复同一个请求不会变好时要明说）。 */
  readonly nextStep: string;
}

/** 取一个字符串型插值参数；缺 / 空 / 非字符串 ⇒ null（不写 `undefined` 到文案里）。 */
function paramString(params: ErrorCodeParams, key: string): string | null {
  const value = params?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * 码 → 成因/下一步。**键必须逐字等于后端错误码**（大小写敏感，后端恒为大写——
 * CLI 是 `toUpperCase()` 后按正则匹配，本表是精确查表，不做归一）。
 */
export const BACKEND_ERROR_HINTS: Readonly<Record<string, BackendErrorHint>> = {
  // A6b：`resolveConsumedFirePoint` 的第一道门（task.service.ts:2881-2886）——
  // 非 cron 任务没有「计划落点」可消耗。后端**故意**报 400 而不是静默忽略：
  // 静默忽略会让调用方以为这一跑顶掉了下一个落点，而实际上到点仍会照常跑。
  TASK_FIRE_POINT_NOT_CRON: {
    category: "validation",
    cause: (params) => {
      const triggerType = paramString(params, "triggerType");
      return (
        `consumeNextFirePoint was rejected because this task's trigger type is ` +
        `${triggerType ? `"${triggerType}"` : "not cron"} — only cron tasks have scheduled ` +
        `fire points, so fixed_rate / webhook / manual schedules have nothing to consume ` +
        `(refused rather than silently ignored, otherwise you would believe a fire point ` +
        `was skipped while it actually still runs)`
      );
    },
    nextStep:
      `Either retry without consumeNextFirePoint (a plain manual run — no scheduled fire ` +
      `point is consumed), or switch the task to a cron trigger with update_task ` +
      `(triggerType=cron + a valid cronExpression) and retry — resending the same request ` +
      `unchanged fails the same way`,
  },

  // A6b：第二道门（task.service.ts:2887-2892）——cron 表达式为空/非法 ⇒ 算不出落点。
  TASK_FIRE_POINT_UNRESOLVABLE: {
    category: "validation",
    cause: (params) => {
      const cron = paramString(params, "cronExpression");
      return (
        `the next scheduled fire point cannot be computed because the task's cron ` +
        `expression is ${cron ? `"${cron}"` : "empty"} (empty or invalid), so there is no ` +
        `fire point to consume`
      );
    },
    nextStep:
      `Fix the schedule first: update_task with a valid 5-field cronExpression (and timezone ` +
      `if the schedule depends on it), confirm it with get_task, then retry — resending the ` +
      `same request unchanged fails the same way`,
  },

  // A6b：已有**未消耗**的登记时再次请求（task.service.ts:2919-2945，条件 UPDATE
  // affected=0）⇒ 409。不静默覆盖：覆盖会丢掉「上一拍已答应跳过」的承诺。
  // 登记的三条清除路径（决定 nextStep 的说法）：
  //   · 到点：scheduler.service.ts:3000-3011 原子「判定+清除」⇒ 那一拍被跳过；
  //   · 改 cron/时区：task.service.ts:2471-2476 ⇒ 旧登记不再成立，清掉；
  //   · 本次入队失败：task.service.ts:2844-2845 按登记值 CAS 清（与并发登记隔离）。
  // 另：**不带** consumeNextFirePoint 的普通触发不清登记（trigger 里只有
  // `dto.consumeNextFirePoint === true` 才写那一列）。
  TASK_FIRE_POINT_ALREADY_CONSUMED: {
    category: "conflict",
    cause: (params) => {
      const firePointAt = paramString(params, "firePointAt");
      return (
        `this task already carries an unconsumed fire-point registration` +
        `${firePointAt ? ` (registered fire point: ${firePointAt})` : ""} — the earlier ` +
        `consumeNextFirePoint promise is still owed, so a second registration is refused ` +
        `rather than silently overwriting it (overwriting would drop the skip that was ` +
        `already promised for the previous fire point)`
      );
    },
    nextStep:
      `Do not resend it blindly: the registration clears by itself when that fire point is ` +
      `reached (the scheduler then skips that one run), or immediately when update_task ` +
      `changes cronExpression/timezone (the stale registration is dropped). If you only need ` +
      `a run right now, trigger again WITHOUT consumeNextFirePoint — a plain manual run does ` +
      `not consume the pending registration`,
  },
};

/**
 * 命中已知码 ⇒ 返回**带前导空格**的追加片段（`[CODE · category] cause: … — next: …`）；
 * **未知码 / 非字符串 / 空串 ⇒ `null`**（调用方据此逐字节保持现状，绝不猜）。
 */
export function formatBackendErrorHint(
  errorCode: unknown,
  params?: Record<string, unknown>,
): string | null {
  if (typeof errorCode !== "string" || errorCode.length === 0) return null;
  // hasOwn：防止 `constructor` / `toString` 之类的原型键被当成"已知码"命中。
  if (!Object.prototype.hasOwnProperty.call(BACKEND_ERROR_HINTS, errorCode)) {
    return null;
  }
  const hint = BACKEND_ERROR_HINTS[errorCode];
  return (
    ` [${errorCode} · ${hint.category}] cause: ${hint.cause(params)} — next: ${hint.nextStep}`
  );
}

/**
 * LANG-ERR-01：错误码**分片**的类型契约与模板渲染。
 *
 * ## 为什么要把码表拆成多个文件
 *
 * 「全量错误码化」要把 admin-api 约 420 处、执行器约 141 处抛点迁到
 * `AppError(码, 参数)`，码表随之从 19 个涨到数百个。若所有码都写在同一个
 * `error-codes.ts` 里，**多人/多 agent 并行迁移时必然互相覆盖**
 * （各自 read-modify-write 同一文件，后写者静默丢掉前者的新增码——本仓已有
 * 一次真实教训：并发改控制器时 `prettier --write` 的读改写差点覆盖他人改动）。
 *
 * 故按**域**分片：每个迁移者只写自己那一片（`catalog/<域>.ts`），合并点唯一
 * （`error-codes.ts`）。分片之间**零耦合**，只共享本文件的类型。
 *
 * ## 为什么渲染函数也在这里（而不是在合并点）
 *
 * 分片只需要 `ErrorCodeDef` 类型，不需要任何运行时依赖；把 `renderTemplate`
 * 放在这里可以让分片的语汇自洽（写码的人能就近看到占位符规则），也避免
 * `catalog/* → error-codes.ts → catalog/*` 的循环 import。
 */

/** 单个错误码的定义。 */
export interface ErrorCodeDef {
  /** HTTP 状态码（写入响应体既有的数字 `code`）。 */
  status: number;
  /**
   * 中文人读文案模板。占位符语法是 **`{{name}}`（双花括号）**，与前端 i18next
   * 的 interpolation prefix/suffix **必须一致**——否则会出现"后端能插值、
   * 前端渲染出未替换的原文"这种半失效（首版用单花括号 `{name}` 时真实踩到，
   * 由 `error-code-i18n.test.ts` 的插值用例抓出）。
   *
   * 这是**服务端兜底文案**：服务裸 API / CLI / MCP / 日志 / 落库字段等不翻译的
   * 消费者，故必须始终存在且自足（详见 `error-codes.ts` 的说明）。
   */
  zh: string;
  /**
   * 英文文案模板（同样的 `{{name}}` 占位语法）。
   *
   * ## 为什么 en 也放在后端码表里，而不是只写在前端 locale
   *
   * 因为前端 locale 的 `err.*` 词条是**生成**出来的（`scripts/gen-error-i18n.mjs`
   * 从本码表生成 `locales/error-codes.{zh,en}.ts`）。把两种语言收在**同一个**
   * 码定义里，等于：
   *   · 新增一个码只需改**一处**（不存在"后端加了码、前端忘了加词条"的窗口，
   *     那正是最隐蔽的失效形态：英文用户悄悄看到中文兜底，而 zh 用户完全正常）；
   *   · zh 与 en 的**占位符**由同一条定义约束，不会出现"中文用 {{id}}、英文写成
   *     {id}"这种只有切到英文才暴露的插值错；
   *   · 生成物可做**漂移门禁**（生成后比 diff），与 `gen:api-types` 同款纪律——
   *     而不是靠人记得两边都改。
   *
   * ⚠️ 与 `zh` 不同，`en` **不会被服务端用于响应**（响应固定给 `zh` 兜底，
   * 用户语言由前端决定）。它只作为生成前端英文词条的源。
   */
  en: string;
}

/**
 * 把 `{{name}}` 占位替换成 `params.name`。
 *
 * 容错纪律（每条都有真实触发场景）：
 *   · 缺参 → **保留占位原文**（`{{id}}`）而不是替换成 `undefined`/空串。这样
 *     运维一眼能看出"这条消息漏传了参数"，而不是读到一句读得通但意思残缺的
 *     文案（后者会被当成正常文案，永远发现不了）；
 *   · 值含 `$&` 等替换模式特殊串 → 用**函数式** replace 而非字符串式，避免
 *     `String.replace` 把 `$&` 当反向引用（否则参数里带 `$&` 会污染文案）；
 *   · 对象值 → `JSON.stringify`（直接 `String()` 会得到 `[object Object]`，
 *     信息量为零）；
 *   · `null`/`undefined` 值 → 同"缺参"处理（保留占位）。
 */
export function renderTemplate(
  template: string,
  params?: Record<string, unknown> | null,
): string {
  if (!params) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => {
    if (!(key in params)) return whole;
    const v = params[key];
    if (v === null || v === undefined) return whole;
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  });
}

/**
 * FEAT-10: 通知模板渲染引擎（纯函数，零依赖）。
 *
 * 渠道级模板存放在渠道 config（titleTemplate / contentTemplate 两个可选
 * 键，走既有 NotificationConfigService 内存注册表 + ChannelConfigStore 写穿
 * 机制——不落库、零迁移）。发送侧在渠道配置了模板时用本函数替换固定拼串；
 * 未配置走原拼串，渲染失败 fail-open 回退默认文案。
 *
 * 设计约束（任务书 + 评审语义）：
 * 1. **单 pass 替换**：一次遍历正则替换，替换值中的 `{{...}}` 不再展开——
 *    天然阻断 `{{a}} → {{b}} → ...` 递归注入（变量值来自任务日志/错误信息，
 *    是不可信输入）。
 * 2. **未知变量保留原文**：`{{nope}}` 原样留在输出里，便于配置者发现拼写
 *    错误，而不是静默吞掉。
 * 3. **8KB 输出上限**：超限截断并追加截断标记，防止异常大的日志摘要把
 *    钉钉/企业微信消息体撑爆（各渠道自身也有上限，这里是全局兜底）。
 * 4. 变量值 null/undefined → 空串（可选语义）；其他类型 String() 化。
 */

/** 输出上限：8KB（按 UTF-8 码元计，与 JS string.length 同口径的保守近似）。 */
export const TEMPLATE_MAX_BYTES = 8 * 1024;

/** 截断标记（追加在超限输出尾部）。 */
export const TEMPLATE_TRUNCATION_SUFFIX = "\n…[已截断: 超过 8KB 模板输出上限]";

/** 模板占位符：`{{ variableName }}`（两侧空白容忍）。 */
const TEMPLATE_VAR_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/**
 * 渲染模板。单 pass：先收集所有占位符位置再一次性拼接，替换值内部的
 * `{{...}}` 不参与二次展开（防递归注入）。
 *
 * @param template 模板串（含 `{{var}}` 占位符）；空/非串返回空串
 * @param vars 变量表；值 null/undefined 渲染为空串
 * @returns 渲染结果；超过 8KB 截断并追加截断标记
 */
export function renderTemplate(
  template: string | undefined | null,
  vars: Record<string, string | number | null | undefined>,
): string {
  if (!template || typeof template !== "string") return "";

  const resolve = (name: string): string => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) {
      // 未知变量保留原文（配置拼写错误的可见性）
      return `{{${name}}}`;
    }
    const value = vars[name];
    if (value === null || value === undefined) return "";
    return String(value);
  };

  // 单 pass：用 replace 的回调一次性完成——替换值里新出现的 {{...}} 不会被
  // 重新扫描（String.replace 只按原串匹配位置替换，不重扫替换值）。
  let out = template.replace(TEMPLATE_VAR_RE, (_m, name: string) =>
    resolve(name),
  );

  if (out.length > TEMPLATE_MAX_BYTES) {
    out = out.slice(0, TEMPLATE_MAX_BYTES) + TEMPLATE_TRUNCATION_SUFFIX;
  }
  return out;
}

/**
 * FEAT-10: 判断渠道 config 是否配置了任一模板键。
 * 仅当值为非空字符串时才算配置（空串等价未配置，走默认拼串）。
 */
export function hasChannelTemplate(
  config: Record<string, string> | undefined,
): boolean {
  if (!config) return false;
  return (
    (typeof config.titleTemplate === "string" &&
      config.titleTemplate.length > 0) ||
    (typeof config.contentTemplate === "string" &&
      config.contentTemplate.length > 0)
  );
}

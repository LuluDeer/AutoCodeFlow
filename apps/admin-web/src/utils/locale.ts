import i18n from '../i18n';

/**
 * F-26（DEEP_REVIEW 0ef3bbe）：全站日期时间格式化的 locale 单一来源。
 *
 * 此前约 24 处散落硬编码 `toLocaleString('zh-CN')`——英文界面下日期/时间仍是
 * 中文排版，与 antd ConfigProvider 已跟随 i18n 的语言切换不一致。现统一由
 * 当前 i18n 语言推导（zh→zh-CN，en→en-US），与 ThemeProviders.tsx 选择 antd
 * locale 的口径同源。
 *
 * 默认语言是 zh（产品基线），故默认输出与原先硬编码 'zh-CN' 逐字一致——既有
 * 测试与快照零回归。
 */
export function currentLocale(): string {
  return (i18n.language || 'zh').startsWith('en') ? 'en-US' : 'zh-CN';
}

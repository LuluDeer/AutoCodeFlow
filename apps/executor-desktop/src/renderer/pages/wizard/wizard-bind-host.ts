/**
 * R5-T1：向导「监听地址（bind host）」的单一真源（纯函数，无 React / DOM / IPC）。
 *
 * 向导界面没有 executorHost 输入位（设置页才有），重跑向导时必须沿用已存值，
 * 首次安装读不到配置时回落固定默认 0.0.0.0。此前 checkPort() 硬编码 '0.0.0.0'
 * 而 finish() 读 wizardCfg，两处口径会漂：本机仅允许回环（127.0.0.1）时，
 * 端口检查给出的是另一张网卡的结论；保存目标又无法在向导页核对。
 *
 * 现在两处都调用本函数，且完成页把同一结果展示出来，三点同源。
 */

/** 缺省监听地址：与 config-store 的 executorHost 默认值一致。 */
export const DEFAULT_WIZARD_BIND_HOST = '0.0.0.0';

/**
 * 已存监听地址非空即沿用；空值 / 非字符串 / 纯空白一律回落默认。
 *
 * 入参刻意收窄为 unknown：调用方拿到的是 IPC 配置对象（Record<string, unknown>），
 * 字段类型由主进程写入方决定，脏值必须安全回落而不是把意外值送进 bind 或探针。
 * 合法值原样返回（不 trim），保证与已落盘配置逐字节一致；只有「纯空白」被
 * 视为未配置（它不可能是合法 host）。
 */
export function wizardBindHost(savedHost: unknown): string {
  return typeof savedHost === 'string' && savedHost.trim() !== ''
    ? savedHost
    : DEFAULT_WIZARD_BIND_HOST;
}

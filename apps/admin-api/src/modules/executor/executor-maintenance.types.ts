/**
 * `ExecutorMaintenance` 的最小型依赖类型。
 *
 * 为什么单独一个文件：`ExecutorService` 的构造器参数是 `SystemConfigService`
 * 的具体类，而协作者只需要 `findOne(key)` 一个方法。把最小面抽成类型可以
 * 避免协作者 → 具体 service 的强依赖（也避免循环 import）。
 */

/** `system_configs` 的运行期配置读取面（`SystemConfigService` 的子集）。 */
export interface ExecutorRetentionConfigReader {
  /**
   * 按 key 读一条运行期配置。
   *
   * 缺失/读失败时返回 `null`/`undefined`（协作者按"未配置"回落缺省值）。
   */
  findOne(key: string): Promise<{ value?: string | null } | null>;
}

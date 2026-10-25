/**
 * P2-2：域名白名单条目的共享校验（纯函数，无依赖——runtime / browser /
 * config-sanitize 三处共用同一份语义，杜绝各写各的正则漂移）。
 *
 * ## 为什么单标签必须拒
 * 执行器侧的子域匹配是 `host.endsWith('.' + domain)`：白名单里一个单标签
 * `"com"` 会把匹配放大成放行**一切** `*.com`——攻击面从「SOP 声明的域」
 * 塌缩成「半个互联网」。要求至少含一个点后，`"com"` 在入口（config 消毒、
 * runtime 白名单并集、browser 会话构造）就被剔除，匹配层永远见不到它。
 *
 * ## 字形规则（与 admin-api sop-frontmatter.ts 的裸域名正则对齐）
 *  - 至少一个点、首尾不得为点（`.com` / `com.` 拒）；
 *  - 字符白名单 [a-z0-9.-]（先小写化；协议/路径/通配符/下划线/Unicode 一律拒）；
 *  - 每个标签非空且不以 `-` 开头/结尾（`a..com`、`-a.com`、`a-.com` 拒）；
 *  - 全长 ≤253（DNS 域名上限）。
 */

const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** 是否是可安全进入导航白名单的裸域名（输入不信任：先 trim + 小写化）。 */
export function isValidAllowlistDomain(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const d = value.trim().toLowerCase();
  if (d.length === 0 || d.length > 253) return false;
  return DOMAIN_PATTERN.test(d);
}

/** 过滤一份白名单候选：返回合法条目（去重、小写化）与被拒条目（供 warn/审计）。 */
export function filterAllowlistDomains(values: readonly unknown[]): {
  valid: string[];
  invalid: string[];
} {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const v of values) {
    if (isValidAllowlistDomain(v)) {
      const d = (v as string).trim().toLowerCase();
      if (!valid.includes(d)) valid.push(d);
    } else if (typeof v === 'string' && v.trim() !== '') {
      if (!invalid.includes(v)) invalid.push(v);
    }
    // 非字符串/空白条目静默丢弃——那是形状错误，不是域名单
  }
  return { valid, invalid };
}

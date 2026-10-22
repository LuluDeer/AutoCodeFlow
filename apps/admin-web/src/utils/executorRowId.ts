/**
 * ADR-017 阶段 3（决策 §7）+ 生产报告 2026-10-22 §8.3 工单 10：执行器**行 id** 的
 * 短形态（前 8 位），供列表/部署/执行记录等读面在名字旁标注。
 *
 * 为什么需要：阶段 3 允许 pull 模式**同址多行**（两台机器同网段同 IP 各自成行），
 * 于是「名字 + 地址」这一对**不再唯一**——同名的两份安装、或 DHCP 复用同一 IP 的
 * 两台机器，在界面上会长得一模一样。行 id（`executors.id`）是唯一稳定的区分符，
 * 也是告警/审计里出现的那个 id 的前缀。
 *
 * 只截 8 位：uuid 前 8 位已足够人眼区分（同一屏不会出现两份前 8 位相同的行），
 * 又短到能和名字放同一行；完整 id 始终放在 tooltip 里（复制/排障要用全值）。
 */
export function shortExecutorRowId(id?: string | null): string | null {
  if (typeof id !== 'string') return null;
  const trimmed = id.trim();
  return trimmed ? trimmed.slice(0, 8) : null;
}

/**
 * P3-5：对外地址的网卡判定共享纯函数（无 React / DOM / Electron 依赖）。
 *
 * 逻辑自 Wizard.tsx 的 D-04 实现抽取（原 `pickRecommendedIp` 仅向导私有）：
 * 排除链路本地（169.254.*）与回环（127.*）后取第一个地址——这两类地址
 * 注册到中台后永远不可达（中台侧 reserved 拒绝/无法回连），不能作为
 * 「对外地址」的自动填充值。
 *
 * 消费方：
 *   · Wizard StepExecutor（D-04 原语义：自动填入 + 推荐徽标）；
 *   · ConfigPage（P3-5：失焦自动填充与 IP 快速选择 chips 同步过滤——
 *     此前设置页取 localIPs[0]，第一块网卡是链路本地/回环时会填出
 *     不可注册地址，与向导口径漂移）。
 */

/** 链路本地（169.254.*）与回环（127.*）：不可作为对外注册地址。 */
export function isLocalOrLinkLocalIp(ip: string): boolean {
  return ip.startsWith('169.254.') || ip.startsWith('127.');
}

/** 过滤出可对外注册的网卡地址（保持原顺序）。 */
export function filterRecommendedIps(ips: string[]): string[] {
  return ips.filter((ip) => !isLocalOrLinkLocalIp(ip));
}

/** 推荐网卡：第一个非链路本地/回环地址；全部被排除时返回 null。 */
export function pickRecommendedIp(ips: string[]): string | null {
  return filterRecommendedIps(ips)[0] ?? null;
}

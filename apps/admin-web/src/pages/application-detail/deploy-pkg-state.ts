/**
 * R150（F1）：「下发到设备」弹窗的**快照包地址三态**判定（纯函数，零 React）。
 *
 * ## 为什么单独成文件
 *
 * `react-refresh/only-export-components` 守卫要求「组件文件只导出组件」——
 * 纯函数与组件同文件会触发 warning。本文件只放纯判定逻辑，组件文件
 * （`DeployToDevicesModal.tsx`）只导出组件。
 *
 * ## 语义（**核心纪律：读失败 ≠ 确实没有**）
 *
 * 下发前展示的 packageUrl 提示，事实上有**三**种，不是两种：
 *
 *   · `present`  —— 已确认：快照**含**包地址（会随快照恢复回应用）。
 *   · `missing`  —— 已确认：快照**不含**包地址 ⇒ 本次下发不会回退安装包。
 *   · `unknown`  —— **未确认**：读失败（readFailed）或本次版本记录里定位不到
 *     该版本行（notLocated）。
 *
 * 「unknown」此前被静默吞掉（页面侧 `catch(() => null)` 后什么都不显示），
 * 用户无法区分「这份快照确定没有包地址（安全）」与「我们没读到（未知）」。
 * 未知状态下「本次下发会不会回退安装包」是真的不知道 ⇒ 必须可见。
 */
import type { AppReleasesPage } from '../../api/applications';

/** 快照包地址的确认状态（三态，别把「未知」混进「没有」）。 */
export type DeployPkgState =
  /** 未确认：读失败（readFailed）或本次版本查询结果里定位不到该版本（notLocated）。 */
  | { kind: 'unknown'; reason: 'readFailed' | 'notLocated' }
  /** 已确认：快照**不含**包地址 ⇒ 本次下发不会回退安装包。 */
  | { kind: 'missing' }
  /** 已确认：快照含包地址。 */
  | { kind: 'present'; url: string };

/**
 * 由 /releases 的读取结果解析快照包地址状态。
 *
 * `releases === null` ⇒ 版本记录读取失败（页面侧 catch 后的约定）⇒ 未知。
 * 定位不到目标版本行 ⇒ 未知（版本记录可能超出本次查询窗口；此时**不能**说
 * 「快照不含包地址」——那会把「没读到」说成「确定没有」）。
 */
export function resolveDeployPkgState(
  releases: AppReleasesPage | null,
  versionId: string,
): DeployPkgState {
  if (!releases) return { kind: 'unknown', reason: 'readFailed' };
  const release = releases.data.find((r) => r.id === versionId);
  if (!release) return { kind: 'unknown', reason: 'notLocated' };
  if (typeof release.packageUrl === 'string' && release.packageUrl) {
    return { kind: 'present', url: release.packageUrl };
  }
  return { kind: 'missing' };
}

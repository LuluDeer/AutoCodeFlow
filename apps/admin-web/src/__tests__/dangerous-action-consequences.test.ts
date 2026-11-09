/**
 * R188（P3-7 / P3-8 / P3-9）· 三条「危险操作缺后果说明」的回归钉子。
 *
 * ## 三条的共同形态
 *
 * **不可逆动作的确认框只问「确定吗」，不告诉用户后果** ⇒ 用户按自己的直觉理解代价，
 * 而真相是**另一个方向**的代价。三条分别是：
 *
 * | 条目 | 位置 | 此前 | 现在 |
 * |---|---|---|---|
 * | **P3-9** | `TaskListPage`（**移动端** ≤768px）删任务 | 只有「确认删除？」 | 补「**正在执行中的运行将被强制终止**」 |
 * | **P3-7** | `ExecutionsPage` 终止**运行中**的执行 | `description` 是 `undefined`（**waiting 反而有**） | running 分支也有说明 |
 * | **P3-8** | `AppDeploymentPage` 单行「升级」 | **零确认**，点了就重启设备上的实例 | 加 `Popconfirm` + 后果说明 |
 *
 * ## 为什么 P3-9 / P3-7 是「漏写」而不是「设计取舍」
 *
 * · P3-9：**桌面端已有同一句**（`task-list-columns.tsx` 的 `deleteForceTerminateDesc`）⇒
 *   同一不可逆动作在两个断点**两套文案** ⇒ 漏写；
 * · P3-7：**waiting 分支已有说明**，running 分支没有 ⇒ 而**终止 running 比取消排队更危险**
 *   （不可恢复）⇒ 分支口径反了；
 * · P3-8：同页「升级所有」**有** Modal + 后果说明（`upgradeAllDesc` 明写「git pull + 重启」），
 *   而**同一粒度族的单行升级没有** ⇒ 口径分裂。
 *
 * ## 判据
 *
 * ① 三处的确认面**都含后果说明**（而不是只有 title）；
 * ② **正例控制组**：P3-7 的 waiting 分支**仍保留**它原有的说明（改 running 分支不能动 waiting）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (rel: string): string =>
  readFileSync(join(__dirname, "..", rel), "utf8");

/** 去掉注释与字符串，避免注释里的词条名被误判为「代码里用了」。 */
const codeOnly = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

describe("R188（P3-7 / P3-8 / P3-9）· 危险操作的确认必须写明后果", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.clearAllMocks());

  it("① P3-9：移动端删除任务的确认框**必须带**后果说明（与桌面端同一句）", () => {
    const src = codeOnly(read("pages/TaskListPage.tsx"));
    // 移动端分支（`isMobile`）里的删除 Popconfirm 必须有 description
    const mobile = /isMobile[\s\S]*?deleteConfirm[\s\S]{0,400}?\/>\s*Popconfirm/.test(src)
      || /deleteConfirm[\s\S]{0,300}?description=/.test(src);
    expect(mobile, "移动端删除确认框没有 description").toBe(true);
    expect(src).toMatch(/deleteForceTerminateDesc/);
  });

  it("② P3-7：终止**运行中**的执行必须有说明，且**不能**把 waiting 的说明挪走", () => {
    const src = codeOnly(read("pages/ExecutionsPage.tsx"));
    // running 分支不再是 `undefined`
    expect(
      src,
      "running 分支的 description 仍是 undefined（只有 waiting 有说明）",
    ).not.toMatch(/status === 'waiting' \? t\('execs\.killConfirmWaitingDesc'\) : undefined/);
    // 两套说明都在
    expect(src).toMatch(/execs\.killConfirmRunningDesc/);
    expect(src).toMatch(/execs\.killConfirmWaitingDesc/);
  });

  it("③ P3-8：单行「升级」必须有确认 + 后果说明（复用「升级所有」的措辞）", () => {
    const src = codeOnly(read("pages/AppDeploymentPage.tsx"));
    // 单行升级按钮外层有 Popconfirm，且带后果说明
    expect(src).toMatch(/upgradeOneTitle/);
    expect(src).toMatch(/upgradeAllDesc/);
    // 且 `handleUpgrade` 的调用点在 onConfirm（不是按钮的 onClick 直接触发）
    const pop = /<Popconfirm[\s\S]{0,600}?upgradeOneTitle[\s\S]{0,600}?<\/Popconfirm>/.exec(src);
    expect(pop, "找不到单行升级的 Popconfirm").toBeTruthy();
    expect(pop![0]).toMatch(/onConfirm=\{\(\) => void handleUpgrade\(/);
  });
});

/**
 * R189 · P3-4 / P3-5：「**读失败**」不得被渲染成「**没有**」。
 *
 * 两条同型：`catch {}` 空吞 + 渲染处用「集合为空」「keys 为 0」当判据 ⇒
 * **失败时控件/整行消失** ⇒ 用户得出「**这里本来就没有**」的相反结论。
 *
 * | 条目 | 位置 | 此前 | 后果 |
 * |---|---|---|---|
 * | **P3-4** | `SopFromVideoPage` 历史会话 | `catch {}` + `sessions.length > 0 ? <Select/> : null` | **整个下拉消失** ⇒ 用户连「本该有入口」都不知道 ⇒ 以为草稿丢了 ⇒ **重跑一遍（重复花钱）** |
 * | **P3-5** | `ExecutorPackagesPage` 机队版本分布 | `catch {}` + `fleetVersionKeys.length > 0 &&` | **整行摘要消失** ⇒ 管理员得出「**机队没有版本漂移**」⇒ **恰好在最需要它时不去看它** |
 */
describe("R189 · P3-4 / P3-5：读失败不得渲染成「没有」", () => {
  it("④ P3-4：历史会话必须有三态，且失败态有独立文案（不能说成「没有历史会话」）", () => {
    const hook = codeOnly(read("pages/sop-from-video/useSopSessions.ts"));
    // 三态齐全
    expect(hook).toMatch(/'loading'/);
    expect(hook).toMatch(/'ready'/);
    expect(hook).toMatch(/'error'/);
    // 失败时**不能**静默吞掉（必须有 setError）
    expect(hook).toMatch(/setError\(err\)/);
    // 页面：失败态要显式呈现（StateError + reload）
    const page = codeOnly(read("pages/SopFromVideoPage.tsx"));
    expect(page).toMatch(/sessionsState\.state === 'error'/);
    expect(page).toMatch(/sessionsState\.reload/);
    // 且「ready 且空」才是「没有」——不能再用裸 `sessions.length > 0`
    expect(page).not.toMatch(/^\s*sessions\.length > 0 \?/m);
  });

  it("⑤ P3-5：机队版本分布读失败必须有独立告警（不能说成「没有漂移」）", () => {
    const src = codeOnly(read("pages/ExecutorPackagesPage.tsx"));
    expect(src).toMatch(/fleetVersionsLoadError/);
    expect(src).toMatch(/execPkg\.fleetVersions\.loadFail/);
    // 失败时**不得**沿用「keys 为 0」的门控去渲染空（必须与失败分支互斥）
    expect(src).toMatch(/!fleetVersionsLoadError && fleetVersionKeys\.length > 0/);
  });
});

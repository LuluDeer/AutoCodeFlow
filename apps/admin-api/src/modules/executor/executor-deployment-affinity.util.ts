/**
 * ARCH-35 P1（生产事故 2026-09-23）：应用部署归属的**调度偏好**（单一事实源）。
 *
 * ── 背景：这次事故的真正主因 ─────────────────────────────────────────────
 * 中台上「应用只部署在执行器 A」，但创建/下发任务时任务跑到了执行器 B。
 * 排查结论（详见 docs/reviews/executor-identity-and-dispatch-mismatch-2026-09-23.md）：
 * `app_deployments` 行**记了** `executorId`/`executorAddress`，但 manifest 驱动的
 * 任务自动注册不写 `task.executorId`，于是任务恒为 `executorId = NULL` →
 * `dispatch()` 走**全机队分支** → 按负载评分挑一台空闲的 → 挑中 B。
 * 全仓库**没有任何一处**在选执行器时查过「这个应用部署在哪台」——
 * 用户的部署意图在调度面被静默丢弃。这是预期行为的缺席，不是评分 bug。
 *
 * ── 为什么是「偏好」而不是「过滤」（关键设计约束）───────────────────────
 * 直觉方案是「只派给部署了该应用的执行器」（硬过滤）。**本仓库事实否定了它**：
 * 任务执行**完全不依赖**执行器本地是否部署过该应用。四种 codeSource 逐一核验
 * （git / glue / application_zip / NULL 存量）后确认，执行器的执行路径
 * （`<workDir>/<executionId>/`）与部署产物路径（`<workDir>/apps/<appId>/`）
 * 是**两棵互不相交的目录树**，执行路径从不读 `apps/`：
 *   - git  → 执行器自己 clone 到 per-execution 临时目录；
 *   - glue → 脚本随派发载荷下发，写进临时目录；
 *   - zip  → 执行器自己下载 admin 附加的 `packageUrl` 并解压到临时目录；
 *   - NULL → 同 zip 兜底。
 * `applicationId` 在执行器侧**从不变成文件路径**（node 9 处 / python 5 处全部
 * 只是谓词与日志）。最硬的旁证：`executor-python` **根本没有 deploy 路由**
 * （`commands.py` 把 deploy 声明为 "unsupported"）——若执行依赖本地部署，
 * 则所有 python 执行器上的任务都将无法运行。
 *
 * 因此硬过滤会造成**大面积误伤**：任何未部署该应用的任务、以及全部 python
 * 执行器，都会从候选集中消失 → 直接派发失败。正确语义是：
 *   **有部署 → 优先派给它；它接不了（满/离线）→ 平滑降级回全机队。**
 * 本模块产出的正是这个顺序。
 *
 * ── 为什么是「稳定分区」而不是「改评分」─────────────────────────────────
 * 两种实现方式的差别：
 *   (a) 给部署命中的执行器加一个负分偏移量 → 会**污染评分面**：决策日志里
 *       的 score 不再是可比较的真实负载分，「为什么选这台」无法回溯；
 *       且偏移量必须大到能压过任意负载差，等价于硬过滤（回到误伤）。
 *   (b) 对**已按评分排好序**的候选列表做一次稳定分区 → 部署命中的整体前置，
 *       组内仍严格保持原有评分顺序（最优负载仍是首选），落选者的 score 仍
 *       是真实值。调用方既有的「逐个候选原子占坑、失败即试下一个」循环
 *       天然实现降级，**零新增失败面**。
 * 本模块采用 (b)。
 *
 * ── 为什么不做缓存 ──────────────────────────────────────────────────────
 * 同文件的 `packageUrlCache` 先例是 30s 正缓存，但这里**刻意不缓存**：
 * 事故场景正是「刚部署完 A → 立刻下发任务」，任何 TTL 缓存都会让用户在最
 * 该生效的时刻看到旧结论（仍然派给 B），修复感为零。查询走
 * `idx_app_deployments_executor_address_status` 与 `["applicationId","status"]`
 * 复合索引，单次索引查找相对 dispatch 既有的多轮 DB 往返可忽略。
 *
 * ── 匹配优先级：先 id 后 address ────────────────────────────────────────
 * `app_deployments.executorId` 可空（实体注释 "Logical executor ID if known"），
 * 存量行只有 `executorAddress`。故：id 命中优先（精确、抗地址漂移），
 * address 命中兜底（覆盖存量行、以及「执行器行被删后重新注册拿到新 id、
 * 但地址未变」的场景）。两者都只表示"该应用跑在这台"，不分档。
 *
 * ── 纪律（与仓库既有 util 一致）─────────────────────────────────────────
 * - **纯函数、零依赖、零 IO**：不 import 实体（状态值以字符串常量复述），
 *   不读 config，不做 DB——开关判定与查询都留在调用方。
 * - **零行为变化保证**：候选 ≤1、或无运行中部署、或全部未命中时，返回**原序
 *   副本**，调用方按原顺序占坑，与引入本特性前逐字节一致。
 */

/**
 * `app_deployments.status` 中代表「应用确实正跑在这台机器上」的取值。
 *
 * 复述自 `DeploymentStatus.RUNNING`（`app-deployment.entity.ts`）而非 import：
 * 保持本 util 零依赖（纯函数纪律），漂移由 check-enum-drift 门禁与调用方的
 * 类型约束共同兜底。**只有** running 计入偏好——pending/deploying/upgrading
 * 尚未落地，stopped/failed 已经不在跑，都不该把任务吸过去。
 */
export const DEPLOYMENT_STATUS_RUNNING = "running";

/** 参与偏好判定的候选执行器最小面（结构类型，避免耦合实体）。 */
export interface DeploymentAffinityCandidate {
  /** `executors.id`（稳定 UUID）。 */
  id: string;
  /** `executors.address`（自报、可漂移、NAT 下可能碰撞——故非唯一判据）。 */
  address: string;
}

/** 参与偏好判定的部署行最小面（结构类型）。 */
export interface DeploymentAffinityDeployment {
  /** `app_deployments.executorId`；存量行为 null。 */
  executorId?: string | null;
  /** `app_deployments.executorAddress`；非空列。 */
  executorAddress?: string | null;
  /** `app_deployments.status`；仅 running 计入。 */
  status?: string | null;
}

/** 分区结果：`ordered` 供调用方按序占坑，其余字段供决策日志回溯。 */
export interface DeploymentAffinityResult<
  T extends DeploymentAffinityCandidate,
> {
  /** 部署命中的候选（保持入参相对顺序）在前，其余（同样保序）在后。 */
  ordered: T[];
  /** 前置的候选数（= 命中数）。0 表示顺序未变。 */
  preferredCount: number;
  /** 其中靠 `executorId` 命中的数量（精确匹配）。 */
  matchedByExecutorId: number;
  /** 其中仅靠 `executorAddress` 命中的数量（存量行/地址兜底）。 */
  matchedByAddressOnly: number;
  /** 传入的部署行里状态为 running 的行数（过滤后）。 */
  runningDeployments: number;
}

/**
 * 按「该应用是否部署在这台执行器上」对候选列表做**稳定分区**。
 *
 * 前置条件：`candidates` 已由调用方按业务评分排序——本函数只调整分组，
 * **绝不**在组内重排，因此组内最优（评分最低）仍是首选。
 *
 * @param candidates  候选执行器（任意顺序；调用方传评分升序即为最优语义）。
 * @param deployments 该应用的部署行（调用方按 applicationId 查询；本函数仍会
 *                    自行过滤 status，传入未过滤的全量行同样正确）。
 * @returns 分区结果；无命中时 `ordered` 为原序副本（零行为变化）。
 */
export function partitionByDeploymentAffinity<
  T extends DeploymentAffinityCandidate,
>(
  candidates: readonly T[],
  deployments: readonly DeploymentAffinityDeployment[],
): DeploymentAffinityResult<T> {
  const running = deployments.filter(
    (d) => d.status === DEPLOYMENT_STATUS_RUNNING,
  );

  // 快速路径：无候选可换序 / 无运行中部署 → 原序副本。
  // （≤1 个候选时分区无意义；这两条同时是「开关关闭时零开销」的保证面。）
  if (candidates.length <= 1 || running.length === 0) {
    return {
      ordered: [...candidates],
      preferredCount: 0,
      matchedByExecutorId: 0,
      matchedByAddressOnly: 0,
      runningDeployments: running.length,
    };
  }

  const deployedIds = new Set<string>();
  const deployedAddresses = new Set<string>();
  for (const d of running) {
    const id = typeof d.executorId === "string" ? d.executorId.trim() : "";
    if (id) deployedIds.add(id);
    const addr =
      typeof d.executorAddress === "string" ? d.executorAddress.trim() : "";
    if (addr) deployedAddresses.add(addr);
  }

  const preferred: T[] = [];
  const rest: T[] = [];
  let matchedByExecutorId = 0;
  let matchedByAddressOnly = 0;

  for (const c of candidates) {
    const idHit = Boolean(c.id) && deployedIds.has(c.id);
    if (idHit) {
      matchedByExecutorId += 1;
      preferred.push(c);
      continue;
    }
    // 仅当 id 未命中时才看地址：id 命中已足以证明归属，无需重复计数。
    const addrHit = Boolean(c.address) && deployedAddresses.has(c.address);
    if (addrHit) {
      matchedByAddressOnly += 1;
      preferred.push(c);
      continue;
    }
    rest.push(c);
  }

  return {
    ordered: [...preferred, ...rest],
    preferredCount: preferred.length,
    matchedByExecutorId,
    matchedByAddressOnly,
    runningDeployments: running.length,
  };
}

/**
 * N23 — capability generation swap 生产接线层。
 *
 * 把 generation-swap.ts 的纯不可变状态机接到真实 capability 写事件与 resolve 读路径：
 * - capability.changed（由 CapabilityService 写操作落库后 emit）→ 按 key 重新 resolve
 *   → stageIncoming → swap → 对 retired 快照调用 disposer 一次；
 * - resolve 优先读当前代 active，空态（尚未收到任何事件）回退 CapabilityService，
 *   fail-open，既有 resolve 行为逐字不变。
 *
 * 不变量：
 * - 所有状态转移都经 generation-swap 的纯函数，registry 只做「重解析 + 赋值 + 副作用」；
 * - 同代 / validate 拒绝 / 重解析失败时 state 引用不变，active 引用不变，disposer 零调用；
 * - 首次事件只 createSwapState（无 retired 可释放），第二次起的 swap 才 dispose 旧 active；
 * - bus 是 @Optional：内存单测缺席不崩（fail-open）；生产由 @Global DomainEventModule 注入。
 */
import { Injectable, Optional } from "@nestjs/common";
import {
  DOMAIN_EVENTS,
  CapabilityChangedEventPayload,
} from "../../common/events/domain-events";
import {
  DomainEventBus,
  DomainEventListener,
} from "../../common/services/domain-event-bus.service";
import { CapabilityService, CapabilityResolution } from "./capability.service";
import { ResolveCapabilityDto } from "./dto/resolve-capability.dto";
import {
  GenerationSnapshot,
  SwapState,
  createSwapState,
  isStaleGeneration,
  resolveCurrent,
  rollback as rollbackState,
  stageIncoming,
  swap,
} from "./generation-swap";

/** retired 快照释放器：swap 成功后对 swap 前的 active 调用一次。 */
export type GenerationDisposer = (
  retired: GenerationSnapshot<CapabilityResolution>,
) => void | Promise<void>;

/** validate 拒绝空/畸形候选代；可被单测替换以验证提交点失败路径。 */
export type GenerationValidator = (
  candidate: GenerationSnapshot<CapabilityResolution>,
) => boolean;

const defaultValidate: GenerationValidator = (candidate) =>
  !isStaleGeneration(candidate.generation) &&
  candidate.value != null &&
  typeof candidate.value.key === "string" &&
  candidate.value.key.length > 0 &&
  candidate.value.effective != null &&
  typeof candidate.value.effective === "object";

@Injectable()
export class CapabilityGenerationRegistry {
  /** null = 空态：resolve 回退 service；首次事件后才有代。 */
  private state: SwapState<CapabilityResolution> | null = null;
  /** 最近一次 resolve 请求；事件只带 key，重解析时复用其 layers/fieldRules。 */
  private lastDto: ResolveCapabilityDto | null = null;
  private subscribed = false;
  private disposer: GenerationDisposer = () => undefined;
  private validate: GenerationValidator = defaultValidate;
  private readonly listener: DomainEventListener<CapabilityChangedEventPayload>;

  constructor(
    @Optional() private readonly svc: CapabilityService | null = null,
    @Optional() private readonly bus: DomainEventBus | null = null,
  ) {
    // 固定引用：subscribe / unsubscribe 必须成对使用同一个 listener。
    this.listener = (payload: CapabilityChangedEventPayload): void => {
      void this.onCapabilityChanged(payload);
    };
  }

  /** 测试缝：注入 retired 快照释放器。 */
  setDisposer(disposer: GenerationDisposer): this {
    this.disposer = disposer;
    return this;
  }

  /** 测试缝：注入 swap 提交点校验器。 */
  setValidate(validate: GenerationValidator): this {
    this.validate = validate;
    return this;
  }

  /** 当前状态机（null = 空态），供读侧与单测断言。 */
  get current(): SwapState<CapabilityResolution> | null {
    return this.state;
  }

  /** 由 CapabilityModule.onModuleInit 调用。 */
  subscribe(): void {
    if (!this.bus || this.subscribed) return;
    this.bus.on<CapabilityChangedEventPayload>(
      DOMAIN_EVENTS.CAPABILITY_CHANGED,
      this.listener,
    );
    this.subscribed = true;
  }

  /** 由 CapabilityModule.onModuleDestroy 调用，避免测试进程泄漏。 */
  unsubscribe(): void {
    if (!this.bus || !this.subscribed) return;
    this.bus.off(DOMAIN_EVENTS.CAPABILITY_CHANGED, this.listener);
    this.subscribed = false;
  }

  /**
   * resolve 统一入口（controller 调用）：
   * 命中当前代且 key 一致 → 返回 active.value（引用级）；否则回退 service。
   * 空态/陈旧/缺 service 一律 fail-open，保持既有 resolve 响应形状。
   */
  async resolve(
    dto: ResolveCapabilityDto,
    fallback: () => Promise<CapabilityResolution>,
  ): Promise<CapabilityResolution> {
    if (dto?.key) this.lastDto = { ...dto };
    const state = this.state;
    if (state !== null) {
      const active = resolveCurrent(state);
      if (
        !isStaleGeneration(active.generation) &&
        active.value != null &&
        active.value.key === dto?.key
      ) {
        return active.value;
      }
    }
    return fallback();
  }

  /** 回滚到 swap 前的 active（纯 rollbackState 的薄封装，不触发 disposer）。 */
  rollback(): void {
    if (this.state !== null) this.state = rollbackState(this.state);
  }

  /** 事件入口：重解析 → stage → swap → dispose retired；全程 fail-open。 */
  private async onCapabilityChanged(
    payload: CapabilityChangedEventPayload,
  ): Promise<void> {
    const key = payload?.key;
    if (typeof key !== "string" || key.length === 0 || !this.svc) return;

    // 事件只有 key/operation，没有解析结果：复用最近一次 resolve 的层叠参数，
    // 从未 resolve 过时用最小 managed 层替身；始终按事件的 key 重新解析。
    const base = this.lastDto ?? {
      key,
      layers: [{ name: "managed", config: {} }],
    };
    let value: CapabilityResolution;
    try {
      value = await this.svc.resolveFor({ ...base, key });
    } catch {
      // key 已 remove / 层叠非法 → 不产生新代，主链已落库的写操作不受影响。
      return;
    }
    if (
      value == null ||
      value.key !== key ||
      value.effective == null ||
      typeof value.effective !== "object"
    ) {
      return;
    }

    const incoming: GenerationSnapshot<CapabilityResolution> = {
      // 不透明 token：同 key + 同 occurredAt 即同代，stageIncoming 判 no-op。
      generation: `${key}:${payload.occurredAt}`,
      value,
    };

    const previous = this.state;
    if (previous === null) {
      // 首代：没有 retired 可释放，不调 disposer。
      this.state = createSwapState(incoming);
      return;
    }

    const staged = stageIncoming(previous, incoming);
    if (staged === previous) return; // 同代 no-op
    const swapped = swap(staged, this.validate);
    if (swapped === staged) return; // validate 拒绝 / 提交点失败

    const retired = swapped.retired;
    this.state = swapped;
    if (retired !== null) {
      try {
        await this.disposer(retired);
      } catch {
        // fail-open：释放失败不改变已提交的代际。
      }
    }
  }
}

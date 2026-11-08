/**
 * R183 · 出站 webhook 的**事件级幂等键**（`deliveryId`）。
 *
 * ## 为什么必须有（这不是「锦上添花」，是 at-least-once 的**必要配套**）
 *
 * 出站是 **at-least-once**：快速路径 + outbox 补投、租约超时重投、部分失败留给扫描重试
 * —— **同一个事件会被投递多次**。而此前信封里**没有任何可用于去重的稳定字段**：
 * `occurredAt` 是**每次投递重新生成**的（`new Date().toISOString()`）⇒
 * **两次投递的 `occurredAt` 不同** ⇒ 订阅方**无法区分「重复投递」与「新事件」**。
 *
 * 代价是实打实的：计费类订阅按事件条数计费会**翻倍**、执行类订阅会**重复执行**。
 * 而代码里多处注释写着「订阅方仍需幂等」—— **却从没给它一个可用的幂等键**。
 *
 * ## 判据（四条，最后一条是**反向钉子**）
 *
 * ① **同一个事件 id 稳定**：`buildEventPayload(..., deliveryId)` 产出的
 *    `deliveryId` **逐字等于**传入值，且**两次构建（模拟快速路径 + 补投）拿到同一个值**
 *    （因为值来自 payload 本身，不是投递时新生成）；
 * ② **不给就没有**：`deliveryId` 缺省时**不出现在信封里**（outbox 不可用的降级路径没有
 *    稳定 id）；
 * ③ **向后兼容**：新增字段不改变既有字段（`event`/`occurredAt`/`schemaVersion`/`data`）；
 * ④ **反向钉子（最重要）**：`buildEventPayload` **不许**在没收到 `deliveryId` 时
 *    **自己生成一个** —— 那比不生成更糟：订阅方会以为它是幂等键而**永远无法去重**
 *    （每次投递都不同 ⇒ 每次都被当成新事件）。
 */
import {
  buildEventPayload,
  type OutboundEventEnvelope,
} from "../event-subscription.util";

describe("R183 · 出站事件的幂等键 deliveryId", () => {
  const AT = "2026-11-08T00:00:00.000Z";
  const DATA = { executionId: "e-1", status: "failed" };

  it("① 同一 deliveryId 逐字保留（快速路径与补投拿到同一个值）", () => {
    const first = buildEventPayload("execution.failed", DATA, AT, "execution.failed:abc-123");
    // 模拟补投：同一份 payload（outbox 落库后再取出）→ 再构建一次
    const second = buildEventPayload(
      first.event,
      first.data,
      first.occurredAt,
      first.deliveryId,
    );
    expect(first.deliveryId).toBe("execution.failed:abc-123");
    expect(second.deliveryId).toBe(first.deliveryId);
  });

  it("② 不给 deliveryId ⇒ 信封里**没有**这个字段（降级路径不伪造）", () => {
    const env = buildEventPayload("execution.failed", DATA, AT);
    expect(env).not.toHaveProperty("deliveryId");
  });

  it("③ 向后兼容：既有四个字段一字不变", () => {
    const env = buildEventPayload("execution.failed", DATA, AT, "id-1");
    expect(env.event).toBe("execution.failed");
    expect(env.occurredAt).toBe(AT);
    expect(env.data).toEqual(DATA);
    expect(typeof env.schemaVersion).toBe("number");
  });

  it("④ 反向钉子：**不许自己生成** deliveryId（伪造幂等键比不给更糟）", () => {
    // 连调三次、都不给 id ⇒ 三次都必须没有该字段。
    // 若实现改成「缺省时自动 randomUUID()」，这条会红 —— 那种实现会让订阅方
    // **以为可以去重**，而每次投递的 id 都不同 ⇒ **永远去不了重**（比重没有更危险）。
    const runs: OutboundEventEnvelope[] = [
      buildEventPayload("execution.failed", DATA, AT),
      buildEventPayload("execution.failed", DATA, AT),
      buildEventPayload("execution.failed", DATA, AT),
    ];
    for (const env of runs) {
      expect(env.deliveryId).toBeUndefined();
    }
  });
});

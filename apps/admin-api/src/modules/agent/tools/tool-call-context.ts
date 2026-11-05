/**
 * R63（ADR-031 步骤 2）：**per-call 上下文**——`execute` 的第四次参数。
 *
 * ## 为什么需要这个文件（而不是把类型塞进 `tool-executor.service.ts`）
 *
 * `tool-executor.service.ts`（实现）与 `agent-runtime.service.ts`（接口
 * `AgentToolExecutor` + 唯一调用方）互相引用。把 `ToolCallContext` 放在实现侧，
 * 接口侧就得反向 import 实现侧 ⇒ 又造一个环。本文件**零依赖、零 import**，
 * 两侧都只依赖它，环消失。
 *
 * ## 为什么是「声明」而不是「上下文」作为入参（`ReplayDeclaration`）
 *
 * 上下文里带身份字段（`sessionId` / `toolCallId` / `stepId`）。若让**调用方**
 * 填这三个字段，就等于把「这次调用是谁」的判据交给调用方 —— 而 R60 修的缺陷
 * 正是「两处判据不同源」。所以：
 *   · 调用方只**声明意图**（`replayDeclared`）；
 *   · 身份字段由 `execute` 入口按**真实入参**重建（`buildToolCallContext`），
 *     调用方无从伪造；
 *   · 入口构造出的那个实例**就是**整条路径上唯一的一份上下文，向下传递。
 *
 * ## `replayDeclared` 的语义边界（步骤 1 之后）
 *
 * R60 起，台账写入口的判据是 **`ledgerRowExists`**（台账里有没有这个
 * `toolCallId` 的行），与「是不是重放」**解耦**。`replayDeclared` 因此**不参与
 * 任何写入判定**，它只剩一个消费点：调用方声明了重放、但台账里没有对应行时
 * 发一条 warn（「重放候选与台账漂移」的唯一可检索信号）。
 *
 * 保留它、而不是直接删掉的理由：那条 warn 是运维排查「审批已批但台账行被清理/
 * 迁移丢了」的第一手线索；但它**不该**再以裸布尔的形式占着公开签名（会让下一个
 * 读代码的人误以为它是语义开关）。ADR-031 步骤 4/5 会把整个决策挪到 `run()`
 * 边界，届时本类型随 `planApprovedReplays` 一起演进。
 */

/** 一次工具调用的 per-call 上下文（由 `execute` 入口构造，向下传递）。 */
export interface ToolCallContext {
  /** 所属会话（恒等于 `session.id`；入口重建，不由调用方指定）。 */
  readonly sessionId: string;
  /** 本次调用 id（恒等于 `call.id`；入口重建，不由调用方指定）。 */
  readonly toolCallId: string;
  /** 本次调用所属的 step（入口透传 `execute` 的第三个参数）。 */
  readonly stepId: string | null;
  /**
   * 调用方**声明**这是对已批准调用的确定性重放。
   * 只影响「声明重放但台账无行」那条 warn；**不参与** insert/update 判定。
   */
  readonly replayDeclared: boolean;
}

/**
 * 调用方唯一能提供的东西：意图声明。
 *
 * `undefined` / `{}` = 没有声明（绝大多数路径）；`true` = 「我认为这是重放」。
 * 是否**真的**是重放由台账回答（`ledgerRowExists`），不由这里回答。
 */
export interface ReplayDeclaration {
  readonly replayDeclared?: boolean;
}

/**
 * 在 `execute` 入口调用**一次**：把真实入参与调用方的声明合成唯一上下文实例。
 *
 * 身份字段只从入参取（`sessionId` / `toolCallId` / `stepId` 三个形参），
 * 因此上下文里的身份**不可能**与本次调用不一致 —— 这是本文件存在的核心理由。
 */
export function buildToolCallContext(
  sessionId: string,
  toolCallId: string,
  stepId: string | null,
  declaration: ReplayDeclaration = {},
): ToolCallContext {
  return {
    sessionId,
    toolCallId,
    stepId,
    replayDeclared: declaration.replayDeclared === true,
  };
}

/** 「声明重放但台账无行」那条 warn 的文案（抽出来让 execute 少占 3 行）。 */
export function replayDriftMessage(
  ctx: ToolCallContext,
  toolName: string,
): string {
  return (
    `Agent replay declared but ledger row missing — falling back to insert: ` +
    `session=${ctx.sessionId} tool=${toolName} toolCallId=${ctx.toolCallId}`
  );
}

import { Injectable, Logger } from "@nestjs/common";
import type { AgentToolSpec } from "./tool-registry";

/**
 * P3：Agent 工具的执行体（设计文档 10 §调整1）。
 *
 * ## 为什么 in-process 而不是绕 HTTP 调自己的 API
 * 中台 Agent 就在 admin-api 进程内。若走 HTTP 调本机 3105：
 *   · 多一次序列化 + 一次网络往返 + 一次鉴权（纯浪费）；
 *   · 需要给 Agent 签发凭据——而 `JWT_ONLY_API_KEY_PATHS` 明确把
 *     `config` 面排除在 API Key 之外，Agent 用 API Key 根本碰不到
 *     system_configs（设计文档 10 §缺口2）。
 *
 * 因此本客户端直接调用 Service 层。这与 mcp-server 的设计同构——
 * 它的 handler 只做 `call(method, path, body)`，具体传输由注入的 `call`
 * 决定；这里 `call` 的实现是「路由到内部 service」而非 fetch。
 *
 * ## P3 范围（刻意的）
 * 本阶段实现**只读工具**的真实调用（排障主力的前 12 个），写工具的
 * 执行体在 P4/P5 随触发器与 SOP 一起接（它们需要那些模块的能力）。
 * 未实现的工具**如实返回错误**，而不是静默成功——静默成功会让模型在
 * 错误前提上继续推理，比明确失败更危险。
 */

/** 工具调用结果。 */
export interface ApiCallResult {
  data: unknown;
  isError: boolean;
  errorMessage?: string;
}

/**
 * 只读工具的路由表：工具名 → 内部服务调用。
 *
 * 值是一个返回 `unknown` 的函数，由 `AgentApiClient` 在构造时注入依赖后
 * 绑定。这样做的理由：这些 service 属于不同模块，逐一注入会让
 * AgentModule 的依赖列表很长且随工具增长；用「注册表 + 懒解析」把增长
 * 点收在一处。
 */
type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

@Injectable()
export class AgentApiClient {
  private readonly logger = new Logger(AgentApiClient.name);

  /** 工具名 → 执行体。未登记的工具视为「本阶段未实现」。 */
  private readonly handlers = new Map<string, ToolHandler>();

  /**
   * 注册一个工具执行体。
   * 由 AgentModule 在引导时装配（见 agent.module.ts 的 onModuleInit）。
   */
  register(toolName: string, handler: ToolHandler): void {
    this.handlers.set(toolName, handler);
  }

  /** 已实现的工具名（供自检与「能力自述」使用）。 */
  implementedTools(): string[] {
    return [...this.handlers.keys()].sort();
  }

  /**
   * 执行一次工具调用。
   *
   * 未实现的工具返回 `isError: true` —— **不抛异常**（抛异常会让推理循环
   * 的 catch 分支把它当链路故障，收敛为 failed 会话；而「这个工具还没实现」
   * 是模型可以换路径绕过的信息）。
   */
  async invoke(
    spec: AgentToolSpec,
    args: Record<string, unknown> | null,
  ): Promise<ApiCallResult> {
    const handler = this.handlers.get(spec.name);
    if (!handler) {
      return {
        data: null,
        isError: true,
        errorMessage:
          `工具 ${spec.name} 在当前版本尚未实现执行体（P3 只接了只读工具）。` +
          `请改用已实现的工具，或直接说明需要人工介入。`,
      };
    }

    try {
      const data = await handler(args ?? {});
      return { data, isError: false };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Tool ${spec.name} failed: ${msg}`);
      return { data: null, isError: true, errorMessage: msg };
    }
  }
}

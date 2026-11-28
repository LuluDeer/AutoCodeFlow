/**
 * 切片 E1：工作台会话 → SOP 转写的窄端口。
 *
 * 独立成文件（零重依赖）是有意的：WorkbenchSessionController 只 import 这个
 * token 与结构面，不 value-import convert-to-sop.service.ts——后者拖
 * AgentSessionService / AgentApprovalsService 的 typeorm 依赖链，会让
 * workbench-session 控制器的内存替身单测在装载期撞 ESM/CJS 互操作问题
 * （与 workbench-sessions.port.ts 同款隔离纪律）。
 *
 * 生产由 WorkbenchModule 以 useClass 把真实服务接到本 token；单测可直接
 * `new WorkbenchSessionController(interaction, fakeConvert)`。
 */
export const WORKBENCH_CONVERT_TO_SOP = "WORKBENCH_CONVERT_TO_SOP";

export interface WorkbenchConvertSessionInput {
  sessionId: string;
  user: { id: number | string; username?: string; role?: string } | undefined;
  cadence: "once" | "hourly" | "daily" | "weekly" | "monthly";
  params?: Record<string, string>;
  ip?: string | null;
}

export interface WorkbenchConvertSessionResult {
  /** 新草稿 slug（goal 归一化；冲突自动 -2/-3…）。 */
  slug: string;
  /** 新落库 SOP 草稿行 id。 */
  sopId: string;
  /** 恒为 "draft"——转换绝不发布。 */
  status: "draft";
  /** 恒为 false。 */
  published: boolean;
  /** SOP 页深链（/sops?sop=<id>，SopsPage 现行深链契约）。 */
  deeplink: string;
}

export interface WorkbenchConvertToSopPort {
  convert(
    input: WorkbenchConvertSessionInput,
  ): Promise<WorkbenchConvertSessionResult>;
}

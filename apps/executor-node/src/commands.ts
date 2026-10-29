/**
 * ARCH-33（ADR-016）：pull 控制面命令的本地执行分派。
 *
 * 背景：ADR-015 只把「任务派发」搬上了 pull 通道，而所有「中台主动拨入
 * 执行器」的控制面调用（deploy / app-stop / app-uninstall / config-reload /
 * kill / update-package）仍是纯 push 硬编码。公网中台 + 内网执行器拓扑下
 * 这些调用必然超时（生产实证：app_deployments.statusMessage =
 * "Failed to reach executor after 3 attempts: timeout of 30000ms exceeded"）。
 *
 * 本模块把中台经 pull 响应下发的命令，**回环**到执行器自己的既有本地路由：
 * `http://127.0.0.1:{port}/api/...` + 本执行器令牌。这是 E-1 配置热更新已验证
 * 的先例（pull.ts 的 maybePullConfig / python 侧 _maybe_pull_config）——apply
 * 逻辑单一事实源，零漂移；本地路由的全部校验（路径安全、SSRF 闸、zip 炸弹
 * 守卫、停机守卫）照常生效。
 *
 * ## 安全边界（如实声明，勿误读）
 *
 * 命令类型是**封闭枚举**，本地路径由本模块按类型构造，**绝不接受中台下发的
 * 自由路径**。这**不扩大**信任面——中台今日就能对 push 执行器发同样的入站
 * POST，也能给任何 pull 执行器下发含任意脚本的 glue 任务（等价于任意代码
 * 执行），执行器本就完全信任中台。封闭枚举的意义是**限制误配与内部错误的
 * 影响半径**（例如队列里混入一条畸形载荷时，不会变成一个任意路径的请求），
 * 不是新增授权。
 */
import axios from 'axios';
import { config } from './config';
import { logger } from './logger';
import { getExecutorAuthToken } from './routes/logs';
import { ControlCommandSchema, type ControlCommand } from './generated/protocol.schemas';

/** 中台可下发的命令类型（封闭枚举——新增类型必须两端同批）。 */
export const CONTROL_COMMAND_TYPES = [
  'deploy',
  'app-stop',
  'app-uninstall',
  'config-reload',
  'kill-execution',
  'update-package',
] as const;

export type ControlCommandType = (typeof CONTROL_COMMAND_TYPES)[number];

// E-P2-P4: 单一事实源——命令载荷类型直接来自生成的 ControlCommandSchema，
// 不再手写第二份 interface（消除协议两端漂移的第二事实源）。
export type { ControlCommand };

/** 命令执行结果（回传中台 /executors/command-result）。 */
export interface ControlCommandResult {
  commandId: string;
  type: string;
  ok: boolean;
  status?: number;
  error?: string | null;
  durationMs: number;
}

/**
 * 各命令类型的本地路由与超时预算。
 *
 * 超时按「本地路由何时返回」定，而非按命令何时**做完**定：
 * deploy / update-package 的路由都是「先 res.json 应答、再 setImmediate
 * 异步干活」，所以它们的超时只需覆盖校验 + 应答，不覆盖 git clone / 下载。
 */
const COMMAND_ROUTES: Record<
  ControlCommandType,
  { path: (payload: Record<string, unknown>) => string; timeoutMs: number }
> = {
  deploy: { path: () => '/api/deploy', timeoutMs: 30_000 },
  'app-stop': { path: () => '/api/app-stop', timeoutMs: 10_000 },
  'app-uninstall': { path: () => '/api/app-uninstall', timeoutMs: 60_000 },
  'config-reload': { path: () => '/api/config/reload', timeoutMs: 10_000 },
  'kill-execution': {
    // executionId 进 URL 路径段——必须编码。本执行器侧的 kill 路由不做路径
    // 校验（它只查运行表），未编码的 '../' 之类会改变路由匹配。中台侧
    // executionId 是 UUID，但载荷来自队列，纵深防御不依赖上游。
    path: (payload) =>
      `/api/executions/${encodeURIComponent(String(payload.executionId ?? ''))}/kill`,
    timeoutMs: 5_000,
  },
  'update-package': { path: () => '/api/update-package', timeoutMs: 10_000 },
};

export function isControlCommandType(type: unknown): type is ControlCommandType {
  return (
    typeof type === 'string' &&
    (CONTROL_COMMAND_TYPES as readonly string[]).includes(type)
  );
}

/**
 * EXEC-04（第 3 轮并行审计，P2）：未知命令类型的统一错误文案。
 *
 * 字面量与 python `commands.py:UNSUPPORTED_COMMAND_TYPE_ERROR` **逐字一致**——
 * 同一个畸形载荷落在哪一侧执行器上，中台看到的原因应当完全一样。
 */
export function unsupportedCommandTypeError(type: string): string {
  return `unsupported command type: ${type}`;
}

/** 协议 commandId 形态（生成的 `ControlCommandSchema` 同正则）。 */
const COMMAND_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * 中台 `ExecutorCommandResultDto.type` 是 `@MaxLength(64)`——上报体里超长的
 * type 会被 400 整条丢掉，于是又回到"中台没有结果行"的原始故障。截断上报的
 * type，完整原文留在 error（≤1000）。
 */
const REPORTED_TYPE_MAX_CHARS = 64;
const ERROR_MAX_CHARS = 1000;

/**
 * EXEC-04：把「未知命令类型」转成一条**可上报**的 `ok:false` 结果。
 *
 * 失败模式（改动前）：未知 type 在协议闸（`ControlCommandSchema.type` 是封闭
 * 枚举）被拒 → `parseControlCommand` 返回 null → pull 循环只 warn 后 `continue`，
 * **不向中台回报**。中台那条命令于是永远没有结果行，运维无法区分"执行器拒了"
 * 与"命令丢了"。python 侧一直回报 `ok:false`，同一件事两端行为分叉。
 *
 * 返回 null 的三种情形（仍然只能丢弃 + warn）：
 *   - 载荷不是对象 / 没有 type；
 *   - 没有可关联到中台行的 commandId（缺失或形态不合协议）——没有键就无法入账；
 *   - type 属于封闭枚举（那是正常执行路径的事，不是"不支持"）。
 *
 * **安全语义不变**：本函数只产出结果对象，绝不执行任何动作（不投递本地路由）。
 */
export function rejectUnsupportedControlCommand(
  raw: unknown,
): ControlCommandResult | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const commandId = record.commandId;
  const type = record.type;
  if (typeof commandId !== 'string' || !COMMAND_ID_RE.test(commandId)) return null;
  if (typeof type !== 'string' || type.length === 0) return null;
  if (isControlCommandType(type)) return null;

  return {
    commandId,
    type: type.slice(0, REPORTED_TYPE_MAX_CHARS),
    ok: false,
    error: unsupportedCommandTypeError(type).slice(0, ERROR_MAX_CHARS),
    // 未投递本地路由：没有耗时也没有 HTTP 状态。`durationMs` 保留字段（协议可选）
    // 以便结果体与正常路径同形，中台侧无需分支。
    durationMs: 0,
  };
}

/**
 * 解析并校验一条来自队列的命令载荷。畸形条目返回 null（丢弃 + warn），
 * 不投递到本地路由。
 */
export function parseControlCommand(raw: unknown): ControlCommand | null {
  // E-P1-P1: 取件运行时路径走生成的 ControlCommandSchema.safeParse（对齐
  // execute.ts 对 ExecuteRequest 的做法）——commandId 格式、type 枚举、payload
  // 类型全部以协议为唯一事实源；畸形 commandId 整条丢弃，不再手写第二套宽松
  // 校验（旧实现只查「非空字符串」+isControlCommandType，放过含空格/非法字符的 id）。
  const parsed = ControlCommandSchema.safeParse(raw);
  if (!parsed.success) return null;
  const data = parsed.data;
  return {
    commandId: data.commandId,
    type: data.type,
    // 协议 payload 可选：缺省补 {}——本地路由 path 函数读 payload.executionId，
    // undefined 会抛（纵深：协议没带 payload 时不丢弃整条命令，仅补空载荷）。
    payload: data.payload ?? {},
    issuedAt: data.issuedAt,
  };
}

/**
 * 执行一条命令：回环 POST 到本地路由。
 *
 * **绝不抛出**——任何失败都收敛为 `ok: false` 的结果对象，由调用方上报中台。
 * 抛错会让 pull 循环的 catch 吞掉命令 ID，中台侧就再也无法把「命令没生效」
 * 与「命令没送达」区分开。
 */
export async function executeControlCommand(
  cmd: ControlCommand,
): Promise<ControlCommandResult> {
  const startedAt = Date.now();
  const route = COMMAND_ROUTES[cmd.type as ControlCommandType];
  // E-P2-P4: 协议类型里 payload 可选（parse 路径已补 {}，此处再兜底一次边界）。
  const path = route.path(cmd.payload ?? {});
  const url = `http://127.0.0.1:${config.port}${path}`;
  const token = getExecutorAuthToken();
  try {
    logger.info(
      `[command] Executing ${cmd.type} (${cmd.commandId}) via local route ${path}`,
    );
    const resp = await axios.post(url, cmd.payload, {
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      timeout: route.timeoutMs,
      // 本地回环，不经代理；也绝不跟随重定向（本地路由不会发重定向）。
      proxy: false,
      maxRedirects: 0,
      // 本地路由对 4xx/5xx 的应答体是我们的诊断信息，不要抛。
      validateStatus: () => true,
    });
    const ok = resp.status >= 200 && resp.status < 300;
    if (!ok) {
      // 本地路由的错误信封有两种形态：{error}（deploy/update-package）与
      // FastAPI/Nest 风格的 {message}。取到哪个用哪个，都没有就报状态码。
      const body = resp.data as { error?: unknown; message?: unknown } | undefined;
      const detail =
        (typeof body?.error === 'string' && body.error) ||
        (typeof body?.message === 'string' && body.message) ||
        `HTTP ${resp.status}`;
      logger.warn(
        `[command] ${cmd.type} (${cmd.commandId}) rejected by local route: ${detail}`,
      );
      return {
        commandId: cmd.commandId,
        type: cmd.type,
        ok: false,
        status: resp.status,
        error: String(detail).slice(0, 1000),
        durationMs: Date.now() - startedAt,
      };
    }
    logger.info(`[command] ${cmd.type} (${cmd.commandId}) accepted by local route`);
    return {
      commandId: cmd.commandId,
      type: cmd.type,
      ok: true,
      status: resp.status,
      durationMs: Date.now() - startedAt,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      `[command] ${cmd.type} (${cmd.commandId}) failed to reach local route ${path}: ${message}`,
    );
    return {
      commandId: cmd.commandId,
      type: cmd.type,
      ok: false,
      error: message.slice(0, 1000),
      durationMs: Date.now() - startedAt,
    };
  }
}

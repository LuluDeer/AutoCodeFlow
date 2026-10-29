/**
 * P2-2（2026-10-26 执行器域审计）：任务 params 的**键名闸**——派发源头主闸。
 *
 * ## 为什么在 admin 派发面就拦（主闸位置论证）
 *
 * params 逐键注入口径是 `AUTOFLOW_<KEY 大写>`（两执行器同形：node
 * `param-env.ts` 的 paramEnvKey / python `routers/execute.py` 的
 * `f'AUTOFLOW_{k.upper()}'`），键名**直接成为子进程环境变量名**。含 `=` 的键
 * 落到 executor-node 会让 spawn 构造 env 时**直接抛错**（secrets 向量
 * illegal-equals 注释自证同形，任务以与参数毫无关系的形态失败）；含空格/短
 * 横线/点的键在 shell 引用（`$AUTOFLOW_MY-KEY`）里必然错位；两端失败方式还
 * 不一致（node 抛错 / python 静默注入坏名）。在派发源头丢弃坏键，好键照常
 * 下发——任务面可观测（warn 带 taskId/executionId），执行器侧 param-env.ts
 * 的同款闸退居防御纵深。
 *
 * ## 规则形态（SSOT 与宽松版论证）
 *
 * 单一事实源：`packages/executor-protocol/protocol.json` 顶层 `params` 段
 * （keyPattern `^[A-Za-z0-9_]{1,64}$`）。它是 secrets 键名规则
 * （`^[A-Za-z_][A-Za-z0-9_]*$`，见同文件 secrets 段）的**宽松版**：
 *  - 无首字符限制——`AUTOFLOW_` 前缀保证 env 名首字符合法，数字开头的原始键
 *    （1ST_RETRY）不构成风险；secrets 的「字母/下划线开头」约束只服务原名注入；
 *  - 长度 ≤64——含前缀后仍有界，防止超长键在 Windows env 块/日志里失控。
 * **不进 schemas.ExecuteRequest 的 schema 闸**（additionalProperties:true 刻意
 * 保留）：非法键的线上语义是「跳过坏键、保留好键」（params 来自用户配置面，
 * 一个手滑的键名不该弄挂整份合法配置），不是 400——与 secrets 的 skip-and-warn
 * 同策。本 util 的正则与 protocol.json 的 keyPattern 字符串由 spec 逐字符对账
 * （dispatch-params-keys.util.spec.ts 加载同一份协议文件断言）。
 *
 * 三端同款规则（常量注释互指）：executor-node `param-env.ts`
 * isInjectableParamEnvKey（注入循环防御纵深）、executor-python
 * `routers/execute.py` `_is_injectable_param_key`（对等兜底）。
 */

/** params 键名白名单：字母/数字/下划线，1..64 字符（= protocol.json params.keyPattern）。 */
export const DISPATCH_PARAM_KEY_PATTERN = "^[A-Za-z0-9_]{1,64}$";

const DISALLOWED_KEY_RE = new RegExp(DISPATCH_PARAM_KEY_PATTERN);

/** 该 params 键能否经 `AUTOFLOW_<KEY 大写>` 通道注入执行器子进程 env。 */
export function isInjectableParamKey(key: string): boolean {
  return typeof key === "string" && DISALLOWED_KEY_RE.test(key);
}

/** 键名过滤结果：kept 保序保留合法键，rejected 收集被跳过的原始键名。 */
export interface DispatchParamKeyFilter {
  kept: Record<string, unknown>;
  rejected: string[];
}

/**
 * 对 params 做键名过滤（skip-and-warn 语义的纯函数半边——warn 由调用方带
 * taskId/executionId 语境补全）。值不做任何改写：A-11R 的序列化口径与
 * null 值语义完全不动。
 */
export function filterDispatchParamKeys(
  params: Record<string, unknown> | null | undefined,
): DispatchParamKeyFilter {
  const kept: Record<string, unknown> = {};
  const rejected: string[] = [];
  if (!params || typeof params !== "object") return { kept, rejected };
  for (const [key, value] of Object.entries(params)) {
    if (!isInjectableParamKey(key)) {
      rejected.push(key);
      continue;
    }
    kept[key] = value;
  }
  return { kept, rejected };
}

/**
 * EXEC-07b（第 3 轮审计残差）：params 键名**大小写折叠冲突**的判定。
 *
 * 缺陷形态与执行器侧同一份（protocol.json `params.keyUniqueness`）：
 * `{"limit":1,"LIMIT":2}` 两个键都过键名闸，注入口径把键 `toUpperCase()`
 * 折叠成同一个 `AUTOFLOW_LIMIT`，后者静默覆盖前者。执行器现在在 accept 阶段
 * 400，但那是**派发之后**——用户在触发时看不到问题。本函数让 admin 在
 * **保存/触发**边界就用同一判据拒绝（DTO 约束，见 task/dto）。
 *
 * 规则与执行器逐条对齐：只分析能通过键名闸的键（非法键本来就不注入，不参与
 * 判定，避免 `{"A=B":1,"a=b":2}` 误报）；分组键 = `AUTOFLOW_<KEY 大写>`；
 * 结果按 envKey 升序、组内原始拼写升序（两端输出顺序一致）。
 */
export interface DispatchParamKeyCollision {
  envKey: string;
  keys: string[];
}

export function findDispatchParamKeyCollisions(
  params: Record<string, unknown> | null | undefined,
): DispatchParamKeyCollision[] {
  if (!params || typeof params !== "object" || Array.isArray(params)) return [];
  const grouped = new Map<string, string[]>();
  for (const key of Object.keys(params)) {
    if (!isInjectableParamKey(key)) continue;
    const envKey = `AUTOFLOW_${key.toUpperCase()}`;
    const list = grouped.get(envKey);
    if (list) list.push(key);
    else grouped.set(envKey, [key]);
  }
  return [...grouped.entries()]
    .filter(([, keys]) => keys.length > 1)
    .map(([envKey, keys]) => ({
      envKey,
      keys: [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    }))
    .sort((a, b) => (a.envKey < b.envKey ? -1 : 1));
}

/** 拼可观测日志用的键名清单（≤10 个 + 溢出计数，防超长键刷屏）。 */
export function summarizeRejectedParamKeys(rejected: string[]): string {
  const head = rejected
    .slice(0, 10)
    .map((k) => `"${k.slice(0, 64)}"`)
    .join(", ");
  return rejected.length > 10
    ? `${head} … (+${rejected.length - 10} more)`
    : head;
}

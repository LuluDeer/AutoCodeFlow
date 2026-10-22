import * as fs from 'fs';
import * as path from 'path';
import { config } from './config';
import { DEVICE_IDENTITY_DIR_NAME, resolveInstanceKind } from './device-identity';
import { logger } from './logger';

/**
 * 执行器**行 id**（`executors.id`）的本地持久化（工单 11 / ADR-017 决策 §3 补全）。
 *
 * ## 为什么需要它
 *
 * 注册响应本来就带 `id`（控制器 `...executor`），但执行器侧此前**从不持久化、
 * 也不回传**——于是中台只有「指纹」与「地址」两个自报线索，遇到「同址多行 +
 * 指纹采集失败」的形态就只能 fail-closed（生产实证 2026-10-22 §4.6：36 次
 * `Identity resolution … is ambiguous`，那台机器 pull 直接 404、拿不到任何任务）。
 *
 * 持久化 + 回传后，中台可以在**该行的 per-executor 令牌校验通过**的前提下按行
 * 定位（见 admin-api `authenticateMachineRequest` 的安全边界）。共享令牌不采纳
 * 自报 id —— 否则任何持共享令牌的机器都能声明别人的行、拉走别人的队列。
 *
 * ## 落盘位置
 *
 * `<WORK_DIR>/.device-identity/<kind>.instance`（与盐同目录、同 kind 分域）。
 * 与 `device-identity.ts` 的盐文件共享两个关键性质：
 *   ① 位于**子目录**里 —— workDir 清扫只遍历顶层条目，护住一个目录名即可；
 *   ② 按 `EXECUTOR_INSTANCE_KIND` 分域 —— 同一台机器跑多实例时各自一行。
 *
 * 注意与指纹的区别：指纹是**本机推导**的（盐 + deviceId），id 是**中台下发**的。
 * 行被删除后旧 id 作废，执行器下一次注册会拿到新 id 并覆盖本地文件——这正是
 * 「删行重建」后不再误绑旧行的原因。
 */

/** 行 id 的合法形态：uuid 文本（长度上限防被污染的文件把脏值送进请求体）。 */
const EXECUTOR_ID_RE = /^[0-9a-fA-F-]{8,64}$/;

/** 进程级缓存：undefined = 还没读过盘。 */
let cached: string | null | undefined;

/** 落盘路径（导出供测试/排障定位）。 */
export function executorInstanceIdPath(workDir: string, kind: string): string {
  return path.join(workDir, DEVICE_IDENTITY_DIR_NAME, `${kind}.instance`);
}

/** 读本地已持久化的行 id；缺失/非法/读失败一律 null（视同未上报）。 */
export function readPersistedExecutorInstanceId(
  workDir: string = config.workDir,
  kind: string = resolveInstanceKind(),
): string | null {
  try {
    const raw = fs.readFileSync(executorInstanceIdPath(workDir, kind), 'utf8').trim();
    return EXECUTOR_ID_RE.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * 本进程应当上报的行 id（惰性读盘 + 缓存）。
 *
 * 缓存的是**中台下发的身份**，进程生命周期内不变；注册成功后会由
 * {@link persistExecutorInstanceId} 覆盖为最新值并刷新缓存。
 */
export function getExecutorInstanceId(
  opts: { workDir?: string; kind?: string } = {},
): string | null {
  if (cached === undefined) {
    cached = readPersistedExecutorInstanceId(
      opts.workDir ?? config.workDir,
      opts.kind ?? resolveInstanceKind(),
    );
  }
  return cached;
}

/**
 * 持久化注册响应里的行 id（best-effort）。
 *
 * 写失败只 warn 不抛：拿不到 id 的后果是「退回按指纹/地址定位」（引入本机制前
 * 的行为），绝不阻断注册/心跳主链。
 */
export function persistExecutorInstanceId(
  raw: unknown,
  opts: { workDir?: string; kind?: string } = {},
): string | null {
  const id = typeof raw === 'string' ? raw.trim() : '';
  if (!EXECUTOR_ID_RE.test(id)) {
    // 旧版中台 / 裁剪过的响应：不是错误，只是无从持久化。
    logger.debug('Register response carried no usable executor id; keeping the persisted one');
    return getExecutorInstanceId();
  }
  if (getExecutorInstanceId() === id) return id;
  try {
    const target = executorInstanceIdPath(
      opts.workDir ?? config.workDir,
      opts.kind ?? resolveInstanceKind(),
    );
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, id, { encoding: 'utf8', mode: 0o600 });
    cached = id;
    logger.info(`Adopted executor row id ${id} from the register response (persisted for row-scoped identity)`);
    return id;
  } catch (err: unknown) {
    logger.warn(
      `Failed to persist executor row id (falling back to fingerprint/address identity): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    cached = id;
    return id;
  }
}

/** 测试出口：丢掉进程级缓存（盘上文件仍在）。 */
export function __resetExecutorInstanceIdForTest(): void {
  cached = undefined;
}

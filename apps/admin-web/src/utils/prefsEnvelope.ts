/**
 * 通用版本化信封 localStorage 存取（复用 useDraft 的信封范式）。
 *
 * 与 hooks/useDraft.ts 同一信封形状：`{ version, savedAt, data }`；
 * 坏值防御口径一致：
 *  - 无 window / storage 被禁用（隐私模式抛 SecurityError）→ 读返回 null、写返回 false；
 *  - 坏 JSON / 版本不符 / 形状不对（由调用方 validate 判定）→ 视为无存量；
 *  - 写入 quota 满 / 隐私模式 → 静默降级为会话内记忆，绝不抛错打断 UI。
 *
 * 键命名：调用方传入完整键，统一带 `autoflow-` 前缀（与 theme/auth/lang 同惯例）。
 * 本模块只做存取与形状校验，不持有任何业务字段语义。
 */
import { readDraft, writeDraft, removeDraft } from '../hooks/useDraft';

/**
 * 读取信封并校验 data。
 *
 * @param key      完整 localStorage 键（含 autoflow- 前缀）
 * @param version  结构版本；不符整体丢弃，不做半兼容
 * @param validate data 形状守卫；返回 false 时按无存量处理
 * @returns 校验通过的 data；无存量 / 坏值 / 不可用 → null
 */
export function readEnvelope<T>(
  key: string,
  version: number,
  validate: (data: unknown) => boolean,
): T | null {
  const env = readDraft<unknown>(key, version);
  if (!env || !validate(env.data)) return null;
  return env.data as T;
}

/**
 * 写入信封。返回是否真的落盘成功（false = storage 不可用 / quota 满，调用方按会话内记忆降级）。
 */
export function writeEnvelope<T>(key: string, version: number, data: T): boolean {
  return writeDraft(key, data, version);
}

/** 删除信封。返回是否真的删掉；storage 不可用 → false。 */
export function removeEnvelope(key: string): boolean {
  return removeDraft(key);
}

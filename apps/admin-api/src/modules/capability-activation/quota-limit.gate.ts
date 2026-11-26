/**
 * N20 硬阈闸的轻量 DI 契约：只有结构接口 + Symbol  token，零 Nest/DB 依赖，
 * 内存单测可直接构造替身，裁剪部署缺席即 fail-open。
 *
 * 真实实现是 QuotaService.evaluateHardLimit（module 内用 ModuleRef 惰性别名到
 * 本 token）：activation.service 只依赖本 token，不 import quota.service，
 * 因此不会出现 quota→activation→quota 的解析期环。
 */
import type { HardLimitDecision, HardLimitTarget } from "./quota-limit";

export const QUOTA_HARD_LIMIT_GATE = Symbol("QUOTA_HARD_LIMIT_GATE");

export interface QuotaHardLimitGate {
  evaluateHardLimit(dto: HardLimitTarget): Promise<HardLimitDecision>;
}

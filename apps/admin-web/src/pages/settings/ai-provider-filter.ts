import type { AiProviderView, AiPurpose } from '../../api/ai';

/**
 * 主控在 `AiProviderView` 生成物上追加的可选标记（本文件不改生成物）。
 * 字段缺席时下面只按 id 名单过滤，行为与改造前逐字一致。
 */
type DeniedCapableProvider = AiProviderView & { deniedForUse?: boolean };

const normalizeProviderId = (id: string): string => id.trim().toLowerCase();

/**
 * 用途 → 可选条目（纯函数，导出以便单测）。
 *
 * 与服务端 `selectableProviders` 同判据：这里先挡一次，避免用户选到一个
 * 注定被服务端拒的模型（"选了才发现不行"是最差的交互）。
 *
 * ADR-044 步 2：被中台 deny 的 provider 从结果里**移除**（不是置灰）。
 * 双保险：`deniedForUse === true` 或 id（trim+lowercase 归一化）命中
 * `deniedProviderIds` 都直接过滤掉；用途判据与既有语义逐字不变。
 */
export function filterProvidersForPurpose(
  purpose: AiPurpose,
  providers: AiProviderView[],
  deniedProviderIds?: readonly string[],
): AiProviderView[] {
  const denied = new Set((deniedProviderIds ?? []).map(normalizeProviderId));
  const usable = providers.filter((p) => {
    if (!p.enabled) return false;
    if ((p as DeniedCapableProvider).deniedForUse === true) return false;
    return !denied.has(normalizeProviderId(p.id));
  });
  if (purpose === 'video') return usable.filter((p) => p.supportsVideo);
  if (purpose === 'agent') return usable.filter((p) => p.transport === 'openai');
  return usable;
}


import type { AiProviderView, AiPurpose } from '../../api/ai';

/**
 * 用途 → 可选条目（纯函数，导出以便单测）。
 *
 * 与服务端 `selectableProviders` 同判据：这里先挡一次，避免用户选到一个
 * 注定被服务端拒的模型（"选了才发现不行"是最差的交互）。
 */
export function filterProvidersForPurpose(
  purpose: AiPurpose,
  providers: AiProviderView[],
): AiProviderView[] {
  const usable = providers.filter((p) => p.enabled);
  if (purpose === 'video') return usable.filter((p) => p.supportsVideo);
  if (purpose === 'agent') return usable.filter((p) => p.transport === 'openai');
  return usable;
}


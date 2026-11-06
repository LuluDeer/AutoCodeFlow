/**
 * R139 / P2-1：视频用途模型列表的**三态**读取。
 *
 * ## 缺陷形态（修复前）
 * 页面用 `videoProviders.length === 0` 一句话同时表达三种完全不同的事实：
 *   · 请求还没回来（首帧必然成立 → 每次进页面都闪一次「没有可用的视频模型」，
 *     同时把唯一主操作「上传录屏」禁掉）；
 *   · 请求**失败**（永远停在这条预警上，文案把人引向「设置 → AI 接入」这个
 *     **错误的根因**，且页面没有任何重试入口，只能整页刷新）；
 *   · 真的一个视频模型都没有（这才是那条预警该说的话）。
 *
 * 这是本仓反复点名的一类缺陷——「读取失败 ≠ 数据为空」（同型已在
 * `ExecutorPackagesPage` 的 P3-12、`NotificationBell` 的 W5、`StateError`
 * 全站铺开里修过）。故这里把状态显式化成 `loading | ready | error`，
 * 让消费方不可能再把三者糊成一个布尔。
 *
 * ## 为什么外提成文件
 * `SopFromVideoPage.tsx` 与 `ExecutorPackagesPage.tsx` 的体量已在
 * `scripts/source-size-baseline.json` 里**顶格**（ceiling 只减不增）。新增逻辑
 * 一律落到本目录下的新文件，不往两个巨型页面里再加行。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { aiApi, type AiProviderView } from '../../api/ai';
import { showApiError } from '../../utils/error';

/** 读取状态：唯一的事实源，消费方不得再用 `数组长度` 推断。 */
export type VideoProvidersState = 'loading' | 'ready' | 'error';

export interface VideoProvidersResult {
  /** 启用了 **且** 勾了「支持视频」的接入项 = 本页唯一可选集合。 */
  video: AiProviderView[];
  state: VideoProvidersState;
  /** 失败时的原始错误（交给 `StateError` 做本地化展示）。 */
  error: unknown;
  /** 重新拉取——失败态唯一的重试入口。 */
  reload: () => void;
}

/**
 * 拉取接入项并按「支持视频 + 已启用」过滤。
 *
 * `alive` 守卫与页面其它请求同纪律：卸载后不再 setState（也避免 StrictMode
 * 双跑时后到的旧响应覆盖新状态）。失败时**同时**保留页内错误块（持久、可重试）
 * 与一次 toast（瞬时的动作反馈，与全站 `showApiError` 口径一致）。
 */
export function useVideoProviders(): VideoProvidersResult {
  const [all, setAll] = useState<AiProviderView[]>([]);
  const [state, setState] = useState<VideoProvidersState>('loading');
  const [error, setError] = useState<unknown>(null);
  // 重试序号：点「重试」只是 +1，effect 重跑；不把 reload 做成命令式请求，
  // 免得与首载两条路径各自维护 loading/error。
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setState('loading');
    setError(null);
    void (async () => {
      try {
        const view = await aiApi.listProviders();
        if (!alive) return;
        setAll(view.providers);
        setState('ready');
      } catch (err: unknown) {
        if (!alive) return;
        setError(err);
        setState('error');
        showApiError(err);
      }
    })();
    return () => {
      alive = false;
    };
  }, [attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  const video = useMemo(() => all.filter((p) => p.enabled && p.supportsVideo), [all]);

  return { video, state, error, reload };
}

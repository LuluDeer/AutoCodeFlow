/**
 * P1-9（2026-11-15 产品评审）：管理台展示版本号。
 *
 * 构建期由 vite.config.ts 的 resolveAppVersion() 注入
 * import.meta.env.VITE_APP_VERSION，单一事实源 = 仓库根 version.txt
 * （解析优先级与兜底见 vite.config.ts 注释）。这里只做透传 + 去空白，
 * 读不到时为空串——消费点据此省略版本段，不展示占位版本号。
 *
 * 消费点：登录页页脚（brand.edition 旁的版本段）。
 */
export const APP_VERSION: string = (import.meta.env.VITE_APP_VERSION ?? '').trim();

/**
 * R139：执行器包页的**上传约束常量**（从 `ExecutorPackagesPage.tsx` 外提）。
 *
 * 为什么外提：该页体量已在 `scripts/source-size-baseline.json` 顶格
 * （`nonCommentLines=773` / `functionLines=929`，只减不增），而本轮的 P2-2 /
 * P3-2 必须往组件函数里加分支。把这些纯常量搬到独立模块既腾出行数预算，
 * 也让上传弹窗与页面共用同一份约束（否则又是两份内联副本各自漂移）。
 *
 * ⚠️ **包类型选项的展示名一律走 i18n**（`install.type.node|python|universal`），
 * 本模块只持有 `value` 与「静态翻译键 → 展示名」的映射，**不出现任何面向用户的
 * 英文字面量**：
 *   · 此前页面里写死 `label: 'Universal'`，被
 *     `scripts/check-user-facing-language.mjs` 登记为已知欠账
 *     （`web-copy … ExecutorPackagesPage.tsx Universal`）——即「英文文案待修」，
 *     不是合法文案；把它换个文件登记只会让欠账搬家（脚本头注明令禁止
 *     「登记代替修复」）。
 *   · 正确修法是复用既有词条：zh 的 `install.type.universal` 已是「通用」，
 *     en 是 `Universal`；node/python 同理。故这里用**静态**翻译键调用 `t()`，
 *     不引入 `t(变量)` 那种动态键（那会要求登记
 *     `scripts/i18n-key-baseline.json` 的 `dynamicCallFiles`，属 scripts/ 写域）。
 *   · 职责边界也更清楚：展示名是**界面文案**（归 locales），扩展名与大小上限是
 *     **协议约束**（归本模块）。
 */

/**
 * 安装包类型选项——必须与后端 `ExecutorPackageType`
 * （`apps/admin-api/src/modules/executor-package/executor-package.entity.ts`：
 * `node` / `python` / `universal`）一致。
 *
 * 此前筛选器与上传表单各自内联了一份 `node|python|java|shell`：`java` 与 `shell`
 * 后端**根本不存在**，而 DTO 上是 `@IsEnum(ExecutorPackageType)` + 全局
 * `forbidNonWhitelisted`，于是选中这两项必然 400——筛选时整页变成加载失败块，
 * 上传时只得到一个泛化的「上传失败」。两处内联副本正是漂移的根源，故共用一份。
 *
 * 展示名由 `packageTypeOptions(t)` 用既有 i18n 词条渲染；筛选与上传都按 `value`
 * 匹配，`label` 仅用于展示。
 */
export function packageTypeOptions(
  t: (key: string) => string,
): Array<{ value: string; label: string }> {
  return [
    { value: 'node', label: t('install.type.node') },
    { value: 'python', label: t('install.type.python') },
    { value: 'universal', label: t('install.type.universal') },
  ];
}

/**
 * F-3：包类型 ↔ 可上传扩展名联动。后端 `ExecutorPackageType` 只有
 * node/python/universal，不存在 java/.jar；.whl 是 Python 专属（uv/pip wheel），
 * 不应在 node/universal 下可选。此前 accept 写死 `.zip,.tar.gz,.whl,.jar`，与
 * 类型枚举漂移——选 python 传 .jar 也能选，直到后端 400 才暴露。
 * 这里按当前选中类型收窄 accept，并在 beforeUpload 二次校验。
 */
export const PACKAGE_ACCEPT: Record<string, string> = {
  python: '.whl,.zip,.tar.gz,.tgz',
  node: '.zip,.tar.gz,.tgz',
  universal: '.zip,.tar.gz,.tgz',
};
export const PACKAGE_ACCEPT_FALLBACK = '.zip,.tar.gz,.tgz,.whl';

/**
 * B-12：上传大小上限——与后端 FileInterceptor limits 逐字节对齐
 * （`apps/admin-api/src/modules/executor-package/executor-package.controller.ts`:
 * `limits: { fileSize: 500 * 1024 * 1024 }`）。超限请求后端必然 413/400，
 * 前端先拦，避免用户白等一次大文件上传才发现被拒。
 */
export const MAX_PACKAGE_SIZE_BYTES = 500 * 1024 * 1024;

/** 当前包类型允许的扩展名（未选类型时给并集兜底）。 */
export function extensionsFor(type: string | undefined): string {
  return (type && PACKAGE_ACCEPT[type]) || PACKAGE_ACCEPT_FALLBACK;
}

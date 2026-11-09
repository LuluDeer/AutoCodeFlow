/**
 * 设置页「配置源」的**纯判定**（R7-B 第二刀：读路径外提的纯函数半边）。
 *
 * ## 为什么把这三条判定搬出来
 *
 * 设置页的读路径（首屏 `loadConfig` + `config:changed` 合并）此前只有源码文本
 * 契约（`readFileSync` + `includes`/`indexOf`）——它能证明"这段代码写着"，证明
 * 不了"用户编辑过 textarea 时草稿被保留、没编辑时随磁盘刷新"这类**行为**。
 * 而这些正是本页缺陷史的高频形态（P1-1：向导保存后主窗陈旧基线整表回写，
 * 静默覆盖用户刚在向导里改的端口；不报错、不崩，只有用户看得见）。
 *
 * 拆法：读路径的**副作用部分**（setState / effect 订阅）留在
 * `use-config-source.ts`，**判定部分**收进本文件（无 React / 无 DOM / 无时钟）
 * ⇒ 可被 `config-source.selftest.mjs` 直接执行，逐条钉真值表。
 *
 * ## 归属边界（与 `use-config-source.ts` 同一刀，两份文件合起来才是"读路径"）
 *
 *   · 本文件：`listText`（textarea 视图 ↔ 配置数组的唯一转换口）、
 *     `loadErrorMessage`（首屏失败文案）、`planExternalSync`（磁盘广播合并后的
 *     表单/基线/两个 textarea 草稿/一次性提示的**全部**分支）。
 *   · `use-config-source.ts`：三个 effect 的声明顺序（首屏 load → 6s 提示消退
 *     → `config:changed` 订阅）本身是语义，无法脱离 React 断言 ⇒ 由该文件头注
 *     与 `config-source.selftest.mjs` 的"取数面 + 实现体唯一性"自检钉住。
 *
 * 由 `renderer.selftest.mjs` 尾部 import 驱动断言（`npm run test:renderer`）。
 */
import { mergeConfigWithDisk } from '../../config-merge';
import { ipcErrorMessage } from '../../ipc-error';
import { sameConfigValue } from './dirty';
import type { CfgText } from './io-result';

/**
 * 配置里的数组字段 ↔ 右栏 textarea 的单行文本（唯一转换口）。
 *
 * 只认数组：掩码配置里该字段可能缺失（旧配置）或是字符串（损坏配置的兜底
 * 形态），那时显示空串而不是 `undefined`——textarea 的 value 不能是 undefined。
 */
export function listText(value: unknown): string {
  return Array.isArray(value) ? value.join('\n') : '';
}

/**
 * 首屏读取失败的页内文案（NETOPT-7⑤）。
 *
 * 刻意**独立于** `saveError`：保存失败行的前缀是「保存失败：」，套在"配置读不出
 * 来"上会撒谎（用户会以为自己刚保存失败）。错误正文走 `ipcErrorMessage` 剥
 * Electron 包装前缀，与全渲染层统一入口同口径。
 */
export function loadErrorMessage(err: unknown, t: CfgText): string {
  return t('cfg.error.loadError', ipcErrorMessage(err));
}

/** `planExternalSync` 的输出：三个 setState 目标 + 一次性提示。 */
export interface ExternalSyncPlan {
  /** 合并后的表单草稿（用户改过的字段保留、其余随磁盘刷新）。 */
  form: Record<string, unknown>;
  /** 合并后的基线（整体采用磁盘真值）。 */
  savedForm: Record<string, unknown>;
  /**
   * textarea 的新文本；**null = 不动**——用户编辑过该字段时草稿必须保留
   * （与 merge 的字段级语义一致：form 里该字段保留的是用户值，若这里回写
   * 磁盘值，textarea 与 form 会互相矛盾）。
   */
  allowedAppsText: string | null;
  allowedDomainsText: string | null;
  /** 磁盘真变了时才有的提示；null = 不提示（无更新时弹提示是噪音）。 */
  syncMsg: string | null;
}

export interface ExternalSyncInput {
  /** 用户当前草稿（合并前）。 */
  form: Record<string, unknown>;
  /** 旧基线（合并前）。 */
  savedForm: Record<string, unknown>;
  /** 磁盘新真值（`config:changed` 后重取的掩码配置）。 */
  disk: Record<string, unknown>;
  /** 文案取值（语言在页面求值一次，同 N-04 口径）。 */
  t: CfgText;
}

/**
 * P1-1：向导保存落盘后 `config:changed` 广播 → 重取磁盘真值后的**全部**合并判定。
 *
 * 语义（`config-merge.ts` 的字段级合并 + 本页 textarea 草稿的独立 state）：
 *   · 基线整体采用磁盘值（`mergeConfigWithDisk` 的既有语义）；
 *   · 用户**改过**的 textarea 字段：保留草稿（不是"以磁盘为准"——那会把用户
 *     正在编辑的白名单静默清掉）；
 *   · 用户**没改过**的：随磁盘刷新；
 *   · 提示只在 `updatedKeys` 非空时出现，且"有草稿被保留"要如实说（
 *     `cfg.sync.mergedWithDraft`），否则用户以为自己的改动丢了。
 */
export function planExternalSync(input: ExternalSyncInput): ExternalSyncPlan {
  const { form, savedForm, disk, t } = input;
  const merged = mergeConfigWithDisk({ savedForm, form, disk });
  // 「用户编辑过」的判据与 merge 内部同一口径（form vs 旧基线），故两边不会打架。
  const appsEdited = !sameConfigValue(form.agentAllowedApps, savedForm.agentAllowedApps);
  const domainsEdited = !sameConfigValue(form.agentAllowedDomains, savedForm.agentAllowedDomains);
  return {
    form: merged.form,
    savedForm: merged.savedForm,
    allowedAppsText: appsEdited ? null : listText(merged.form.agentAllowedApps),
    allowedDomainsText: domainsEdited ? null : listText(merged.form.agentAllowedDomains),
    syncMsg: merged.updatedKeys.length > 0
      ? t(
        merged.preservedKeys.length > 0 ? 'cfg.sync.mergedWithDraft' : 'cfg.sync.updated',
        merged.updatedKeys.length,
      )
      : null,
  };
}

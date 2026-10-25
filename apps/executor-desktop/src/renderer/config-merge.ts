/**
 * P1-1：向导改写配置后，主窗配置页表单与磁盘真值的**合并策略**（纯函数）。
 *
 * ## 为什么需要
 *
 * 「重新运行初始化向导」时主窗只是被 hide 让位（window-manager.openWizard，
 * 非卸载）——ConfigPage 常驻挂载、仅挂载时读过一次配置。向导保存落盘后，
 * 主窗表单基线（savedForm）与草稿（form）都是向导保存前的旧值；用户切回
 * 配置页再点「保存配置」，`saveConfig(form)` 会把**整份旧表单**写回主进程，
 * 向导刚保存的端口/对外地址/执行器名/并发数被静默回退（渲染层审计 P1-1）。
 *
 * 修复形态：主进程在 save-and-close-wizard 落盘后广播 `config:changed`
 * （对齐 history:changed 先例），ConfigPage 订阅后重取 getConfig 并用本函数
 * 合并。合并语义（审计修复单指定的「磁盘覆盖基线、用户草稿保留」）：
 *
 *   · savedForm（基线）← 磁盘值整体覆盖（新真值）；
 *   · form（草稿）：
 *       - 用户改过的字段（form 与旧基线不同）→ **保留用户值**——哪怕磁盘
 *         也变了。改动清单（form vs 新基线）如实呈现这两者的差异，由用户
 *         决定保存还是放弃；
 *       - 用户没改过的字段 ← 磁盘值（表单刷新为向导后的新配置）。
 *
 * 已知取舍：用户草稿与磁盘变更加在同一字段时保留草稿（不弹窗逐字段问），
 * 底部改动清单 + 「向导已更新配置」提示保证差异可见；token 是掩码哨兵
 * 语义（未改动 = '******' 原样回传 = 保留已存 token），不受合并影响。
 */

/** 深比较（JSON 序列化语义，与 ConfigPage.sameConfigValue 同口径）。 */
function sameConfigValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export interface ConfigMergeInput {
  /** 旧基线：用户上次「已保存」视图（合并前）。 */
  savedForm: Record<string, unknown>;
  /** 用户当前草稿（合并前）。 */
  form: Record<string, unknown>;
  /** 磁盘新真值（getConfig 重取结果，掩码形态）。 */
  disk: Record<string, unknown>;
}

export interface ConfigMergeResult {
  /** 合并后的表单草稿。 */
  form: Record<string, unknown>;
  /** 合并后的基线（= 磁盘值）。 */
  savedForm: Record<string, unknown>;
  /** 磁盘相对旧基线变更、且用户未编辑的字段（提示「表单已刷新」的依据）。 */
  updatedKeys: string[];
  /** 用户草稿被保留、且与磁盘值不同的字段（提示「未保存修改已保留」的依据）。 */
  preservedKeys: string[];
}

export function mergeConfigWithDisk(input: ConfigMergeInput): ConfigMergeResult {
  const { savedForm, form, disk } = input;
  const nextForm: Record<string, unknown> = { ...disk };
  const updatedKeys: string[] = [];
  const preservedKeys: string[] = [];

  const keys = new Set([...Object.keys(form), ...Object.keys(savedForm)]);
  for (const key of keys) {
    const userValue = form[key];
    const baselineValue = savedForm[key];
    const diskValue = disk[key];
    const userEdited = !sameConfigValue(userValue, baselineValue);
    if (userEdited) {
      // 用户改过 → 保留草稿（含恰好与磁盘相同的情况，无差异无副作用）。
      nextForm[key] = userValue;
      // preservedKeys 只收「草稿 ≠ 磁盘」的字段——草稿与磁盘碰巧一致时
      // 保存与否结果相同，不算需要用户核对的差异（selftest 钉住该口径）。
      if (!sameConfigValue(userValue, diskValue)) preservedKeys.push(key);
    } else if (!sameConfigValue(baselineValue, diskValue)) {
      // 用户没改、磁盘变了 → 随磁盘刷新（nextForm 已含 disk 值）。
      updatedKeys.push(key);
    }
  }
  return { form: nextForm, savedForm: { ...disk }, updatedKeys, preservedKeys };
}

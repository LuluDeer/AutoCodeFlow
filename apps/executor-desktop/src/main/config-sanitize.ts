/**
 * UX-DSK-NUM：渲染层数值字段落到 electron-store **之前**的消毒层（纯函数）。
 *
 * 为什么必须独立成模块：`ipc-handlers.ts` 顶层 `import { app } from 'electron'`，
 * 裸 node 下加载即崩，里面的入参处理逻辑因此长期没有回归闸（既有
 * `path-domain.ts` / `uv-paths.ts` 都是同一理由抽出来的）。本模块只依赖
 * 语言本身，可在 `npm run test:main` 里直接断言。
 *
 * 反证过的真实故障（见 config-sanitize.selftest.ts 的第一组断言）：
 *   设置页「最大并发任务数」用 `parseInt(e.target.value, 10)` 且无兜底——
 *   用户清空输入框时得到 `NaN`，`JSON.stringify(NaN)` 是 `null`，于是
 *   `ConfigStore.save()` 拿着 `null` 去 `store.set('maxConcurrentTasks', null)`，
 *   历史故障形态（conf 15 移除 ajv 校验之前）：electron-store（conf + ajv）以
 *   `Config schema violation` 抛出，IPC reject → 渲染层只显示「保存失败」，但
 *   同批次其它修改已被部分写入——用户分不清到底存没存。
 *   conf 15 起 JSON schema 校验被移除：同样的坏值现在**静默落盘**，下游
 *   （executor 子进程 env、IPC 读面）拿到 null/NaN 直接损坏——故障从
 *   「保存失败」变成「保存成功但配置坏了」，更隐蔽。消毒层因此从
 *   「改善报错」升级为「唯一防线」。
 *
 * 因此这里的策略是**写入前消毒**而不是"让 store 去抛"：
 *   - 数值字段一律钳到合法区间，非有限数回落到字段默认值（config-store defaults）；
 *   - 字符串字段非字符串回落 ''；
 *   - `workDir` 空白视为"不修改"（丢弃该键）——否则一次空字符串会把已初始化
 *     的工作目录清成空串，任务落盘点直接消失；
 *   - **P2-4：键集白名单**——只放行 KNOWN_CONFIG_KEYS 里的键，未知键一律
 *     丢弃。旧策略"其余键原样透传"有两个被审计确认的滥用面：① electron-store
 *     的 setter 按点号切键（dot-prop），渲染层送 `'a.b': 1` 会变成**嵌套写**，
 *     任意垃圾键从此落盘且永不清理；② 白名单外的键没有任何消毒，形状不受控。
 *     代价是新增配置字段必须在本模块登记（SYNC 守卫会把漂移变成红灯，
 *     与 export-flows.IMPORTABLE_CONFIG_KEYS 的同款纪律）。
 *   - **P2-4：`configured` 移出渲染层可写集**（RENDERER_IMMUTABLE_KEYS）——
 *     它是「已完成初始化向导」的标志，渲染层可写 = 被注入的脚本可以跳过
 *     向导把应用标成已配置，后续 start 会拿着空 token / 空 adminApiUrl 起
 *     执行器。设置页保存时原样回传的 `configured`（掩码配置的回显）被丢弃
 *     = 落盘值保持不变，既有合法链路无感；置位只发生在主进程链路（向导
 *     完成的 save-and-close-wizard）。
 * 消毒只覆盖"渲染层可能送错"的形状，语义校验（端口是否可用等）仍在调用方。
 */

/** 数值字段的区间与默认值（与 config-store.ts 的 defaults 对齐）。 */
export interface NumberFieldRule {
  key: string;
  /** 非有限数（NaN / null / undefined / 非数字）时回落的值。 */
  fallback: number;
  min: number;
  max: number;
}

/**
 * 三个会被渲染层 number input 污染的字段。
 *  - maxConcurrentTasks / executorPort：schema 是 number，**必须**非 NaN；
 *  - interpreterDownloadTimeoutMs：0 表示"用执行器默认"，故下界为 0。
 */
export const NUMBER_FIELDS: readonly NumberFieldRule[] = [
  { key: 'maxConcurrentTasks', fallback: 10, min: 1, max: 100 },
  { key: 'executorPort', fallback: 8002, min: 1, max: 65535 },
  { key: 'interpreterDownloadTimeoutMs', fallback: 0, min: 0, max: 86_400_000 },
];

/** 纯字符串字段：非字符串一律回落 ''（不得把 null/object 送进 store）。 */
export const STRING_FIELDS: readonly string[] = [
  'adminApiUrl',
  'executorName',
  'executorHost',
  'executorAddressPublic',
  'uvPath',
  'uvPythonInstallMirror',
  'uvPythonInstallDir',
  'pypiRegistryUrl',
  'logLevel',
];

/**
 * 布尔字段：非布尔**丢弃该键**（不猜测语义，保持已存值不变）。
 * `configured` 不在这里——它被移入 RENDERER_IMMUTABLE_KEYS（P2-4，见其注释）。
 */
export const BOOLEAN_FIELDS: readonly string[] = [
  'autoStart',
  'autoStartExecutor',
  'notifyEnabled',
  // ARCH-33：pull 回连模式开关。非布尔丢弃而非强转——`'false'` 是真值串，
  // 强转会把它变成 true，等于用户关掉 pull 却反而打开了。
  'pullMode',
  // P7b：Agent 总开关。同 pullMode 纪律——`'false'` 强转会把它变成 true，
  // 等于用户没开 Agent 却被偷偷开了（ADR-022 信任模型变更的入口，更不能错）。
  'agentEnabled',
];

/**
 * P2-4：渲染层**不可写**的键——语义上只允许主进程链路置位，消毒层无条件
 * 从保存补丁里剔除。
 *
 * `configured` 是「已完成初始化向导」的标志：渲染层可写时，被注入的脚本
 * 可以在未完成向导的情况下把它置 true（BOOLEAN_FIELDS 曾把它当普通布尔
 * 放行），跳过引导后 start 会拿着空 token / 空 adminApiUrl 起执行器。
 * 设置页回显的 configured 被丢弃 = 落盘值保持不变（已配置机器无感）；
 * 置位点只剩向导完成链路（config:save-and-close-wizard 的
 * `save({ ...safeCfg, configured: true })`）。配置导入（config:import）经
 * 同一消毒通道，导入的 configured 同样不再透传——导入到新机器后仍走一次
 * 向导确认启动参数（导入文件可能只含部分字段，静默标成已配置更危险）。
 */
export const RENDERER_IMMUTABLE_KEYS: readonly string[] = ['configured'];

/**
 * P7a（agent-and-deployment / ADR-022）：Agent 权限档位的**封闭枚举**字段。
 *
 * 为什么必须进消毒层（09 §4.1 明确点名的踩坑风险）：conf 15 移除 JSON
 * schema 校验后，坏值**静默落盘**——`sandbox` 拼成 `sandox` 不会有任何报错，
 * 而档位解析层会把未知值回落到最保守档。故障形态因此变成「用户在设置页
 * 选了 standard、保存成功、界面也显示 standard，但 Agent 实际按 off 跑」，
 * 且**没有任何日志**。这类"配置看起来生效了、行为却是另一套"的故障排查
 * 成本极高。
 *
 * 因此这里**在写入前**就把非法档位名归一化成空串（= "不覆盖"，跟随预设），
 * 而不是让坏值落盘。空串是合法语义，见 config-store.ts 的 defaults 注释。
 */
export interface EnumFieldRule {
  key: string;
  /** 合法值（小写比较，输入先 trim + 小写化）。 */
  values: readonly string[];
  /**
   * 非法值归一化为哪个值。缺省 `''`（= "不覆盖，跟随预设"，Agent 档位轴的
   * 既有语义）；**封闭且有默认值的枚举必须显式给出**（如 uiLanguage → 'en'），
   * 否则非法值会被归一化成 `''`，而 `''` 不在该枚举的合法集里——等于把一个
   * 坏值换成另一个坏值，下游只能靠各自的兜底逻辑猜。
   */
  fallback?: string;
}

export const ENUM_FIELDS: readonly EnumFieldRule[] = [
  {
    key: 'agentPermissionProfile',
    values: ['minimal', 'standard', 'developer', 'ops-assist', 'full-trust'],
  },
  { key: 'agentCodeExecution', values: ['off', 'sandbox', 'host'] },
  { key: 'agentSandboxBackend', values: ['none', 'process', 'container', 'vm'] },
  { key: 'agentHostAccess', values: ['none', 'app-scoped', 'session'] },
  { key: 'agentTaskExecution', values: ['deploy-only', 'isolated-runner'] },
  // i18n-DESK-01：界面语言（zh/en/auto）。与 Agent 档位不同的是它**有明确
  // 默认值**：非法值（手改 config.json 写成 'fr' / '' / 数字）必须归一化成
  // 'en'，而不是 ''——'' 不是合法语言，判定层还得再猜一次；且产品要求默认英文。
  { key: 'uiLanguage', values: ['zh', 'en', 'auto'], fallback: 'en' },
];

/** P7a：字符串数组成员（白名单清单）——非数组清空、非字符串条目剔除、条数封顶。 */
export const STRING_LIST_FIELDS: readonly { key: string; max: number }[] = [
  { key: 'agentAllowedApps', max: 32 },
  { key: 'agentAllowedDomains', max: 64 },
];

/**
 * P2-4：保存面（config:save / config:import / 向导）的**键集白名单**。
 * 由各字段表 + 密钥/目录等特殊键派生——新增配置字段时把键加进对应字段表
 * （或下方显式清单），白名单自动跟上；自检见 config-sanitize.selftest.ts
 * 的 SYNC 守卫（与 export-flows.IMPORTABLE_CONFIG_KEYS / config-store 的
 * AppConfig 三方对齐）。
 */
export const KNOWN_CONFIG_KEYS: ReadonlySet<string> = new Set<string>([
  ...NUMBER_FIELDS.map((r) => r.key),
  ...STRING_FIELDS,
  ...BOOLEAN_FIELDS,
  ...ENUM_FIELDS.map((r) => r.key),
  ...STRING_LIST_FIELDS.map((r) => r.key),
  // 密钥（走 save() 的独立加密/掩码分支）与工作目录（sanitize 有专门的
  // "空白 = 不修改"规则），都不属于上面的形状字段表：
  'executorToken',
  'workDir',
  // 已知但渲染层不可写（sanitize 输出里被剔除）：
  ...RENDERER_IMMUTABLE_KEYS,
]);

/**
 * 把任意入参规整成一个落进 electron-store 安全的值。
 *
 * 非有限数（NaN / ±Infinity）、`null`、`undefined`、`{}`、`[]`、数字字符串
 * 之外的类型都走回落；数字字符串（`'12'`）按数字解析——渲染层 `<input
 * type="number">` 在部分浏览器/IME 组合下会给出字符串。
 */
export function coerceNumber(value: unknown, rule: NumberFieldRule): number {
  // 空/空白串 = 用户清空了输入框 = "未指定"，必须回落默认值，而不是当 0
  // （当 0 会被钳到下界，于是"清空并发数"变成 1——与 UI 显示的 10 又不一致）。
  if (typeof value === 'string' && value.trim() === '') return clamp(rule.fallback, rule);
  const n =
    typeof value === 'number' ? value
    : typeof value === 'string' ? Number(value.trim())
    : NaN;
  if (!Number.isFinite(n)) return clamp(rule.fallback, rule);
  return clamp(n, rule);
}

function clamp(n: number, rule: NumberFieldRule): number {
  // 先 round 再钳：小数会让 executor-node 的 parseInt 语义与 UI 显示不一致。
  const rounded = Math.round(n);
  return Math.min(Math.max(rounded, rule.min), rule.max);
}

/**
 * 消毒一份渲染层送来的配置补丁，返回**新对象**（不改入参）。
 *
 * P2-4：先按 KNOWN_CONFIG_KEYS 过滤键集（未知键/点号键一律丢弃，不再原样
 * 透传），再剔除渲染层不可写键（RENDERER_IMMUTABLE_KEYS），最后只对本模块
 * 认识的形状做消毒（数值钳制/枚举归一化/清单白名单等，语义见各字段表）。
 */
export function sanitizeConfigInput(
  cfg: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(cfg)) {
    // 点号键（'a.b'）不匹配任何白名单键，在这里就被丢弃——不会走到
    // electron-store 的 dot-prop 嵌套写。
    if (!KNOWN_CONFIG_KEYS.has(key)) continue;
    out[key] = cfg[key];
  }
  // 渲染层不可写键：无条件剔除（置位只属于主进程链路，见其注释）。
  for (const key of RENDERER_IMMUTABLE_KEYS) {
    delete out[key];
  }

  for (const rule of NUMBER_FIELDS) {
    if (rule.key in out) {
      out[rule.key] = coerceNumber(out[rule.key], rule);
    }
  }

  for (const key of STRING_FIELDS) {
    if (key in out && typeof out[key] !== 'string') {
      out[key] = '';
    }
  }

  for (const key of BOOLEAN_FIELDS) {
    if (key in out && typeof out[key] !== 'boolean') {
      delete out[key];
    }
  }

  // P7a（ADR-022）：Agent 权限档位——封闭枚举，非法值归一化为该规则的
  // fallback（Agent 各轴 = 空串"不覆盖"；uiLanguage = 'en' 默认英文）。
  // **不删除该键**：删键意味着"保留已存值"，而一个拼错的值若因此留在盘上，
  // 用户看到的仍是旧值、界面无法反映"我刚选的那个没生效"。写成 fallback 则让
  // 该轴明确落到一个确定的合法值——语义确定、可解释、且不会再有坏值残留。
  for (const rule of ENUM_FIELDS) {
    const fallback = rule.fallback ?? '';
    if (!(rule.key in out)) continue;
    const v = out[rule.key];
    if (typeof v !== 'string') {
      out[rule.key] = fallback;
      continue;
    }
    const normalized = v.trim().toLowerCase();
    out[rule.key] = rule.values.includes(normalized) ? normalized : fallback;
  }

  // P7a：白名清单——非数组一律清空（不得把对象/标量带进 store）；
  // 条目只留非空字符串并封顶（防超大清单拖垮每次路径/域名校验）。
  for (const rule of STRING_LIST_FIELDS) {
    if (!(rule.key in out)) continue;
    const v = out[rule.key];
    if (!Array.isArray(v)) {
      out[rule.key] = [];
      continue;
    }
    out[rule.key] = v
      .filter((s): s is string => typeof s === 'string' && s.trim() !== '')
      .map((s) => s.trim())
      .slice(0, rule.max);
  }

  // 密钥字段：非字符串时**丢弃**（ConfigStore.save 里 executorToken 走独立的
  // 加密/掩码分支，塞 null 进去既无意义又损坏存储）。
  if ('executorToken' in out && typeof out.executorToken !== 'string') {
    delete out.executorToken;
  }

  // workDir：空白/非字符串 = "不修改"。它一旦被清成空串，任务落盘点就没了
  // （config-store 只在构造时补默认值，运行中不会回填）。
  if ('workDir' in out) {
    const wd = out.workDir;
    if (typeof wd !== 'string' || wd.trim() === '') delete out.workDir;
  }

  return out;
}

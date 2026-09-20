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
 *   electron-store（conf + ajv）以
 *   `Config schema violation: maxConcurrentTasks must be number` 抛出。
 *   抛点位于 `config:save` handler 内 → IPC reject → 渲染层 `save()` 的 catch
 *   只显示「保存失败」，但**同批次的其它修改已被部分写入**（executorName 等
 *   在异常前已 set 进内存 store，只是没落盘）。用户看到的是「改了名、也报了错」，
 *   且重新打开设置页可能看到旧值——分不清到底存没存。
 *
 * 因此这里的策略是**写入前消毒**而不是"让 store 去抛"：
 *   - 数值字段一律钳到合法区间，非有限数回落到 schema default；
 *   - 字符串字段非字符串回落 ''；
 *   - `workDir` 空白视为"不修改"（丢弃该键）——否则一次空字符串会把已初始化
 *     的工作目录清成空串，任务落盘点直接消失。
 * 消毒只覆盖"渲染层可能送错"的形状，语义校验（端口是否可用等）仍在调用方。
 */

/** 数值字段的区间与默认值（与 config-store.ts 的 schema default 对齐）。 */
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

/** 布尔字段：非布尔**丢弃该键**（不猜测语义，保持已存值不变）。 */
export const BOOLEAN_FIELDS: readonly string[] = [
  'configured',
  'autoStart',
  'autoStartExecutor',
  'notifyEnabled',
  // ARCH-33：pull 回连模式开关。非布尔丢弃而非强转——`'false'` 是真值串，
  // 强转会把它变成 true，等于用户关掉 pull 却反而打开了。
  'pullMode',
];

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
 * 只处理本模块认识的形状；其余键原样透传（避免每次新增配置项都要改这里）。
 */
export function sanitizeConfigInput(
  cfg: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...cfg };

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

  // 密钥字段：非字符串时**丢弃**（ConfigStore.save 里 executorToken 走独立的
  // 加密/掩码分支，塞 null 进去既无意义又会撞 schema）。
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

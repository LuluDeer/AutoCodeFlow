/**
 * A-11R：params → 子进程 env 的**注入口径**（单一出处）。
 *
 * ## 背景：A-11 修对了一半，另一半造成了生产回归
 *
 * A-11（2026-10-02，R5 审计第 11 项）把 params→env 的序列化从 `String(v)` 改成
 * `JSON.stringify(v)`，理由是 `String(v)` 与 python 的 `str(v)` 对布尔/空值/
 * 容器产出不同字节（`true` vs `True`、`null` vs `None`、`["a"]` vs `['a']`），
 * 同一任务脚本在两个执行器上读到不同值。**这个缺口是真的**，必须保留修复。
 *
 * 但落地时把**字符串也一起 JSON 化**了，而中台 `ParamsEditor` 的契约是
 * `Record<string, string>`——控制台上配的每一个参数都是字符串。于是 A-11 之后
 * 经中台 UI 配置的**全部**参数都被加了一对首尾双引号：
 *
 *     params {"region":"欧盟"}  →  AUTOFLOW_REGION='"欧盟"'   ← 值里带引号
 *     params {"limit":"3"}      →  AUTOFLOW_LIMIT='"3"'
 *     params {"mode":""}        →  AUTOFLOW_MODE='""'        ← 而且 '""' 是真值
 *
 * 后果是**静默**的：按官方文档 `int(os.environ["AUTOFLOW_LIMIT"])` 裸读的存量
 * 脚本直接 `ValueError: invalid literal for int() with base 10: '"3"'`。生产
 * 实证：`tk-ship-notify` 因此停摆 12 天（2026-10-02 ~ 10-14）无人察觉。
 *
 * ## 本模块的口径（两条通道并存）
 *
 * ① **逐键通道 `AUTOFLOW_<KEY>`**（向后兼容，救存量脚本与 shell/node/第三方 SDK）
 *    - 字符串 → **裸值**，不加任何引号（回到 A-11 之前对字符串的行为）
 *    - 非字符串（布尔/数字/null/数组/对象）→ **JSON**，保留 A-11 的真修复
 *
 *    这样「中台 UI 配的参数」与「文档教的裸读」重新一致，而布尔/容器仍与
 *    python 逐字节相同。
 *
 * ② **类型化通道 `AUTOFLOW_PARAMS_JSON`**（新增，消除字符串语义歧义）
 *    整个 params 对象一份 JSON。**这是唯一能区分**「用户填了字符串 `"true"`」
 *    与「用户传了布尔 `true`」的通道——env 值是字符串，逐键通道在原理上无法
 *    表达这个区别。SDK 的 `fromEnv()` 优先读它并做类型还原。
 *
 *    注入点在 params 循环**之后**（与 AUTOFLOW_CALLBACK_TOKEN 同一纪律）：
 *    用户参数不得覆盖平台变量；一个名为 `params_json` 的参数会被这一条覆盖，
 *    这是刻意的——该名字属于平台命名空间。
 *
 * ## 为什么字符串能安全地回到裸值
 *
 * 逐键通道的**消费方本来就只有两种读法**：裸读（文档教的、脚本里写的、
 * shell/`$AUTOFLOW_X` 拼命令用的）与 JSON 解析（抄了 `getParam` 容错的）。
 * 裸值让第一种恢复正确；第二种（`JSON.parse`）对裸 `欧盟` 会抛错，故 SDK 的
 * `getParam` 必须做**容错回退**（见 autocodeflow-node-sdk 的 getParam）。而
 * 需要精确类型的消费方一律改用 ②，不再依赖对 ① 做猜测性解析。
 *
 * python 侧对等实现：`apps/executor-python/routers/execute.py` 的
 * `_serialize_param_value`（字符串裸值）+ `apps/executor-python/js_json.py`
 * （非字符串的 JSON，与 `JSON.stringify` **逐字节**一致，含浮点指数形态与
 * JS 的整数键排序——A-11 自称的 "两端逐字节一致" 此前并未做到）。
 *
 * 契约向量：packages/contract-fixtures/contract.json 的
 * `executorEnvSerializationV2` 段（append-only；V1 段为 A-11 语义的历史档案）。
 */

/**
 * 类型化通道的变量名。
 *
 * ⚠️ 保留名：它落在 params 的 `AUTOFLOW_` 命名空间内，同名参数会被覆盖。
 * 中台侧另有 `secret-key-map.constraint.ts` 禁止 secret 占用 `AUTOFLOW_` 前缀，
 * 故只有 params 键能与之冲突。
 */
export const PARAMS_JSON_ENV_KEY = 'AUTOFLOW_PARAMS_JSON';

/**
 * 逐键通道：把单个参数值序列化成注入 env 的字节。
 *
 * 字符串**原样**返回（不加引号）；其余类型走 `JSON.stringify`。
 * `undefined` 只在进程内直调（runTask）时可能出现——JSON 载荷不可携带它，
 * 而 `JSON.stringify(undefined)` 返回 `undefined`（不是字符串），故兜底成空串
 * （env 值必须是字符串；写成 `"undefined"` 会让脚本拿到一个看似合法的假值）。
 */
export function serializeParamEnvValue(value: unknown): string {
  if (typeof value === 'string') return value;
  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value) : serialized;
}

/**
 * 逐键通道的键名：`AUTOFLOW_<KEY>`（键名转大写，与 python 的 `k.upper()` 同形）。
 */
export function paramEnvKey(key: string): string {
  return `AUTOFLOW_${key.toUpperCase()}`;
}

/**
 * 类型化通道：把整个 params 对象序列化成一份紧凑 JSON。
 *
 * 返回 `null` 表示**不该注入**（params 为空或不可序列化）——空对象注入
 * `{}` 只会让消费方多一个需要特判的形态，缺席比空值更清楚。
 *
 * 不可序列化（循环引用等）：让 `JSON.stringify` 抛出的错误向上传播。派发载荷
 * 来自 HTTP JSON，构造不出循环引用，故这是**不可能路径**；真出现时宁可让该次
 * 执行以明确错误失败，也不要静默注入一个残缺的参数视图。
 */
export function serializeParamsJson(
  params: Record<string, unknown> | null | undefined,
): string | null {
  if (!params) return null;
  const keys = Object.keys(params);
  if (keys.length === 0) return null;
  return JSON.stringify(params);
}

/**
 * P2-2（2026-10-26 执行器域审计）：params 逐键通道的**键名闸**。
 *
 * ## 为什么 params 也需要键名闸（此前零校验）
 *
 * params 注入形态是 `env[paramEnvKey(k)] = …`，即 `AUTOFLOW_<KEY 大写>`——
 * 键名**直接成为子进程环境变量名**。含 `=` 的键（`A=B` → `AUTOFLOW_A=B`）会让
 * node spawn 构造 env 时**直接抛错**（secrets 向量 illegal-equals 注释自证同形：
 * spawn 对含 `=` 的 env 键同步 throw，任务以与参数毫无关系的形式失败）；
 * 含空格/短横线/点的键在 shell 引用（`$AUTOFLOW_MY-KEY`）里必然错位。此前
 * 这些键直通 env——POSIX 下部分形态侥幸可用（unicode 键），Windows 下必坏，
 * 且两端失败方式不一致（node spawn 抛错 / python 静默注入坏名）。
 *
 * ## 规则形态（对齐 secrets keyPattern 的宽松版）
 *
 * 单一事实源是 `packages/executor-protocol/protocol.json` 顶层 `params` 段
 * （keyPattern `^[A-Za-z0-9_]{1,64}$`、onInvalidKey skip-and-warn）。与
 * secret-env.ts 的 `SAFE_SECRET_NAME_RE`（`^[A-Za-z_][A-Za-z0-9_]*$`）的两点
 * 刻意差异：① 无首字符限制——`AUTOFLOW_` 前缀保证 env 名首字符合法，数字开头
 * 的原始键不构成风险；② 长度 ≤64——含前缀后仍有界。**不挂保留名/前缀拒绝**：
 * params 走 `AUTOFLOW_` 命名空间，用户参数不可能触碰平台变量（同名参数被
 * PARAMS_JSON_ENV_KEY 等平台键按注入顺序覆盖，那是既有语义不是漏洞）。
 *
 * 三端同款规则（常量注释互指）：admin 源头主闸
 * `apps/admin-api/src/modules/executor/dispatch-params-keys.util.ts`
 * （DISPATCH_PARAM_KEY_PATTERN，派发时跳过坏键保留好键）；本文件是执行器侧
 * 防御纵深（pull 载荷、直连 /api/execute 都是入口，执行器不能假设上游一定
 * 校验过——与 secret-env.ts 头注同一立场）；python 对等实现
 * `apps/executor-python/routers/execute.py` 的 `_is_injectable_param_key`。
 * 向量断言：`__tests__/executor-protocol-contract.spec.ts` 的 params 段
 * （对真实实现逐条断言 protocol.json params.vectors）。
 */
const SAFE_PARAM_ENV_KEY_RE = /^[A-Za-z0-9_]{1,64}$/;

/** 该 params 键是否可注入逐键通道（`AUTOFLOW_<KEY 大写>` 形态）。 */
export function isInjectableParamEnvKey(key: string): boolean {
  return SAFE_PARAM_ENV_KEY_RE.test(key);
}

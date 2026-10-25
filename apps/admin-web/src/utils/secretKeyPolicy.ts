/**
 * F-7（UIUX 审计 P2-6）：secrets 键名规则的前端单一真值源——**逐字镜像**后端
 * `apps/admin-api/src/modules/task/dto/secret-key-map.constraint.ts`
 * （`SAFE_SECRET_NAME_RE` / `RESERVED_SECRET_NAMES` / `describeSecretKeyProblem`
 * 的三条规则）。
 *
 * 为什么要有这个文件（对齐任务名/密码的镜像校验先例）：
 * 之前 SecretsEditor 对 key 输入零校验——用户填 `my-key`、`PATH`、
 * `AUTOFLOW_TOKEN`，编辑器照常收值，保存时整批 400（错误提示是后端校验串），
 * 掩码合并语义下用户难以定位是哪一行的问题。前端在行内即时给出与后端同一套
 * 规则的判定，问题在「输入」这一步就可见，而不是等保存被拒。
 *
 * 规则语义与后端逐条一致（后端头注释有完整论证）：
 *  1. 键名必须匹配 `[A-Za-z_][A-Za-z0-9_]*`（合法环境变量名）；
 *  2. 不得占用保留名（全部按大写比对——Windows 环境变量名大小写不敏感）；
 *  3. 不得以 `AUTOFLOW_` 开头（那是 params 的命名空间）；
 *  4. 不得以 `PYTHON` 开头（解释器行为开关，执行器必须独占）。
 *
 * 双侧一致性纪律不靠肉眼比对字面量：`__tests__/secret-key-policy-source-guard.test.ts`
 * 从两侧源码抽出正则与保留名清单逐项核验（对齐 scripts/check-password-policy-sync.mjs
 * 的源码级核验思路，落在 vitest 门禁内），任一侧漂移即测试红。
 */

/** 合法环境变量名（与后端 SAFE_SECRET_NAME_RE 逐字一致，源码守卫钉住）。 */
export const SECRET_KEY_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 保留名（全部按大写比对）。清单与后端 RESERVED_SECRET_NAMES 同集，源码守卫钉住。
 */
export const RESERVED_SECRET_NAMES: ReadonlySet<string> = new Set<string>(
  [
    // 执行器注入的任务作用域变量
    'EXECUTION_ID',
    'TASK_ID',
    'TASK_NAME',
    'NODE_PATH',
    // 环境白名单透传的宿主变量（与 executor-node env-whitelist.ts 同集）
    'PATH',
    'HOME',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TZ',
    'npm_config_cache',
    'npm_config_prefix',
    'TMPDIR',
    'TEMP',
    'TMP',
    'USER',
    'LOGNAME',
    'SHELL',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'USERNAME',
    'APPDATA',
    'LOCALAPPDATA',
    'ProgramData',
    // 执行器密钥
    'EXECUTOR_SHARED_TOKEN',
    'EXECUTOR_SECRET',
    'EXECUTION_CALLBACK_SECRET',
  ].map((n) => n.toUpperCase()),
);

/** 键名问题分类（顺序 = 后端 describeSecretKeyProblem 的判定顺序）。 */
export type SecretKeyProblem = 'invalidName' | 'reserved' | 'autoflowPrefix' | 'pythonPrefix';

/** 分类 → i18n 词条键（词条带 {{key}} 占位，见 locales 的 secretsEditor.keyError.*）。 */
export const SECRET_KEY_PROBLEM_T_KEYS: Record<SecretKeyProblem, string> = {
  invalidName: 'secretsEditor.keyError.invalidName',
  reserved: 'secretsEditor.keyError.reserved',
  autoflowPrefix: 'secretsEditor.keyError.autoflowPrefix',
  pythonPrefix: 'secretsEditor.keyError.pythonPrefix',
};

/**
 * 单个键名的问题分类；null = 可用（与后端 describeSecretKeyProblem 同判定序）。
 * 判定只用键名本身，不掺值语义——与后端 `for (const key of Object.keys(value))`
 * 同口径：值（含 null=删除）不参与键名合法性判定。
 */
export function describeSecretKeyProblemKind(key: string): SecretKeyProblem | null {
  if (!SECRET_KEY_NAME_RE.test(key)) return 'invalidName';
  const upper = key.toUpperCase();
  if (RESERVED_SECRET_NAMES.has(upper)) return 'reserved';
  if (upper.startsWith('AUTOFLOW_')) return 'autoflowPrefix';
  if (upper.startsWith('PYTHON')) return 'pythonPrefix';
  return null;
}

/**
 * 对提交载荷（SecretsPatchValue 形态：值可为 null=删除该键）逐键判定，
 * 返回问题键列表——TaskFormPage 提交前据此拦截（对齐任务名/密码的镜像校验
 * 先例：前端拦得住，后端才不会 400）。判定键集合与后端完全一致：载荷里的
 * 每个键（含 null 叶子）都过一遍 describeSecretKeyProblemKind。
 */
export function findInvalidSecretKeys(
  value: Record<string, unknown> | null | undefined,
): { key: string; problem: SecretKeyProblem }[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const problems: { key: string; problem: SecretKeyProblem }[] = [];
  for (const key of Object.keys(value)) {
    const problem = describeSecretKeyProblemKind(key);
    if (problem) problems.push({ key, problem });
  }
  return problems;
}

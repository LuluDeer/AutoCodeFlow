import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from "class-validator";

/**
 * SEC-02 续：secrets 键名的可注入性校验（DTO 层，给用户可读的 400）。
 *
 * ## 为什么 DTO 层也要校验
 *
 * 执行器侧已有一道闸门（`apps/executor-node/src/secret-env.ts` 与
 * `apps/executor-python/secret_env.py` 的 `isInjectableSecretName`），它保证
 * 非法键名**不会**被写进子进程 env。但执行器的姿态是"静默跳过 + warn"——
 * 对已经跑起来的任务这是对的（一个手滑的键名不该让整个任务起不来），
 * 对**保存任务**这个动作却是错的：用户以为凭据配好了，实际每次执行都被
 * 丢掉，直到任务在业务上失败才隐约察觉。
 *
 * 所以在写路径上直接拒绝，把问题拦在"保存"这一步，并给出**可操作**的错误
 * 信息（哪个键名、为什么不行）。执行器那道闸门保留为兜底——执行器不能假设
 * 上游一定校验过（pull 载荷、直连 `/api/execute` 都是入口）。
 *
 * ## 校验规则（与执行器侧逐条一致）
 *
 * 1. 键名必须匹配 `[A-Za-z_][A-Za-z0-9_]*`（合法环境变量名）；
 * 2. 不得占用保留名：环境白名单透传的宿主变量（PATH/HOME/TMPDIR…）、执行器
 *    密钥、执行器注入的任务作用域变量（EXECUTION_ID/TASK_ID/TASK_NAME）；
 * 3. 不得以 `AUTOFLOW_` 开头（那是 params 的命名空间，占用会互相覆盖）；
 * 4. 不得以 `PYTHON` 开头（解释器行为开关，执行器必须独占——见 I18N-01：
 *    `PYTHONIOENCODING` 被覆盖会让中文日志重新变乱码）。
 *
 * ## 为什么这里**不**直接 import 执行器的实现
 *
 * admin-api 与 executor-node 是两个独立可发布的包，没有共享运行时依赖
 * （admin-api 不能 import executor-node 的源码）。故规则在此**重述**一遍，
 * 并由 `secret-key-map.constraint.spec.ts` 里的对等性断言钉住两侧一致——
 * 单侧改动会让测试转红，而不是让两个包在运行时悄悄分叉。
 */

/** 合法环境变量名（与执行器侧 SAFE_SECRET_NAME_RE 同款）。 */
const SAFE_SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 保留名（全部按大写比对——Windows 环境变量名大小写不敏感，用户可能写
 * `Path`/`path`）。与执行器侧 RESERVED_SECRET_NAMES 同集。
 */
const RESERVED_SECRET_NAMES = new Set<string>(
  [
    // 执行器注入的任务作用域变量
    "EXECUTION_ID",
    "TASK_ID",
    "TASK_NAME",
    "NODE_PATH",
    // 环境白名单透传的宿主变量（与 executor-node env-whitelist.ts 同集）
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "npm_config_cache",
    "npm_config_prefix",
    "TMPDIR",
    "TEMP",
    "TMP",
    "USER",
    "LOGNAME",
    "SHELL",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "USERNAME",
    "APPDATA",
    "LOCALAPPDATA",
    "ProgramData",
    // 执行器密钥
    "EXECUTOR_SHARED_TOKEN",
    "EXECUTOR_SECRET",
    "EXECUTION_CALLBACK_SECRET",
  ].map((n) => n.toUpperCase()),
);

/** 单个键名的问题描述；null = 可用。 */
export function describeSecretKeyProblem(key: string): string | null {
  if (!SAFE_SECRET_NAME_RE.test(key)) {
    return `"${key}" 不是合法的环境变量名（需匹配 [A-Za-z_][A-Za-z0-9_]*）`;
  }
  const upper = key.toUpperCase();
  if (RESERVED_SECRET_NAMES.has(upper)) {
    return `"${key}" 是平台保留的环境变量名，不能作为凭据键`;
  }
  if (upper.startsWith("AUTOFLOW_")) {
    return `"${key}" 使用了 AUTOFLOW_ 前缀（平台参数命名空间），请改用别的键名`;
  }
  if (upper.startsWith("PYTHON")) {
    return `"${key}" 使用了 PYTHON 前缀（解释器行为开关），请改用别的键名`;
  }
  return null;
}

/** 该键名是否可注入（与执行器侧 isInjectableSecretName 对等）。 */
export function isInjectableSecretKey(key: string): boolean {
  return describeSecretKeyProblem(key) === null;
}

@ValidatorConstraint({ name: "isSecretKeyMap", async: false })
export class IsSecretKeyMapConstraint implements ValidatorConstraintInterface {
  private problems: string[] = [];

  validate(value: unknown): boolean {
    this.problems = [];
    // null / undefined 合法：PATCH 的"清空"语义与"未提供"都由 @IsOptional 处理。
    if (value === null || value === undefined) return true;
    if (typeof value !== "object" || Array.isArray(value)) {
      this.problems.push("凭据必须是以键值对形式给出的对象");
      return false;
    }
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const problem = describeSecretKeyProblem(key);
      if (problem) this.problems.push(problem);
    }
    return this.problems.length === 0;
  }

  defaultMessage(_args: ValidationArguments): string {
    return `凭据键名不可用：${this.problems.join("；")}`;
  }
}

/**
 * 校验 secrets 的键名可注入性。放在 `@IsObject()` 之后：类型不对时先报类型
 * 错误，键名问题只在确实是对象时才逐键检查。
 */
export function IsSecretKeyMap(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: "isSecretKeyMap",
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: IsSecretKeyMapConstraint,
    });
  };
}

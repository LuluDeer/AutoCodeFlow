/**
 * GENERATED — DO NOT EDIT.
 *
 * 来源：`packages/executor-protocol/protocol.json` 的 `failureReason.classifiers` 段。
 * 由 `node scripts/generate-failure-classifiers.mjs` 生成。
 *
 * 用途：failureReason 分类器的 **TS 侧**类型与常量导出。求值逻辑在
 * `failure-classifier.mjs`（同目录）——它同时被 node 侧的 admin / executor
 * 落地与跨语言一致性探针复用，故 TS 侧只导出**类型 + 规则表**，不重复实现
 * 判定（避免又一份「看起来一样但行为不同」的判定）。
 *
 * 手改本文件会在下次生成时被覆盖，且不会让契约生效——要改请改 protocol.json。
 */

/** 分类阶段。executor = 执行器在失败发生地做细粒度归因；admin = 中台对文本兜底裁决。 */
export type FailureClassifyStage = "executor" | "admin";

/** 契约里的码（取自 failureReason.all，**逐字**）。 */
export type ContractFailureCode =
  | "package_fetch_failed"
  | "script_error"
  | "timeout"
  | "executor_offline"
  | "executor_restart"
  | "stale_recovered"
  | "dependency_install_failed"
  | "git_fetch_failed"
  | "runtime_missing"
  | "sandbox_unavailable"
  | "interpreter_unavailable"
  | "killed"
  | "unknown"
  | "application_missing"
  | "never_dispatched";

/** 分类器返回的码：executor 阶段可能返回 null（「我不知道，交给中台」）。 */
export type ClassifiedFailureCode = ContractFailureCode | null;

/** 一条契约规则（`body` 是已翻译的正则体：token 已展开、禁令已规避）。 */
export interface FailureClassifierRule {
  readonly id: string;
  readonly order: number;
  readonly code: ContractFailureCode;
  readonly appliesTo: readonly FailureClassifyStage[];
  readonly body: string;
}

/** 契约 token 表（字符类；**不用** \w/\b/\d —— 那是两语言语义不同的构造）。 */
export const FAILURE_CLASSIFIER_TOKENS = {
  "WS": "[ \\t\\n\\r\\f\\v]",
  "NONWS": "[^ \\t\\n\\r\\f\\v]",
  "WORD": "[A-Za-z0-9_]",
  "NONWORD": "[^A-Za-z0-9_]",
  "ANY_ONE_LINE": "[^\\n]"
} as const;

/** 规则表（按 `order` 升序 —— 顺序即规格）。 */
export const FAILURE_CLASSIFIER_RULES: readonly FailureClassifierRule[] = [
  {
    "id": "interpreter_unavailable",
    "order": 10,
    "code": "interpreter_unavailable",
    "appliesTo": [
      "executor",
      "admin"
    ],
    "body": "no interpreter found|no download found|python downloads are set to|interpreter[^\\n]{0,40}?(?:unavailable|not found|missing|unable)|(?:unavailable|not found|missing|unable)[^\\n]{0,40}?interpreter|interpreter[^\\n]{0,40}?(?:download|install)[^\\n]{0,40}?(?:fail|timeout|timed out)|(?:download|install)[^\\n]{0,40}?(?:fail|timeout|timed out)[^\\n]{0,40}?interpreter|python [A-Za-z0-9_]+?(?:[.][A-Za-z0-9_]+)*(?: unavailable| not found| 不可用| 未找到)|[（(](?:not_downloadable|download_failed|download_timeout|mirror_unreachable|corrupt|uv_missing)[）)]|解释器[^\\n]{0,20}?(?:无法获取|不可用|不可获得|缺失|找不到)|解释器[^\\n]{0,20}?下载[^\\n]{0,20}?(?:失败|超时)"
  },
  {
    "id": "application_missing",
    "order": 20,
    "code": "application_missing",
    "appliesTo": [
      "admin"
    ],
    "body": "cannot resolve packageurl|application[ \\t\\n\\r\\f\\v]+[^ \\t\\n\\r\\f\\v]+[ \\t\\n\\r\\f\\v]+not found|无法解析[ \\t\\n\\r\\f\\v]*packageurl|应用[ \\t\\n\\r\\f\\v]*[^ \\t\\n\\r\\f\\v]*[ \\t\\n\\r\\f\\v]*不存在|找不到应用"
  },
  {
    "id": "application_missing_defer",
    "order": 25,
    "code": null,
    "appliesTo": [
      "executor"
    ],
    "body": "cannot resolve packageurl|application[ \\t\\n\\r\\f\\v]+[^ \\t\\n\\r\\f\\v]+[ \\t\\n\\r\\f\\v]+not found|无法解析[ \\t\\n\\r\\f\\v]*packageurl|应用[ \\t\\n\\r\\f\\v]*[^ \\t\\n\\r\\f\\v]*[ \\t\\n\\r\\f\\v]*不存在|找不到应用"
  },
  {
    "id": "terminal_timeout",
    "order": 30,
    "code": "timeout",
    "appliesTo": [
      "executor"
    ],
    "body": "任务执行超时|execution timed out|task execution timed out"
  },
  {
    "id": "git_fetch_failed",
    "order": 32,
    "code": "git_fetch_failed",
    "appliesTo": [
      "executor",
      "admin"
    ],
    "body": "git (?:clone|fetch|checkout) failed|git (?:clone|fetch|checkout) 执行失败|[^A-Za-z0-9_]git[^A-Za-z0-9_][^\\n]*returned non-zero|[^A-Za-z0-9_]git[^A-Za-z0-9_][^\\n]*[^A-Za-z0-9_](?:clone|fetch|checkout)[^A-Za-z0-9_][^\\n]*fail|git (?:clone|fetch|checkout)[^\\n]{0,20}?(?:timed out|超时)"
  },
  {
    "id": "dependency_install_failed",
    "order": 34,
    "code": "dependency_install_failed",
    "appliesTo": [
      "executor",
      "admin"
    ],
    "body": "npm install failed|uv pip install failed|pip install failed|dependency installation failed|npm install[^\\n]{0,10}?失败|uv pip install[^\\n]{0,10}?失败|pip install[^\\n]{0,10}?失败|依赖安装失败|uv (?:pip install|venv) (?:install )?failed|uv venv[^\\n]{0,20}?超时|uv venv timed out|uv venv 执行失败|uv pip install 执行失败"
  },
  {
    "id": "terminal_timeout_admin_broad",
    "order": 35,
    "code": "timeout",
    "appliesTo": [
      "admin"
    ],
    "body": "timeout|timed out|etimedout|execution timed|超时|执行已超时"
  },
  {
    "id": "runtime_missing",
    "order": 40,
    "code": "runtime_missing",
    "appliesTo": [
      "executor",
      "admin"
    ],
    "body": "spawn[^\\n]*enoent|no such file or directory[^\\n]{0,60}(?:uv|git|python3?)|runtime[^\\n]*not (?:supported|available)|runtime[^\\n]{0,20}?(?:不可用|缺失|未安装|未找到)|不支持的 run ?time|unsupported runtime"
  },
  {
    "id": "invalid_package_name",
    "order": 45,
    "code": "package_fetch_failed",
    "appliesTo": [
      "executor",
      "admin"
    ],
    "body": "invalid npm package name|无效的 npm 包名"
  },
  {
    "id": "sandbox_unavailable",
    "order": 58,
    "code": "sandbox_unavailable",
    "appliesTo": [
      "executor",
      "admin"
    ],
    "body": "sandbox_unavailable|task_sandbox|task sandbox|sandbox (?:is )?(?:unavailable|not available|disabled|missing)|bwrap|沙箱|task_launcher|资源限制启动器"
  },
  {
    "id": "executor_offline",
    "order": 60,
    "code": "executor_offline",
    "appliesTo": [
      "admin"
    ],
    "body": "executor[^\\n]*(?:offline|unavailable)|no available executor|[^A-Za-z0-9_]econnrefused[^A-Za-z0-9_]|[^A-Za-z0-9_]enotfound[^A-Za-z0-9_]|network error|socket hang up|无可用执行器|没有可用(?:的)?执行器|执行器[^\\n]{0,120}?(?:离线|不可用|不可达)"
  },
  {
    "id": "executor_restart",
    "order": 70,
    "code": "executor_restart",
    "appliesTo": [
      "executor",
      "admin"
    ],
    "body": "shutting down before this execution started|正在停机"
  },
  {
    "id": "package_fetch_failed",
    "order": 80,
    "code": "package_fetch_failed",
    "appliesTo": [
      "executor",
      "admin"
    ],
    "body": "git clone|package fetch|pull package|download package|npm install|pip install|requirements|dependency|module not found|cannot find module|modulenotfounderror|no module named|拉取(?:应用包|依赖|代码)|克隆代码|下载(?:应用包|依赖|包)|依赖安装|安装依赖|代码拉取|package download failed|package exceeds the|zip package rejected|packageurl|包下载失败|包体积超过|zip 包未通过安全检查|zip 包渠道不可用|unsafe or invalid package archive|压缩包下载失败|压缩包不安全或不合法"
  },
  {
    "id": "script_error",
    "order": 99,
    "code": "script_error",
    "appliesTo": [
      "executor",
      "admin"
    ],
    "body": "traceback|syntaxerror|referenceerror|typeerror|uncaught|exception|command failed|exit code|脚本(?:错误|异常)|命令执行失败"
  }
];

/** 兜底（executor 阶段为 null = 「我不知道，交给中台」）。 */
export const FAILURE_CLASSIFIER_FALLBACKS = {"executor":null,"admin":"unknown"} as const;

/** sentinel（词边界的合法替代）。 */
export const FAILURE_CLASSIFIER_SENTINEL_PAD = "\u0001";

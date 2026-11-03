/**
 * GENERATED — DO NOT EDIT.
 *
 * 来源：`packages/executor-protocol/protocol.json` 的 `failureReason.classifiers` 段。
 * 由 `node scripts/generate-failure-classifiers.mjs` 生成。
 *
 * 用途：failureReason 分类器的 **node 侧运行时代码**（executor-node 落地用）。
 * python 侧对等物：`apps/executor-python/generated/failure_classifier.py`。
 *
 * ## 契约不变式
 *
 *   ① **归一**：文本先按 `normalize` 拼接 + ASCII 小写化 + astral 折叠，再判定。
 *   ② **sentinel**：判定前在文本首尾各补一个 U+0001，于是 `{{NONWORD}}` 在串边界
 *      处也成立（`\b` 的合法替代）。
 *   ③ **顺序即规格**：规则按 `order` 升序求值，首个命中者给出码。
 *   ④ **阶段不同**：`executor` 阶段答 `null` 表示「我不知道，交给中台」；
 *      `admin` 阶段永远返回一个码（兜底 `"unknown"`）。
 *
 * ## 与 .mjs 那份的关系
 *
 * 契约**数据**（TOKENS / RULES / NORMALIZE / FALLBACKS / SENTINEL_PAD）**同源**
 * （都由 protocol.json 注入）；**逻辑**各自写全，等价性由
 * `scripts/check-failure-classifiers.mjs` 在两语言**真跑同一批向量**后断言。
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
  /** 让位规则的 code 为 null（「本阶段主动不表态」）。 */
  readonly code: ContractFailureCode | null;
  readonly appliesTo: readonly FailureClassifyStage[];
  readonly body: string;
}

/** 契约 token 表（字符类；**不用** \w/\b/\d —— 那是两语言语义不同的构造）。 */
export const TOKENS: Readonly<Record<string, string>> = {
  "WS": "[ \\t\\n\\r\\f\\v]",
  "NONWS": "[^ \\t\\n\\r\\f\\v]",
  "WORD": "[A-Za-z0-9_]",
  "NONWORD": "[^A-Za-z0-9_]",
  "ANY_ONE_LINE": "[^\\n]"
};

/** 归一参数（拼接 + ASCII 小写化 + astral 折叠）。 */
export const NORMALIZE: Readonly<{
  joinWith: string;
  dropFalsyParts: boolean;
  caseFold: string;
  astralFold: string;
}> = {"joinWith":"\n","dropFalsyParts":true,"caseFold":"ascii-lower","astralFold":"replace-with-U+FFFD"};

/** 规则表：`body` 是**已翻译**的正则体（token 已展开、禁令已规避）。 */
export const RULES: readonly FailureClassifierRule[] = [
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

/**
 * **ASCII** 小写化（只 A-Z → a-z）。
 *
 * 刻意**不用** `toLowerCase()`：JS 的 toLowerCase 与 Python 的 str.lower 都按
 * Unicode Default Case Conversion，但**不是**逐字同义（实测 ſ→s、K(U+212A)→k
 * 在两侧不同），且 Unicode 小写化会**改变长度**——长度一变，与 `{n,m}` 的
 * 计数耦合就又成了跨语言不等价的入口。只做 ASCII 折叠：两侧逐字相同、不改长度。
 */
export function asciiLower(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    out += code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 32) : ch;
  }
  return out;
}

/**
 * astral 折叠（码点 > U+FFFF → U+FFFD）。
 *
 * 存在的唯一理由：JS 的 `{n,m}` 按 **UTF-16 code unit** 计数、Python 按
 * **code point** 计数。实测 `a[^\n]{0,3}b` 对 `a😀😀b` 在 JS 不命中、在
 * Python 命中 ⇒ 同一 `{0,N}` 在两侧覆盖不同长度。折叠成单码点的 U+FFFD 后，
 * 两侧的计数单位一致（1 code unit = 1 code point）。
 *
 * ⚠️ 这条**由孙Agent（开源调研专项）独立发现**，并由本轮实现吸收 ——
 * 见 docs/archive/audits/2026-11-03-round1/contract-source.md §6.1。
 */
export function foldAstral(text: string): string {
  let out = "";
  for (const ch of text) {
    out += (ch.codePointAt(0) ?? 0) > 0xffff ? "�" : ch;
  }
  return out;
}

/** 归一 + sentinel。 */
export function normalizeText(parts: readonly (string | null | undefined)[]): string {
  const kept = NORMALIZE.dropFalsyParts
    ? parts.filter((p): p is string => p !== null && p !== undefined && p !== "")
    : (parts as readonly string[]);
  const joined = kept.join(NORMALIZE.joinWith);
  return foldAstral(asciiLower(joined));
}

/** 判定前的补齐：首尾各一个 sentinel，于是词边界在串边界处也成立。 */
export function pad(text: string): string {
  return SENTINEL_PAD + text + SENTINEL_PAD;
}

type CompiledRule = {
  id: string;
  order: number;
  code: ContractFailureCode | null;
  appliesTo: readonly FailureClassifyStage[];
  re: RegExp;
};

const COMPILED: CompiledRule[] = RULES.map((r) => ({ ...r, re: new RegExp(r.body, "u") }));
const BY_STAGE: Record<string, CompiledRule[]> = { executor: [], admin: [] };
for (const r of COMPILED) {
  for (const stage of r.appliesTo) {
    if (!BY_STAGE[stage]) BY_STAGE[stage] = [];
    BY_STAGE[stage].push(r);
  }
}
for (const stage of Object.keys(BY_STAGE)) {
  BY_STAGE[stage].sort((a, b) => a.order - b.order);
}

/**
 * 分类。stage = 'executor' | 'admin'。
 *
 * @param parts 参与判定的文本片段（错误文案 + 日志）
 * @param stage 分类阶段
 * @returns 命中的码；executor 阶段不命中时返回 null
 */
export function classify(
  parts: readonly (string | null | undefined)[],
  stage: FailureClassifyStage = "executor",
): ClassifiedFailureCode {
  const text = pad(normalizeText(parts));
  for (const rule of BY_STAGE[stage] ?? []) {
    if (rule.re.test(text)) return rule.code;
  }
  return stage === "admin" ? FALLBACKS.admin : FALLBACKS.executor;
}

/** 规则明细（供守卫比对「生成物 ↔ 契约」）。 */
export function ruleIds(stage: string): string[] {
  return (BY_STAGE[stage] ?? []).map((r) => r.id);
}

export const FALLBACKS: Readonly<{ executor: ClassifiedFailureCode; admin: ContractFailureCode }> =
  {"executor":null,"admin":"unknown"};
export const SENTINEL_PAD: string = "\u0001";

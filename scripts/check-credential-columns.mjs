#!/usr/bin/env node
/**
 * 凭据列守卫：**凭据实体列必须 `select: false`**（或在本守卫里逐条显式豁免）。
 *
 * ## 为什么需要它
 *
 * 本仓的凭据防线是**三条彼此独立的腿**（逐字写在 `packages/mcp-server/src/redact.ts:8-10`）：
 *
 *   ① 实体列 `select: false`；② 响应 DTO 显式排除；③ 掩码函数（`maskForResponse()`）。
 *
 * 三条腿之所以要「彼此独立」，是因为**上游的保证是三处约定**，任何一处新增面时漏一次，
 * 凭据就**直接进 LLM 上下文**（`redact.ts:10-11`）。而第 ① 条是**唯一一条能被机械判定**的
 * ——②③ 依赖 DTO 与掩码函数逐个调用点，人只能靠评审；① 是**列声明上的一个属性**，
 * 可以被静态扫出来。
 *
 * 本守卫盯的就是第 ① 条：扫所有 `*.entity.ts`，凡**列名/注释暗示凭据**的列，
 * 必须有 `select: false`；否则要么加 `select: false`（**默认不给，需要明文的路径显式
 * addSelect**），要么在本文件里**逐条登记豁免并写理由**。
 *
 * ## 判据（与实现逐条对应）
 *
 *   A. **扫描面**：`<root>/apps/admin-api/src` 下全部 `*.entity.ts`（递归，排除 `node_modules`）。
 *   B. **列解析**：每个 `@Column(...)` 装饰器 → 属性名 + 选项文本 + 该列**自己的**文档注释
 *      （紧邻装饰器上方的 `//` 行或 `/** … *／` 块）。
 *   C. **凭据信号**（满足其一即入候选集）：
 *      · **列名**命中 `secret|token|password|passwd|credential|apiKey`（大小写不敏感）；
 *      · **该列自己的注释**命中同一组关键词。
 *   D. **判定**：候选列必须有 `select: false`；没有 ⇒ 红灯（除非在豁免表里逐条登记）。
 *   E. **豁免表纪律**（照本仓 `apps/admin-api/src/modules/agent/tools/gate-inventory.ts` 的形态）：
 *      · 每条带 `note` 理由，长度 ≥ `MIN_REASON_LENGTH`、不得是占位符；
 *      · `kind: "known-gap"` 必须带 `ref`（登记它的地方）；
 *      · **豁免不能静默吞掉新列**——新列不在表里 ⇒ 红；
 *      · **豁免表陈旧 ⇒ 红**：登记的列已经改名/删除（幽灵名），或该列现在**已有**
 *        `select: false`（豁免多余，该删）——登记册不能静默过期。
 *
 * ## 结构红（判据瞎了 ⇒ 必须红，不能绿）
 *
 *   ① 扫不到任何 entity 文件（扫描面收窄/目录改名）；
 *   ② 一个 `@Column` 都没解析到（解析器/正则失效）；
 *   ③ **判据自检**：本脚本用一组**已知的正/负样例**当场检验解析器与检测器
 *      （真阳性必须命中、真阴性必须不命中、注释归属必须正确）——任一条不符即红。
 *      这一条是本守卫的「眼镜是否戴着」检查：解析器一坏，② 之外的场景会**静默全绿**。
 *   ④ **规模下界**（仅默认根模式；`--root` 显式指定时跳过，避免 fixture 被下界误伤）：
 *      entity 文件数 < `MIN_ENTITY_FILES` 或解析出的列数 < `MIN_PARSED_COLUMNS`。
 *
 * ## 已知盲区（**必须知道**，否则会误以为「守卫绿 = 没有凭据泄漏面」）
 *
 *   ① 只看**列声明**：列有 `select: false` 但某条读路径忘了显式 addSelect ⇒
 *      明文变成 `undefined`（**静默的签名失效**／校验失败），本守卫**看不见**
 *      ——那要靠调用点 spec 钉（本仓先例：`modules/__tests__/entities.db-fixes.spec.ts`）。
 *   ② 只看**本仓 admin-api**：`packages/**` 与 `apps/executor-*` 里若将来出现
 *      TypeORM 实体，不在本扫描面内。
 *   ③ 注释信号只认**该列自己的**文档注释；写在文件头或类头的说明不被采纳
 *      （否则整文件会被一句话牵连）。
 *   ④ `select: false` 只保证「默认读面不带出」，**不保证写面不回写**
 *      （整实体 `save()` 的旧快照复活问题另有 ADR-026 守卫与 R32-C2 spec 盯着）。
 *
 * ## 用法
 *
 *   node scripts/check-credential-columns.mjs              # 守卫（CI）
 *   node scripts/check-credential-columns.mjs --report      # 列全部候选 + 豁免命中情况
 *   node scripts/check-credential-columns.mjs --selftest    # 判据有牙（子进程级真断言）
 *   node scripts/check-credential-columns.mjs --root <dir>  # 以 <dir> 为仓库根（selftest/反证用）
 *   node scripts/check-credential-columns.mjs --root=<dir>  # 同上（等号形态，两种都认）
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  REPO_ROOT,
  expectExit,
  makeFixtureRepo,
  reportCases,
  runGuard,
} from "./lib/guard-selftest.mjs";

const SELF = fileURLToPath(import.meta.url);

/**
 * 缺省根 = **仓库根**（按本脚本位置锚定），不是 `process.cwd()`。
 * 与另外 40 多个守卫的 `DEFAULT_ROOT = resolve(import.meta.dirname, "..")` 对齐。
 */
const DEFAULT_ROOT = REPO_ROOT;

/** 扫描面：`apps/admin-api/src` 下的 `*.entity.ts`。 */
const SRC_DIR = join("apps", "admin-api", "src");

/** 规模下界（真实仓库现场；仅默认根模式生效）。 */
const MIN_ENTITY_FILES = 30;
const MIN_PARSED_COLUMNS = 200;

/**
 * 凭据关键词（列名与注释同用，大小写不敏感）。
 *
 * 英文关键词照任务书给定：`secret|token|password|passwd|credential|apiKey`。
 * **中文关键词是本仓实情必需**：实体注释几乎全是中文，只认英文会让
 * 「HMAC 签名密钥」「明文口令」这类**最危险的**声明整批漏检（实测：
 * `app-deployment-event.entity.ts` 的 `detail` 列注释写的是「绝不放 env——
 * 密钥进事件即泄漏」，纯英文关键词看不见它）。
 */
const CREDENTIAL_KEYWORDS = [
  "secret",
  "token",
  "password",
  "passwd",
  "credential",
  "apikey",
  "密钥",
  "凭据",
  "令牌",
  "密码",
  "口令",
];

/** 理由的最短长度（trim 后）。低于此值视为「没写」。 */
export const MIN_REASON_LENGTH = 12;

/** 占位理由的黑名单——写了这些等于没写。 */
const PLACEHOLDER_REASONS = [
  "todo",
  "tbd",
  "fixme",
  "待补",
  "待定",
  "占位",
  "xxx",
];

/**
 * 豁免理由的**类别**（判据词汇表，不是自由文本）——照 `gate-inventory.ts` 的形态。
 */
export const CREDENTIAL_EXEMPTION_KINDS = [
  /** 列名/注释里的关键词是**巧合**：计数、布尔标志、租约 id、id 之类，根本不是凭据。 */
  "not-a-credential",
  /** 存的是**哈希/摘要**，不是明文（拿不到明文 ⇒ 拿不到凭据）。 */
  "hashed",
  /** 写入点已**机械**脱敏/已掩码（有代码在跑脱敏函数），列里存的不是明文凭据。 */
  "sanitized-at-write",
  /**
   * **只靠约定**：写入侧目前只落标量/枚举（`runMode` / `reason` / `deletedStatus`…），
   * 「不放密钥」写在**注释**里、由**每个调用方**自觉遵守——**没有任何机制兜住**。
   *
   * 为什么单独开一个类别而不是混进 `sanitized-at-write`（2026-11-02 自查）：
   * 两者**强度不同**。`sanitized-at-write` 是「即使有人传了密钥也会被打码」；
   * 本类只是「目前没人传」。把它标成前者会让这张表**看起来比实际更强**——
   * 而本会话反复出现的缺陷类型正是「声称的与做的不一致」。
   * ⇒ 若将来给这类列补上真实脱敏，**应改成 `sanitized-at-write`**（那时它才是机制）。
   */
  "convention-only",
  /** 读面靠掩码函数/列级写隔离兜底，加 `select: false` 会破坏既有调用路径。 */
  "masked-at-read",
  /** **确实还缺** `select: false` 的已知缺口——必须带 `ref` 指向登记它的地方。 */
  "known-gap",
];

/**
 * @typedef {object} CredentialExemption
 * @property {string} file 仓库相对路径（posix 分隔符）
 * @property {string} property 属性名
 * @property {string} kind 类别（`CREDENTIAL_EXEMPTION_KINDS` 之一）
 * @property {string} note 理由 + 证据（file:line）。**空理由等于没登记。**
 * @property {string} [ref] 仅 `known-gap` 必填：登记它的地方
 */

/**
 * 豁免表（**逐条带理由**）。
 *
 * 这张表**不是**「这些列不安全」的清单，而是「这些列**为什么不需要** `select: false`」
 * 的清单。登记 ≠ 认可（先例：`gate-inventory.ts` 的 `known-gap` 类别）——
 * `kind: "known-gap"` 的条目确实还缺 `select: false`，它们是**可见且可追踪的欠账**，
 * 不是「没问题」。
 *
 * 新增一条凭据列**必须**二选一：加 `select: false`，或在这里登记一条带理由的豁免。
 * 两者都不做 ⇒ 守卫红（这是本守卫唯一的判据，没有别的出口）。
 */
export const CREDENTIAL_COLUMN_EXEMPTIONS = [
  {
    file: "apps/admin-api/src/modules/users/entities/user.entity.ts",
    property: "password",
    kind: "hashed",
    note:
      "存 bcrypt 哈希（cost 12，users.service.ts:99/158/297 在落库前 bcrypt.hash），" +
      "不是明文凭据——明文永不落库。登录路径每次都要比对哈希，故不能 select:false；" +
      "响应面另有 @Exclude（user-response.dto.ts 头注：password/totpSecret/oidcSub 三列 @Exclude）。",
  },
  // 2026-11-02：`users.totpSecret` 的 `known-gap` 豁免**已删除**——那一列已补 `select: false`，
  // 需要明文的窄路径改走 `UsersService.findByIdWithTotp` / `findByUsernameWithTotp`（专用方法）。
  // ⇒ 若它再次出现在候选里而没 `select: false`，本守卫会**直接红**（不再有豁免兜着）。
  // ⚠ 别把它加回豁免表：那条豁免的意义是「已知欠账待修」，欠账已经修了。
  {
    file: "apps/admin-api/src/modules/task/entities/task.entity.ts",
    property: "secrets",
    kind: "masked-at-read",
    note:
      "任务级凭据键值对 jsonb：写路径经 encryptForStorage 加密（SEC_SECRETS_KEY 未配置时降级明文），" +
      "读路径经 maskForResponse 掩码（task.service.ts:2271/2409/2438），叶子值永不回传。" +
      "不能 select:false 的原因：列表/详情读面**要拿到值才能掩码**（掩码函数依赖原值），" +
      "select:false 会让掩码面拿到 undefined —— 方向反了（默认不给 vs 需要才显式要）。",
  },
  {
    file: "apps/admin-api/src/modules/notification/entities/notification-channel-config.entity.ts",
    property: "config",
    kind: "masked-at-read",
    note:
      "渠道配置 jsonb（RAW，可能含 webhook secret 等）。读面逐键掩码" +
      "（notification-config.service.ts:221-230 的 maskChannel 口径）。" +
      "不能 select:false 的原因：渠道配置回灌依赖整行读出" +
      "（channel-config.store.ts:159/181 的 refreshFromStore/listPersisted），" +
      "select:false 会让渠道配置读不回来 —— 改法应是「收窄到非凭据键 + 凭据键单独读」，属独立改动。",
  },
  {
    file: "apps/admin-api/src/modules/event-subscriptions/entities/event-outbox.entity.ts",
    property: "leaseToken",
    kind: "not-a-credential",
    note:
      "outbox 扫描器的**租约 id**（claim 时 md5(random()) 写的随机串，outbox-dispatcher.service.ts:361），" +
      "只用于「谁持有租约」的 CAS 判定，不对外暴露、不具备凭据语义。",
  },
  {
    file: "apps/admin-api/src/modules/config/entities/system-config.entity.ts",
    property: "isSecret",
    kind: "not-a-credential",
    note: "布尔标志位（该配置项的值是否按 secret 处理），本身不是凭据数据。",
  },
  {
    file: "apps/admin-api/src/modules/config/entities/config-history.entity.ts",
    property: "isSecret",
    kind: "not-a-credential",
    note: "布尔标志位（历史行的元数据快照，沿用当前配置行的 isSecret），本身不是凭据数据。",
  },
  {
    file: "apps/admin-api/src/modules/agent/entities/agent-session.entity.ts",
    property: "totalTokensIn",
    kind: "not-a-credential",
    note: "LLM 用量**计数**（token 数目），不是令牌/密钥。",
  },
  {
    file: "apps/admin-api/src/modules/agent/entities/agent-session.entity.ts",
    property: "totalTokensOut",
    kind: "not-a-credential",
    note: "LLM 用量**计数**（token 数目），不是令牌/密钥。",
  },
  {
    file: "apps/admin-api/src/modules/agent/entities/agent-step.entity.ts",
    property: "tokensIn",
    kind: "not-a-credential",
    note: "本步请求的 LLM token **计数**，不是令牌/密钥。",
  },
  {
    file: "apps/admin-api/src/modules/agent/entities/agent-step.entity.ts",
    property: "tokensOut",
    kind: "not-a-credential",
    note: "本步响应的 LLM token **计数**，不是令牌/密钥。",
  },
  {
    file: "apps/admin-api/src/modules/agent/entities/agent-step.entity.ts",
    property: "content",
    kind: "sanitized-at-write",
    note:
      "消息正文（列名不含凭据关键词，**靠注释命中**：注释明写「可能含凭据样式串」）。" +
      "写入点已脱敏（appendStepOnce → redactEventBodyText → sanitizeString），" +
      "落库的是打码后的文本；本列是模型回灌的权威源，加 select:false 会直接打断会话重建。",
  },
  {
    file: "apps/admin-api/src/modules/agent/entities/agent-tool-call.entity.ts",
    property: "argsJson",
    kind: "sanitized-at-write",
    note:
      "工具调用参数 jsonb（**靠注释命中**：注释明写参数可能含 token/password/secret）。" +
      "**脱敏在调用方，不在写入点**（2026-11-02 自查纠正）：" +
      "写入点是 `agent-session.service.ts:1930` / `:1838` 的 `argsJson: input.args ?? null`——**不过任何脱敏**；" +
      "真正打码的是唯一调用方 `tool-executor.service.ts:762` 的 `args: this.sanitizeArgs(args)`。" +
      "⚠ 所以这条保证是「**当前只有一个调用方且它记得脱敏**」，不是「写入点强制脱敏」；" +
      "新增第二个调用方就会静默绕过（`check-agent-write-sanitize.mjs` 也**不覆盖**本列）。",
  },
  {
    file: "apps/admin-api/src/modules/agent/entities/agent-approval.entity.ts",
    property: "preview",
    kind: "sanitized-at-write",
    note:
      "审批卡片的只读参数预览（**靠注释命中**：注释提到 SECRET_KEYS_RE 与「新的泄密面」）。" +
      "写入点已脱敏（复用既有 sanitizeArgs 口径）+ 超 2KB 截断，不落可执行脚本全文。",
  },
  {
    file: "apps/admin-api/src/modules/agent/entities/agent-session.entity.ts",
    property: "summary",
    kind: "sanitized-at-write",
    note:
      "通知用的一句话摘要（**靠注释命中**：注释明写「先脱敏、再截断 200 字」，否则会把跨第 200 字的凭据切一半）。" +
      "写入点已脱敏（finish → redactNullableText），落库的是脱敏文本。",
  },
  {
    file: "apps/admin-api/src/modules/application/entities/app-deployment-event.entity.ts",
    property: "detail",
    kind: "convention-only",
    note:
      "部署事件的短事实快照 jsonb（**靠注释命中**：注释明写「绝不放 env——事件表无掩码读面，密钥进事件即泄漏」）。" +
      "**只靠约定，无机制**：唯一的 insert 点（app-deployment.service.ts:1949）是 " +
      "`detail: input.detail ?? null`，**不过任何脱敏函数**；安全性来自 7 个调用方各自只传标量" +
      "（实测：`{approvalRequired,runMode}` / `{runMode}` ×2 / `{reason}` ×2 / `null` ×2）。" +
      "⚠ 其中 `reason` 是**人工输入的审批理由**（controller 传入的自由文本）——" +
      "运维写一句「rotated token=abc…」就会明文进事件表。本列为**已知的弱防线**，不是「已脱敏」。",
  },
  {
    file: "apps/admin-api/src/modules/event-subscriptions/entities/event-subscription.entity.ts",
    property: "lastFailureError",
    kind: "not-a-credential",
    note:
      "投递失败摘要（截 512）。**靠注释命中**：注释里的 secret 出现在**否定句**" +
      "「不含 secret/payload 原文」——恰恰说明它不是凭据列。",
  },
  {
    file: "apps/admin-api/src/modules/task/entities/task.entity.ts",
    property: "retryableErrors",
    kind: "not-a-credential",
    note:
      "可重试失败原因的白名单（simple-array）。**靠注释命中**：注释里的 token 是" +
      "「classified failureReason token」——**词法 token**，不是令牌/密钥。",
  },
  {
    file: "apps/admin-api/src/modules/users/entities/user.entity.ts",
    property: "sessionVersion",
    kind: "not-a-credential",
    note:
      "用户级会话版本号（计数器）。**靠注释命中**：注释提到 password 与 access token " +
      "只是在说明「改密/注销会让在途令牌失效」——本列是版本号，既不是口令也不是令牌。",
  },
  {
    file: "apps/admin-api/src/modules/config/entities/config-history.entity.ts",
    property: "userId",
    kind: "not-a-credential",
    note:
      "历史行的操作人 id（integer）。**靠注释命中**：注释里出现 api_keys / refresh_tokens " +
      "只是在说明「全库 userId 的类型对齐」——本列是外键 id，不是凭据。",
  },
  {
    file: "apps/admin-api/src/modules/config/entities/config-history.entity.ts",
    property: "valueType",
    kind: "not-a-credential",
    note:
      "值类型快照（'string'/'number'/'boolean'/'json'）。**靠注释命中**：注释里的 isSecret " +
      "只是在说明「读面掩码与回滚对 NULL 行沿用旧推断」——本列是类型标记，不是凭据数据。",
  },
  {
    file: "apps/admin-api/src/modules/users/entities/user.entity.ts",
    property: "oidcSub",
    kind: "not-a-credential",
    note:
      "OIDC IdP 的稳定身份标识（sub 声明）。**靠注释命中**：注释里的 password 是在说明" +
      "「本地密码登录用户恒为 NULL」——本列是身份绑定标识，不是口令；响应面另有 @Exclude" +
      "（user-response.dto.ts 头注：password/totpSecret/oidcSub 三列 @Exclude）。",
  },
];

// ── 文本工具 ────────────────────────────────────────────────────────────────

/** 抹掉注释与字符串字面量（保留换行，行号不漂）。 */
function stripNonCode(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  let state = "code";
  const SQ = String.fromCharCode(39);
  const DQ = String.fromCharCode(34);
  const BT = String.fromCharCode(96);
  const BS = String.fromCharCode(92);
  const NL = String.fromCharCode(10);
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (state === "code") {
      if (c === "/" && c2 === "/") {
        state = "line";
        out.push(" ", " ");
        i += 2;
        continue;
      }
      if (c === "/" && c2 === "*") {
        state = "block";
        out.push(" ", " ");
        i += 2;
        continue;
      }
      if (c === SQ || c === DQ || c === BT) {
        state = c === SQ ? "sq" : c === DQ ? "dq" : "tpl";
        out.push(" ");
        i += 1;
        continue;
      }
      out.push(c);
      i += 1;
      continue;
    }
    if (state === "line") {
      if (c === NL) {
        state = "code";
        out.push(NL);
      } else {
        out.push(" ");
      }
      i += 1;
      continue;
    }
    if (state === "block") {
      if (c === "*" && c2 === "/") {
        state = "code";
        out.push(" ", " ");
        i += 2;
        continue;
      }
      out.push(c === NL ? NL : " ");
      i += 1;
      continue;
    }
    if (c === BS) {
      out.push(" ", " ");
      i += 2;
      continue;
    }
    const closer = state === "sq" ? SQ : state === "dq" ? DQ : BT;
    if (c === closer) {
      state = "code";
      out.push(" ");
      i += 1;
      continue;
    }
    out.push(c === NL ? NL : " ");
    i += 1;
  }
  return out.join("");
}

/** 从 `(` 起读平衡圆括号，返回 [内容, 结束下标]（跳过字符串字面量）。 */
function readParens(s, start) {
  let depth = 0;
  let i = start;
  const n = s.length;
  let state = "code";
  const SQ = String.fromCharCode(39);
  const DQ = String.fromCharCode(34);
  const BT = String.fromCharCode(96);
  const BS = String.fromCharCode(92);
  while (i < n) {
    const c = s[i];
    if (state === "code") {
      if (c === SQ || c === DQ || c === BT) {
        state = c === SQ ? "sq" : c === DQ ? "dq" : "tpl";
        i += 1;
        continue;
      }
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) return [s.slice(start + 1, i), i];
      }
    } else {
      if (c === BS) {
        i += 2;
        continue;
      }
      if (
        (state === "sq" && c === SQ) ||
        (state === "dq" && c === DQ) ||
        (state === "tpl" && c === BT)
      ) {
        state = "code";
      }
    }
    i += 1;
  }
  return [null, s.length];
}

/** 属性声明行：`name: Type` 或 `name;`（可带 `?` / `!`）。 */
const PROP_DECL_RE = /^\s*([A-Za-z_$][\w$]*)\s*[?!]?\s*[:;]/;

/** 装饰器行（`@Xxx(...)` 或裸 `@Xxx`）。 */
const DECORATOR_RE = /^\s*@[A-Za-z_$][\w$]*/;

/**
 * 解析一个 entity 文件里的全部 `@Column(...)` 列。
 *
 * 返回 `{ property, options, comment, line, selectFalse }` 列表。
 *
 * 解析要点（踩过的坑）：
 * · 装饰器与属性**可以同行**（`@Column({ type: "int" }) foo: number;`）——
 *   多数实体列都是这个形态，只按「装饰器下一行找属性」会**整体错位一列**。
 * · 装饰器与属性之间可以夹**别的装饰器**（`@Column()` + `@Exclude()`）。
 * · `@Column(...)` 的选项里可以有**字符串字面量含右括号**
 *   （`default: () => "'{}'::jsonb"`）⇒ 必须跳过字符串再配平括号。
 * · 文档注释取**紧邻装饰器上方**的注释块（`//` 行或 `/* … *／` 块），
 *   文件头/类头的说明不采纳。
 */
export function parseEntityColumns(src) {
  const lines = src.split("\n");
  const codeOnly = stripNonCode(src);
  const cols = [];

  // 装饰器在 codeOnly 里的位置（行内字符串被抹白，但括号位置不变 ⇒ 行号可信）
  const re = /@Column\s*\(/g;
  let m;
  while ((m = re.exec(codeOnly)) !== null) {
    const parenStart = codeOnly.indexOf("(", m.index);
    if (parenStart < 0) continue;
    const [options, closeIdx] = readParens(codeOnly, parenStart);
    if (options === null) continue;

    const line = lineOf(codeOnly, m.index);
    const lineText = lines[line - 1] ?? "";

    // 属性名：装饰器**闭合括号之后**的部分（同行优先），否则向后找
    let property = null;
    const after = codeOnly.slice(closeIdx + 1);
    const sameLine = /^[\s;]*([A-Za-z_$][\w$]*)/.exec(after.split("\n")[0] ?? "");
    if (sameLine) {
      property = sameLine[1];
    } else {
      // 向后逐行：跳过空行与其它装饰器
      let idx = closeIdx + 1;
      while (idx < codeOnly.length) {
        const nl = codeOnly.indexOf("\n", idx);
        const end = nl < 0 ? codeOnly.length : nl;
        const seg = codeOnly.slice(idx, end);
        const trimmed = seg.trim();
        if (trimmed === "" || DECORATOR_RE.test(seg)) {
          idx = end + 1;
          continue;
        }
        const pm = PROP_DECL_RE.exec(seg);
        if (pm) {
          property = pm[1];
        }
        break;
      }
    }
    if (!property) continue;

    cols.push({
      property,
      options: options.trim(),
      comment: extractDocComment(lines, line - 1),
      line,
      selectFalse: /select\s*:\s*false/.test(options),
    });
  }
  return cols;
}

/** 取第 `idx` 行（0-based）**紧邻上方**的注释块（`//` 行或 `/* … *／` 块）。 */
function extractDocComment(lines, idx) {
  const parts = [];
  let i = idx - 1;
  // 向上收 `//` 行
  while (i >= 0 && /^\s*\/\//.test(lines[i] ?? "")) {
    parts.unshift(lines[i]);
    i -= 1;
  }
  // 向上收 `/* … *／` 块（块尾必须在紧邻位置）
  if (i >= 0 && (lines[i] ?? "").trim().endsWith("*/")) {
    const buf = [];
    while (i >= 0) {
      buf.unshift(lines[i]);
      if ((lines[i] ?? "").trim().startsWith("/*")) break;
      i -= 1;
    }
    parts.unshift(...buf);
  }
  return parts.join(" ");
}

function lineOf(src, idx) {
  let line = 1;
  for (let i = 0; i < idx && i < src.length; i++) if (src[i] === "\n") line++;
  return line;
}

// ── 检测 ────────────────────────────────────────────────────────────────────

/** 列名里的凭据关键词（大小写不敏感）。 */
export function nameLooksCredential(property) {
  const lower = String(property ?? "").toLowerCase();
  return CREDENTIAL_KEYWORDS.some((k) => lower.includes(k));
}

/** 注释里的凭据关键词（大小写不敏感）。 */
export function commentLooksCredential(comment) {
  const lower = String(comment ?? "").toLowerCase();
  return CREDENTIAL_KEYWORDS.some((k) => lower.includes(k));
}

/** 一列是否入候选集（列名命中 或 该列自己的注释命中）。 */
export function isCredentialCandidate(col) {
  return nameLooksCredential(col.property) || commentLooksCredential(col.comment);
}

// ── 扫描 ────────────────────────────────────────────────────────────────────

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist" || e.name === "__tests__") {
        continue;
      }
      walk(join(dir, e.name), out);
    } else if (e.name.endsWith(".entity.ts")) {
      out.push(join(dir, e.name));
    }
  }
  return out;
}

function relPosix(root, p) {
  return relative(root, p).split(sep).join("/");
}

/**
 * 扫描一棵仓库根。
 *
 * 返回 `{ entityFiles, parsedColumns, candidates, violations, exemptionProblems, stale }`。
 */
export function collect(root) {
  const files = walk(join(root, SRC_DIR));
  const candidates = [];
  let parsedColumns = 0;
  const scannedFiles = new Set();

  for (const f of files) {
    const rel = relPosix(root, f);
    scannedFiles.add(rel);
    const src = readFileSync(f, "utf8");
    for (const col of parseEntityColumns(src)) {
      parsedColumns += 1;
      if (!isCredentialCandidate(col)) continue;
      candidates.push({
        file: rel,
        line: col.line,
        property: col.property,
        selectFalse: col.selectFalse,
        signal: nameLooksCredential(col.property) ? "name" : "comment",
      });
    }
  }

  const exemptionByKey = new Map();
  for (const e of CREDENTIAL_COLUMN_EXEMPTIONS) {
    exemptionByKey.set(`${e.file}#${e.property}`, e);
  }

  const violations = [];
  const matchedExemptions = new Set();
  for (const c of candidates) {
    if (c.selectFalse) continue;
    const key = `${c.file}#${c.property}`;
    const ex = exemptionByKey.get(key);
    if (ex) {
      matchedExemptions.add(key);
      continue;
    }
    violations.push(c);
  }

  // 豁免表自身的纪律：理由不合格 / 幽灵名 / 豁免多余（列已有 select: false）
  const exemptionProblems = [];
  const stale = [];
  for (const e of CREDENTIAL_COLUMN_EXEMPTIONS) {
    const key = `${e.file}#${e.property}`;
    const note = (e.note ?? "").trim();
    const lower = note.toLowerCase();
    if (note.length < MIN_REASON_LENGTH) {
      exemptionProblems.push(
        `${e.file}#${e.property}: 理由为空或过短（< ${MIN_REASON_LENGTH} 字）`,
      );
    } else if (PLACEHOLDER_REASONS.some((p) => lower.includes(p))) {
      exemptionProblems.push(`${e.file}#${e.property}: 理由是占位符（${note}）`);
    }
    if (!CREDENTIAL_EXEMPTION_KINDS.includes(e.kind)) {
      exemptionProblems.push(
        `${e.file}#${e.property}: kind=${e.kind} 不在类别表 ${JSON.stringify(CREDENTIAL_EXEMPTION_KINDS)} 里`,
      );
    }
    if (e.kind === "known-gap" && !(e.ref ?? "").trim()) {
      exemptionProblems.push(
        `${e.file}#${e.property}: kind=known-gap 必须带 ref（登记它的地方）`,
      );
    }
    const hit = candidates.find((c) => `${c.file}#${c.property}` === key);
    if (!hit) {
      // **只在「该文件确实在本次扫描面里」时**判幽灵名。
      //
      // 为什么要这条限定：豁免表是**全仓**的，而扫描面可以是一棵**局部的**树
      // （selftest 的 fixture 树、只 checkout 了部分目录的工作副本）。若不限定，
      // 一棵只含 1 个 entity 文件的 fixture 树会把表里另外 21 条全报成「陈旧」
      // ——**误红**，且这种误红会逼人把守卫改宽（= 拆掉判据）。
      //
      // 「该文件不在扫描面里」与「该文件在扫描面里但那一列没了」是两件事：
      // 前者 = 没扫到，无从判断；后者 = 扫到了，登记确实陈旧 ⇒ 红。
      const fileWasScanned = scannedFiles.has(e.file);
      if (fileWasScanned) {
        stale.push({
          file: e.file,
          property: e.property,
          reason: "该列已不在候选集里（改名/删除/不再是凭据列）——登记该删了",
        });
      }
    } else if (hit.selectFalse) {
      stale.push({
        file: e.file,
        property: e.property,
        reason: "该列现在已有 select: false——豁免多余，该删了",
      });
    }
  }

  return {
    entityFiles: files.length,
    parsedColumns,
    candidates,
    violations,
    matchedExemptions,
    exemptionProblems,
    stale,
  };
}

// ── 判据自检（解析器/检测器的「眼镜是否戴着」）────────────────────────────────

/**
 * 用一组**已知的正/负样例**当场检验解析器与检测器。
 *
 * 为什么必须有：解析器一坏（列名整体错位、注释归属错乱、关键词表被清空），
 * ②「一个列都没解析到」这条结构红**不会**触发（还能解析出列，只是解析错了），
 * 于是守卫会**静默全绿**——正是本仓反复踩的「判据瞎了」形态。
 *
 * 返回问题清单（空 = 眼镜戴着）。
 */
export function assertDetectorLiveness() {
  const problems = [];

  const sample = `
import { Column } from "typeorm";

/** 文件级说明：这里提到 secret 与 token，但不属于任何一列。 */
export class Sample {
  /** 明文 HMAC 密钥。 */
  @Column({ type: "varchar", length: 256, select: false })
  secret: string;

  @Column({ type: "varchar", length: 256 })
  protectedSecret: string;

  @Column({ type: "int", default: 0 })
  totalTokensIn: number;

  /** 与上一列无关的说明：token 计数。 */
  @Column({ type: "int", default: 0 })
  tokensOut: number;

  @Column({ type: "boolean", default: false })
  isSecret: boolean;

  @Column({ type: "int", default: 0 })
  plainCounter: number;
}
`;

  const cols = parseEntityColumns(sample);
  const byProp = new Map(cols.map((c) => [c.property, c]));

  if (cols.length !== 6) {
    problems.push(`解析器应解析出 6 列，实际 ${cols.length} 列`);
  }
  for (const expected of [
    "secret",
    "protectedSecret",
    "totalTokensIn",
    "tokensOut",
    "isSecret",
    "plainCounter",
  ]) {
    if (!byProp.has(expected)) {
      problems.push(`解析器漏掉了属性 ${expected}`);
    }
  }
  if (!byProp.has("secret") || !byProp.get("secret").selectFalse) {
    problems.push("解析器没认出 `select: false`");
  }
  if (byProp.has("protectedSecret") && byProp.get("protectedSecret").selectFalse) {
    problems.push("解析器把没有 select:false 的列误判成有");
  }
  // 注释归属：只认**该列自己的**注释，不采纳文件级说明
  const secretCol = byProp.get("secret");
  if (secretCol && !secretCol.comment.includes("明文 HMAC 密钥")) {
    problems.push("注释归属错了：secret 列没拿到自己的文档注释");
  }
  if (secretCol && secretCol.comment.includes("文件级说明")) {
    problems.push("注释归属错了：secret 列拿到了文件级说明");
  }
  const counterCol = byProp.get("plainCounter");
  if (counterCol && counterCol.comment.trim() !== "") {
    problems.push("注释归属错了：plainCounter 拿到了不属于它的注释");
  }

  // 检测器：列名命中 / 注释命中 / 不命中
  if (!nameLooksCredential("secret")) problems.push("检测器：列名 secret 未命中");
  if (!nameLooksCredential("webhookSecret")) {
    problems.push("检测器：列名 webhookSecret 未命中");
  }
  if (!nameLooksCredential("apiKey")) problems.push("检测器：列名 apiKey 未命中");
  if (nameLooksCredential("plainCounter")) {
    problems.push("检测器：列名 plainCounter 误命中");
  }
  if (!commentLooksCredential("明文 HMAC 密钥 secret")) {
    problems.push("检测器：注释里的 secret 未命中");
  }
  if (commentLooksCredential("这里只是普通计数说明")) {
    problems.push("检测器：无关注释误命中");
  }
  // 中文关键词（本仓实体注释几乎全是中文）：「凭据/密钥/令牌/密码/口令」必须命中
  for (const cn of ["凭据", "密钥", "令牌", "密码", "口令"]) {
    if (!commentLooksCredential(`本列存${cn}`)) {
      problems.push(`检测器：注释里的中文关键词「${cn}」未命中`);
    }
  }

  // 端到端：plainCounter 不入候选集，secret 入候选集
  if (counterCol && isCredentialCandidate(counterCol)) {
    problems.push("检测器：plainCounter 误入候选集");
  }
  if (secretCol && !isCredentialCandidate(secretCol)) {
    problems.push("检测器：secret 漏入候选集");
  }

  return problems;
}

// ── 输出 ────────────────────────────────────────────────────────────────────

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.selftest) {
    selftest();
    return;
  }

  const scan = collect(opts.root);
  const structural = structuralProblems(scan, opts);

  if (opts.report) {
    console.log(
      `  扫描面：${scan.entityFiles} 个 entity 文件 / ${scan.parsedColumns} 列 / ${scan.candidates.length} 个凭据候选列`,
    );
    for (const c of scan.candidates) {
      const ex = scan.matchedExemptions.has(`${c.file}#${c.property}`);
      console.log(
        `  ${c.file}:${c.line}  ${c.property}  select:false=${c.selectFalse}  信号=${c.signal}${ex ? "  [已豁免]" : ""}`,
      );
    }
    console.log("");
  }

  if (structural.length > 0) {
    for (const p of structural) console.error(p);
    process.exit(1);
  }

  if (scan.violations.length > 0) {
    console.error("");
    for (const v of scan.violations) {
      console.error(
        `✖ 凭据列没有 select: false：${v.file}:${v.line}  ${v.property}（信号：${v.signal}）`,
      );
      console.error(
        "  → 要么给该列加 `select: false`（默认不给明文；需要明文的读路径显式 addSelect），",
      );
      console.error(
        "  → 要么在 scripts/check-credential-columns.mjs 的 CREDENTIAL_COLUMN_EXEMPTIONS 里登记一条带理由的豁免。",
      );
    }
  }
  if (scan.exemptionProblems.length > 0) {
    console.error("");
    for (const p of scan.exemptionProblems) console.error(`✖ 豁免表不合格：${p}`);
  }
  if (scan.stale.length > 0) {
    console.error("");
    for (const s of scan.stale) {
      console.error(`✖ 豁免表陈旧：${s.file}#${s.property} —— ${s.reason}`);
    }
  }

  const bad =
    scan.violations.length > 0 ||
    scan.exemptionProblems.length > 0 ||
    scan.stale.length > 0;
  if (bad) {
    console.error(
      `✖ 凭据列守卫失败：${scan.violations.length} 个缺 select:false 的凭据列 / ${scan.exemptionProblems.length} 条豁免不合格 / ${scan.stale.length} 条豁免陈旧（扫了 ${scan.entityFiles} 个 entity 文件）。`,
    );
    process.exit(1);
  }

  console.log(
    `✔ 凭据列守卫通过：${scan.candidates.length} 个凭据候选列全部有 select:false 或已逐条豁免（扫了 ${scan.entityFiles} 个 entity 文件 / ${scan.parsedColumns} 列）。`,
  );
}

/** 结构错（守卫自失效）。 */
function structuralProblems(scan, opts) {
  const problems = [];
  if (scan.entityFiles === 0) {
    problems.push("✖ 凭据列守卫自失效：扫不到任何 entity 文件（" + SRC_DIR + "）");
  }
  if (scan.parsedColumns === 0) {
    problems.push("✖ 凭据列守卫自失效：一个 @Column 都没解析到（解析器/正则失效）");
  }
  const live = assertDetectorLiveness();
  if (live.length > 0) {
    problems.push(
      "✖ 凭据列守卫自失效：判据自检不通过（解析器/检测器失效）——\n  " +
        live.map((p) => "· " + p).join("\n  "),
    );
  }
  if (!opts.rootExplicit) {
    if (scan.entityFiles < MIN_ENTITY_FILES) {
      problems.push(
        `✖ 扫描面异常收窄：只扫到 ${scan.entityFiles} 个 entity 文件（下界 ${MIN_ENTITY_FILES}）`,
      );
    }
    if (scan.parsedColumns < MIN_PARSED_COLUMNS) {
      problems.push(
        `✖ 解析面异常收窄：只解析出 ${scan.parsedColumns} 列（下界 ${MIN_PARSED_COLUMNS}）`,
      );
    }
  }
  return problems;
}

/** 解析 CLI 参数。 */
export function parseArgs(argv = []) {
  const opts = {
    root: DEFAULT_ROOT,
    rootExplicit: false,
    report: false,
    selftest: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") {
      opts.root = resolve(argv[++i] ?? ".");
      opts.rootExplicit = true;
    } else if (a.startsWith("--root=")) {
      opts.root = resolve(a.slice("--root=".length));
      opts.rootExplicit = true;
    } else if (a === "--report") opts.report = true;
    else if (a === "--selftest") opts.selftest = true;
  }
  return opts;
}

// ── selftest：真子进程断言「退出码 + 文本」 ──────────────────────────────────

const SELFTEST_CASE_BUDGET_MS = 5000;

/** 造一棵 fixture 仓库（entity 文件 + 可选的豁免表副本）。 */
function fixtureRepo(files) {
  return makeFixtureRepo(files, { prefix: "cred-cols-selftest-" });
}

const GOOD_ENTITY = `import { Column } from "typeorm";

export class Good {
  /** 明文 HMAC 密钥。 */
  @Column({ type: "varchar", length: 256, select: false })
  secret: string;
}
`;

const BAD_ENTITY = `import { Column } from "typeorm";

export class Bad {
  /** 明文 HMAC 密钥。 */
  @Column({ type: "varchar", length: 256 })
  secret: string;
}
`;

const NEW_COLUMN_ENTITY = `import { Column } from "typeorm";

export class Extra {
  /** 明文 HMAC 密钥。 */
  @Column({ type: "varchar", length: 256, select: false })
  secret: string;

  /** 新增的凭据列。 */
  @Column({ type: "varchar", length: 64 })
  apiKey: string;
}
`;

function selftest() {
  const cases = [];
  const unit = (name, fn) => cases.push({ name, fn });

  // ── 第一层：纯函数（快） ────────────────────────────────────────────────
  unit("解析器：同行属性形态正确解析", () => {
    const cols = parseEntityColumns(BAD_ENTITY);
    if (cols.length !== 1) throw new Error(`列数 ${cols.length} ≠ 1`);
    if (cols[0].property !== "secret") throw new Error(`属性名 ${cols[0].property}`);
    if (cols[0].selectFalse) throw new Error("select:false 误判为真");
  });
  unit("解析器：夹装饰器（@Exclude）的列仍解析出属性名", () => {
    const cols = parseEntityColumns(
      `import { Column, Exclude } from "typeorm";\nclass X {\n  @Column()\n  @Exclude()\n  password: string;\n}\n`,
    );
    if (cols.length !== 1 || cols[0].property !== "password") {
      throw new Error(`解析失败：${JSON.stringify(cols)}`);
    }
  });
  unit("解析器：选项里的字符串右括号不破坏配平", () => {
    const cols = parseEntityColumns(
      `class X {\n  @Column({ type: "jsonb", default: () => "'{}'::jsonb" })\n  config: Record<string, string>;\n}\n`,
    );
    if (cols.length !== 1 || cols[0].property !== "config") {
      throw new Error(`解析失败：${JSON.stringify(cols)}`);
    }
  });
  unit("检测器：列名命中 secret/webhookSecret/apiKey", () => {
    for (const p of ["secret", "webhookSecret", "apiKey", "accessToken", "password"]) {
      if (!nameLooksCredential(p)) throw new Error(`未命中 ${p}`);
    }
  });
  unit("检测器：计数/标志列名不命中", () => {
    for (const p of ["plainCounter", "id", "createdAt"]) {
      if (nameLooksCredential(p)) throw new Error(`误命中 ${p}`);
    }
  });
  unit("判据自检：眼镜是戴着的（liveness 无问题）", () => {
    const problems = assertDetectorLiveness();
    if (problems.length > 0) throw new Error(problems.join("; "));
  });

  // ── 第二层：真脚本子进程 ────────────────────────────────────────────────
  let alternate = 0;
  const subprocess = (c) => {
    cases.push({
      name: c.name,
      fn: () => {
        const repo = fixtureRepo(c.files);
        try {
          const rootFlag = alternate++ % 2 === 0 ? ["--root", repo.dir] : [`--root=${repo.dir}`];
          expectExit(
            runGuard(SELF, { args: [...rootFlag, ...(c.args ?? [])] }),
            {
              code: c.code,
              contains: c.contains ?? [],
              absent: c.absent ?? [],
              withinMs: SELFTEST_CASE_BUDGET_MS,
              label: c.name,
            },
          );
        } finally {
          repo.cleanup();
        }
      },
    });
  };

  const ent = (name, body) => `apps/admin-api/src/modules/demo/entities/${name}`;

  // 正例控制组：正确树 ⇒ 绿（**必须有**，否则「expectExit 永远抛」也能让全部负例通过）
  subprocess({
    name: "正例控制组：有 select:false 的凭据列 ⇒ 绿",
    files: { [ent("good.entity.ts")]: GOOD_ENTITY },
    code: 0,
    contains: ["凭据列守卫通过"],
    absent: ["✖"],
  });

  // 负例：去掉 select:false ⇒ 红
  subprocess({
    name: "负例：凭据列去掉 select: false ⇒ 红（退出码 1 + 报错文本）",
    files: { [ent("bad.entity.ts")]: BAD_ENTITY },
    code: 1,
    contains: ["凭据列没有 select: false", "secret"],
  });

  // 负例：新增凭据列不登记 ⇒ 红（豁免表不能静默吞掉新列）
  subprocess({
    name: "负例：新增凭据列（apiKey）不登记 ⇒ 红",
    files: { [ent("extra.entity.ts")]: NEW_COLUMN_ENTITY },
    code: 1,
    contains: ["apiKey"],
  });

  // 结构红：扫不到任何 entity 文件 ⇒ 红
  subprocess({
    name: "结构红：扫描面空（没有任何 entity 文件）⇒ 红",
    files: { "apps/admin-api/src/modules/demo/service.ts": "export const x = 1;\n" },
    code: 1,
    contains: ["扫不到任何 entity 文件"],
  });

  // 结构红：entity 文件在，但一个 @Column 都解析不到 ⇒ 红
  subprocess({
    name: "结构红：解析器瞎了（列解析不到）⇒ 红",
    files: { [ent("empty.entity.ts")]: "export class Empty {}\n" },
    code: 1,
    contains: ["一个 @Column 都没解析到"],
  });

  // 结构红：扫描面收窄（文件数下界）⇒ 红（仅默认根模式，此处用 --root 显式⇒跳过）
  //  —— 这一条由「默认根」用例覆盖：真实仓库根跑主跑必须绿且规模达标。

  const failed = reportCases(cases, { title: "凭据列守卫 selftest" });
  if (failed > 0) process.exit(1);
}

main();

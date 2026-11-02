/**
 * S6 §6-1：SOP 正文供应链扫描（发布前的**内容层**闸门）。
 *
 * ## 它挡的是什么（缺口证据）
 *
 * 发布 SOP = 获取间接指令注入权（`scripts/agent-sop-check.mjs` 头注原话）。但发布
 * 路径此前只做 front-matter **结构**校验（`sop-frontmatter.ts` 的未知键拒绝 +
 * `validateFrontMatter({strict:true})`），而正文是**可以被 Agent 自主修订**的
 * （`sop.service.ts` 的 replyClarification → sop_amended → publish）。三者叠加 =
 * 「一条被批准的 SOP 正文可以携带安装诱饵 / 外发指令，控制台全程无感」。
 *
 * ## 规则来源（只借语义，不抄代码）
 *
 * 对照 `awesome-llm-apps` 的 `agent_skills/evals/tools/skill_scanner.py`
 * （Apache-2.0；调研记录见 S6 §6-1）。借的是它的三个**思路**：
 *   ① **分级 + 只升不降**：CRITICAL 命中不与 WARN 混算（`:332-335` 的排序）；
 *   ② **显式抑制**：行内标记跳过（`:38,251`，它的 marker 是 `skillscan:allow`）；
 *   ③ **窗口**：install 类标题之后 20 行内的抓取命令升级（`:116-118,253-264`）。
 * **不抄**它的「正则兜底」思路——我们比它多一个结构化声明位：
 * `constraints.allowedDomains`（`sop-frontmatter.ts` 的 `SopConstraints`）是**校验
 * 过的字符串数组**，所以「网络调用是否已声明」在我们这里是集合判定，不是它那种
 * 自由文本 `compatibility` 匹配（对照其 `:316-319`）。
 *
 * ## 三条判据（逐条写明挡的是哪一种攻击）
 *
 *   · **LURE01 / LURE02（安装诱饵）**：`install / setup / 安装 / 前置` 类标题后 20 行
 *     窗口内的抓取命令 → LURE01 CRITICAL（ClawHavoc 的头号投递手法就是「前置条件」
 *     一节里的 `curl | bash`）；**同一正文里出现过这类标题**、但命令在窗口外 →
 *     LURE02 WARN（不阻断，但必须看得见）。一次标题都没有的抓取命令不判 LURE，
 *     那条由 NET01 兜（见下面取舍④）。
 *   · **EXEC01 / EXEC02（远程脚本直入 shell）**：`curl|wget … | sh`、PowerShell
 *     `iwr|irm … | iex`、`base64 -d | sh|python|node`。这条**不看标题位置**——
 *     只要正文里有这行，它本身就是「让执行器去跑一段我们没审过的代码」。
 *   · **EXFIL01（凭据 × 外发）**：同一正文里既出现**凭据材料 / 整机环境变量转储**，
 *     又出现**发往未声明目标**的网络调用——这是外带（exfil）的标准形状。目标全部
 *     落在 `allowedDomains` 里时**不判**（那是经过声明的正常集成，见下面 NET01）。
 *   · **NET01（网络调用 vs 声明）**：任何网络调用都记一条；目标全部被
 *     `allowedDomains` 覆盖 → INFO（已声明）；否则 WARN（**不阻断**）。
 *
 * ## 三个刻意的取舍（别把它们当 bug 改回去）
 *
 *   ① **不做围栏降级**。skill_scanner 把 markdown 围栏里的 WARN 降 INFO（`:286-292`），
 *      因为技能文档里的代码围栏**通常是示例**。SOP 正文恰好相反：围栏就是**给执行器
 *      的指令**。照抄这条会把真正的指令面判成 INFO。
 *   ② **block 只看 CRITICAL**。WARN 级（未声明的 `curl`、窗口外的抓取）在真实运维
 *      SOP 里太常见，拿它阻断发布等于逼人关掉整个开关——不如让它**可见但不拦**。
 *   ③ **抑制必须带理由**。skill_scanner 的 marker 不要求理由（`:38`），而 SOP 正文
 *      可由 Agent 修订，无理由的 marker 就是一条静默后门。故缺理由的 marker
 *      **不生效**，并且反过来产生一条 SUPPRESS01 WARN。
 *
 * ## 边界（明确不做）
 *
 * 不做 AST/沙箱执行，不发任何网络请求，不读磁盘，不扫执行器侧产物——纯字符串判据，
 * 可离线、可在单测里逐条反证。
 */

/** 严重度：与 skill_scanner 的 SEV_RANK（`:35`）同序，只用于排序与统计。 */
export type SopScanSeverity = "CRITICAL" | "WARN" | "INFO";

/** 规则 id：与本文档头注一一对应，落进日志/审计后能直接定位到判据。 */
export type SopScanRule =
  | "LURE01"
  | "LURE02"
  | "EXEC01"
  | "EXEC02"
  | "EXFIL01"
  | "NET01"
  | "SUPPRESS01";

export type SopScanMode = "warn" | "block";

export interface SopScanFinding {
  rule: SopScanRule;
  severity: SopScanSeverity;
  /** 1-based 行号（正文首行为 1）。 */
  line: number;
  message: string;
  /** 命中行的截断原文，审计/日志里可直接人读。 */
  evidence: string;
}

/** 一次生效的抑制（带理由——无理由的抑制不生效，见头注取舍③）。 */
export interface SopScanSuppression {
  rule: SopScanRule;
  line: number;
  reason: string;
}

export interface SopBodyScanInput {
  /** SOP 正文（markdown）。 */
  body: string;
  /** front-matter 的 `constraints.allowedDomains`（结构化声明位）。 */
  allowedDomains?: string[] | null;
}

export interface SopBodyScanResult {
  findings: SopScanFinding[];
  suppressed: SopScanSuppression[];
  /** 出现但**未生效**的抑制标记数（缺理由），会同时产生 SUPPRESS01。 */
  suppressedWithoutReason: number;
  criticalCount: number;
  warnCount: number;
  infoCount: number;
  maxSeverity: SopScanSeverity | null;
  scannedLines: number;
  /** 命中数超过上限时置位（只影响报告完整度，不影响 CRITICAL 判定）。 */
  truncated: boolean;
}

/** 行内抑制标记（对照 skill_scanner 的 `skillscan:allow`，我们要求带理由）。 */
export const SOP_SCAN_SUPPRESS_MARKER = "sopscan:allow";
/** 诱饵窗口长度（行）：与 skill_scanner 的 `i + 20`（`:253-254`）同口径。 */
export const SOP_SCAN_LURE_WINDOW_LINES = 20;
/** 单次扫描的命中上限：防一条超大正文把日志/审计撑爆。 */
export const SOP_SCAN_MAX_FINDINGS = 200;
/** evidence / 抑制理由的截断长度（审计行长期保留，不给不可信文本开外带通道）。 */
export const SOP_SCAN_EVIDENCE_MAX = 160;
/** 抑制理由的最小长度（`-` / `ok` 这种不算理由）。 */
export const SOP_SCAN_MIN_REASON = 4;

const SEV_RANK: Record<SopScanSeverity, number> = {
  CRITICAL: 3,
  WARN: 2,
  INFO: 1,
};

// ── 判据表 ────────────────────────────────────────────────────────────────
//
// 说明：来源列写的是 skill_scanner.py 的行区间（调研时逐段打开确认过）。
// 正则**不逐字照抄**——它的 Python 正则里有若干只服务于它自身文件布局的兜底，
// 我们要的是判据语义（列出见头注「不抄…思路」）。

/** 围栏标记行：内容是代码块边界，不是正文指令。 */
const FENCE_LINE_RE = /^\s*```/;

/**
 * 安装/前置条件类标题 → 打开诱饵窗口。来源 `LURE_HEADING_RE`（:116-118）。
 * 追加中文关键词：本仓 SOP 正文是中文（`docs/design/agent-and-deployment/04`），
 * 只留英文标题词等于这条判据在中文 SOP 上恒不命中。
 */
const LURE_HEADING_RE =
  /^#{1,6}\s.*\b(prerequisite|installation|install|setup|set\s?up|before you begin|getting started|activation|activate|first run|initiali[sz])|^#{1,6}\s*[^#\n]{0,40}(安装|前置|准备|初始化|激活|首次运行|环境准备)/i;

/** 抓取远程内容（curl/wget/iwr/irm 带 http(s) URL）。来源 `FETCH_CMD_RE`（:119）。 */
const FETCH_CMD_RE =
  /\b(?:curl|wget|iwr|irm|invoke-webrequest)\b[^\n]*https?:\/\//i;

/**
 * EXEC01/EXEC02：远程脚本或解码后的负载直入 shell。来源 PIPE_SHELL_PATTERNS（:60-74）。
 * EXEC01 = 抓取管道给 shell/iex；EXEC02 = base64 解码后给 shell/解释器（隐藏负载形态）。
 */
const PIPE_SHELL_PATTERNS: {
  re: RegExp;
  rule: "EXEC01" | "EXEC02";
  message: string;
}[] = [
  {
    re: /(?:curl|wget)\b[^\n|]{0,200}\|\s*(?:sudo\s+)?(?:ba|z|da|fi)?sh\b/i,
    rule: "EXEC01",
    message:
      "远程脚本直入 shell（curl/wget 管道给 sh）——投递手法与 skill_scanner EXEC01 同形",
  },
  {
    re: /(?:\biwr\b|\birm\b|invoke-webrequest|downloadstring)[^\n|]{0,160}\|\s*iex\b/i,
    rule: "EXEC01",
    message: "PowerShell 下载内容直入 Invoke-Expression（iex）",
  },
  {
    re: /\biex\b[^\n]{0,160}(?:downloadstring|invoke-webrequest|\biwr\b|\birm\b)/i,
    rule: "EXEC01",
    message: "Invoke-Expression 执行下载内容（iex + 下载命令同现）",
  },
  {
    re: /base64\s+(?:-d|-D|--decode)\b[^\n]{0,120}\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/i,
    rule: "EXEC02",
    message: "base64 解码后直入 shell（隐藏负载的经典形态）",
  },
  {
    re: /\|\s*base64\s+(?:-d|-D|--decode)\b[^\n]{0,80}\|\s*(?:python3?|node|perl|ruby)\b/i,
    rule: "EXEC02",
    message: "base64 解码后直入解释器（python/node/perl/ruby）",
  },
];

/**
 * 凭据材料 / 整机环境变量转储。来源 CRED_PATTERNS（:99-137）的 CRED01 / CRED02。
 * 刻意**窄**：只认「读密钥材料 / 转储整个环境」这类动作，不认「提到某个环境变量名」
 * （正常 SOP 会写 `API_TOKEN`，那不是外带信号）。
 */
const CRED_PATTERNS: { re: RegExp; label: string }[] = [
  {
    re: /~\/\.ssh\b|\/\.ssh\/|\bid_rsa\b|\bid_ed25519\b/,
    label: "SSH 私钥材料",
  },
  { re: /\.aws\/credentials|\.aws\/config\b/, label: "AWS 凭据文件" },
  {
    re: /\.netrc\b|\.npmrc\b|\.pypirc\b/,
    label: "凭据类 dotfile（netrc/npmrc/pypirc）",
  },
  {
    re: /security\s+(?:find-generic-password|find-internet-password|dump-keychain)/i,
    label: "macOS keychain 查询",
  },
  {
    re: /(?:Login Data|Cookies)['"]|browser.{0,20}profile.{0,20}(?:passw|cookie)/i,
    label: "浏览器凭据 / Cookie 库",
  },
  {
    re: /(?:exodus|electrum|phantom|solana)[^\n]{0,40}(?:wallet|keystore|id\.json)/i,
    label: "加密货币钱包存储",
  },
  {
    re: /\bprintenv\b|\benv\s*\|\s*(?:curl|nc|base64)\b|\bdict\(os\.environ\)|os\.environ\.items\(\)|JSON\.stringify\(process\.env\)|Object\.(?:entries|keys)\(process\.env\)/,
    label: "整机环境变量转储",
  },
];

/**
 * 网络调用（命令/API 形态，**不是**裸 URL）。来源 NET_PATTERNS（:84-97）。
 *
 * 为什么只认命令形态：SOP 正文里出现 `[文档](https://…)` 只是链接，不是要求执行器
 * 去访问——把裸 URL 也算网络调用，会让每条带外链的 SOP 都报 NET01。
 */
const NET_PATTERNS: { re: RegExp; label: string }[] = [
  {
    re: /\b(?:curl|wget)\b[^\n]{0,160}https?:\/\//i,
    label: "curl/wget 调用",
  },
  {
    re: /\bfetch\s*\(|\baxios\b|new\s+WebSocket\s*\(|\bXMLHttpRequest\b/,
    label: "JS 网络 API",
  },
  {
    re: /\brequests\.(?:get|post|put|patch|delete)\s*\(|\burlopen\s*\(|\bhttp\.client\b|\bsocket\.(?:socket|create_connection)\b/,
    label: "Python 网络 API",
  },
  {
    re: /\b(?:nc|ncat|netcat)\s+[\w.-]+\s+\d{2,5}\b/,
    label: "netcat 裸连接",
  },
];

// ── 工具 ──────────────────────────────────────────────────────────────────

function clamp(text: string, max = SOP_SCAN_EVIDENCE_MAX): string {
  const oneLine = String(text ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/**
 * 规范化 `constraints.allowedDomains`。
 *
 * 为什么宽进：这份声明是人写的，`https://api.internal/`、`API.INTERNAL:8443`、
 * `*.internal` 都是同一件事的常见写法。规范化是**减少误报**的方向（声明没被认出
 * → 正常正文被判 WARN），与「扩大放行面」不同：它不会让未声明的目标变合法。
 */
export function normalizeAllowedDomains(raw?: string[] | null): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((d): d is string => typeof d === "string")
    .map((d) =>
      d
        .trim()
        .toLowerCase()
        .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
        .replace(/\/.*$/, "")
        .replace(/:\d+$/, "")
        .replace(/^\*\./, ""),
    )
    .filter((d) => d.length > 0);
}

/** 主机是否被声明覆盖：精确匹配或**子域**匹配（`a.api.internal` ⊂ `api.internal`）。 */
export function isHostAllowed(host: string, domains: string[]): boolean {
  const h = String(host ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
  if (!h) return false;
  return domains.some((d) => h === d || h.endsWith(`.${d}`));
}

/** 从一行里取出 URL 主机（去 userinfo / 端口 / 路径 / 查询串）。 */
export function extractHosts(line: string): string[] {
  const out: string[] = [];
  // 字符类里排除 `/ ? #`：否则 `https://api.internal/health` 会被整段当主机名，
  // 于是**已声明的域永远匹配不上**（本文件的自检就抓到过这一条）。
  const re = /https?:\/\/([^\s"'`)\]>,;/?#]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const host = m[1]
      .replace(/^.*@/, "")
      .replace(/:\d+$/, "")
      .replace(/^\[|\]$/g, "")
      .toLowerCase();
    if (host && !out.includes(host)) out.push(host);
  }
  return out;
}

/** 解析行内抑制标记：返回 {present, reason, valid}。理由长度下限见头注取舍③。 */
export function parseSuppression(line: string): {
  present: boolean;
  reason: string;
  valid: boolean;
} {
  const at = line.indexOf(SOP_SCAN_SUPPRESS_MARKER);
  if (at < 0) return { present: false, reason: "", valid: false };
  const rest = clamp(line.slice(at + SOP_SCAN_SUPPRESS_MARKER.length), 200)
    .replace(/^[\s:：-]+/, "")
    .trim();
  return {
    present: true,
    reason: rest,
    valid: rest.length >= SOP_SCAN_MIN_REASON,
  };
}

const firstMatch = <T extends { re: RegExp }>(
  pats: T[],
  line: string,
): T | null => pats.find((p) => p.re.test(line)) ?? null;

// ── 主扫描 ────────────────────────────────────────────────────────────────

/**
 * 扫描一段 SOP 正文。纯函数：同输入必同输出，不读环境、不发请求。
 *
 * 顺序与 skill_scanner 的 scan_skill（`:245-292`）对齐：
 * 围栏状态 → 抑制标记 → 标题窗口 → 逐行判据 → 文件级交叉信号 → 去重排序。
 */
export function scanSopBody(input: SopBodyScanInput): SopBodyScanResult {
  const body = typeof input?.body === "string" ? input.body : "";
  const allowedDomains = normalizeAllowedDomains(input?.allowedDomains);
  const lines = body.split(/\r?\n/);

  const findings: SopScanFinding[] = [];
  const suppressed: SopScanSuppression[] = [];
  let suppressedWithoutReason = 0;
  let truncated = false;

  /** 行号 → 生效的抑制理由（供行级判据与 EXFIL01 交叉信号共用）。 */
  const suppressionByLine = new Map<number, string>();

  let inFence = false;
  let lureWindowUntil = -1;
  let credLine: { line: number; label: string; text: string } | null = null;
  let undeclaredNetLine: {
    line: number;
    label: string;
    text: string;
  } | null = null;

  const push = (f: SopScanFinding): void => {
    if (findings.length >= SOP_SCAN_MAX_FINDINGS) {
      truncated = true;
      return;
    }
    findings.push(f);
  };

  /** 先算该行的判据，再决定「入 findings 还是入 suppressed」——抑制按行生效。 */
  const emitLine = (
    lineNo: number,
    raw: string,
    rule: SopScanRule,
    severity: SopScanSeverity,
    message: string,
  ): void => {
    const reason = suppressionByLine.get(lineNo);
    if (reason !== undefined) {
      suppressed.push({ rule, line: lineNo, reason });
      return;
    }
    push({
      rule,
      severity,
      line: lineNo,
      message,
      evidence: clamp(raw),
    });
  };

  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1;
    const raw = lines[i];

    // ① 围栏边界：它本身不是内容行（与 skill_scanner :250-252 同序）。
    if (FENCE_LINE_RE.test(raw)) {
      inFence = !inFence;
      continue;
    }

    // ② 抑制标记：**登记但不跳行**——跳行会让「它抑制了哪条判据」无从留痕
    // （skill_scanner 是直接 `continue`，:251；我们的抑制理由要落审计，见 §6-1
    // 「抑制标记必须带理由字符串并落审计」）。判据照常跑，命中的由 emitLine
    // 分流进 suppressed。
    const marker = parseSuppression(raw);
    if (marker.present) {
      if (marker.valid) {
        suppressionByLine.set(lineNo, marker.reason);
      } else {
        suppressedWithoutReason += 1;
        push({
          rule: "SUPPRESS01",
          severity: "WARN",
          line: lineNo,
          message: `抑制标记 ${SOP_SCAN_SUPPRESS_MARKER} 缺理由（需 ≥${SOP_SCAN_MIN_REASON} 字符），本行抑制不生效`,
          evidence: clamp(raw),
        });
      }
    }

    // ③ 标题窗口：只在围栏外识别标题（围栏里的 `# 注释` 不是标题）。
    if (!inFence && LURE_HEADING_RE.test(raw)) {
      lureWindowUntil = lineNo + SOP_SCAN_LURE_WINDOW_LINES;
    }

    // ④ EXEC01/EXEC02：与标题位置无关——只要正文里有这行，它本身就是
    //    「让执行器去跑一段我们没审过的代码」。
    const pipe = firstMatch(PIPE_SHELL_PATTERNS, raw);
    if (pipe) {
      emitLine(lineNo, raw, pipe.rule, "CRITICAL", pipe.message);
    }

    // ⑤ LURE01/LURE02：**已经出现过**安装类标题时，围栏内的抓取命令按窗口分级。
    //    一次标题都没出现过就不判 LURE——那种 `curl` 由 NET01 兜（未声明域 = WARN），
    //    否则每条「带一条 curl 的正常正文」都会被 LURE02 叨一遍，噪声全落在同一处。
    if (lureWindowUntil >= 0 && inFence && FETCH_CMD_RE.test(raw)) {
      if (lineNo <= lureWindowUntil) {
        emitLine(
          lineNo,
          raw,
          "LURE01",
          "CRITICAL",
          `安装/前置条件类标题后 ${SOP_SCAN_LURE_WINDOW_LINES} 行窗口内出现远程抓取命令（ClawHavoc 的头号投递手法）`,
        );
      } else {
        emitLine(
          lineNo,
          raw,
          "LURE02",
          "WARN",
          "代码块内的远程抓取命令（不在安装类标题窗口内）——请核对目标域名与用途",
        );
      }
    }

    // ⑥ 网络调用：目标全部被 allowedDomains 覆盖 → INFO；否则 WARN（不阻断）。
    const net = firstMatch(NET_PATTERNS, raw);
    if (net) {
      const hosts = extractHosts(raw);
      const undeclared =
        hosts.length === 0 ||
        hosts.some((h) => !isHostAllowed(h, allowedDomains));
      emitLine(
        lineNo,
        raw,
        "NET01",
        undeclared ? "WARN" : "INFO",
        undeclared
          ? `正文发起网络调用（${net.label}），目标${hosts.length ? ` ${hosts.join(",")} ` : ""}未在 constraints.allowedDomains 声明`
          : `正文发起网络调用（${net.label}），目标 ${hosts.join(",")} 已由 constraints.allowedDomains 声明`,
      );
      if (undeclared && !undeclaredNetLine) {
        undeclaredNetLine = { line: lineNo, label: net.label, text: raw };
      }
    }

    // ⑦ 凭据线索：只登记第一个（EXFIL01 是文件级交叉信号）。
    if (!credLine) {
      const cred = firstMatch(CRED_PATTERNS, raw);
      if (cred) {
        credLine = { line: lineNo, label: cred.label, text: raw };
      }
    }
  }

  // ⑧ 交叉信号 EXFIL01：凭据材料 × 未声明目标的网络调用。
  if (credLine && undeclaredNetLine) {
    const reason =
      suppressionByLine.get(undeclaredNetLine.line) ??
      suppressionByLine.get(credLine.line);
    if (reason !== undefined) {
      suppressed.push({
        rule: "EXFIL01",
        line: undeclaredNetLine.line,
        reason,
      });
    } else {
      push({
        rule: "EXFIL01",
        severity: "CRITICAL",
        line: undeclaredNetLine.line,
        message: `同一正文既触达凭据/整机环境（${credLine.label}）又向未声明目标发起网络调用（${undeclaredNetLine.label}）——外带的标准形状`,
        evidence: clamp(
          `L${credLine.line} ${credLine.text} ／ L${undeclaredNetLine.line} ${undeclaredNetLine.text}`,
        ),
      });
    }
  }

  // ⑨ 去重 + 严重度降序、行号升序（对照 skill_scanner :332-335）。
  const seen = new Set<string>();
  const unique = findings.filter((f) => {
    const key = `${f.rule}@${f.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort(
    (a, b) =>
      SEV_RANK[b.severity] - SEV_RANK[a.severity] ||
      a.line - b.line ||
      a.rule.localeCompare(b.rule),
  );
  const maxSeverity =
    unique.length > 0
      ? unique.reduce<SopScanSeverity>(
          (acc, f) => (SEV_RANK[f.severity] > SEV_RANK[acc] ? f.severity : acc),
          "INFO",
        )
      : null;

  return {
    findings: unique,
    suppressed,
    suppressedWithoutReason,
    criticalCount: unique.filter((f) => f.severity === "CRITICAL").length,
    warnCount: unique.filter((f) => f.severity === "WARN").length,
    infoCount: unique.filter((f) => f.severity === "INFO").length,
    maxSeverity,
    scannedLines: lines.length,
    truncated,
  };
}

/**
 * 开关解析（**默认 warn**）。
 *
 * 为什么默认不阻断：这条闸门是新引入的内容判据，误报的代价是**正常发布被挡**，
 * 而漏报的代价是「正文里的诱饵没被看见」。上线的第一步是让它**可见**（warn：
 * 记日志 + 落审计），确认噪声水平后再显式开 `block`。任何不认识的取值一律回落
 * warn —— 拼错 `blok` 不能变成「静默放行 = 关闭闸门」，也不能变成「静默阻断」。
 */
export function resolveSopScanMode(raw: unknown): SopScanMode {
  return String(raw ?? "")
    .trim()
    .toLowerCase() === "block"
    ? "block"
    : "warn";
}

/**
 * 是否应当阻断发布：**只有 block 模式 + CRITICAL**（见头注取舍②）。
 * 抽在这里而不是写进服务，是为了让 CLI（`scripts/sop-body-scan.mjs`）与服务
 * 用同一条语义——两处各写一遍是漂移的起点。
 */
export function isSopBodyScanBlocking(
  result: Pick<SopBodyScanResult, "criticalCount">,
  mode: SopScanMode,
): boolean {
  return mode === "block" && result.criticalCount > 0;
}

/** 一行摘要（日志/审计共用；不含正文原文，只看得到规则与行号）。 */
export function summarizeSopScan(result: SopBodyScanResult): string {
  if (result.findings.length === 0 && result.suppressed.length === 0) {
    return "无命中";
  }
  const hits = result.findings.map((f) => `${f.rule}@${f.line}`).join(",");
  const sup = result.suppressed.map((s) => `${s.rule}@${s.line}`).join(",");
  return [
    hits ? `命中 ${hits}` : "无命中",
    sup ? `已抑制 ${sup}` : "",
    result.truncated ? `超上限仅报前 ${SOP_SCAN_MAX_FINDINGS} 条` : "",
  ]
    .filter(Boolean)
    .join("；");
}

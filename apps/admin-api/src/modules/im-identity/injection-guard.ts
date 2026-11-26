/**
 * N6：群聊 @bot 消息的 prompt-injection 防护（纯确定性规则，**不调 LLM**）。
 *
 * finding 形态借鉴 modules/sop/sop-body-scan.ts：{ rule, severity, evidence }，
 * evidence 走同样的 clamp 截断（审计行长期保留，不给不可信文本开外带通道）。
 * 命中任一 CRITICAL 规则 ⇒ safe=false；WARN 只提示不阻断。
 *
 * 覆盖四类：角色劫持、越权指令、隐藏指令（零宽 / HTML 注释 / 超长重复）、
 * 可疑 URL + 危险命令组合。规则表 IM_INJECTION_RULES 导出供测试与审计枚举。
 */

export type ImInjectionSeverity = "CRITICAL" | "WARN";

export interface ImInjectionRule {
  readonly code: string;
  readonly severity: ImInjectionSeverity;
  readonly label: string;
  readonly re: RegExp;
}

export interface ImInjectionFinding {
  rule: string;
  severity: ImInjectionSeverity;
  evidence: string;
}

export interface ImInjectionScanResult {
  safe: boolean;
  findings: ImInjectionFinding[];
  criticalCount: number;
  /** 超长输入只扫描前 IM_INJECTION_MAX_TEXT 字符时置位。 */
  truncated: boolean;
}

/** 单次扫描的输入上限，防超大正文把正则与报告撑爆。 */
export const IM_INJECTION_MAX_TEXT = 20_000;
/** evidence 截断长度（与 SOP_SCAN_EVIDENCE_MAX 同口径）。 */
export const IM_INJECTION_EVIDENCE_MAX = 160;
/** 单次扫描的命中上限。 */
export const IM_INJECTION_MAX_FINDINGS = 100;

/**
 * 判据表。正则统一用非 g 标志，exec 无 lastIndex 竞态；大小写/中英文双覆盖。
 */
export const IM_INJECTION_RULES: readonly ImInjectionRule[] = [
  {
    code: "ROLE_HIJACK_EN",
    severity: "CRITICAL",
    label: "英文角色劫持：忽略之前的指令",
    re: /\bignore\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?|messages?)\b/i,
  },
  {
    code: "ROLE_HIJACK_ZH",
    severity: "CRITICAL",
    label: "中文角色劫持：忽略之前的指令",
    re: /(?:忽略|无视|忘记|清除|丢弃)(?:之前|前面|上面|以上|先前|此前)?的?(?:指令|指示|提示词|规则|约束)/,
  },
  {
    code: "ROLE_TAKEOVER",
    severity: "CRITICAL",
    label: "身份改写：你现在是 / act as / you are now",
    re: /(?:你现在是|你现在扮演|从现在起你是|请扮演|假装你是|act\s+as\b|you\s+are\s+now\b|pretend\s+to\s+be\b)/i,
  },
  {
    code: "SYSTEM_PROMPT",
    severity: "CRITICAL",
    label: "伪造系统提示词边界：system: / 系统指令：",
    re: /(?:^|[\s\n])system\s*[:：]|(?:系统|开发者)(?:提示词|指令|消息)\s*[:：]|<\|im_start\|>\s*system/i,
  },
  {
    code: "PRIVILEGE_ESCALATION",
    severity: "CRITICAL",
    label: "越权指令：以管理员身份 / 绕过审批 / 删除所有",
    re: /(?:以管理员身份|管理员权限|绕过审批|跳过审批|无需审批|免审批|直接执行不要确认|不用确认|不要确认|删除所有|删掉全部|清空全部|\boverride\s+approval\b|\bskip\s+approval\b)/i,
  },
  {
    code: "HIDDEN_ZERO_WIDTH",
    severity: "CRITICAL",
    label: "隐藏指令：零宽/双向控制字符",
    re: /[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/,
  },
  {
    code: "HIDDEN_HTML_COMMENT",
    severity: "CRITICAL",
    label: "隐藏指令：HTML 注释内嵌指令",
    re: /<!--[\s\S]{0,500}?(?:ignore|system|admin|绕过|忽略|指令|执行|删除|密码|token|审批)[\s\S]{0,500}?-->/i,
  },
  {
    code: "HIDDEN_LONG_REPEAT",
    severity: "CRITICAL",
    label: "隐藏指令：超长重复字符（填充/夹带）",
    re: /([^\s\-=_.,。，、])\1{119,}/,
  },
  {
    code: "DANGEROUS_COMMAND",
    severity: "CRITICAL",
    label: "危险命令：rm -rf / mkfs / dd / |bash / sudo 等",
    re: /(?:rm\s+-rf\b|rm\s+-fr\b|rm\s+-r\s+-f\b|\bmkfs\b|\bdd\s+if=|\bchmod\s+777\b|\bshutdown\b|\breboot\b|\bsudo\b|\|\s*(?:bash|sh|zsh)\b)/i,
  },
];

/** 可疑 URL（与危险命令共现时升级为组合命中）。 */
export const IM_SUSPICIOUS_URL_RE =
  /(?:https?|ftp|gopher|file):\/\/[^\s<>"']+/i;

/** 与 sop-body-scan.ts 的 clamp 同形：换行压平 + 截断，evidence 可安全落审计。 */
function clamp(text: string, max = IM_INJECTION_EVIDENCE_MAX): string {
  const oneLine = String(text ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/**
 * 扫描一条群聊 @bot 消息。纯函数：同输入必同输出，不读环境、不发请求。
 * 命中 CRITICAL ⇒ safe=false；WARN 不阻断；规则去重按 code 首次命中。
 */
export function scanImMessage(text: string): ImInjectionScanResult {
  const raw = typeof text === "string" ? text : "";
  const truncated = raw.length > IM_INJECTION_MAX_TEXT;
  const scanned = truncated ? raw.slice(0, IM_INJECTION_MAX_TEXT) : raw;

  const findings: ImInjectionFinding[] = [];
  const seen = new Set<string>();
  let hitLimit = false;

  const push = (
    rule: string,
    severity: ImInjectionSeverity,
    evidence: string,
  ): void => {
    if (seen.has(rule)) return;
    seen.add(rule);
    if (findings.length >= IM_INJECTION_MAX_FINDINGS) {
      hitLimit = true;
      return;
    }
    findings.push({ rule, severity, evidence: clamp(evidence) });
  };

  for (const rule of IM_INJECTION_RULES) {
    const match = rule.re.exec(scanned);
    if (match) push(rule.code, rule.severity, match[0]);
  }

  // 交叉信号：URL × 危险命令。单独 URL 不阻断（群里发链接是正常业务），
  // 但「打开这个链接并执行 rm -rf / curl|bash」是标准的投递形态。
  const url = IM_SUSPICIOUS_URL_RE.exec(scanned);
  const danger = findings.find((f) => f.rule === "DANGEROUS_COMMAND");
  if (url && danger) {
    push("URL_DANGEROUS_COMMAND", "CRITICAL", `${url[0]} + ${danger.evidence}`);
  }

  // hitLimit 时把标记落进 findings（同一规则不重复计），保证超限可观测。
  if (hitLimit) {
    findings.push({
      rule: "FINDINGS_TRUNCATED",
      severity: "WARN",
      evidence: `findings exceeded ${IM_INJECTION_MAX_FINDINGS}`,
    });
  }

  const criticalCount = findings.filter(
    (f) => f.severity === "CRITICAL",
  ).length;
  return { safe: criticalCount === 0, findings, criticalCount, truncated };
}

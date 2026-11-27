import { createHash } from "node:crypto";
import { dump as yamlDump } from "js-yaml";

import { AppError } from "../../common/errors/app-error";
import { ErrorCode } from "../../common/errors/error-codes";
import {
  SOP_CAPABILITIES,
  validateFrontMatter,
  type SopCapability,
  type SopFrontMatter,
} from "../sop/sop-frontmatter";
import { outputBudgetFor } from "./context-budget";
import type {
  PlanCardBudgetDto,
  PlanCardCheckDto,
  PlanCardDto,
  PreviewCadence,
  PreviewPlanCardRequestDto,
} from "./dto/preview-plan-card.dto";

/**
 * N7 反幻觉闸门的**纯函数内核**。
 *
 * 纪律：本文件不 import 任何 LLM/chatJson/relay，不读时钟、不读随机、不碰 DB。
 * 同一入参永远得到同一 card / checks / cardHash——这是「方案卡可确定性复现」
 * 的全部含义，也是 GCO 证伪切片能成立的前提。
 */

/** 中台预算硬上限（暂定 20；超出只截断并记 warn，不放行自由增长）。 */
export const PREVIEW_MAX_TURNS_CAP = 20;
/** 未显式给预算时的确定性默认值。 */
export const PREVIEW_DEFAULT_MAX_TURNS = 10;
/**
 * 能力白名单：取自 SOP frontmatter 的真实能力域
 * （apps/admin-api/src/modules/sop/sop-frontmatter.ts 的 SOP_CAPABILITIES =
 *  ["browser","gui","filesystem","http"]），禁止编造未登记能力键。
 */
export const PREVIEW_CAPABILITY_WHITELIST = [
  "browser",
  "gui",
  "filesystem",
  "http",
] as const;

/** 触发周期档位 → 业务语句回读表：唯一事实源，纯查表，无 LLM、无格式化分支。 */
const CADENCE_TRIGGER_TEXT: Readonly<Record<PreviewCadence, string>> = {
  once: "手动触发一次",
  hourly: "每小时执行一次",
  daily: "每天",
  weekly: "每周",
  monthly: "每月 N 日",
};

export interface PreviewResult {
  eligible: boolean;
  card: PlanCardDto;
  checks: PlanCardCheckDto[];
  cardHash: string;
}

/** 触发频率值 → 确定性业务语句（once/hourly/daily/weekly/monthly）。 */
export function cadenceToTriggerText(cadence: PreviewCadence): string {
  return CADENCE_TRIGGER_TEXT[cadence];
}

/** 规范化 JSON：递归按键排序，保证 cardHash 不受对象插入顺序影响。 */
function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

/** 对 card 规范化 JSON 取 sha256，截 16 位十六进制短前缀。 */
export function computeCardHash(card: PlanCardDto): string {
  return createHash("sha256")
    .update(stableStringify(card))
    .digest("hex")
    .slice(0, 16);
}

/**
 * N18 策略代际围栏：generation 由「显式策略版本 + 能力白名单 + 预算上限」共同决定。
 *
 * 与 agent-approvals.service.ts 的 computeApprovalPolicyFingerprint 同型：
 * 策略项变化时指纹变化 ⇒ 生成于旧策略下的方案卡作废，必须重新 preview。
 * 复用本文件 stableStringify 的键排序口径，截 16 hex（与 cardHash 同格式）。
 *
 * N14 起该常量**只是编译期缺省值**（极简装配/单测回退用）：生产运行的
 * policyVersion 由 PolicyGenerationService 的进程内 counter 动态注入，
 * 经 policySnapshotForVersion() 进入同一个 computePolicyGeneration()。
 */
export const PREVIEW_POLICY_VERSION = "1";

/** 参与 generation 求值的策略快照；显式成接口，便于单测注入变更后的快照。 */
export interface PolicySnapshot {
  policyVersion: string;
  capabilityWhitelist: readonly string[];
  maxTurnsCap: number;
}

/**
 * N14 运行时注入点：用给定的策略版本串（来自注册表 counter）组装快照。
 * 其余策略项仍是本文件的编译期常量——本轮只把「策略版本」一维运行时化，
 * 白名单/预算的运行时化是后续增量。
 */
export function policySnapshotForVersion(
  policyVersion: string | number,
): PolicySnapshot {
  return {
    policyVersion: String(policyVersion),
    capabilityWhitelist: PREVIEW_CAPABILITY_WHITELIST,
    maxTurnsCap: PREVIEW_MAX_TURNS_CAP,
  };
}

/** 编译期缺省快照（无注册表时的回退；生产走 policySnapshotForVersion）。 */
export function currentPolicySnapshot(): PolicySnapshot {
  return policySnapshotForVersion(PREVIEW_POLICY_VERSION);
}

/**
 * 策略代际指纹：对快照的规范化 JSON 取 sha256，截 16 位十六进制短前缀。
 * snapshot 省略时取当前部署快照；传入其它快照用于模拟「策略在此期间变更」。
 */
export function computePolicyGeneration(
  snapshot: PolicySnapshot = currentPolicySnapshot(),
): string {
  return createHash("sha256")
    .update(
      stableStringify({
        policyVersion: snapshot.policyVersion,
        capabilityWhitelist: snapshot.capabilityWhitelist,
        maxTurnsCap: snapshot.maxTurnsCap,
      }),
    )
    .digest("hex")
    .slice(0, 16);
}

function check(
  field: string,
  status: PlanCardCheckDto["status"],
  message: string,
): PlanCardCheckDto {
  return { field, status, message };
}

/** 截断展示用文本（只影响文案，不影响确定性）。 */
function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 由 goal + cadence（+ 可选 params）确定性地生成方案卡并跑闸门。
 * 不调用 LLM、不落库；非法 goal/cadence 复用既有 VALIDATION_FAILED 错误码。
 */
export function buildPreview(dto: PreviewPlanCardRequestDto): PreviewResult {
  const goal = dto?.goal;
  if (typeof goal !== "string" || goal.trim().length === 0) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, {
      detail: "goal 不能为空或纯空白",
    });
  }
  if (goal.length > 500) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, {
      detail: "goal 长度不得超过 500",
    });
  }
  if (
    !Object.prototype.hasOwnProperty.call(CADENCE_TRIGGER_TEXT, dto.cadence)
  ) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, {
      detail: "cadence 必须是 once | hourly | daily | weekly | monthly",
    });
  }

  const params = dto.params ?? {};
  const checks: PlanCardCheckDto[] = [
    check("goal", "ok", `目标已登记（长度 ${goal.length}）`),
    check(
      "cadence",
      "ok",
      `触发语句确定性回读：${CADENCE_TRIGGER_TEXT[dto.cadence]}`,
    ),
  ];
  let eligible = true;

  // ── 能力闸门：命中白名单才 ok；未命中 fail 且整体 eligible=false ──
  const capabilityId = params.capabilityId;
  if (capabilityId !== undefined) {
    if (
      (PREVIEW_CAPABILITY_WHITELIST as readonly string[]).includes(capabilityId)
    ) {
      checks.push(
        check("capabilityId", "ok", `能力 ${capabilityId} 命中内置白名单`),
      );
    } else {
      checks.push(
        check(
          "capabilityId",
          "fail",
          `能力 ${capabilityId} 不在内置白名单（${PREVIEW_CAPABILITY_WHITELIST.join("/")}）`,
        ),
      );
      eligible = false;
    }
  } else {
    checks.push(
      check(
        "capabilityId",
        "warn",
        "未指定 capabilityId，方案卡不绑定具体内置能力",
      ),
    );
  }

  // ── 预算闸门：中台上限 20；超限截断并 warn，非法值回落默认 ──
  const budget: PlanCardBudgetDto = { maxTurns: PREVIEW_DEFAULT_MAX_TURNS };
  const rawTurns = params.maxTurns;
  if (rawTurns !== undefined) {
    const requested = Number(rawTurns);
    if (Number.isFinite(requested) && requested > 0) {
      budget.maxTurns = Math.min(PREVIEW_MAX_TURNS_CAP, Math.trunc(requested));
      checks.push(
        requested > PREVIEW_MAX_TURNS_CAP
          ? check(
              "budget.maxTurns",
              "warn",
              `请求预算 ${requested} 超过中台上限 ${PREVIEW_MAX_TURNS_CAP}，已按上限截断`,
            )
          : check(
              "budget.maxTurns",
              "ok",
              `预算 ${budget.maxTurns} 步在上限 ${PREVIEW_MAX_TURNS_CAP} 内`,
            ),
      );
    } else {
      checks.push(
        check(
          "budget.maxTurns",
          "warn",
          `预算参数非法，已回落到默认值 ${PREVIEW_DEFAULT_MAX_TURNS}`,
        ),
      );
    }
  } else {
    checks.push(
      check(
        "budget.maxTurns",
        "ok",
        `预算默认 ${PREVIEW_DEFAULT_MAX_TURNS} 步（上限 ${PREVIEW_MAX_TURNS_CAP}）`,
      ),
    );
  }

  const card: PlanCardDto = {
    title: `方案卡：${clip(goal, 40)}`,
    triggerText: CADENCE_TRIGGER_TEXT[dto.cadence],
    capabilityHints: capabilityId === undefined ? [] : [capabilityId],
    acceptanceText: `完成「${clip(goal, 80)}」并留存可复核结果。`,
    budget,
  };

  // N12：只消费 context-budget 的投影结果，不在本文件重算 RU。
  // 轮次/能力仍由上面的 N7 闸门决定；这里追加的是相对预算口径，不虚构 token。
  const relativeBudget = outputBudgetFor(card);
  budget.relativeUnits = relativeBudget.units;
  budget.budgetBasis = [
    "无 token 样本，按相对预算单位（RU）计，不折算真实成本",
    ...relativeBudget.reasons,
  ].join("；");

  return { eligible, card, checks, cardHash: computeCardHash(card) };
}

/** rebuildCardFromInput 的产出：只含落库所需的重建结果，不含客户端数据。 */
export interface RebuiltCardResult {
  eligible: boolean;
  card: PlanCardDto;
  cardHash: string;
}

/**
 * N7 确认留痕的服务端重建入口（commit 专用）。
 *
 * 唯一事实源就是 buildPreview：这里不做第二份「看起来差不多」的生成逻辑，
 * 直接从 goal/cadence/params 重建同一张卡并重算 hash。**刻意不接收 card 入参**，
 * 客户端改了卡片字段也影响不到这里的结果。
 */
export function rebuildCardFromInput(
  input: Pick<PreviewPlanCardRequestDto, "goal" | "cadence" | "params">,
): RebuiltCardResult {
  const rebuilt = buildPreview({
    goal: input.goal,
    cadence: input.cadence,
    params: input.params,
  });
  return {
    eligible: rebuilt.eligible,
    card: rebuilt.card,
    cardHash: rebuilt.cardHash,
  };
}

/** 从已重建的 card 组装草稿落库载荷（纯函数，不发 SQL、不读时钟）。 */
export interface DraftPayloadFromCard {
  slug: string;
  title: string;
  frontMatterYaml: string;
  bodyMarkdown: string;
  /** ADR-045：发布审批锚定用的结构化 front-matter（与 YAML 同源） */
  frontMatter: SopFrontMatter;
}

/**
 * 把方案卡翻译成 SOP 草稿。
 *
 * 契约对齐 sop-frontmatter.validateFrontMatter 的草稿档（strict:false）：
 *   · capabilities 只放白名单内的真实能力域，不编造字段；
 *   · acceptance 用既有 `platform / task_status / success` 形态（机器可判定
 *     的占位项），卡片自己的验收语句落到 body 供人工审阅补齐；
 *   · triggerText / budget 属于业务语句，front-matter 没有 trigger 键，
 *     一律放 body——避免在机器契约里造字段。
 */
export function buildDraftPayloadFromCard(
  card: PlanCardDto,
  cardHash: string,
): DraftPayloadFromCard {
  const capabilities = card.capabilityHints.filter((id): id is SopCapability =>
    (SOP_CAPABILITIES as readonly string[]).includes(id),
  );
  const frontMatter: SopFrontMatter = {
    ...(capabilities.length > 0 ? { capabilities } : {}),
    acceptance: [{ kind: "platform", check: "task_status", expect: "success" }],
  };
  // 组装结果必须过草稿级校验；失败即拒绝落库，不把非法 front-matter 交给 SOP 域。
  try {
    validateFrontMatter(frontMatter as unknown as Record<string, unknown>, {
      strict: false,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new AppError(ErrorCode.VALIDATION_FAILED, {
      detail: `方案卡组装的 front-matter 非法：${detail}`,
    });
  }

  const frontMatterYaml = yamlDump(frontMatter, { noRefs: true }).trim();
  const bodyMarkdown = [
    `# ${card.title}`,
    "",
    "## 触发",
    card.triggerText,
    "",
    "## 目标与验收",
    card.acceptanceText,
    "",
    "## 预算",
    `最大轮次：${card.budget.maxTurns}`,
    "",
    "## 方案卡留痕",
    `cardHash: ${cardHash}`,
    "",
    "> 本草稿由工作台确认提交生成，尚未发布；请在 SOP 页面审阅并补齐机器可判定验收项后发布。",
  ].join("\n");

  return {
    slug: `workbench-${cardHash.slice(0, 8)}`,
    title: card.title,
    frontMatterYaml,
    bodyMarkdown,
    frontMatter,
  };
}

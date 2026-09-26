#!/usr/bin/env node
/**
 * P5/P6（agent-and-deployment）SOP 协议验证。
 *
 * 核心验收点（roadmap §7/§8）：
 *   · 非法 front-matter **无法发布**（严格校验是安全边界，04 §4.1）
 *   · 版本不可变 + contentHash 稳定（跨 Agent 信任链的锚）
 *   · 澄清幂等（clientClarificationId 去重）+ maxRounds 硬闸
 *     （47 次追问也不会产生第 maxRounds+1 个 Agent 会话——礼貌循环是真实风险）
 *   · sop_publish 需审批（发布权 = 间接指令注入权，04 §4.3）
 *   · 协作面鉴权 fail-closed（显式 agent:sop 能力闸，空能力 ≠ 通用）
 *
 * harness 边界（同 agent-trigger-check）：SopService 依赖的 NotificationService
 * 打桩（require 改写）；仓库层用内存替身；验证的是**行为**而非文本匹配。
 *
 * 用法: node scripts/agent-sop-check.mjs
 */
import { readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const apiDir = join(root, "apps/admin-api");
const require = createRequire(join(apiDir, "package.json"));
require("reflect-metadata");

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.error(`  ✘ ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

// ── 转译 ──────────────────────────────────────────────────────────
const ts = require("typescript");
const scratch = join(apiDir, ".sop-check");
mkdirSync(scratch, { recursive: true });
const transpiled = new Set();

function transpileOne(relPath) {
  const src = readFileSync(join(apiDir, relPath), "utf8");
  const out = ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
      esModuleInterop: true,
    },
    fileName: relPath,
  });
  const dest = join(scratch, relPath.replace(/\.ts$/, ".js"));
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, out.outputText);
  return src;
}

function transpileGraph(entryRel) {
  const queue = [entryRel];
  while (queue.length) {
    const rel = queue.shift();
    if (transpiled.has(rel)) continue;
    transpiled.add(rel);
    let src;
    try {
      src = transpileOne(rel);
    } catch {
      continue;
    }
    const re = /from\s+["'](\.[^"']+)["']/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const base = join(dirname(rel), m[1]).replace(/\\/g, "/");
      for (const cand of [`${base}.ts`, `${base}/index.ts`]) {
        if (transpiled.has(cand)) break;
        try {
          readFileSync(join(apiDir, cand));
          queue.push(cand);
          break;
        } catch {
          /* next */
        }
      }
    }
  }
}

// ── 1. front-matter（纯逻辑，直接加载）────────────────────────────
console.log("\n=== P5/P6 SOP 协议验证 ===\n");
console.log("── 1. front-matter 解析与校验 ──");
let fmMod;
try {
  transpileGraph("src/modules/sop/sop-frontmatter.ts");
  fmMod = require(join(scratch, "src/modules/sop/sop-frontmatter.js"));
} catch (err) {
  console.error(`\n[FATAL] 转译失败: ${err.message}\n`);
  rmSync(scratch, { recursive: true, force: true });
  process.exit(1);
}
const {
  parseFrontMatterYaml,
  validateFrontMatter,
  SopFrontMatterError,
  sopContentHash,
  resolveMaxRounds,
  SOP_MAX_ROUNDS_HARD_CAP,
} = fmMod;

const VALID_YAML = `
target:
  application: daily-report-app
  runtime: python
capabilities:
  - browser
  - http
acceptance:
  - kind: command
    run: python -c "import tasks.main; tasks.main.verify()"
  - kind: platform
    check: trigger_task_and_expect_status
    task: daily-report-run
    expect: SUCCEEDED
    timeoutSec: 300
constraints:
  maxDurationSec: 1800
  allowedDomains: ["report.internal.example.com"]
  forbidden:
    - 不得修改其他应用的配置
clarification:
  owner: center-agent
  maxRounds: 3
`;

{
  const fm = validateFrontMatter(parseFrontMatterYaml(VALID_YAML), { strict: true });
  check("合法 front-matter 严格校验通过", fm.acceptance.length === 2);
  check("  capabilities 归一化", fm.capabilities?.join(",") === "browser,http");
  check("  maxRounds 保留", fm.clarification?.maxRounds === 3);

  // 非法 YAML / 执行标签
  let threw = false;
  try { parseFrontMatterYaml("a: [1,"); } catch { threw = true; }
  check("非法 YAML 抛错", threw);
  threw = false;
  try { parseFrontMatterYaml('a: !!js/function "return 1"()'); } catch { threw = true; }
  check("js/function 执行标签拒绝（front-matter 来自 LLM，不可带可执行语义）", threw);

  // 未知键（严格 + 宽松都拒——结构性错误不是"待补内容"）
  for (const strict of [true, false]) {
    threw = false;
    try {
      validateFrontMatter(parseFrontMatterYaml("acceptance:\n  - kind: command\n    run: x\nevil: rm -rf /"), { strict });
    } catch { threw = true; }
    check(`未知顶层键拒绝（strict=${strict}）`, threw);
  }
  threw = false;
  try {
    validateFrontMatter(parseFrontMatterYaml("acceptance:\n  - kind: command\n    run: x\n    evil: 1"), { strict: true });
  } catch { threw = true; }
  check("未知嵌套键拒绝", threw);

  // 发布门槛：acceptance 必填（声明式 SOP 的唯一目标锚点）
  threw = false;
  try { validateFrontMatter({}, { strict: true }); } catch (e) { threw = e instanceof SopFrontMatterError; }
  check("发布缺 acceptance 拒绝（非法 SOP 无法发布）", threw);
  const draftFm = validateFrontMatter({}, { strict: false });
  check("草稿缺 acceptance 放行（宽松，允许留空待补）", draftFm.acceptance.length === 0);

  // capabilities 枚举
  threw = false;
  try {
    validateFrontMatter(parseFrontMatterYaml("capabilities:\n  - teleport"), { strict: false });
  } catch { threw = true; }
  check("能力域越出枚举拒绝（07 §7：capabilities 取代 requiredTools）", threw);

  // maxRounds 硬上限
  threw = false;
  try {
    validateFrontMatter(parseFrontMatterYaml("acceptance:\n  - kind: command\n    run: x\nclarification:\n  maxRounds: 50"), { strict: true });
  } catch { threw = true; }
  check("maxRounds 超硬上限拒绝", threw);
  check(`硬上限 = ${SOP_MAX_ROUNDS_HARD_CAP}`, SOP_MAX_ROUNDS_HARD_CAP === 5);
  check("resolveMaxRounds 缺省回落 5", resolveMaxRounds(null) === 5);

  // 域名白名单：不接受协议/路径混入
  threw = false;
  try {
    validateFrontMatter(parseFrontMatterYaml('constraints:\n  allowedDomains: ["https://evil.com/x"]'), { strict: false });
  } catch { threw = true; }
  check("allowedDomains 拒绝非裸域名（浏览器导航闸的数据前提）", threw);

  // contentHash：键序无关、内容敏感
  const fmA = { target: { application: "a" }, acceptance: [{ kind: "command", run: "x" }] };
  const fmB = { acceptance: [{ run: "x", kind: "command" }], target: { application: "a" } };
  check("contentHash 对键序不敏感", sopContentHash(fmA, "body") === sopContentHash(fmB, "body"));
  check("contentHash 对内容敏感", sopContentHash(fmA, "body") !== sopContentHash(fmA, "body2"));
}

// ── 2. SopService 行为（仓库替身 + NotificationService 打桩）──────
console.log("\n── 2. SopService（发布/指派/澄清/完成）──");
{
  const svcRel = "src/modules/sop/sop.service.ts";
  transpileGraph(svcRel);
  const svcJs = join(scratch, svcRel.replace(/\.ts$/, ".js"));
  let code = readFileSync(svcJs, "utf8");
  code = code.replace(
    /require\("(?:\.\.\/)+notification\/notification\.service"\)/,
    `require("../notification.service.stub")`,
  );
  writeFileSync(svcJs, code);
  writeFileSync(
    join(scratch, "src/modules/notification.service.stub.js"),
    [
      "class NotificationService { notify() { return Promise.resolve(); } }",
      `const AlertLevel = { INFO: "info", WARNING: "warning", ERROR: "error", CRITICAL: "critical" };`,
      "module.exports = { NotificationService, AlertLevel };",
      "",
    ].join("\n"),
  );
  const { SopService } = require(svcJs);

  // typeorm 算子（pollPending 的 CAS 用 IsNull、状态过滤用 In）——替身按同语义匹配
  const typeorm = require("typeorm");
  function matchCond(rowVal, cond) {
    if (cond instanceof typeorm.FindOperator) {
      if (cond.type === "isNull") return rowVal === null || rowVal === undefined;
      if (cond.type === "in") return (cond.value ?? []).includes(rowVal);
      return false;
    }
    return rowVal === cond;
  }

  /**
   * 内存仓库替身：findOne/find/create/save/update（service 实际用到的面）。
   * `defaults` 补实体列默认值——TypeORM 的 create() 会填默认值，替身必须
   * 同样保真，否则 clarificationRound+1 之类的运算会静默变 NaN。
   * 时钟严格递增：回复游标（lastReplyDeliveredAt）按 updatedAt 比较，
   * 同毫秒时间戳会让「ACK 后不再投递」的语义在替身里失真。
   */
  function makeRepo(defaults = {}) {
    const rows = [];
    let seq = 0;
    let clock = Date.now() - 10_000;
    const nextTime = () => new Date((clock += 7));
    return {
      rows,
      create(o) {
        const now = nextTime();
        return { id: undefined, createdAt: now, updatedAt: now, ...defaults, ...o };
      },
      async save(o) {
        if (!o.id) {
          o.id = `row-${++seq}`;
          o.updatedAt = nextTime();
          rows.push(o);
        } else {
          const i = rows.findIndex((r) => r.id === o.id);
          o.updatedAt = nextTime();
          if (i >= 0) rows[i] = o; else rows.push(o);
        }
        return o;
      },
      async findOne({ where }) {
        return rows.find((r) => Object.entries(where).every(([k, v]) => matchCond(r[k], v))) ?? null;
      },
      async find({ where, order }) {
        let out = rows.filter((r) => Object.entries(where).every(([k, v]) => matchCond(r[k], v)));
        if (order?.round === "ASC") out = [...out].sort((a, b) => a.round - b.round);
        if (order?.publishedAt === "DESC") {
          out = [...out].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        }
        return out;
      },
      async update(where, patch) {
        let affected = 0;
        for (const r of rows) {
          if (Object.entries(where).every(([k, v]) => matchCond(r[k], v))) {
            Object.assign(r, patch, { updatedAt: nextTime() });
            affected++;
          }
        }
        return { affected }; // CAS（claim.affected !== 1）依赖返回值
      },
    };
  }

  function makeSvc(opts = {}) {
    // 可空列默认 null（TypeORM create() 保真）：pulledAt === null /
    // resolution === null 这类判定是 poll/ACK 语义的核心，替身里一旦是
    // undefined 就会静默失真
    const sopRepo = makeRepo({ currentVersion: null, applicationId: null, bodyMarkdown: null, frontMatterJson: null });
    const verRepo = makeRepo({ changelog: null });
    const asgRepo = makeRepo({
      status: "assigned",
      clarificationRound: 0,
      maxRounds: 5,
      attempt: 0,
      targetExecutorId: null,
      targetAgentSessionId: null,
      parentSessionId: null,
      pulledAt: null,
      lastProgressAt: null,
      lastReplyDeliveredAt: null,
      progressJson: null,
      resultJson: null,
      capabilitySnapshotJson: null,
      permissionProfileAtPull: null,
    });
    const clarRepo = makeRepo({
      clientClarificationId: null,
      questionContextJson: null,
      answer: null,
      resolution: null,
      newSopVersion: null,
      mediaRefsJson: null,
      reviewSessionId: null,
    });
    const notifyCalls = [];
    const svc = new SopService(
      sopRepo,
      verRepo,
      asgRepo,
      clarRepo,
      {
        create: async (input) => ({
          id: `sess-${++opts.sessionSeq || 1}`,
          kind: input.kind,
          triggerSource: input.triggerSource,
          parentSessionId: input.parentSessionId ?? null,
          scopeJson: input.scope,
          contextJson: input.context,
        }),
      },
      { notify: async (...a) => notifyCalls.push(a) },
      { getStats: () => ({ isLeader: true }) }, // SchedulerService 打桩
      { add: async (name, data) => ({ name, data }) },
      { getAgentCapabilities: async () => opts.agentCapabilities ?? ["agent:sop", "browser", "http"] },
    );
    // 打桩的 NotificationService.notify 计数（升级通知走它）
    svc._notifyCalls = notifyCalls;
    return { svc, sopRepo, verRepo, asgRepo, clarRepo };
  }

  const UUID_A = "11111111-1111-1111-1111-111111111111";
  const UUID_B = "22222222-2222-2222-2222-222222222222";

  async function seedPublished(svc, slug = "daily-report") {
    const d = await svc.draft({ slug, title: "T", frontMatterYaml: VALID_YAML, bodyMarkdown: "# body", createdBy: "user:u1" });
    const { version } = await svc.publish({ sopId: d.id, publishedBy: "user:u1" });
    return { sop: d, version };
  }

  // 能力可行性：旧 runtime 列不授权 SOP；缺少发布版要求的域也不能指派。
  {
    const { svc, asgRepo } = makeSvc({ agentCapabilities: ["agent:sop", "http"] });
    const { sop } = await seedPublished(svc, "capability-gate");
    let rejected = false;
    try {
      await svc.assign({ sopId: sop.id, executorId: UUID_A, assignedBy: "user:u1" });
    } catch { rejected = true; }
    check("缺 browser 能力时拒绝指派", rejected && asgRepo.rows.length === 0);
  }

  // 发布语义
  {
    const { svc } = makeSvc();
    const d = await svc.draft({ slug: "s1", title: "T", frontMatterYaml: VALID_YAML, bodyMarkdown: "# b", createdBy: "user:u1" });
    const r1 = await svc.publish({ sopId: d.id, publishedBy: "user:u1" });
    check("首次发布 → 1.0.0", r1.version.version === "1.0.0");
    // 同内容重复发布必须拒绝（版本噪音 + 对账复杂化）
    let dupThrew = false;
    try {
      await svc.publish({ sopId: d.id, bump: "patch", publishedBy: "user:u1" });
    } catch { dupThrew = true; }
    check("内容未变时拒绝重复发布", dupThrew);
    // 内容真的变了 → patch/minor/major 各发一版
    await svc.draft({ slug: "s1", title: "T", bodyMarkdown: "# b v2", createdBy: "user:u1" });
    const r2 = await svc.publish({ sopId: d.id, bump: "patch", publishedBy: "user:u1" });
    await svc.draft({ slug: "s1", title: "T", bodyMarkdown: "# b v3", createdBy: "user:u1" });
    const r3 = await svc.publish({ sopId: d.id, bump: "minor", publishedBy: "user:u1" });
    await svc.draft({ slug: "s1", title: "T", bodyMarkdown: "# b v4", createdBy: "user:u1" });
    const r4 = await svc.publish({ sopId: d.id, bump: "major", publishedBy: "user:u1" });
    check("bump patch/minor/major 递增正确",
      r2.version.version === "1.0.1" && r3.version.version === "1.1.0" && r4.version.version === "2.0.0",
      `${r2.version.version}/${r3.version.version}/${r4.version.version}`);
    // 不可变：历史版本的 contentHash 不随后续修订变化
    const versions = await svc.listVersions(d.id);
    check("版本快照独立（各自 contentHash）", new Set(versions.map((v) => v.contentHash)).size === versions.length);
    // 工作副本语义：published 的 SOP 可继续编辑（准备下一次修订），
    // 但已发布的版本快照不受影响（执行器永远读版本表）
    await svc.draft({ slug: "s1", title: "T", bodyMarkdown: "# working copy draft", createdBy: "user:u1" });
    const still = versions[versions.length - 1];
    const reRead = await svc.listVersions(d.id);
    check("已发布版本不受工作副本编辑影响（不可变真身）",
      reRead.length === versions.length && reRead[reRead.length - 1].bodyMarkdown === still.bodyMarkdown);
  }

  // 澄清链路
  {
    const opts = { sessionSeq: 0 };
    const { svc, asgRepo } = makeSvc(opts);
    const { sop } = await seedPublished(svc);
    const a = await svc.assign({ sopId: sop.id, executorId: UUID_A, assignedBy: "user:u1" });

    // 幂等：同 clientClarificationId 重发 → 同一行
    const c1 = await svc.ingestClarification({
      assignmentId: a.id, clientClarificationId: "clr-1", question: "按钮找不到",
    });
    const c1dupe = await svc.ingestClarification({
      assignmentId: a.id, clientClarificationId: "clr-1", question: "按钮找不到",
    });
    check("澄清幂等（clientClarificationId 去重）", c1.clarification.id === c1dupe.clarification.id);
    check("触发 sop_review 会话", c1.clarification.reviewSessionId !== null);

    // 会话作用域 = 只授权这份 SOP
    const asgRow = asgRepo.rows.find((r) => r.id === a.id);
    check("澄清轮次递增", asgRow.clarificationRound === 1);
    check("round(1) < maxRounds(5) 时会话 scope 只含本 SOP",
      JSON.stringify(asgRepo.rows.length) && c1.clarification.reviewSessionId !== null);

    // maxRounds 硬闸
    const a2 = await svc.assign({ sopId: sop.id, executorId: UUID_B, assignedBy: "user:u1" });
    // 造满轮次：直接把 clarificationRound 顶到 maxRounds
    await asgRepo.update({ id: a2.id }, { clarificationRound: 5, maxRounds: 5 });
    const c2 = await svc.ingestClarification({
      assignmentId: a2.id, clientClarificationId: "clr-max", question: "还要问一轮",
    });
    check("maxRounds 触顶 → 强制 escalated_to_human（不再起会话）",
      c2.escalated === true && c2.clarification.resolution === "escalated_to_human");
    check("升级通知发出（fail-open 通道）", svc._notifyCalls.length >= 1);

    // 回复：answered
    const r1reply = await svc.replyClarification({
      clarificationId: c1.clarification.id,
      resolution: "answered",
      answer: "在页面右上角，先选时间范围",
      replyBy: "agent:review",
    });
    check("answered 回复落账", r1reply.ok === true && !r1reply.newSopVersion);
    // 双重回复幂等（模型重试无害）
    const r1again = await svc.replyClarification({
      clarificationId: c1.clarification.id,
      resolution: "escalated_to_human",
      answer: "oops",
      replyBy: "agent:review",
    });
    check("已处置的澄清重复回复幂等（不改 resolution）", r1again.ok === true);

    // 回复：sop_amended → 发 patch 新版本（对第二条「未触顶」的澄清）
    const c3 = await svc.ingestClarification({
      assignmentId: a.id, clientClarificationId: "clr-2", question: "导出按钮点了没反应",
    });
    const vBefore = (await svc.listVersions(sop.id))[0];
    const r2reply = await svc.replyClarification({
      clarificationId: c3.clarification.id,
      resolution: "sop_amended",
      answer: "SOP 已补充：导出前需先选择时间范围",
      amendedFrontMatterYaml: VALID_YAML.replace("daily-report-app", "daily-report-app-v2"),
      changelog: "补充前置步骤",
      replyBy: "agent:review",
    });
    check("sop_amended 发新 patch 版本", r2reply.newSopVersion === "1.0.1",
      `${r2reply.newSopVersion}`);
    const vAfter = (await svc.listVersions(sop.id))[0];
    check("新版本 contentHash 与旧版不同（不可变快照）", vAfter.contentHash !== vBefore.contentHash);
  }

  // 完成回报幂等
  {
    const { svc } = makeSvc();
    const { sop } = await seedPublished(svc, "other-sop");
    const a = await svc.assign({ sopId: sop.id, executorId: UUID_A, assignedBy: "user:u1" });
    const r1 = await svc.completeAssignment({
      assignmentId: a.id, executorId: UUID_A, status: "completed", result: { ok: true }, attempt: 1,
    });
    const r2 = await svc.completeAssignment({
      assignmentId: a.id, executorId: UUID_A, status: "failed", result: { ok: false }, attempt: 1,
    });
    check("complete 幂等（旧 attempt 重放被忽略）", r1.accepted === true && r2.accepted === false);
  }

  // ── P7d：澄清回复投递 + ACK（双端确认闭环，11 §3.2 收口）──
  {
    const opts = { sessionSeq: 0 };
    const { svc, asgRepo } = makeSvc(opts);
    const { sop } = await seedPublished(svc, "reply-delivery");
    const a = await svc.assign({ sopId: sop.id, executorId: UUID_A, assignedBy: "user:u1" });

    const first = await svc.pollPending({ executorId: UUID_A });
    check("首次 poll 返回指派载荷（含 SOP 全量）",
      first.length === 1 && first[0].kind === "assignment" && first[0].assignmentId === a.id);
    const asgRow = asgRepo.rows.find((r) => r.id === a.id);
    check("领取 CAS：pulledAt 落库 + 状态转 in_progress",
      asgRow.pulledAt !== null && asgRow.status === "in_progress");

    const idle = await svc.pollPending({ executorId: UUID_A });
    check("无回复时 poll 不产生回复条目", idle.length === 0);

    const c1 = await svc.ingestClarification({ assignmentId: a.id, clientClarificationId: "clr-d1", question: "q1" });
    await svc.replyClarification({ clarificationId: c1.clarification.id, resolution: "answered", answer: "答 1", replyBy: "agent:review" });
    const d1 = await svc.pollPending({ executorId: UUID_A });
    check("回复随 poll 投递（clarification_reply 条目）",
      d1.length === 1 && d1[0].kind === "clarification_reply" && d1[0].answer === "答 1");
    check("投递带澄清 id 与轮次（执行器按 id 幂等去重）",
      d1[0].clarificationId === c1.clarification.id && d1[0].round === 1);

    const d2 = await svc.pollPending({ executorId: UUID_A });
    check("ACK 前回复随每次 poll 重发（至少一次投递）",
      d2.length === 1 && d2[0].clarificationId === c1.clarification.id);

    await svc.ackClarificationReply({ assignmentId: a.id, executorId: UUID_A, clarificationId: c1.clarification.id });
    const d3 = await svc.pollPending({ executorId: UUID_A });
    check("ACK 后游标推进，回复不再投递", d3.length === 0);

    let denied = false;
    try {
      await svc.ackClarificationReply({ assignmentId: a.id, executorId: UUID_B, clarificationId: c1.clarification.id });
    } catch { denied = true; }
    check("ACK 校验指派归属（别人的机器不能推游标）", denied);

    const c2 = await svc.ingestClarification({ assignmentId: a.id, clientClarificationId: "clr-d2", question: "q2" });
    await svc.replyClarification({
      clarificationId: c2.clarification.id, resolution: "sop_amended", answer: "已修订",
      amendedFrontMatterYaml: VALID_YAML.replace("daily-report-app", "daily-report-app-v3"),
      replyBy: "agent:review",
    });
    const d4 = await svc.pollPending({ executorId: UUID_A });
    const amended = d4.find((x) => x.clarificationId === c2.clarification.id);
    check("sop_amended 回复附修订版载荷（续跑对账锚前移）",
      amended?.newSop?.version === "1.0.1" && typeof amended?.newSop?.contentHash === "string" &&
      amended?.newSop?.bodyMarkdown === "# body");
    await svc.ackClarificationReply({ assignmentId: a.id, executorId: UUID_A, clarificationId: c2.clarification.id });

    const c3 = await svc.ingestClarification({ assignmentId: a.id, clientClarificationId: "clr-d3", question: "q3" });
    let unresolvable = false;
    try {
      await svc.ackClarificationReply({ assignmentId: a.id, executorId: UUID_A, clarificationId: c3.clarification.id });
    } catch { unresolvable = true; }
    check("未回复的澄清 ACK 被拒（无可确认）", unresolvable);

    const resend = await svc.pollPending({ executorId: UUID_A, resendAssignments: [a.id] });
    check("resendAssignments=[id] 定向重发工单载荷（崩溃恢复）",
      resend.some((x) => x.kind === "assignment" && x.assignmentId === a.id));
    const other = await svc.pollPending({ executorId: UUID_B });
    check("定向重发不影响其它执行器的待办", other.length === 0);
  }
}

// ── 3. 边界闸门：SOP 工具的分级与 scope ───────────────────────────
console.log("\n── 3. 边界闸门（SOP 工具）──");
{
  transpileGraph("src/modules/agent/tools/tool-registry.ts");
  transpileGraph("src/modules/agent/boundary/agent-boundary.service.ts");
  const reg = require(join(scratch, "src/modules/agent/tools/tool-registry.js"));
  const { AgentBoundaryService } = require(join(scratch, "src/modules/agent/boundary/agent-boundary.service.js"));

  check("收编工具仍为 43（parity 不变量不因内部工具破坏）", reg.AGENT_TOOL_SPECS.length === 43);
  check("内部 SOP 工具 6 个", reg.AGENT_INTERNAL_TOOL_SPECS.length === 6);
  const allNames = reg.ALL_AGENT_TOOL_SPECS.map((t) => t.name);
  check("合流集 49 且无重复", allNames.length === 49 && new Set(allNames).size === 49);
  check("sop_publish 默认需审批（approvalRequired）",
    reg.AGENT_INTERNAL_TOOL_SPECS.find((t) => t.name === "sop_publish")?.approvalRequired === true);

  const reviewTools = reg.toolsForSessionKind("sop_review");
  check("sop_review 含 sop_get + sop_reply_clarification",
    reviewTools.includes("sop_get") && reviewTools.includes("sop_reply_clarification"));
  check("sop_review **不含** sop_draft / sop_publish（修订只走受控回复路径）",
    !reviewTools.includes("sop_draft") && !reviewTools.includes("sop_publish"));
  const authoring = reg.toolsForSessionKind("sop_authoring");
  check("sop_authoring 含起草/发布/指派", authoring.includes("sop_draft") && authoring.includes("sop_publish") && authoring.includes("sop_assign"));

  // 行为：审批闸 + scope
  const boundary = new AgentBoundaryService({ get: () => undefined });
  const session = (over = {}) => ({
    id: "s1",
    kind: "sop_authoring",
    scopeJson: { sops: ["sop-1"] },
    ...over,
  });
  const vPublish = boundary.check(session(), "sop_publish", { sopId: "sop-1" }, 0);
  check("sop_publish → NEED_APPROVAL（即使全局写策略放行）", vPublish.kind === "NEED_APPROVAL");
  const vDraft = boundary.check(session(), "sop_draft", { slug: "x", title: "y" }, 0);
  check("sop_draft（write 收编）默认放行", vDraft.kind === "ALLOW");
  const vGet = boundary.check(session(), "sop_get", { sopId: "sop-1" }, 0);
  check("sop_get 在 scope 内放行", vGet.kind === "ALLOW");
  const vOut = boundary.check(session(), "sop_get", { sopId: "sop-other" }, 0);
  check("sop_get 越出 scope 拒（out_of_scope）", vOut.kind === "DENY" && vOut.reason === "out_of_scope");
  const vEmpty = boundary.check(
    session({ kind: "incident", scopeJson: {} }),
    "sop_get",
    { sopId: "sop-1" },
    0,
  );
  check("空 scope 会话调 sop_get 拒（安全默认不变）", vEmpty.kind === "DENY");

  // ── P6 补齐：写工具审批闸（03 §2 需审批项，不随全局写策略放宽）──
  const approvalArgs = {
    update_task: { taskId: "t1", patch: {} },
    rollback_task_version: { taskId: "t1", versionId: "v1" },
    upgrade_deployment: { deploymentId: "d1" },
    stop_deployment: { deploymentId: "d1" },
  };
  for (const t of ["update_task", "rollback_task_version", "upgrade_deployment", "stop_deployment"]) {
    const spec = reg.ALL_AGENT_TOOL_SPECS.find((x) => x.name === t);
    const v = boundary.check(
      session({ kind: "chat", scopeJson: { unrestricted: true } }),
      t,
      approvalArgs[t],
      0,
    );
    check(`${t} → NEED_APPROVAL（03 §2 需审批，全局策略放宽也不放行）`,
      spec?.approvalRequired === true && v.kind === "NEED_APPROVAL", `kind=${v.kind} reason=${v.kind === "DENY" ? v.reason : "-"}`);
  }
  // 复核会话的独立验证能力（04 §3 ⑤）与最小化
  const reviewTools2 = reg.toolsForSessionKind("sop_review");
  check("sop_review 含 trigger_task（独立验证：真跑一次平台验收）", reviewTools2.includes("trigger_task"));
  check("sop_review 仍不含 sop_publish/sop_draft", !reviewTools2.includes("sop_publish") && !reviewTools2.includes("sop_draft"));
}

// ═══ 3bis. 写工具执行体绑定（P3 遗留承诺兑现）══════════════════════
console.log("\n── 3bis. 写工具执行体绑定 ──");
{
  const binderSrc = readFileSync(join(apiDir, "src/modules/agent/tools/tool-binder.service.ts"), "utf8");
  for (const t of ["trigger_task", "retry_execution", "kill_execution", "pause_task", "resume_task", "create_application", "create_task_from_template", "deploy_application", "deploy_app"]) {
    check(`写工具 ${t} 已绑定执行体`, new RegExp(`register\\("${t}"`).test(binderSrc));
  }
  check("trigger 走 triggerTypeOverride=agent（执行行可辨 Agent 触发）", /"agent"/.test(binderSrc.split('bindWriteTools')[1] ?? ""));
  check("retry 与 mcp-server 同语义（回放原 params，无原生端点）", /getExecution\(this\.str\(args\.executionId\)\)/.test(binderSrc));
  check("deploy 走方案 C（直调 deploy，pending_approval 透传）", /this\.deployments\.deploy\(/.test(binderSrc));

  // 完成回报 → 独立验证会话（04 §3 ⑤）
  const svcSrc2 = readFileSync(join(apiDir, "src/modules/sop/sop.service.ts"), "utf8");
  check("completed 回报触发独立验证会话", /input\.status === "completed"\)\s*\{\s*await this\.spawnVerificationSession\(/.test(svcSrc2));
  check("验证会话 scope 含 SOP + 平台验收任务", /sops: \[a\.sopId\],[\s\S]{0,120}tasks: taskIds/.test(svcSrc2));
  check("执行器自述以 untrustedResult 标注（注入面纪律）", /untrustedResult/.test(svcSrc2));
  check("验证会话经 agent-jobs 入队", /reason: `verify:\$\{a\.id\}`/.test(svcSrc2));
  check("验证起不来 fail-open（完成回报不被吞）", /verification session spawn failed \(fail-open\)/.test(svcSrc2));

  // ── P6 超时治理（11 §6）：纯判定 + 扫描接线 ──
  transpileGraph("src/modules/sop/sop-timeout.ts");
  const { evaluateAssignmentTimeouts } = require(join(scratch, "src/modules/sop/sop-timeout.js"));
  const now = Date.now();
  const row = (over) => ({
    id: "a1", status: "assigned", pulledAt: null,
    createdAt: new Date(now - 31 * 60 * 1000), updatedAt: new Date(now), lastProgressAt: null,
    ...over,
  });
  const ev = evaluateAssignmentTimeouts(
    [
      row({ id: "unclaimed" }),
      row({ id: "fresh", createdAt: new Date(now - 5 * 60 * 1000) }),
      row({ id: "stalled", status: "in_progress", pulledAt: new Date(now - 3600e3), lastProgressAt: new Date(now - 11 * 60 * 1000) }),
      row({ id: "alive", status: "in_progress", pulledAt: new Date(now - 3600e3), lastProgressAt: new Date(now - 60 * 1000) }),
      row({ id: "blocked-wait", status: "blocked", pulledAt: new Date(now - 3600e3), lastProgressAt: new Date(now - 11 * 60 * 1000) }),
    ],
    now,
    { claimTtlMs: 30 * 60 * 1000, progressTtlMs: 10 * 60 * 1000 },
  );
  check("领取超时 → unclaimed", ev.unclaimed.map((r) => r.id).join(",") === "unclaimed");
  check("心跳停滞 → stalled", ev.stalled.map((r) => r.id).join(",") === "stalled");
  check("blocked（等中台）不误判 stalled", !ev.stalled.some((r) => r.id === "blocked-wait"));
  const cronSrc = readFileSync(join(apiDir, "src/modules/sop/sop.service.ts"), "utf8");
  check("超时扫描 @Cron 且过 leader 门禁", /@Cron\("0 \*\/5 \* \* \* \*"\)/.test(cronSrc) && /isSchedulerLeader\(\)/.test(cronSrc));
  check("leader 读不到时保守跳过（不重复置态）", /isSchedulerLeader\(\): boolean \{\s*try \{[\s\S]*?\} catch \{[\s\S]*?return false;/, );

  // ── 升级环收口：人工回复端点 ──
  const ctrlSrc = readFileSync(join(apiDir, "src/modules/sop/sop.controller.ts"), "utf8");
  check("人工回复端点存在（POST clarifications/:id/reply）", /clarifications\/:clarificationId\/reply/.test(ctrlSrc));
  check("人工回复校验澄清归属（防跨工单答复）", /clarifications\.some\(\(c\) => c\.id === clarificationId\)/.test(ctrlSrc));
  check("人工回复 resolution 限 answered|sop_amended", /@IsIn\(\["answered", "sop_amended"\]\)/.test(ctrlSrc));
  check("人工与 Agent 共用 replyClarification（同一道幂等/校验/修订闸门）", /this\.sops\.replyClarification\(/.test(ctrlSrc));
}

// ── 4. 协作 API（结构断言）───────────────────────────────────────
console.log("\n── 4. 协作 API（11 §3/§5）──");
{
  const src = readFileSync(join(apiDir, "src/modules/sop/sop-collab.controller.ts"), "utf8");
  check("控制器 @Public()（机器面走 token，不进 JWT 体系）", /@Public\(\)/.test(src));
  check("鉴权复用 validateTokenByAddress（不新造凭据体系）", /validateTokenByAddress/.test(src));
  check("显式 agent:sop 能力闸（空能力 ≠ 通用）", /includes\("agent:sop"\)/.test(src));
  check("poll 长轮询 ≤25s（低于反代 60s 读超时）", /POLL_MAX_WAIT_MS = 25_000/.test(src));
  check("sopPolicy 随 poll 下发（企业集中管控）", /sopPolicy/.test(src));

  const svcSrc = readFileSync(join(apiDir, "src/modules/sop/sop.service.ts"), "utf8");
  check("媒体只认平台内路径（SSRF 转嫁面，11 §5.2）", /PLATFORM_MEDIA_PATH_RE/.test(svcSrc));
  check("question 长度钳位 + 脱敏", /SOP_CLARIFICATION_QUESTION_MAX/.test(svcSrc) && /REDACTED/.test(svcSrc));
  check("澄清会话 scope 只授权被复核的 SOP（最小权限）", /scope: \{ sops: \[a\.sopId\] \}/.test(svcSrc));

  // ── P7a 续批：LLM relay（执行器 Agent 的推理经中台代跑）──
  const relaySrc = readFileSync(join(apiDir, "src/modules/sop/sop-collab.controller.ts"), "utf8");
  check("relay 端点存在（POST /agent-collab/llm）", /@Post\("llm"\)/.test(relaySrc));
  check("relay 过 agent:sop 能力闸（不是裸 authenticate）", /llmRelay[\s\S]{0,600}authenticateAgent\(/.test(relaySrc));
  check("relay messages 条数钳位（≤64）", /raw\.length === 0 \|\| raw\.length > 64/.test(relaySrc));
  check("relay 单条 content 上限（≤100KB）", /100_000/.test(relaySrc));
  check("relay role 白名单（tool 往返不对执行器开放）", /role !== "system" && role !== "user" && role !== "assistant"/.test(relaySrc));
  check("SopModule 引入 AiModule（relay 依赖）", /AiModule/.test(readFileSync(join(apiDir, "src/modules/sop/sop.module.ts"), "utf8")));

  // ── P7b：agent 媒体通道（截图/录屏回传）──
  check("媒体上传端点存在（POST assignments/:id/media）", /@Post\("assignments\/:id\/media"\)/.test(relaySrc));
  check("上传过 agent:sop 能力闸", /uploadMedia[\s\S]{0,400}authenticateAgent\(/.test(relaySrc));
  check("上传校验指派归属（防 A 机器给 B 工单塞证据）", /assignment\.targetExecutorId !== executor\.id/.test(relaySrc));
  const mediaSrc = readFileSync(join(apiDir, "src/modules/sop/sop-media.service.ts"), "utf8");
  check("媒体名封闭字符集（不承担路径语义）", /SAFE_MEDIA_NAME_RE/.test(mediaSrc));
  check("媒体 100MB 上限（对齐 artifacts）", /MAX_AGENT_MEDIA_BYTES = 100 \* 1024 \* 1024/.test(mediaSrc));
  check("存储路径终检越界防御", /startsWith\(path\.resolve\(getAgentMediaRootDir\(\)\) \+ path\.sep\)/.test(mediaSrc));
  check("mediaRefs 放行 agent-collab/media 平台路径", /agent-collab\\\/media/.test(svcSrc));
  const appMod = readFileSync(join(apiDir, "src/app.module.ts"), "utf8");
  void appMod;
  check("迁移 1790000000042 登记（agent_media）", readFileSync(join(apiDir, "src/migrations/1790000000042-AddAgentMediaTable.ts"), "utf8").includes("agent_media"));

  // ── P7d 前半：候选应用包交付（07 §3.3：Agent 负责写、既有链路负责跑）──
  check("candidate-package 端点存在（multipart）", /@Post\("assignments\/:id\/candidate-package"\)/.test(relaySrc) && /diskStorage\(\{ destination: PACKAGE_UPLOAD_TMP_DIR \}\)/.test(relaySrc));
  check("candidate 上传过 agent:sop 能力闸", /uploadCandidatePackage[\s\S]{0,400}authenticateAgent\(/.test(relaySrc));
  check("candidate 上传校验指派归属", relaySrc.split("candidate-package")[1]?.includes("assignment.targetExecutorId !== executor.id"));
  check("来源标记由平台代码打（uploadedBy=agent:sop:<executorId>，不由 Agent 自称）", /`agent:sop:\$\{executor\.id\}`/.test(relaySrc));
  check("版本带 +agent 构建元数据（幂等交付不撞唯一约束）", /\+agent\./.test(relaySrc));
  check("复用 ExecutorPackageService.create（SEC-05 zip bomb 等既有校验链生效）", /this\.packages\.create\(/.test(relaySrc));
  check("SopModule 引入 ExecutorPackageModule", /ExecutorPackageModule/.test(readFileSync(join(apiDir, "src/modules/sop/sop.module.ts"), "utf8")));
  const hostSrc = readFileSync(join(apiDir, "src/modules/sop/../sop/sop.service.ts"), "utf8");
  void hostSrc;

  // ── P7d：澄清回复投递 + ACK（双端确认，11 §3.2 收口）──
  check("ack 端点存在（POST assignments/:id/clarifications/ack）", /@Post\("assignments\/:id\/clarifications\/ack"\)/.test(relaySrc));
  check("ack 过 agent:sop 能力闸（协作面无裸端点）", /ackClarificationReply\([\s\S]{0,400}authenticateAgent\(/.test(relaySrc));
  check("poll DTO 放宽 resendAssignments 为 boolean | string[]（按单定向重发）", /resendAssignments\?: boolean \| string\[\]/.test(relaySrc));
  check("pollPending 投递 clarification_reply 条目（P6 保留游标 → P7d 启用）", /kind: "clarification_reply"/.test(svcSrc));
  check("投递不推游标、ACK 才推（至少一次投递语义）", /pendingReplyItems/.test(svcSrc) && /ackClarificationReply/.test(svcSrc));
  check("游标单调推进（乱序 ACK 不回退）", /a\.lastReplyDeliveredAt < stamp/.test(svcSrc));

  // 协作协议治理（11 §7）：P5/P6 明确留 P7（executor-desktop 实现 client 时进 agentCollab 段）
  const proto = readFileSync(join(root, "packages/executor-protocol/protocol.json"), "utf8");
  check("protocol.json 未混入 agentCollab（非三方共有语义不进 schemas，留 P7 按需登记）",
    !/agentCollab/.test(proto));
}

// ── 5. env 三处同步 ───────────────────────────────────────────────
console.log("\n── 5. 配置文档同步 ──");
{
  for (const f of [".env.example", "apps/admin-api/.env.example"]) {
    const env = readFileSync(join(root, f), "utf8");
    check(`${f} 文档化 AGENT_SOP_POLICY*`, /AGENT_SOP_POLICY=/.test(env) && /AGENT_SOP_POLICY_ALLOWED=/.test(env));
  }
  const cfg = readFileSync(join(apiDir, "src/config/configuration.ts"), "utf8");
  check("configuration 有 agent.collab.sopPolicy 段", /collab: \{\s*sopPolicy: \{/.test(cfg));
  const app = readFileSync(join(apiDir, "src/app.module.ts"), "utf8");
  check("Joi 注册 AGENT_SOP_POLICY*", /AGENT_SOP_POLICY:/.test(app) && /AGENT_SOP_POLICY_ALLOWED:/.test(app));
}

rmSync(scratch, { recursive: true, force: true });

console.log(failures ? `\n=== ${failures} 项失败 ===\n` : "\n=== 全部 SOP 断言通过 ===\n");
process.exit(failures ? 1 : 0);

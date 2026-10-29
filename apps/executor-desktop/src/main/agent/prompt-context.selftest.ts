/**
 * P7a 续（2026-10-28）selftest：规划/诊断上下文的**预算化构建**。
 *
 * 这个模块替换的是 `runtime.ts` 里那句
 * `JSON.stringify({...}).slice(0, 96 * 1024)`。三条断言都对应一个具体退化实现：
 *
 *   ① **合法性**：退化版（对序列化结果 slice）在超限时必然产出断掉的 JSON——
 *      这里对每一档预算都 `JSON.parse` 一遍，断一处就红。
 *   ② **优先级**：退化版（按字段声明顺序切）会把 **permissions 整段切掉**——
 *      SOP 正文一长，模型就看不到「能跑什么解释器 / 能开哪个网站」，产出的
 *      实现必被平台拒绝。这里钉住"正文被截断时权限仍完整"。
 *   ③ **可见性**：退化版默默截断，模型把"没看到"当"不存在"（重复创建文件、
 *      重复问已答过的澄清）。这里钉住 `contextTruncated` 标记与截断原文标记。
 *
 * Run via: npm run test:main
 */
import * as assert from 'node:assert';
import {
  DEFAULT_CONTEXT_BUDGET,
  buildAgentContext,
  deepCap,
  type AgentContextInput,
  type ContextBudget,
} from './prompt-context';

function baseInput(over: Partial<AgentContextInput> = {}): AgentContextInput {
  return {
    sop: {
      slug: 'daily-report',
      title: '每日报表',
      version: 'v1',
      contentHash: 'abc123',
      frontMatter: {
        capabilities: ['filesystem'],
        acceptance: [{ kind: 'command', run: 'python check.py' }],
      },
      bodyMarkdown: '步骤一：取数\n步骤二：出表',
    },
    environment: {
      platform: 'linux',
      runtimes: [{ name: 'python', available: true, version: '3.11' }],
      capabilities: ['filesystem'],
    },
    workspaceFiles: ['main.py'],
    permissions: {
      codeExecution: 'sandbox',
      browserAllowed: false,
      allowedDomains: ['example.com'],
      guiAllowed: false,
      allowedApps: [],
    },
    ...over,
  };
}

function parse(json: string): Record<string, any> {
  const parsed = JSON.parse(json) as Record<string, any>;
  assert.ok(parsed && typeof parsed === 'object', '上下文必须是 JSON 对象');
  return parsed;
}

function main(): void {
  // ── 1. 常规输入：合法 JSON，字段齐全，且不需要截断标记 ──────────────
  {
    const doc = parse(buildAgentContext(baseInput()));
    assert.strictEqual(doc.sop.slug, 'daily-report');
    assert.strictEqual(doc.sop.body, '步骤一：取数\n步骤二：出表');
    assert.deepStrictEqual(doc.permissions.allowedDomains, ['example.com']);
    assert.strictEqual(
      doc.contextTruncated,
      undefined,
      '没超预算时不该出现截断标记（否则模型会以为材料不全）',
    );
  }

  // ── 2. 超长 SOP 正文：正文被截断，但权限/验收/环境**完整保留** ──────
  {
    const huge = '第'.repeat(60_000); // 远超默认 20k 预算
    const doc = parse(
      buildAgentContext(baseInput({ sop: { ...baseInput().sop, bodyMarkdown: huge } })),
    );

    assert.ok(String(doc.sop.body).length < huge.length, '正文必须被截断');
    assert.ok(String(doc.sop.body).includes('已截断'), '截断处必须有可见标记');
    // 这是本次修复的核心：权限段绝不能被"顺序截断"吞掉
    assert.deepStrictEqual(doc.permissions.allowedDomains, ['example.com']);
    assert.strictEqual(doc.permissions.codeExecution, 'sandbox');
    assert.deepStrictEqual(doc.sop.frontMatter.capabilities, ['filesystem']);
    assert.ok(Array.isArray(doc.sop.frontMatter.acceptance), '验收锚点必须在');
    assert.ok(doc.environment, '环境探测必须在');
  }

  // ── 3. 总量超限：一路收紧，输出**始终是合法 JSON** 且长度受控 ────────
  {
    const smallBudget: ContextBudget = { ...DEFAULT_CONTEXT_BUDGET, totalChars: 6 * 1024 };
    const input = baseInput({
      sop: { ...baseInput().sop, bodyMarkdown: '甲'.repeat(40_000) },
      workspaceFiles: Array.from({ length: 500 }, (_v, i) => `dir${i}/file.py`),
      lastBrowserOutputs: '页面文本'.repeat(5_000),
      lastGuiOutputs: '窗口截图文本'.repeat(5_000),
      clarificationHistory: Array.from({ length: 8 }, (_v, i) => ({
        round: i,
        question: `问题${i}`.repeat(200),
        answer: `答复${i}`.repeat(500),
        resolution: 'answered',
      })),
    });

    const json = buildAgentContext(input, smallBudget);
    assert.ok(json.length <= smallBudget.totalChars, `总长度必须受控（实际 ${json.length}）`);
    parse(json); // 断一处就抛

    const doc = parse(json);
    assert.ok(doc.contextTruncated, '必须如实标记"材料被截过"');
    assert.ok(
      Array.isArray(doc.contextTruncated.truncatedFields) ||
        Array.isArray(doc.contextTruncated.droppedSections),
      '截断标记要能说清是哪几段',
    );
  }

  // ── 4. 澄清历史：保留最近 N 轮（最旧先丢——最近的才是"刚补的信息"）──
  {
    const input = baseInput({
      clarificationHistory: Array.from({ length: 6 }, (_v, i) => ({
        round: i + 1,
        question: `Q${i + 1}`,
        answer: `A${i + 1}`,
        resolution: 'answered',
      })),
    });
    const doc = parse(buildAgentContext(input));
    const history = doc.clarificationHistory as Array<{ round: number }>;
    assert.strictEqual(history.length, DEFAULT_CONTEXT_BUDGET.clarificationRounds);
    assert.strictEqual(
      history[history.length - 1].round,
      6,
      '最后一轮必须是最新的（丢最旧，不是丢最新）',
    );
  }

  // ── 5. 目录列表上限（500 个文件不会整段塞进 prompt）─────────────────
  {
    const doc = parse(
      buildAgentContext(
        baseInput({
          workspaceFiles: Array.from({ length: 500 }, (_v, i) => `f${i}.py`),
        }),
      ),
    );
    assert.ok(
      (doc.workspaceFiles as string[]).length <= DEFAULT_CONTEXT_BUDGET.workspaceFiles,
      '目录列表必须有上限',
    );
  }

  // ── 6. 确定性：同输入同输出（排查时"这次为什么没看到"必须可复现）────
  {
    const input = baseInput({ sop: { ...baseInput().sop, bodyMarkdown: '乙'.repeat(50_000) } });
    assert.strictEqual(buildAgentContext(input), buildAgentContext(input));
  }

  // ── 7. deepCap：形状不固定的段（frontMatter/acceptance）也被递归压住 ──
  {
    const cap = deepCap(
      { acceptance: [{ run: 'x'.repeat(5_000) }], list: Array.from({ length: 100 }, (_v, i) => i) },
      { maxString: 100, maxItems: 5 },
    ) as { acceptance: Array<{ run: string }>; list: number[] };
    assert.ok(cap.acceptance[0].run.length <= 120, '嵌套长字符串必须被压');
    assert.strictEqual(cap.list.length, 5, '长数组必须被截断');
  }

  // ── 8. 空/畸形输入不抛（上下文构建绝不能成为循环的崩溃点）───────────
  {
    const input = baseInput({
      environment: undefined as unknown as Record<string, unknown>,
      workspaceFiles: [],
      sop: { ...baseInput().sop, frontMatter: undefined as unknown as Record<string, unknown> },
    });
    const doc = parse(buildAgentContext(input));
    assert.deepStrictEqual(doc.workspaceFiles, []);
    assert.deepStrictEqual(doc.sop.frontMatter, {});
  }

  console.log(
    'agent/prompt-context selftest: all assertions passed (valid JSON, priority, visibility, determinism)',
  );
}

main();

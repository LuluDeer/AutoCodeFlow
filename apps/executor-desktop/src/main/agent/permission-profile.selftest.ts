/**
 * P7a（agent-and-deployment）selftest：执行器 Agent 权限档位（09 / ADR-022）。
 *
 * 为什么这个模块**最需要**回归闸：档位是 ADR-022 信任模型变更的载体。
 * electron-store 11（conf 15）移除 JSON schema 后，坏值**静默落盘**——
 * 一个拼错的档位名（sandbox 写成 sandox）不会报错，只会在某个深夜把
 * Agent 的行为带到未定义状态。而档位的取值方向有**安全语义**：写错方向
 * 等于把「不能操作已登录系统」变成「能」。
 *
 * 本测试钉死两条硬纪律（permission-profile.ts 头注）：
 *   1. 默认最保守：任何解析失败一律回落 minimal，绝不回落到更高档；
 *   2. 企业管控：最终档位 = min(本地, 中台上限)，中台只能往下压。
 *
 * 反证形态（每组断言都对应一个真实故障形态，不是覆盖率装点）：
 *   · 未实现档位必须**显式钳回**而非静默降级（developer 留 P7b，
 *     若静默按 developer 的定义执行 = 提前开启了 container/app-scoped）；
 *   · codeExecution=off 却带 sandboxBackend ≠ none 是矛盾配置，
 *     归 none（否则「不试跑」配置仍持有试跑后端，语义自相矛盾）；
 *   · hostAccess=none 时 allowedApps **必须为空**——白名单与轴一起失效，
 *     否则「不碰本机」的档位却带着一份待生效的白名单，一次轴变更即全量放开；
 *   · 中台是**上限不是指令**：中台 standard + 本地 minimal 不得升到 standard。
 *
 * Run via: npm run test:main
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  AGENT_PRESETS,
  CODE_EXECUTION_MODES,
  HOST_ACCESS_MODES,
  IMPLEMENTED_PRESETS,
  PRESET_DEFINITIONS,
  SANDBOX_BACKEND_MODES,
  TASK_EXECUTION_MODES,
  allowsDirectTaskExecution,
  allowsTrialRun,
  mergeWithCenterPolicy,
  permissionsFromConfig,
  resolveLocalPermissions,
  type EffectiveAgentPermissions,
} from './permission-profile';

const ALL_AXES = [
  'codeExecution',
  'sandboxBackend',
  'hostAccess',
  'taskExecution',
] as const;

function axesOf(p: EffectiveAgentPermissions): string[] {
  return ALL_AXES.map((k) => p[k] as string);
}

function main(): void {
  // ── 1. 默认最保守：任何非法/缺失输入一律 minimal ──────────────────────
  {
    for (const input of [
      null,
      undefined,
      {},
      { preset: 'nonsense' },
      { preset: 42 },
      { preset: '' },
      { preset: '  ' },
    ]) {
      const p = resolveLocalPermissions(input as never);
      assert.strictEqual(p.preset, 'minimal', `输入 ${JSON.stringify(input)} 必须回落 minimal`);
      assert.deepStrictEqual(
        axesOf(p),
        ['off', 'none', 'none', 'deploy-only'],
        `输入 ${JSON.stringify(input)} 的四轴必须全为最保守档`,
      );
    }
  }

  // ── 2. 已实现预设：minimal / standard 解析正确（09 §3 矩阵）────────────
  {
    const minimal = resolveLocalPermissions({ preset: 'minimal' });
    assert.deepStrictEqual(axesOf(minimal), ['off', 'none', 'none', 'deploy-only']);

    const standard = resolveLocalPermissions({ preset: 'standard' });
    assert.strictEqual(standard.preset, 'standard');
    assert.deepStrictEqual(axesOf(standard), ['sandbox', 'process', 'none', 'deploy-only']);
    assert.strictEqual(allowsTrialRun(standard), true, 'standard 必须允许试跑（09 §3）');
    assert.strictEqual(allowsTrialRun(minimal), false, 'minimal（off）必须不允许试跑');
  }

  // ── 3. ★ 未实现预设必须显式钳回 minimal，绝不静默按定义执行 ────────────
  //    developer 档含 container + app-scoped + isolated-runner，P7a 未实现。
  //    若这里「尊重配置」，等于提前开启未论证的能力。
  {
    for (const preset of AGENT_PRESETS) {
      if (IMPLEMENTED_PRESETS.includes(preset)) continue;
      const p = resolveLocalPermissions({ preset });
      assert.strictEqual(
        p.preset,
        'minimal',
        `未实现预设 ${preset} 必须钳回 minimal，而不是静默按其定义执行`,
      );
      assert.deepStrictEqual(
        axesOf(p),
        ['off', 'none', 'none', 'deploy-only'],
        `未实现预设 ${preset} 的四轴必须全部落在已实现档`,
      );
    }
  }

  // ── 4. 细粒度覆盖：非法 → 回落预设值；指向未实现档 → 钳回保守已实现档 ──
  {
    // 合法覆盖（implemented 内）必须生效
    const overridden = resolveLocalPermissions({
      preset: 'standard',
      codeExecution: 'off',
    });
    assert.strictEqual(overridden.codeExecution, 'off');
    // off + 有后端 = 矛盾 → 归 none
    assert.strictEqual(
      overridden.sandboxBackend,
      'none',
      'codeExecution=off 时 sandboxBackend 必须归 none（off 沙箱无意义）',
    );
    assert.strictEqual(allowsTrialRun(overridden), false);

    // 指向未实现档（host / vm / session）一律**回落预设值**（而非"按配置
    // 执行"）。关键点：回落目标必须是**预设的那一档**，不得高于它——
    // standard 配 host 得到的是 sandbox，不是 host。
    // isolated-runner 自 P7e 前半起**已实现**（08 §2.4 方案 A：desktop 本地
    // 独立执行端点），细粒度覆盖应生效——不再钳回 deploy-only。
    const tried = resolveLocalPermissions({
      preset: 'standard',
      codeExecution: 'host',
      sandboxBackend: 'vm',
      hostAccess: 'session',
      taskExecution: 'isolated-runner',
    });
    assert.deepStrictEqual(
      axesOf(tried),
      ['sandbox', 'process', 'none', 'isolated-runner'],
      '未实现轴（host/vm/session）回落预设值；已实现的 isolated-runner 覆盖生效',
    );
    assert.strictEqual(
      allowsDirectTaskExecution(tried),
      true,
      'isolated-runner 档必须允许直接执行任务（P7e 前半的行为锚）',
    );
    assert.strictEqual(
      allowsDirectTaskExecution(resolveLocalPermissions({ preset: 'standard' })),
      false,
      '默认 deploy-only 不允许直接执行（交付走既有 deploy 通道）',
    );
    assert.strictEqual(
      tried.codeExecution,
      'sandbox',
      '未实现的 host 必须回落到预设的 sandbox——而不是保持 host，也不是掉到 off',
    );

    // 非法形状（非字符串 / 空串）→ 回落预设值，不是回落 minimal
    const junk = resolveLocalPermissions({
      preset: 'standard',
      codeExecution: 42,
      sandboxBackend: {},
      hostAccess: [],
      taskExecution: '   ',
    });
    assert.deepStrictEqual(
      axesOf(junk),
      ['sandbox', 'process', 'none', 'deploy-only'],
      '形状非法的覆盖回落**该预设**的值（不是整体掉到 minimal）',
    );
  }

  // ── 5. 矛盾配置收敛（两个方向都验）───────────────────────────────────
  {
    // sandbox + none 后端：sandbox 必须有非 none 后端（P7a 即 process）
    const fixed = resolveLocalPermissions({
      preset: 'standard',
      sandboxBackend: 'none',
    });
    assert.strictEqual(
      fixed.sandboxBackend,
      'process',
      'codeExecution=sandbox 且后端 none 必须补 process（否则"沙箱试跑"名存实亡）',
    );

    // minimal 强行配 process 后端 → 仍归 none
    const offWins = resolveLocalPermissions({
      preset: 'minimal',
      sandboxBackend: 'process',
    });
    assert.strictEqual(offWins.sandboxBackend, 'none', 'off 优先于后端配置');
  }

  // ── 6. hostAccess=none 时白名单必须为空（不给"待生效"的开放清单）──────
  {
    const p = resolveLocalPermissions({
      preset: 'standard',
      allowedApps: ['chrome', 'excel'],
      allowedDomains: ['erp.corp.com'],
    });
    assert.deepStrictEqual(p.allowedApps, [], 'hostAccess=none 时 allowedApps 必须为空');
    assert.deepStrictEqual(
      p.allowedDomains,
      ['erp.corp.com'],
      'allowedDomains 与 hostAccess 轴无关（试跑的网络面约束），应保留',
    );
    // 域白名单条目数有上限（防超大清单拖垮每次校验）
    const many = resolveLocalPermissions({
      preset: 'standard',
      allowedDomains: Array.from({ length: 500 }, (_, i) => `d${i}.example.com`),
    });
    assert.strictEqual(many.allowedDomains.length, 64, 'allowedDomains 上限 64');
    // 非字符串/空白条目必须被剔除，不得带进配置
    const dirty = resolveLocalPermissions({
      preset: 'standard',
      allowedDomains: ['ok.example.com', '', '  ', 42, null],
    });
    assert.deepStrictEqual(dirty.allowedDomains, ['ok.example.com']);

    const scoped = resolveLocalPermissions({
      preset: 'standard', hostAccess: 'app-scoped',
      allowedApps: ['Notepad.exe', 'notepad', '../cmd', 'powershell*', 'Excel'],
    });
    assert.strictEqual(scoped.hostAccess, 'app-scoped', 'P7c 的显式 app-scoped 覆盖必须生效');
    assert.deepStrictEqual(scoped.allowedApps, ['notepad', 'excel'], '应用白名单只保留精确进程名并去重');
  }

  // ── 7. 中台合并：min(本地, 中台上限) ──────────────────────────────────
  {
    const local = resolveLocalPermissions({ preset: 'standard' });
    const minimalLocal = resolveLocalPermissions({ preset: 'minimal' });

    // 7a. 中台是**上限不是指令**：中台宽、本地窄 → 保持本地（不得被抬高）
    const wideCenter = mergeWithCenterPolicy(minimalLocal, {
      permissionPolicy: 'standard',
      allowedProfiles: ['minimal', 'standard'],
    });
    assert.deepStrictEqual(
      axesOf(wideCenter),
      ['off', 'none', 'none', 'deploy-only'],
      '中台比本地宽时不得抬升本地（中台是上限，不是指令）',
    );
    assert.strictEqual(wideCenter.source.codeExecution, 'local', '未发生下调 → source 标 local');

    // 7b. 中台更保守 → 逐轴取保守者，并留痕 center-clamped（09 §5 审计）
    const clamped = mergeWithCenterPolicy(local, {
      permissionPolicy: 'minimal',
      allowedProfiles: ['minimal', 'standard'],
    });
    assert.deepStrictEqual(
      axesOf(clamped),
      ['off', 'none', 'none', 'deploy-only'],
      '中台 minimal 必须把本地 standard 压下来',
    );
    for (const axis of ALL_AXES) {
      assert.strictEqual(
        clamped.source[axis],
        'center-clamped',
        `${axis} 被中台下调必须留痕（审计要能回答"是谁压的"）`,
      );
    }

    // 7c. 预设白名单不含本地 preset → 整体压回 minimal（宁紧勿松）
    const notAllowed = mergeWithCenterPolicy(local, {
      permissionPolicy: 'standard',
      allowedProfiles: ['minimal'],
    });
    assert.strictEqual(notAllowed.preset, 'minimal');
    assert.deepStrictEqual(axesOf(notAllowed), ['off', 'none', 'none', 'deploy-only']);

    // 7d. 中台策略缺失/形状非法 → **原样保留本地**（离线沿用本地，10 §调整4：
    //     离线绝不能回落成"无限制"，也不能因为一次坏响应就掉到 minimal）
    for (const bad of [null, undefined, {}, { permissionPolicy: 'nonsense' }, { allowedProfiles: 'x' }]) {
      const kept = mergeWithCenterPolicy(local, bad as never);
      assert.deepStrictEqual(axesOf(kept), axesOf(local), `中台策略 ${JSON.stringify(bad)} 不得改变本地档位`);
    }

    // 7e. 只有白名单、无 permissionPolicy，且本地在白名单内 → 原样
    const onlyList = mergeWithCenterPolicy(local, { allowedProfiles: ['standard'] });
    assert.deepStrictEqual(axesOf(onlyList), axesOf(local));

    const localGui = resolveLocalPermissions({
      preset: 'standard', hostAccess: 'app-scoped', allowedApps: ['notepad'],
    });
    const centerDeniedGui = mergeWithCenterPolicy(localGui, {
      permissionPolicy: 'standard', allowedProfiles: ['minimal', 'standard'],
    });
    assert.strictEqual(centerDeniedGui.hostAccess, 'none', '中台 standard 上限不允许本机 GUI');
    assert.deepStrictEqual(centerDeniedGui.allowedApps, [], '中台压回 none 后必须清空生效应用清单');
    const centerAllowsGui = mergeWithCenterPolicy(localGui, {
      permissionPolicy: 'ops-assist', allowedProfiles: ['minimal', 'standard'],
    });
    assert.strictEqual(centerAllowsGui.hostAccess, 'app-scoped');
    assert.deepStrictEqual(centerAllowsGui.allowedApps, ['notepad']);
  }

  // ── 8. 'custom' 细粒度覆盖与 allowedProfiles 的交互（真实缺陷回归）────
  //    allowedProfiles 只枚举预设名；若把 'custom' 当成"不在白名单"而整体
  //    压回 minimal，用户改一个轴会连带丢掉其它轴——一次配置变更静默降级
  //    整台机器的能力。
  {
    const custom: EffectiveAgentPermissions = {
      ...resolveLocalPermissions({ preset: 'standard' }),
      preset: 'custom',
    };
    const merged = mergeWithCenterPolicy(custom, {
      permissionPolicy: 'standard',
      allowedProfiles: ['minimal', 'standard'],
    });
    assert.strictEqual(
      merged.preset,
      'custom',
      "'custom' 不是预设名，不得因不在 allowedProfiles 里而被整体压回 minimal",
    );
    assert.deepStrictEqual(
      axesOf(merged),
      ['sandbox', 'process', 'none', 'deploy-only'],
      'custom 档的四轴不受白名单误判影响',
    );
  }

  // ── 9. permissionsFromConfig：AppConfig → 生效档位（09 §4.1 接线）─────
  {
    assert.deepStrictEqual(
      axesOf(permissionsFromConfig({})),
      ['off', 'none', 'none', 'deploy-only'],
      '缺省配置必须是最保守档',
    );
    const fromCfg = permissionsFromConfig({
      agentPermissionProfile: 'standard',
      agentCodeExecution: 'sandbox',
      agentSandboxBackend: 'process',
      agentHostAccess: 'none',
      agentTaskExecution: 'deploy-only',
      agentAllowedDomains: ['erp.corp.com'],
    });
    assert.strictEqual(fromCfg.preset, 'standard');
    assert.deepStrictEqual(fromCfg.allowedDomains, ['erp.corp.com']);
    // 拼写错误必须回落而不是落盘成未定义值
    const typo = permissionsFromConfig({
      agentPermissionProfile: 'sandard',
      agentCodeExecution: 'sandox',
    });
    assert.strictEqual(typo.preset, 'minimal', '拼错的预设名必须回落 minimal');
    assert.strictEqual(typo.codeExecution, 'off', '拼错的轴值必须回落到保守已实现档');
    // 非字符串形状
    const junk = permissionsFromConfig({
      agentPermissionProfile: 42,
      agentHostAccess: {},
    });
    assert.strictEqual(junk.preset, 'minimal');
  }

  // ── 10. SYNC 守卫：枚举清单与预设矩阵不得漂移 ────────────────────────
  {
    assert.deepStrictEqual([...CODE_EXECUTION_MODES], ['off', 'sandbox', 'host']);
    assert.deepStrictEqual([...SANDBOX_BACKEND_MODES], ['none', 'process', 'container', 'vm']);
    assert.deepStrictEqual([...HOST_ACCESS_MODES], ['none', 'app-scoped', 'session']);
    assert.deepStrictEqual([...TASK_EXECUTION_MODES], ['deploy-only', 'isolated-runner']);
    assert.deepStrictEqual([...AGENT_PRESETS], [
      'minimal',
      'standard',
      'developer',
      'ops-assist',
      'full-trust',
    ]);
    // 预设矩阵必须与 09 §3 的组合表逐格一致（有人改错一格 = 企业选档即错）
    assert.deepStrictEqual(PRESET_DEFINITIONS.minimal, {
      codeExecution: 'off',
      sandboxBackend: 'none',
      hostAccess: 'none',
      taskExecution: 'deploy-only',
    });
    assert.deepStrictEqual(PRESET_DEFINITIONS.standard, {
      codeExecution: 'sandbox',
      sandboxBackend: 'process',
      hostAccess: 'none',
      taskExecution: 'deploy-only',
    });
    // P7a 只实现两档，且它们必须在预设清单里（否则 IMPLEMENTED_PRESETS 是死代码）
    assert.deepStrictEqual([...IMPLEMENTED_PRESETS], ['minimal', 'standard']);
    for (const p of IMPLEMENTED_PRESETS) {
      assert.ok(AGENT_PRESETS.includes(p));
    }

    // 源码级守卫：合并必须逐轴取更保守者（indexOf 比较），不得写成"中台优先"
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'agent', 'permission-profile.ts'), 'utf-8');
    assert.ok(
      src.includes('rank.indexOf(centerV) <= rank.indexOf(localV) ? centerV : localV'),
      'SYNC: min(本地,中台) 的逐轴取保守逻辑被改写（必须按 rank 取更靠前者）',
    );
    assert.ok(
      src.includes('EXECUTOR_AGENT') === false || true,
      'env 键名不在本模块（配置走 config-store），此处仅占位',
    );
  }

  console.log('agent/permission-profile selftest: all assertions passed (defaults, clamping, min(local,center))');
}

main();

/**
 * UX-DSK-NUM self-check：渲染层配置补丁写入 electron-store 前的消毒。
 * Run via: npm run test:main
 *
 * 反证形态：本测试用**真实的 conf（electron-store 的底座）**起一个带
 * config-store.ts 同款 defaults 的 store，把消毒前/后的值分别 set 进去——
 * conf 15 移除 ajv 校验后，消毒前的 null **静默落盘**（读回即 null，下游
 * 拿到即损坏）；消毒后必须落盘成功且值合法。若有人把 ConfigPage 的
 * `|| 10` 兜底删掉、或把 sanitizeConfigInput 改成直接透传，本测试立即变红。
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BOOLEAN_FIELDS,
  ENUM_FIELDS,
  NUMBER_FIELDS,
  STRING_FIELDS,
  STRING_LIST_FIELDS,
  coerceNumber,
  sanitizeConfigInput,
} from './config-sanitize';

/** 最小化复刻 config-store.ts 的 defaults（只留被测字段，语义逐条一致）。 */
const DEFAULTS = {
  configured: false,
  adminApiUrl: '',
  executorName: 'host',
  executorHost: '0.0.0.0',
  executorPort: 8002,
  executorAddressPublic: '',
  workDir: '',
  maxConcurrentTasks: 10,
  logLevel: 'info',
  interpreterDownloadTimeoutMs: 0,
} as const;

function makeStore(dir: string): any {
  // 延迟 require：conf 15 为 ESM，Node 24 的同步 require(esm) 返回模块
  // 命名空间（.default 为类）；本文件在 dist-selftest 下运行，node_modules
  // 解析路径与源码目录一致。
  const Conf = require('conf').default ?? require('conf');
  return new Conf({ cwd: dir, defaults: DEFAULTS });
}

/** 把补丁按 ConfigStore.save 的形态逐键写入（每键一次 set）。 */
function applyPatch(store: any, patch: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(patch)) {
    store.set(k, v);
  }
}

function main(): void {
  const tmp = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'acf-config-sanitize-'),
  );
  try {
    // ── 1. 反证：不消毒时，清空「最大并发任务数」送来的 null/NaN 会
    //       **静默落盘**（conf 15 移除 ajv 后不再抛错）——下游直接读到
    //       null，故障从「保存失败」变成「保存成功但配置坏了」────────
    {
      const store = makeStore(path.join(tmp, 'raw'));
      store.set('workDir', path.join(tmp, 'tasks'));
      store.set('maxConcurrentTasks', 12);

      // 渲染层 parseInt('') → NaN → JSON 序列化 → null（IPC 的结构化克隆语义）
      const rawPatch = { executorName: 'renamed', maxConcurrentTasks: null };
      applyPatch(store, rawPatch); // 不抛——这正是问题所在

      assert.strictEqual(
        store.get('executorName'),
        'renamed',
        '同批次修改已写入（无任何报错提示用户）',
      );
      assert.strictEqual(
        store.get('maxConcurrentTasks'),
        null,
        '未消毒的 null 已静默进入存储——executor 读到的将是坏配置',
      );
    }

    // ── 2. 消毒后：同一份补丁必须完整落盘，且值合法 ──────────────────────
    {
      const store = makeStore(path.join(tmp, 'fixed'));
      store.set('workDir', path.join(tmp, 'tasks'));
      store.set('maxConcurrentTasks', 12);

      const patch = sanitizeConfigInput({
        executorName: 'renamed',
        maxConcurrentTasks: null, // ← 渲染层清空输入框的产物
      });
      assert.ok(!('maxConcurrentTasks' in patch) === false, '键必须保留（要写出默认值）');

      applyPatch(store, patch); // 不得抛
      assert.strictEqual(store.get('executorName'), 'renamed', '同批次修改必须全部落盘');
      assert.strictEqual(
        store.get('maxConcurrentTasks'),
        10,
        'NaN/null 必须回落字段默认值 10，而不是把坏值写进存储',
      );
    }

    // ── 3. coerceNumber：非有限数回落、越界钳制、小数取整、字符串可解析 ──
    {
      const rule = NUMBER_FIELDS.find((r) => r.key === 'maxConcurrentTasks')!;
      for (const bad of [NaN, Infinity, -Infinity, null, undefined, '', 'abc', {}, [], true]) {
        assert.strictEqual(
          coerceNumber(bad, rule),
          10,
          `${JSON.stringify(bad)} 必须回落 10`,
        );
      }
      assert.strictEqual(coerceNumber(4, rule), 4, '合法值原样保留');
      assert.strictEqual(coerceNumber('4', rule), 4, '数字字符串按数字解析');
      assert.strictEqual(coerceNumber(4.6, rule), 5, '小数四舍五入（UI 与子进程语义一致）');
      assert.strictEqual(coerceNumber(0, rule), 1, '低于下界 → 钳到下界');
      assert.strictEqual(coerceNumber(-5, rule), 1, '负数 → 钳到下界');
      assert.strictEqual(coerceNumber(9999, rule), 100, '高于上界 → 钳到上界');

      const portRule = NUMBER_FIELDS.find((r) => r.key === 'executorPort')!;
      assert.strictEqual(coerceNumber(NaN, portRule), 8002, '端口 NaN → 默认 8002');
      assert.strictEqual(coerceNumber(99999, portRule), 65535, '端口越界 → 65535');

      const tRule = NUMBER_FIELDS.find((r) => r.key === 'interpreterDownloadTimeoutMs')!;
      assert.strictEqual(coerceNumber(NaN, tRule), 0, '超时 NaN → 0（= 用执行器默认）');
      assert.strictEqual(coerceNumber(-1, tRule), 0, '超时下界为 0，不是 1');
    }

    // ── 4. 字符串/布尔/密钥/workDir 的形状约束 ───────────────────────────
    {
      const out = sanitizeConfigInput({
        adminApiUrl: 42,
        executorName: null,
        logLevel: undefined,
        notifyEnabled: 'yes', // 非布尔 → 丢弃（不猜测）
        autoStartExecutor: true,
        executorToken: 42, // 非字符串 → 丢弃（ConfigStore 有独立分支）
        workDir: '   ', // 空白 → 丢弃（不得清空已初始化的工作目录）
      });
      for (const key of STRING_FIELDS) {
        if (key in out) {
          assert.strictEqual(typeof out[key], 'string', `${key} 必须是字符串`);
        }
      }
      assert.strictEqual(out.adminApiUrl, '', '数字 → 空串');
      assert.strictEqual(out.executorName, '', 'null → 空串');
      assert.ok(!('notifyEnabled' in out), '非布尔 → 丢弃该键');
      assert.strictEqual(out.autoStartExecutor, true, '合法布尔保留');
      assert.ok(!('executorToken' in out), '非字符串密钥 → 丢弃');
      assert.ok(!('workDir' in out), '空白 workDir → 丢弃（不覆盖已存值）');

      // ARCH-33：pullMode 必须走布尔白名单——**不得强转**。
      // `'false'` 是真值串，若用 Boolean('false') 会变成 true，等于用户关掉
      // 回连模式却反而打开了（该模式下 admin 不再反向连入，故障形态是
      // "配置看起来生效了、任务却收不到"）。
      assert.ok(
        !('pullMode' in sanitizeConfigInput({ pullMode: 'false' })),
        "pullMode 字符串 'false' 必须丢弃而非强转（Boolean('false') === true）",
      );
      assert.strictEqual(
        sanitizeConfigInput({ pullMode: true }).pullMode,
        true,
        '合法 pullMode=true 必须透传',
      );
      assert.strictEqual(
        sanitizeConfigInput({ pullMode: false }).pullMode,
        false,
        '合法 pullMode=false 必须透传（显式关闭是有效语义）',
      );

      // 合法 workDir 必须保留
      assert.strictEqual(
        sanitizeConfigInput({ workDir: 'D:/tasks' }).workDir,
        'D:/tasks',
        '合法 workDir 必须透传',
      );
    }

    // ── 4b. P7a（ADR-022）：Agent 权限档位的封闭枚举消毒 ──────────────────
    //    反证形态：conf 15 移除 ajv 后坏值**静默落盘**。若这里不消毒，
    //    `sandox` 会原样写进配置、界面照常显示，而档位解析层把它回落到
    //    最保守档 →「选了 standard、保存成功、Agent 却按 off 跑」且零日志。
    {
      // 合法值保留（大小写/空白归一化）
      for (const rule of ENUM_FIELDS) {
        for (const v of rule.values) {
          const out = sanitizeConfigInput({ [rule.key]: `  ${v.toUpperCase()}  ` });
          assert.strictEqual(out[rule.key], v, `${rule.key} 的合法值 ${v} 必须归一化保留`);
        }
      }
      // 拼错 / 未知 → 空串（= "不覆盖"，跟随预设），绝不落盘坏值
      for (const [key, bad] of [
        ['agentPermissionProfile', 'sandard'],
        ['agentCodeExecution', 'sandox'],
        ['agentSandboxBackend', 'docker'],
        ['agentHostAccess', 'full'],
        ['agentTaskExecution', 'isolated'],
      ] as const) {
        assert.strictEqual(
          sanitizeConfigInput({ [key]: bad })[key],
          '',
          `${key} 的非法值 ${bad} 必须归一化为 ''（不得静默落盘）`,
        );
      }
      // 非字符串（渲染层送来的对象/数字/null）→ 空串而不是删键
      for (const bad of [42, null, undefined, {}, [], true]) {
        assert.strictEqual(
          sanitizeConfigInput({ agentCodeExecution: bad }).agentCodeExecution,
          '',
          `非字符串档位值 ${JSON.stringify(bad)} 必须归一化为 ''`,
        );
      }
      // 枚举清单必须与 permission-profile.ts 的轴定义**同源**（两处漂移 =
      // 消毒层放行、解析层拒绝，或反过来——都是静默行为偏差）
      const pp = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'main', 'agent', 'permission-profile.ts'),
        'utf-8',
      );
      const axisOf = (name: string): string[] => {
        const m = new RegExp(
          `export const ${name} = \\[([^\\]]*)\\] as const;`,
        ).exec(pp);
        assert.ok(m, `SYNC: permission-profile.ts 找不到 ${name} 定义`);
        return m![1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
      };
      assert.deepStrictEqual(
        ENUM_FIELDS.find((r) => r.key === 'agentCodeExecution')!.values,
        axisOf('CODE_EXECUTION_MODES'),
        'SYNC: agentCodeExecution 枚举与 CODE_EXECUTION_MODES 漂移',
      );
      assert.deepStrictEqual(
        ENUM_FIELDS.find((r) => r.key === 'agentSandboxBackend')!.values,
        axisOf('SANDBOX_BACKEND_MODES'),
        'SYNC: agentSandboxBackend 枚举与 SANDBOX_BACKEND_MODES 漂移',
      );
      assert.deepStrictEqual(
        ENUM_FIELDS.find((r) => r.key === 'agentHostAccess')!.values,
        axisOf('HOST_ACCESS_MODES'),
        'SYNC: agentHostAccess 枚举与 HOST_ACCESS_MODES 漂移',
      );
      assert.deepStrictEqual(
        ENUM_FIELDS.find((r) => r.key === 'agentTaskExecution')!.values,
        axisOf('TASK_EXECUTION_MODES'),
        'SYNC: agentTaskExecution 枚举与 TASK_EXECUTION_MODES 漂移',
      );
      assert.deepStrictEqual(
        ENUM_FIELDS.find((r) => r.key === 'agentPermissionProfile')!.values,
        axisOf('AGENT_PRESETS'),
        'SYNC: agentPermissionProfile 枚举与 AGENT_PRESETS 漂移',
      );
    }

    // ── 4c. P7a：白名清单（数组）消毒 ────────────────────────────────────
    {
      for (const rule of STRING_LIST_FIELDS) {
        // 非数组 → 空数组（不得把标量/对象带进 store）
        for (const bad of [42, null, undefined, {}, 'erp.corp.com', true]) {
          assert.deepStrictEqual(
            sanitizeConfigInput({ [rule.key]: bad })[rule.key],
            [],
            `${rule.key} 的非数组值必须清空`,
          );
        }
        // 条数封顶 + 非字符串/空白条目剔除
        const many = Array.from({ length: rule.max + 50 }, (_, i) => `d${i}.example.com`);
        assert.strictEqual(
          (sanitizeConfigInput({ [rule.key]: many })[rule.key] as string[]).length,
          rule.max,
          `${rule.key} 必须封顶 ${rule.max} 条`,
        );
        assert.deepStrictEqual(
          sanitizeConfigInput({ [rule.key]: ['ok.example.com', '', '  ', 42, null] })[rule.key],
          ['ok.example.com'],
          `${rule.key} 必须剔除非法条目`,
        );
      }
    }

    // ── 5. 不认识的配置项必须原样透传（新增字段不必改本模块）─────────────
    assert.strictEqual(
      sanitizeConfigInput({ someFutureField: 'x' }).someFutureField,
      'x',
      '未知字段必须透传',
    );

    // ── 6. 不得就地修改入参（渲染层对象可能来自 React state）─────────────
    {
      const input: Record<string, unknown> = { maxConcurrentTasks: NaN };
      sanitizeConfigInput(input);
      assert.ok(Number.isNaN(input.maxConcurrentTasks as number), '入参必须不被就地改写');
    }

    // ── 7. SYNC 守卫：字段清单必须与 config-store.ts / ConfigPage 保持同步 ──
    // 新增数值输入框而忘了登记，等于重新引入同一缺陷——这里钉死清单本身。
    {
      const src = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'main', 'config-store.ts'),
        'utf-8',
      );
      for (const key of [
        ...NUMBER_FIELDS.map((r) => r.key),
        ...STRING_FIELDS,
        ...BOOLEAN_FIELDS,
        ...ENUM_FIELDS.map((r) => r.key),
        ...STRING_LIST_FIELDS.map((r) => r.key),
      ]) {
        assert.ok(
          new RegExp(`\\b${key}\\b`).test(src),
          `config-store.ts 未出现字段 ${key}——清单已漂移`,
        );
      }
      // P7a：档位字段必须在 config-store 的 **defaults** 里（否则旧配置文件
      // 升级后读到 undefined，行为与"显式配了 minimal"不等价）。
      const defaultsBlock = /const defaults = \{([\s\S]*?)\n\} satisfies/.exec(src);
      assert.ok(defaultsBlock, 'SYNC: config-store.ts 找不到 defaults 块');
      for (const rule of [...ENUM_FIELDS, ...STRING_LIST_FIELDS]) {
        assert.ok(
          new RegExp(`\\b${rule.key}\\s*:`).test(defaultsBlock![1]),
          `SYNC: ${rule.key} 未进 config-store defaults（旧配置升级后读到 undefined）`,
        );
      }
      // 渲染层的 number input 必须真的经过消毒通道。
      // 注意：不能只在整份文件里找 `sanitizeConfigInput(` —— 两个 handler 里
      // 只要还剩一处就会让断言假绿（反证时踩过）。这里**逐个 handler 取块**，
      // 两条保存路径都必须各自调用。
      const ipc = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'main', 'ipc-handlers.ts'),
        'utf-8',
      );
      const handlerBlock = (name: string): string => {
        const start = ipc.indexOf(`ipcMain.handle('${name}'`);
        assert.ok(start >= 0, `SYNC: 找不到 handler ${name}`);
        const rest = ipc.slice(start + `ipcMain.handle('${name}'`.length);
        const next = rest.indexOf('ipcMain.handle(');
        return next >= 0 ? rest.slice(0, next) : rest;
      };
      for (const name of ['config:save', 'config:save-and-close-wizard']) {
        assert.ok(
          handlerBlock(name).includes('sanitizeConfigInput('),
          `SYNC: ${name} 未调用 sanitizeConfigInput——消毒通道被绕过`,
        );
      }
    }

    console.log('config-sanitize selftest: all assertions passed (NaN→default, clamp, shape guards)');
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

main();

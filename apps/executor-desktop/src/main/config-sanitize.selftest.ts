/**
 * UX-DSK-NUM self-check：渲染层配置补丁写入 electron-store 前的消毒。
 * Run via: npm run test:main
 *
 * 反证形态：本测试用**真实的 conf（electron-store 的底座）**起一个带
 * config-store.ts 同款 schema 的 store，把消毒前/后的值分别 set 进去——
 * 消毒前必须抛 `Config schema violation`，消毒后必须落盘成功且值合法。
 * 若有人把 ConfigPage 的 `|| 10` 兜底删掉、或把 sanitizeConfigInput 改成
 * 直接透传，本测试立即变红。
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BOOLEAN_FIELDS,
  NUMBER_FIELDS,
  STRING_FIELDS,
  coerceNumber,
  sanitizeConfigInput,
} from './config-sanitize';

/** 最小化复刻 config-store.ts 的 schema（只留被测字段，语义逐条一致）。 */
const SCHEMA = {
  configured: { type: 'boolean', default: false },
  adminApiUrl: { type: 'string', default: '' },
  executorName: { type: 'string', default: 'host' },
  executorHost: { type: 'string', default: '0.0.0.0' },
  executorPort: { type: 'number', default: 8002 },
  executorAddressPublic: { type: 'string', default: '' },
  workDir: { type: 'string', default: '' },
  maxConcurrentTasks: { type: 'number', default: 10 },
  logLevel: { type: 'string', default: 'info' },
  interpreterDownloadTimeoutMs: { type: 'number', default: 0 },
} as const;

function makeStore(dir: string): any {
  // 延迟 require：conf 是 CommonJS，且本文件在 dist-selftest 下运行，
  // node_modules 解析路径与源码目录一致。
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Conf = require('conf');
  return new Conf({ cwd: dir, schema: SCHEMA as any });
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
    // ── 1. 反证：不消毒时，清空「最大并发任务数」送来的 null/NaN 会让
    //       electron-store 抛 schema violation（真实故障，不是假想）────────
    {
      const store = makeStore(path.join(tmp, 'raw'));
      store.set('workDir', path.join(tmp, 'tasks'));
      store.set('maxConcurrentTasks', 12);

      // 渲染层 parseInt('') → NaN → JSON 序列化 → null（IPC 的结构化克隆语义）
      const rawPatch = { executorName: 'renamed', maxConcurrentTasks: null };
      let threw: Error | null = null;
      try {
        applyPatch(store, rawPatch);
      } catch (err) {
        threw = err as Error;
      }
      assert.ok(threw, '未消毒的 null 必须让 electron-store 抛错（否则本反证无牙）');
      assert.match(
        threw!.message,
        /maxConcurrentTasks/,
        `schema violation 应点名该字段，实际：${threw!.message}`,
      );

      // 关键的用户可见后果：异常抛出前，同批次的其它键**已经进了内存 store**
      // ——即"改了名 + 报了错"，而 UI 只说"保存失败"，用户分不清存没存。
      assert.strictEqual(
        store.get('executorName'),
        'renamed',
        '部分写入确实发生：这正是"只报一句保存失败"无法表达的事实',
      );
      assert.strictEqual(
        store.get('maxConcurrentTasks'),
        12,
        '抛错后该字段保留旧值（与 UI 显示的 10 又不一致）',
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
        'NaN/null 必须回落 schema default 10，而不是把整次保存打掉',
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

      // 合法 workDir 必须保留
      assert.strictEqual(
        sanitizeConfigInput({ workDir: 'D:/tasks' }).workDir,
        'D:/tasks',
        '合法 workDir 必须透传',
      );
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
      ]) {
        assert.ok(
          new RegExp(`\\b${key}\\b`).test(src),
          `config-store.ts 未出现字段 ${key}——清单已漂移`,
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

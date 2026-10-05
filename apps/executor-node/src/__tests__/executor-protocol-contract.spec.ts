import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CALLBACK_FAILURE_REASONS } from '../callback';
// 本轮协议 SSOT 补全：回调载荷 schema 与 secrets 键名闸的运行时对账
import { CallbackPayloadSchema } from '../generated/protocol.schemas';
import { isInjectableSecretName } from '../secret-env';
import { pageLogLines } from '../routes/logs';

/**
 * A3（DEEP_REVIEW 0ef3bbe §七）：executor-node 侧对 `executor-protocol` 的断言。
 *
 * 三端加载同一份 `packages/executor-protocol/protocol.json`——此前这些一致性只
 * 靠两侧注释互相引用维持（"见 node execute.ts:xxx parity" / "python 侧同步"）。
 */
const PROTOCOL_RELATIVE = path.join(
  'packages',
  'executor-protocol',
  'protocol.json',
);

function findRepoRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 12; i++) {
    if (existsSync(path.join(dir, PROTOCOL_RELATIVE))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error(`executor-protocol/protocol.json not found above ${from}`);
}

const protocol = JSON.parse(
  readFileSync(path.join(findRepoRoot(__dirname), PROTOCOL_RELATIVE), 'utf-8'),
);

const sortStr = (xs: readonly string[]) => [...xs].sort();

describe('A3 执行器协议契约（executor-node 侧）', () => {
  it('契约文件可达（守卫：路径解析失败会让下面所有断言变成假绿）', () => {
    expect(protocol.$schemaVersion).toBeGreaterThan(0);
  });

  describe('failureReason', () => {
    it('可上报集合与契约逐值一致（此前只有类型，运行期无从校验）', () => {
      // 一个非法取值会让 admin 的 @IsIn 拒掉**整批**回调——所以这里必须是
      // 运行期可断言的常量，而不是只存在于编译期的联合类型。
      expect(sortStr(CALLBACK_FAILURE_REASONS)).toEqual(
        sortStr(protocol.failureReason.executorReportable),
      );
    });

    it('不得包含 admin 内部专用的取值', () => {
      for (const internal of protocol.failureReason.adminInternalOnly) {
        expect(CALLBACK_FAILURE_REASONS).not.toContain(internal);
      }
    });
  });

  describe('timeout', () => {
    it('0 = 显式不限时（不得当 falsy 回退默认值，也不是 0ms 立即超时）', () => {
      const zero = protocol.timeout.vectors.find(
        (v: { name: string }) => v.name === 'zero-is-unbounded',
      );
      expect(zero).toMatchObject({ declared: 0, unbounded: true });
      // node execute.ts: `rawTimeout === 0 ? 0 : rawTimeout || default`
      // ——本断言是这条「0 能穿过 or-链」语义的回归守卫。
      const parse = (raw: number | undefined, def: number) =>
        raw === 0 ? 0 : raw || def;
      expect(parse(0, 300)).toBe(0);
      expect(parse(undefined, 300)).toBe(300);
    });
  });

  describe('readiness', () => {
    it('状态码与 status 值域与契约一致', () => {
      expect(protocol.readiness.statusValues).toEqual(['ready', 'not_ready']);
      expect(protocol.readiness.ready.httpStatus).toBe(200);
      expect(protocol.readiness.notReady.httpStatus).toBe(503);
    });

    it('契约记录的执行器侧落点是 /health/ready 且无信封', () => {
      const self = protocol.readiness.perComponent['executor-node'];
      expect(self.path).toBe('/health/ready');
      expect(self.bodyPath).toBe('');
    });
  });

  // -----------------------------------------------------------------------
  // 本轮协议 SSOT 补全：CallbackPayload（执行器→admin 回调载荷）
  // -----------------------------------------------------------------------

  describe('CallbackPayload schema', () => {
    it('failureReason 枚举与 executorReportable 逐值一致（两份字面量不许漂移）', () => {
      const schemaEnum: string[] =
        protocol.schemas.CallbackPayload.properties.failureReason.enum;
      expect(sortStr(schemaEnum)).toEqual(
        sortStr(protocol.failureReason.executorReportable),
      );
      // admin 内部专用取值不在发送端枚举里
      for (const internal of protocol.failureReason.adminInternalOnly) {
        expect(schemaEnum).not.toContain(internal);
      }
    });

    it('全部 executorReportable 分支过生成的 schema；adminInternalOnly 全被拒', () => {
      // **全枚举分支抽样**（与 python test_executor_protocol_contract.py 同款）：
      // 12 个可上报取值逐个 safeParse，一个非法取值会让 admin @IsIn 拒掉整批。
      for (const reason of protocol.failureReason.executorReportable) {
        const res = CallbackPayloadSchema.safeParse({
          executionId: 'exec-cb-enum',
          status: 'failed',
          failureReason: reason,
        });
        expect([reason, res.success]).toEqual([reason, true]);
      }
      for (const reason of protocol.failureReason.adminInternalOnly) {
        const res = CallbackPayloadSchema.safeParse({
          executionId: 'exec-cb-enum',
          status: 'failed',
          failureReason: reason,
        });
        expect([reason, res.success]).toEqual([reason, false]);
      }
    });

    it('node 真实回调载荷形态（8 个构造点的形状并集）过生成的 schema', () => {
      // execute.ts / task-worker.ts / pull.ts 各构造点的代表性形态——
      // 与 python 侧五处手拼字面量同批对账（schema 是同一份）。
      const samples = [
        // runTaskInner 成功
        {
          executionId: 'exec-cb-1',
          status: 'success',
          executorAddress: '10.0.0.5:9100',
          exitCode: 0,
          logs: 'done\n',
          durationMs: 1234,
        },
        // runTaskInner 失败（python 同场景发显式 null——schema 的 nullable 分歧收编）
        {
          executionId: 'exec-cb-2',
          status: 'failed',
          executorAddress: '10.0.0.5:9100',
          exitCode: null,
          logs: '',
          errorMessage: null,
          failureReason: 'runtime_missing',
          durationMs: 5000,
          result: { interpreter: { requested: '3.7', pool: [] } },
          artifacts: [
            { name: 'report.txt', size: 3, sha256: 'a'.repeat(64) },
          ],
          traceparent:
            '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        },
        // pushKilledCallbackOnce
        {
          executionId: 'exec-cb-3',
          status: 'failed',
          executorAddress: '10.0.0.5:9100',
          errorMessage: 'Execution killed by admin request',
          failureReason: 'killed',
        },
        // TaskWorker.stop / reject_pulled（无 executorAddress 也必须合法）
        {
          executionId: 'exec-cb-4',
          status: 'failed',
          errorMessage: 'Executor is shutting down before this execution started',
        },
      ];
      for (const sample of samples) {
        const res = CallbackPayloadSchema.safeParse(sample);
        expect(res.success ? 'ok' : res.error?.issues).toBe('ok');
      }
    });
  });

  // -----------------------------------------------------------------------
  // secrets（SEC-02 续）：键名白名单/保留名拒绝的运行时语义向量
  // -----------------------------------------------------------------------

  describe('secrets（SEC-02 续）', () => {
    const section = protocol.secrets;

    it('向量逐条对真实实现断言（isInjectableSecretName）', () => {
      // 键名规则不在 schemas.ExecuteRequest 里闸（非法键的线上语义是「静默跳过
      // 并 warn」而非 400，收进 schema 会改变线上行为）——这里是唯一共享闸。
      expect(section.onInvalidKey).toBe('skip-and-warn');
      expect(section.injection).toBe('original-name');
      const vectors = section.vectors;
      expect(vectors.length).toBeGreaterThanOrEqual(8);
      expect(vectors.some((v: { injectable: boolean }) => v.injectable)).toBe(true);
      expect(vectors.some((v: { injectable: boolean }) => !v.injectable)).toBe(true);
      for (const vec of vectors) {
        expect([vec.key, isInjectableSecretName(vec.key)]).toEqual([
          vec.key,
          vec.injectable,
        ]);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// A-11（P3）：params→env 的 JSON 序列化契约向量。
//
// 向量钉在 packages/contract-fixtures/contract.json 的
// executorEnvSerialization 段（append-only）：node JSON.stringify(v) 与 python
// json.dumps(v, ensure_ascii=False, separators=(',', ':')) 必须对同一载荷产出
// 逐字节相同的 AUTOFLOW_* env 值。python 侧的运行时注入断言见
// apps/executor-python/tests/test_audit_fixes.py。
// ---------------------------------------------------------------------------

describe('A-11 — executorEnvSerialization contract vectors (contract-fixtures)', () => {
  const CONTRACT_RELATIVE = path.join(
    'packages',
    'contract-fixtures',
    'contract.json',
  );

  it('JSON.stringify matches every pinned env byte vector', () => {
    let dir = __dirname;
    let contractPath: string | null = null;
    for (let i = 0; i < 12; i++) {
      const candidate = path.join(dir, CONTRACT_RELATIVE);
      if (existsSync(candidate)) {
        contractPath = candidate;
        break;
      }
      dir = path.dirname(dir);
    }
    expect(contractPath).not.toBeNull();
    const contract = JSON.parse(readFileSync(contractPath!, 'utf-8'));
    const vectors = contract.executorEnvSerialization?.vectors;
    expect(Array.isArray(vectors)).toBe(true);
    expect(vectors.length).toBeGreaterThan(0);
    for (const vector of vectors) {
      expect(JSON.stringify(vector.input)).toBe(vector.env);
    }
  });
});

// ---------------------------------------------------------------------------
// A-LOG（本轮协议补全）：日志行切分的共享契约向量。
//
// 向量钉在 packages/contract-fixtures/contract.json 的 executorLogLineSplitting
// 段（append-only）：同一段日志原始字节必须让 node pageLogLines（readline）与
// python get_execution_logs（文本模式逐行 + rstrip('\r\n')）产出逐行相同的
// lines[]。python 侧真实路由断言见 apps/executor-python/tests/test_logs.py。
// ---------------------------------------------------------------------------

describe('A-LOG — executorLogLineSplitting contract vectors (contract-fixtures)', () => {
  const CONTRACT_RELATIVE = path.join(
    'packages',
    'contract-fixtures',
    'contract.json',
  );

  function findContract(): Record<string, any> {
    let dir = __dirname;
    for (let i = 0; i < 12; i++) {
      const candidate = path.join(dir, CONTRACT_RELATIVE);
      if (existsSync(candidate)) {
        return JSON.parse(readFileSync(candidate, 'utf-8'));
      }
      dir = path.dirname(dir);
    }
    throw new Error(`contract-fixtures/contract.json not found above ${__dirname}`);
  }

  it('pageLogLines matches every pinned line-splitting vector', async () => {
    const contract = findContract();
    const vectors: Array<{ name: string; input: string; lines: string[] }> =
      contract.executorLogLineSplitting?.vectors;
    expect(Array.isArray(vectors)).toBe(true);
    expect(vectors.length).toBeGreaterThanOrEqual(5);
    // 反永真守卫：空输出样本必须在场（空文件 → 零行是分页终止条件）
    expect(vectors.some(v => v.input === '')).toBe(true);

    const dir = mkdtempSync(path.join(os.tmpdir(), 'acf-logsplit-'));
    try {
      for (const vector of vectors) {
        const file = path.join(dir, `${vector.name.replace(/[^a-z0-9-]/gi, '_')}.log`);
        writeFileSync(file, Buffer.from(vector.input, 'utf-8'));
        const page = await pageLogLines(file, 0, 2000);
        expect([vector.name, page.lines]).toEqual([vector.name, vector.lines]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

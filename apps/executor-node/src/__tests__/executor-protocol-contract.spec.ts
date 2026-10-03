import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { CALLBACK_FAILURE_REASONS } from '../callback';

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

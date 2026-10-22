/**
 * 工单 11（ADR-017 决策 §3 补全）：行 id 的本地持久化。
 *
 * 钉三件事：
 *   ① 注册响应里的 id 会被落盘，并能被读回来（跨进程重启后仍上报同一行）；
 *   ② 形态非法的值**不**落盘（防被污染的文件把脏值送进请求体/日志）；
 *   ③ 落盘失败不抛（best-effort：退回指纹/地址定位，绝不阻断注册）。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  __resetExecutorInstanceIdForTest,
  executorInstanceIdPath,
  getExecutorInstanceId,
  persistExecutorInstanceId,
  readPersistedExecutorInstanceId,
} from './executor-instance-id';

const ROW_ID = 'aabbccdd-1111-2222-3333-444455556666';

describe('executor instance id (工单 11)', () => {
  let workDir: string;
  // 显式传 workDir/kind（config.workDir 是只读 getter，且测试不该依赖环境）。
  const at = () => ({ workDir, kind: 'test' });

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-instance-id-'));
    __resetExecutorInstanceIdForTest();
  });

  afterEach(() => {
    __resetExecutorInstanceIdForTest();
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('persist → 落盘到 .device-identity/<kind>.instance，并可读回', () => {
    expect(persistExecutorInstanceId(ROW_ID, at())).toBe(ROW_ID);
    const file = executorInstanceIdPath(workDir, 'test');
    expect(fs.readFileSync(file, 'utf8')).toBe(ROW_ID);
    expect(getExecutorInstanceId(at())).toBe(ROW_ID);
    // 丢掉缓存后仍能从盘上读回（= 重启后继续上报同一行）
    __resetExecutorInstanceIdForTest();
    expect(getExecutorInstanceId(at())).toBe(ROW_ID);
  });

  it('形态非法（非 uuid 文本）→ 不落盘', () => {
    expect(persistExecutorInstanceId('../../etc/passwd', at())).toBeNull();
    expect(fs.existsSync(executorInstanceIdPath(workDir, 'test'))).toBe(false);
  });

  it('旧版中台响应没带 id（undefined）→ 静默跳过，不写盘', () => {
    expect(persistExecutorInstanceId(undefined, at())).toBeNull();
    expect(fs.existsSync(executorInstanceIdPath(workDir, 'test'))).toBe(false);
  });

  it('盘上是垃圾值 → 读回 null（视同未上报，而不是把脏值送出去）', () => {
    const file = executorInstanceIdPath(workDir, 'test');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'not-a-uuid');
    expect(readPersistedExecutorInstanceId(workDir, 'test')).toBeNull();
    expect(getExecutorInstanceId(at())).toBeNull();
  });

  it('落盘失败（目录被同名文件占住）→ 不抛，仍返回 id（best-effort）', () => {
    const file = executorInstanceIdPath(workDir, 'test');
    fs.mkdirSync(workDir, { recursive: true });
    // 把 .device-identity 造成**文件**，mkdirSync(recursive) 必然失败。
    fs.writeFileSync(path.dirname(file), 'blocking-file');
    expect(() => persistExecutorInstanceId(ROW_ID, at())).not.toThrow();
    expect(persistExecutorInstanceId(ROW_ID, at())).toBe(ROW_ID);
  });
});

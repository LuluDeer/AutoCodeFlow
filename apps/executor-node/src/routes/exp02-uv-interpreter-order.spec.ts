/**
 * EXP-02（本轮体验审查）：node 执行器把「uv 缺失」误归为 `unknown`，
 * 而 python 执行器在同一情形下报 `interpreter_unavailable`。
 *
 * 缺陷链（`routes/execute.ts` 的 `ensurePythonVenv`）：
 *   任务声明了 Python 版本 → 建 venv 分支原先**先** `resolveUvForExecute()`、
 *   **后** `ensureInterpreter(declaredVersion)`。
 *   uv 缺失时 `resolveUvForExecute` 抛的是
 *     「uv is not available on this executor (no UV_BIN, not on PATH, ...)」
 *   该文案既不含 `解释器 <X.Y> 无法获取` 骨架，也不匹配
 *   `prepareFailureReason` 的解释器规则（那条要求 `No interpreter found` /
 *   `No download found` / `Python downloads are set to manual` /
 *   `解释器…无法获取`），于是落到**最后兜底 `unknown`**。
 *
 * 后果不是"文案难看"，而是**分类语义丢失**：
 *   · 执行详情页的失败分类、Dashboard 失败榜、重试策略表都以 failureReason 分流；
 *   · 运维按 `interpreter_unavailable` 筛"该预填/下载解释器的机器"时，
 *     node 执行器上的这类失败全部落进 `unknown` 桶，**被筛掉**；
 *   · 同一失败在两个执行器上归类不同，与 A3 协议契约的"四端一致"直接冲突。
 *
 * 修法：把 `ensureInterpreter(declaredVersion)` 提到 uv 解析**之前**。
 * `ensureVersion()` 走解释器池/下载器，**不需要 uv**，所以提前能得到更准确的
 * 归因：池里没有且下不下来 → `interpreter_unavailable`（附带「候选执行器」
 * 快照供调度改派）；池里有 → 再解析 uv，此时 uv 缺失才是真正的根因。
 *
 * 反证：把顺序改回「先 uv 后解释器」，源码层用例立即变红。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prepareFailureReason } from './execute';

const SRC = readFileSync(join(__dirname, 'execute.ts'), 'utf-8');
const normalize = (s: string) => s.replace(/\s+/g, ' ');

describe('EXP-02 前提：uv 缺失的文案确实**不会**被归到解释器分类', () => {
  it('resolveUvForExecute 的原文落到 unknown（这正是要避免的结局）', () => {
    // 与 resolveUvForExecute 里 throw 的字符串逐字一致
    const uvMissing =
      'uv is not available on this executor (no UV_BIN, not on PATH, no bundled binary); ' +
      'install uv or use a client build that bundles it';
    expect(prepareFailureReason(uvMissing)).toBe('unknown');
  });

  it('解释器缺失的文案则正确归类为 interpreter_unavailable', () => {
    // ensureInterpreter → interpreterFailureMessage 产出的骨架
    expect(prepareFailureReason('解释器 3.11 无法获取（缓存缺失 + 下载失败）')).toBe(
      'interpreter_unavailable',
    );
    expect(
      prepareFailureReason('No interpreter found for Python 3.7 in managed installations'),
    ).toBe('interpreter_unavailable');
  });

  it('两条文案的归类确实不同（顺序颠倒会丢掉这次归因）', () => {
    const uvMissing = 'uv is not available on this executor (no UV_BIN, not on PATH)';
    const interpMissing = '解释器 3.11 无法获取（缓存缺失 + 下载失败）';
    expect(prepareFailureReason(uvMissing)).not.toBe(
      prepareFailureReason(interpMissing),
    );
  });
});

describe('EXP-02 源码层：建 venv 时必须先解析解释器、再解析 uv', () => {
  // 注：Jest 的 expect 不吃第二参数（自定义消息），故断言消息一律走注释或
  // 断言值本身表达。vitest 的 expect(x, msg) 形态在本仓 executor-node 不适用
  // （该子项目跑的是 jest，不是 vitest）。
  it('声明的版本分支里 ensureInterpreter 出现在 resolveUvForExecute 之前', () => {
    const start = SRC.indexOf('async function ensurePythonVenv(');
    expect(start).toBeGreaterThan(-1); // 找不到 ensurePythonVenv
    const body = SRC.slice(start, start + 3000);
    const iInterp = body.indexOf('await ensureInterpreter(declaredVersion');
    const iUv = body.indexOf('await resolveUvForExecute()');
    expect(iInterp).toBeGreaterThan(-1); // 该分支未调用 ensureInterpreter
    expect(iUv).toBeGreaterThan(-1); // 该分支未调用 resolveUvForExecute
    // 核心断言：解释器必须先解析——否则 uv 缺失会遮蔽解释器归因。
    expect(iInterp).toBeLessThan(iUv);
  });

  it('无版本分支仍解析 uv（行为不能被这次重排弄丢）', () => {
    // 无声明版本时不需要解释器池，但还需要 uv 建 venv。
    const start = SRC.indexOf('async function ensurePythonVenv(');
    const body = normalize(SRC.slice(start, start + 3000));
    expect(body).toMatch(/\} else \{ uv = await resolveUvForExecute\(\); \}/);
  });

  it('重排没有改变传给 uv venv 的 argv 形状（AC-10a 兼容红线）', () => {
    // `--python <abs>` 只能在有声明版本时出现，且 `--no-project <dir>` 恒在。
    expect(SRC).toMatch(/venvArgs\.push\('--python', poolPython\)/);
    expect(SRC).toMatch(/venvArgs\.push\('--no-project', venvDir\)/);
    // argv 组装顺序：--python 先于 --no-project
    const iPy = SRC.indexOf("venvArgs.push('--python', poolPython)");
    const iNoProj = SRC.indexOf("venvArgs.push('--no-project', venvDir)");
    expect(iPy).toBeGreaterThan(-1);
    expect(iNoProj).toBeGreaterThan(iPy);
  });
});

import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  BoundedLogBuffer,
  resolveTaskTimeoutRaw,
  selectTimeoutKey,
  taskForTimeoutProtocolValidation,
} from '../src/routes/execute';
import { ExecuteRequestSchema } from '../src/generated/protocol.schemas';
import { assertSafeHttpUrl } from '../src/lib/ssrf-guard';
import { assertGitRepoNetworkPolicyResolved } from '../src/git-repo-network-policy';

/**
 * 跨端运行时一致性：node 侧断言。
 *
 * 与 apps/executor-python/tests/test_runtime_parity.py 读**同一份** fixture
 * （两份 JSON 逐字节相同），覆盖协议 protocol.json 的三段 runtime 消费：
 * networkPolicy / timeoutPrecedence / callbackLogRetention。
 * 任一端语义漂移，同一条向量会在该端单独变红。
 */
const fixtures = JSON.parse(
  readFileSync(path.join(__dirname, 'fixtures', 'runtime-parity.json'), 'utf-8'),
) as {
  urlVectors: Array<{ name: string; url: string; expected: string; switch: string }>;
  dnsVectors: Array<{ name: string; host: string; addresses: string[]; expected: string }>;
  timeoutVectors: Array<{
    name: string;
    task: Record<string, unknown>;
    selected?: string;
    effective?: number;
    expectedStatus: number;
  }>;
  logVectors: Array<{
    name: string;
    inputChars: number;
    tailProbe: string;
    expectedTruncated: boolean;
    expectedHeadContains: string;
    expectedTailContainsProbe: boolean;
  }>;
};

describe('runtime parity（executor-node，共享向量）', () => {
  describe('networkPolicy：URL 出站拒绝清单', () => {
    it.each(fixtures.urlVectors)('$name 双端同结论', (v) => {
      const allowPrivateNetwork = v.switch === 'on';
      let allowed = true;
      try {
        assertSafeHttpUrl(v.url, { allowPrivateNetwork });
      } catch {
        allowed = false;
      }
      expect([v.name, allowed ? 'allow' : 'deny']).toEqual([
        v.name,
        v.expected,
      ]);
    });
  });

  describe('networkPolicy：DNS 解析结果与失败语义', () => {
    it.each(fixtures.dnsVectors)('$name 真实解析后判定', async (v) => {
      const gitRepo = `ssh://git@${v.host}/repo.git`;
      let allowed = true;
      try {
        await assertGitRepoNetworkPolicyResolved(
          gitRepo,
          {},
          async () => v.addresses,
        );
      } catch {
        allowed = false;
      }
      expect([v.name, allowed ? 'allow' : 'deny']).toEqual([
        v.name,
        v.expected,
      ]);
    });
  });

  describe('timeoutPrecedence：正名优先 + 旁键忽略', () => {
    it.each(fixtures.timeoutVectors)('$name 选中键/状态与协议一致', (v) => {
      const selected = selectTimeoutKey(v.task);
      expect([v.name, selected]).toEqual([v.name, v.selected]);

      const raw = resolveTaskTimeoutRaw(v.task);
      if (v.expectedStatus === 400) {
        // 手检：选中键非 0 时必须是 1..86400 的整数
        const selectedValueInvalid =
          typeof raw !== 'number' ||
          !Number.isInteger(raw) ||
          raw < 1 ||
          raw > 86400;
        expect(selectedValueInvalid).toBe(true);
        return;
      }
      expect(raw).toBe(v.effective);

      // 协议闸只喂规范化副本：旁键越界不得被 schema 拒
      const normalized = taskForTimeoutProtocolValidation(v.task);
      const result = ExecuteRequestSchema.safeParse({
        executionId: 'runtime-parity',
        task: normalized,
      });
      expect([v.name, result.success]).toEqual([v.name, true]);
    });
  });

  describe('callbackLogRetention：头尾各 500KB，尾部错误保留', () => {
    it.each(fixtures.logVectors)('$name 保留尾部探针', (v) => {
      const filler = Math.max(
        v.inputChars - v.expectedHeadContains.length - v.tailProbe.length,
        0,
      );
      const text =
        v.expectedHeadContains + 'X'.repeat(filler) + v.tailProbe;
      const buffer = new BoundedLogBuffer();
      buffer.append(text);
      const rendered = buffer.toString();
      expect(rendered.includes(v.expectedHeadContains)).toBe(true);
      expect(rendered.includes(v.tailProbe)).toBe(
        v.expectedTailContainsProbe,
      );
      expect(/\[\s*(?:logs\s+)?truncated\b/i.test(rendered)).toBe(
        v.expectedTruncated,
      );
    });
  });
});

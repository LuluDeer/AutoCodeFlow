// posture-addresses: 25
/**
 * R68 表驱动姿态矩阵（node 端）—— 契约 → 两个出站面，逐地址 × 开关 on/off。
 *
 * 与 `scripts/check-posture-matrix-tables.mjs`（meta 守卫）的约定：
 *   · 首行机器可读声明 `// posture-addresses: <N>`，N = 契约
 *     `networkPolicy.addresses.*.examples` 的实测总条数（本文件另有自检断言）；
 *   · **地址清单逐字从契约读**（`packages/executor-protocol/protocol.json`），
 *     本文件不出现任何地址字面量 —— 契约改了，这张表自动跟上；
 *   · 每个地址都在**开关 on/off 两态**下喂给**真实闸层**：分类器
 *     （`isRestrictedAddressForPolicy`）、布尔视图（`isRestrictedHost`）、
 *     恒拒表（`isMetadataAddress`）、组合规则（`categoryAllowed`），以及
 *     两个出站面的入口 —— 下载面 `assertSafeHttpUrl` 与 gitRepo 面
 *     `assertGitRepoNetworkPolicy`；
 *   · 期望值**不手写**：一律由契约的 `allowedUnderPrivateNetwork` 推出
 *     （`ipv4Mapped` 按契约自述「完全按内嵌 IPv4 判定」递归推导）。
 *
 * 判据分工：本文件管「每个面/每个地址/每种开关的结论」，`ssrf-posture-parity.spec.ts`
 * 管「两个面互相同判 + 解析不了的主机形态不得 fail-open」。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ALLOWED_UNDER_PRIVATE } from '../generated/protocol-categories';
import {
  assertSafeHttpUrl,
  categoryAllowed,
  classifyRestrictedIpv4,
  classifyRestrictedIpv6,
  isMetadataAddress,
  isRestrictedAddressForPolicy,
  isRestrictedHost,
  isRestrictedIpv4,
  isRestrictedIpv6Address,
  type RestrictedCategory,
} from './ssrf-guard';
import { assertGitRepoNetworkPolicy } from '../git-repo-network-policy';

jest.mock('./../config', () => ({ config: { allowPrivateNetwork: false } }));

const PROTOCOL_REL = path.join('packages', 'executor-protocol', 'protocol.json');
function repoRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, PROTOCOL_REL))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error(`protocol.json not found above ${from}`);
}

interface Contract {
  networkPolicy: {
    addresses: Record<string, { examples?: string[]; allowedUnderPrivateNetwork?: boolean }>;
    metadataAddresses: { addresses: string[] };
  };
}
const protocol = JSON.parse(
  fs.readFileSync(path.join(repoRoot(__dirname), PROTOCOL_REL), 'utf-8'),
) as Contract;
const policy = protocol.networkPolicy;

/** 契约逐类是否允许随开关放行（唯一期望值来源）。 */
const allowedUnderSwitch = (category: string): boolean =>
  policy.addresses[category]?.allowedUnderPrivateNetwork === true;

const METADATA = policy.metadataAddresses.addresses.map((entry) =>
  String(entry).split('/')[0].trim(),
);

/** 契约自述：`ipv4Mapped` 完全按内嵌 IPv4 判定 ⇒ 递归到内嵌地址所属类别。 */
function embeddedCategory(value: string): RestrictedCategory | null {
  const tail = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(value);
  return tail ? isRestrictedAddressForPolicy(tail[1]) : null;
}

interface Row {
  category: string;
  value: string;
  /** 该条目的**期望类别**（ipv4Mapped 递归到内嵌 IPv4 的类别；null = 公网）。 */
  expectedCategory: RestrictedCategory | null;
  /** 开关开启时是否应放行。 */
  allowedOn: boolean;
  /** 开关关闭时是否应放行（契约语义：默认全拒，只有公网恒放行）。 */
  allowedOff: boolean;
}

const ROWS: Row[] = Object.entries(policy.addresses).flatMap(([category, meta]) =>
  (meta.examples ?? []).map((example) => {
    const value = String(example);
    const expectedCategory =
      category === 'ipv4Mapped' ? embeddedCategory(value) : (category as RestrictedCategory);
    // 公网地址（分类为 null）恒放行；其余类别开关关闭时一律拒。
    const allowedOn =
      expectedCategory === null
        ? true
        : allowedUnderSwitch(expectedCategory);
    const allowedOff = expectedCategory === null;
    return { category, value, expectedCategory, allowedOn, allowedOff };
  }),
);

/** 把契约里的地址字面量转成 URL 的 host 段（IPv6 需方括号）。 */
const asUrlHost = (value: string): string => (value.includes(':') ? `[${value}]` : value);

const downloadVerdict = (value: string, allow: boolean): 'PASS' | 'DENY' => {
  try {
    assertSafeHttpUrl(`http://${asUrlHost(value)}/pkg.zip`, { allowPrivateNetwork: allow });
    return 'PASS';
  } catch {
    return 'DENY';
  }
};

const gitRepoVerdict = (value: string, allow: boolean): 'PASS' | 'DENY' => {
  try {
    assertGitRepoNetworkPolicy(`https://${asUrlHost(value)}/repo.git`, {
      allowPrivateNetwork: allow,
    });
    return 'PASS';
  } catch {
    return 'DENY';
  }
};

describe('R68 posture matrix（node）：契约地址 × 开关两态 × 两个出站面', () => {
  it('表条数与首行声明一致，且等于契约实测条数（契约改了这里会红）', () => {
    const declared = 25; // 与首行 `// posture-addresses: 25` 同源；契约新增条目时两处一起改
    expect(ROWS.length).toBe(declared);
    // 覆盖率自检：契约里每个类别都至少被取到一条，别悄悄少读一类。
    expect(new Set(ROWS.map((r) => r.category)).size).toBe(
      Object.keys(policy.addresses).length,
    );
  });

  it.each(ROWS.flatMap((row) => [false, true].map((allow) => ({ ...row, allow }))))(
    '$category $value 开关=$allow：分类器 + 三面同判',
    ({ value, expectedCategory, allowedOn, allowedOff, allow }) => {
      const want = allow ? (allowedOn ? 'PASS' : 'DENY') : (allowedOff ? 'PASS' : 'DENY');

      // ① 分类器：归到契约声明的类别（ipv4Mapped 归内嵌 IPv4 的类别）。
      expect({ value, category: isRestrictedAddressForPolicy(value) }).toEqual({
        value,
        category: expectedCategory,
      });
      // ② 布尔视图必须与分类器同判（单一权威，不许两套表）。
      expect({ value, restricted: isRestrictedHost(value) }).toEqual({
        value,
        restricted: expectedCategory !== null,
      });
      // ②′ 两个布尔原语也必须与各自的分类器同判（此前 `192.0.0.192` 在这条上漂移）。
      const isIpv6 = value.includes(':');
      expect({
        value,
        restricted: isIpv6 ? isRestrictedIpv6Address(value) : isRestrictedIpv4(value),
      }).toEqual({
        value,
        restricted: isIpv6
          ? classifyRestrictedIpv6(value) !== null
          : classifyRestrictedIpv4(value) !== null,
      });
      // ③ 组合规则：开关只解锁 privateIPv4。
      expect({ value, allowed: categoryAllowed(expectedCategory, allow, ALLOWED_UNDER_PRIVATE) }).toEqual({
        value,
        allowed: want === 'PASS',
      });
      // ④ 下载面入口。
      expect({ face: 'download', value, allow, verdict: downloadVerdict(value, allow) }).toEqual({
        face: 'download',
        value,
        allow,
        verdict: want,
      });
      // ⑤ gitRepo 面入口。
      expect({ face: 'gitRepo', value, allow, verdict: gitRepoVerdict(value, allow) }).toEqual({
        face: 'gitRepo',
        value,
        allow,
        verdict: want,
      });
    },
  );

  it.each(METADATA.flatMap((value) => [false, true].map((allow) => ({ value, allow }))))(
    '元数据 $value 开关=$allow：恒拒表命中 + 两个面都拒（任何姿态都不能放行）',
    ({ value, allow }) => {
      expect({ value, metadata: isMetadataAddress(value) }).toEqual({ value, metadata: true });
      expect({ face: 'download', value, allow, verdict: downloadVerdict(value, allow) }).toEqual({
        face: 'download',
        value,
        allow,
        verdict: 'DENY',
      });
      expect({ face: 'gitRepo', value, allow, verdict: gitRepoVerdict(value, allow) }).toEqual({
        face: 'gitRepo',
        value,
        allow,
        verdict: 'DENY',
      });
    },
  );

  it('契约里「只有 privateIPv4 可随开关放行」（矩阵的期望值来源自检）', () => {
    const unlocked = Object.entries(policy.addresses)
      .filter(([, meta]) => meta.allowedUnderPrivateNetwork === true)
      .map(([key]) => key);
    expect(unlocked).toEqual(['privateIPv4']);
  });
});

// ---------------------------------------------------------------------------
// R82（2026-11-06）：**同形判决入口** `verdictForAddress` 与既有闸逐条等价。
//
// node 此前的出口是两个分散谓词（`isRestrictedHost` / `categoryAllowed`）+ 调用方
// 自己拼开关语义 ⇒ 跨端判据没法用同一种调用形态比三端（admin 侧已是一个
// `evaluateOutboundPosture({risk, metadata, allowPrivateNetwork})` 入口）。
// 本组判据两件事：
//   ① 契约 25 条示例 × 开关两态 —— `verdictForAddress` 的结论与契约一致；
//   ② 与**真实闸**（`assertSafeHttpUrl` + gitRepo 面）对同一批地址 × 两态逐条同判。
// ---------------------------------------------------------------------------
describe('R82: verdictForAddress 与契约/真实闸逐条等价', () => {
  const { verdictForAddress } = require('./address-category');

  const contractRows = ROWS.flatMap((row) =>
    [false, true].map((allow) => ({ ...row, allow })),
  );

  it.each(contractRows)(
    '契约示例 $value 开关=$allow ⇒ 与契约一致',
    ({ value, expectedCategory, allowedOn, allowedOff, allow }) => {
      const v = verdictForAddress(value, allow, METADATA, ALLOWED_UNDER_PRIVATE);
      expect({ value, allow, allowed: v.allowed }).toEqual({
        value,
        allow,
        allowed: allow ? allowedOn : allowedOff,
      });
      // 元数据恒拒表成员：metadata 标记必须为 true（否则跨端判据会把「恒拒」当「分类拒」）。
      const inTable = METADATA.includes(value);
      expect({ value, metadata: v.metadata }).toEqual({ value, metadata: inTable });
      if (expectedCategory !== null) {
        expect({ value, category: v.category }).toEqual({ value, category: expectedCategory });
      }
    },
  );

  // 与真实闸逐条同判（≥10 地址把契约 25 条都覆盖，另加 3 条**非契约**形态）。
  // 一律用**无方括号**形态：`asUrlHost` 会按需补方括号（重复加会变成非法 URL）。
  // 注：契约里已有的地址（如 `::ffff:8.8.8.8`、`fd00:ec2::254`）一律从 `ROWS` 来，
  // 这里**不再抄副本**；`localhost.localdomain` 不是契约地址，只是它的**子串**里
  // 含契约字面量 `localhost`，故按守卫约定标注豁免。
  // 末项是 localhost 的另一同义写法（非契约地址，见行尾豁免理由）。
  const EXTRA = ['8.8.8.8', 'internal.corp', 'localhost.localdomain']; // allowed-literal: 该项是 localhost 的 FQDN 同义写法（非契约地址），故意不取自契约表
  const equivalenceRows = [...ROWS.map((r) => r.value), ...EXTRA].flatMap((value) =>
    [false, true].map((allow) => ({ value, allow })),
  );

  it.each(equivalenceRows)(
    '$value 开关=$allow：verdictForAddress 与 assertSafeHttpUrl 同判（共 %# 格）',
    ({ value, allow }) => {
      const gateAllowed = downloadVerdict(value, allow) === 'PASS';
      const v = verdictForAddress(value, allow, METADATA, ALLOWED_UNDER_PRIVATE);
      expect({ value, allow, verdict: v.allowed }).toEqual({
        value,
        allow,
        verdict: gateAllowed,
      });
      expect(v.reason).toMatch(/^(public-or-hostname|allowed-under-switch|denied-by-category)/);
    },
  );
});

describe('R82: 空地址 —— 入口层显式拒绝（闸层 `http:///x` 会被 URL 解析接受，属闸的既有边界）', () => {
  const { verdictForAddress } = require('./address-category');
  it('verdictForAddress("") ⇒ allowed:false + reason="empty-address"', () => {
    expect(verdictForAddress('', true, [], ALLOWED_UNDER_PRIVATE)).toEqual({
      allowed: false,
      category: null,
      metadata: false,
      reason: 'empty-address',
    });
  });
});

// ---------------------------------------------------------------------------
// R90（ADR-034 步骤 2）：node 侧「开关可解锁集合」的**单一事实源**判据。
//
// 生产路径由调用方注入契约生成物（`generated/protocol-categories.ts` 的
// `ALLOWED_UNDER_PRIVATE`）；零依赖模块内的**兜底常量**只服务「拿不到生成物」的
// 场景（仓外探针只传 3 参）—— 两者必须**逐字一致**，否则 ADR-034 要消灭的
// 「三份各自推导」又回来了（且兜底那份是**手抄**，最易漂）。
// ---------------------------------------------------------------------------
describe('R90: node 的兜底常量 ≡ 契约生成物', () => {
  const { ALLOWED_UNDER_PRIVATE_FALLBACK, categoryAllowed } = require('./address-category');
  const { ALLOWED_UNDER_PRIVATE, CATEGORY_ORDER } = require('../generated/protocol-categories');

  it('兜底常量与生成物 ALLOWED_UNDER_PRIVATE 逐字一致', () => {
    expect([...ALLOWED_UNDER_PRIVATE_FALLBACK].sort()).toEqual([...ALLOWED_UNDER_PRIVATE].sort());
  });

  it('兜底常量与**契约本身**一致（生成物若过期，这里也会红）', () => {
    const contract = require('../../../../packages/executor-protocol/protocol.json');
    const fromContract = contract.networkPolicy.categories.allowedUnderPrivateNetwork as string[];
    expect([...ALLOWED_UNDER_PRIVATE_FALLBACK].sort()).toEqual([...fromContract].sort());
  });

  it('类别集合与契约 order 一致（node 的 RestrictedCategory 不再是手抄联合的漂移面）', () => {
    const contract = require('../../../../packages/executor-protocol/protocol.json');
    const order = contract.networkPolicy.categories.order as string[];
    expect([...CATEGORY_ORDER].sort()).toEqual([...order].sort());
  });

  it('开关语义由**注入的集合**决定（不是硬编码 privateIPv4）', () => {
    // 注入别的集合 ⇒ 结论随之改变（证明不是硬编码）。
    expect(categoryAllowed('privateIPv4', true, ['privateIPv4'])).toBe(true);
    expect(categoryAllowed('privateIPv4', true, [])).toBe(false);
    expect(categoryAllowed('linkLocal', true, ['linkLocal'])).toBe(true);
    expect(categoryAllowed('linkLocal', true, ['privateIPv4'])).toBe(false);
    // 开关关闭时一律拒（与集合无关）。
    expect(categoryAllowed('privateIPv4', false, ['privateIPv4'])).toBe(false);
  });
});

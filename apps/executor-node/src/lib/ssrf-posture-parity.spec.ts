/**
 * R67（2026-11-06）：node 侧**逐面姿态同构**守卫 —— 下载面 ↔ gitRepo 面 ↔ 契约。
 *
 * ## 为什么需要这一条
 *
 * R63 把下载面收紧成「恒拒/类别表优先于开关」，并把 `categoryAllowed` 上收到
 * `lib/ssrf-guard.ts`，gitRepo 面改为再导出。**代码是同一份了，但「同一套口径」
 * 从未被机检过**：两个面各自还有一层自己的前置逻辑（下载面先判元数据恒拒表、
 * gitRepo 面先判 localhost 同义词、两边各自取 host），任一处分叉都可能让同一个
 * `EXECUTOR_ALLOW_PRIVATE_NETWORK` 在两条出站通道上给出相反结论 —— 那正是
 * ADR-032 记录的「三端两种承诺」在 node 内部的同族形态。
 *
 * ## 判据形态
 *
 * 1. 期望值**不手写**：每类的 `allowedUnderPrivateNetwork` 从契约
 *    `packages/executor-protocol/protocol.json` 的 `networkPolicy.addresses` 读；
 * 2. 每个代表地址在**开/关两态**下同时喂给两个面，断言二者结论都等于契约；
 * 3. DNS 面同做一次（主机名解析到该地址），因为两个面的 DNS 实现是**各自一份**；
 * 4. gitRepo 面的 host 提取形态（scp-like / userinfo / 大写 / 尾点 / IPv4-mapped）
 *    逐个钉住 —— 提取错一格，类别表再准也白搭。
 *
 * 反向验证：把 `assertSafeHttpUrl` 的类别表短路（加回 `if (allow) return;`）
 * ⇒ 本文件必须红（linkLocal/cgnat/reserved/loopback 四类在开关态会放行）。
 */
import * as dns from 'node:dns';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  assertSafeDnsResolution,
  assertSafeHttpUrl,
  isRestrictedAddressForPolicy,
  type RestrictedCategory,
} from './ssrf-guard';
import {
  assertGitRepoNetworkPolicy,
  assertGitRepoNetworkPolicyResolved,
} from '../git-repo-network-policy';

jest.mock('../config', () => ({ config: { allowPrivateNetwork: false } }));

const PROTOCOL_RELATIVE = path.join('packages', 'executor-protocol', 'protocol.json');
function findRepoRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, PROTOCOL_RELATIVE))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error(`protocol.json not found above ${from}`);
}
const protocol = JSON.parse(
  fs.readFileSync(path.join(findRepoRoot(__dirname), PROTOCOL_RELATIVE), 'utf-8'),
) as {
  networkPolicy: {
    addresses: Record<string, { allowedUnderPrivateNetwork: boolean }>;
    metadataAddresses: { addresses: string[] };
  };
};

/** 契约里「开关开启时该类是否放行」——**唯一事实源**，本文件的期望值全从这里来。 */
const contractAllows = (category: string): boolean =>
  protocol.networkPolicy.addresses[category]?.allowedUnderPrivateNetwork === true;

const metadataLiterals = protocol.networkPolicy.metadataAddresses.addresses.map(
  (entry) => String(entry).split('/')[0].trim(),
);

/** 契约七类 + 每类的代表地址（含编码变体：mapped / 大写 / 尾点 / 云元数据）。 */
const SAMPLES: Array<{ category: RestrictedCategory; addresses: string[] }> = [
  { category: 'loopback', addresses: ['127.0.0.1', '[::1]', 'localhost', 'foo.localhost'] },
  { category: 'privateIPv4', addresses: ['10.0.0.5', '172.16.0.1', '192.168.1.1'] },
  {
    category: 'linkLocal',
    addresses: [
      '169.254.169.254', // 云元数据（AWS/GCP/Azure）
      '169.254.1.1', // 非恒拒表成员的 link-local
      '[fe80::1]',
      '[fd00:ec2::254]', // AWS IPv6 元数据（ULA 段）
      '[::ffff:169.254.169.254]', // mapped 形态的云元数据
    ],
  },
  { category: 'cgnat', addresses: ['100.64.0.1'] },
  { category: 'unspecified', addresses: ['0.0.0.0', '[::]'] },
  { category: 'multicast', addresses: ['224.0.0.1', '[ff02::1]'] },
  {
    category: 'reserved',
    addresses: [
      '240.0.0.1',
      '198.18.0.1',
      '255.255.255.255',
      ...metadataLiterals.filter((a) => /^[\d.]+$/.test(a)), // 契约恒拒表（100.100.100.200 / 192.0.0.192）
    ],
  },
];

const downloadVerdict = (host: string, allow: boolean): 'PASS' | 'DENY' => {
  try {
    assertSafeHttpUrl(`http://${host}/pkg.zip`, { allowPrivateNetwork: allow });
    return 'PASS';
  } catch {
    return 'DENY';
  }
};

const gitRepoVerdict = (host: string, allow: boolean): 'PASS' | 'DENY' => {
  try {
    assertGitRepoNetworkPolicy(`https://${host}/repo.git`, { allowPrivateNetwork: allow });
    return 'PASS';
  } catch {
    return 'DENY';
  }
};

describe('R67: 下载面 ↔ gitRepo 面 ↔ 契约 —— 逐类逐态同构', () => {
  it('契约里只有 privateIPv4 允许随开关放行（期望值的来源自检）', () => {
    const allowed = Object.entries(protocol.networkPolicy.addresses)
      .filter(([, meta]) => meta.allowedUnderPrivateNetwork === true)
      .map(([key]) => key);
    expect(allowed).toEqual(['privateIPv4']);
  });

  const cases = SAMPLES.flatMap(({ category, addresses }) =>
    addresses.flatMap((address) =>
      [false, true].map((allow) => ({ category, address, allow })),
    ),
  );

  it.each(cases)(
    '$category $address 开关=$allow：两个面都必须与契约同判',
    ({ category, address, allow }) => {
      const expected = contractAllows(category) && allow ? 'PASS' : 'DENY';
      // ① 分类器把地址归到契约声明的这一类（不是笼统的「受限」）。
      expect({ address, category: isRestrictedAddressForPolicy(address) }).toEqual({
        address,
        category,
      });
      // ② 下载面（ssrf-guard）。
      expect({ face: 'download', address, allow, verdict: downloadVerdict(address, allow) }).toEqual({
        face: 'download',
        address,
        allow,
        verdict: expected,
      });
      // ③ gitRepo 面（git-repo-network-policy）。
      expect({ face: 'gitRepo', address, allow, verdict: gitRepoVerdict(address, allow) }).toEqual({
        face: 'gitRepo',
        address,
        allow,
        verdict: expected,
      });
    },
  );

  it('两个面在任意地址上都必须同判（不是各留一张表）', () => {
    const extra = [
      '8.8.8.8',
      '[2606:4700:4700::1111]',
      '169.254.169.254.', // 尾点
      '[0:0:0:0:0:ffff:a9fe:a9fe]', // 未压缩的 mapped 云元数据
      '[::ffff:10.0.0.1]', // mapped 私网（随开关）
      '[fe80::1%25eth0]', // zone id
    ];
    for (const address of [...extra, ...SAMPLES.flatMap((s) => s.addresses)]) {
      for (const allow of [false, true]) {
        expect({ address, allow, download: downloadVerdict(address, allow) }).toEqual({
          address,
          allow,
          download: gitRepoVerdict(address, allow),
        });
      }
    }
  });
});

describe('R67: DNS 面同构（两个面的解析后判定是各自一份实现）', () => {
  const dnsTargets = [
    { address: '169.254.169.254', expected: 'DENY' },
    { address: '100.100.100.200', expected: 'DENY' },
    { address: '127.0.0.1', expected: 'DENY' },
    { address: '::ffff:a9fe:a9fe', expected: 'DENY' },
    { address: 'fd00:ec2::254', expected: 'DENY' },
    { address: '100.64.0.1', expected: 'DENY' },
    { address: '10.0.0.5', expected: 'KEYSWITCH' }, // 只有开关开启才放行
    { address: '8.8.8.8', expected: 'PASS' },
  ];

  it.each(dnsTargets.flatMap((t) => [false, true].map((allow) => ({ ...t, allow }))))(
    '解析到 $address（开关=$allow）：下载面与 gitRepo 面同判',
    async ({ address, expected, allow }) => {
      const want =
        expected === 'KEYSWITCH' ? (allow ? 'PASS' : 'DENY') : (expected as 'PASS' | 'DENY');

      const spy = jest
        .spyOn(dns.promises, 'lookup')
        .mockResolvedValue([{ address, family: address.includes(':') ? 6 : 4 }] as never);
      let download: 'PASS' | 'DENY';
      try {
        download = await assertSafeDnsResolution('http://probe.example/x', {
          allowPrivateNetwork: allow,
        }).then(
          () => 'PASS' as const,
          () => 'DENY' as const,
        );
      } finally {
        spy.mockRestore();
      }

      const gitRepo = await assertGitRepoNetworkPolicyResolved(
        'https://probe.example/x.git',
        { allowPrivateNetwork: allow },
        async () => [address],
      ).then(
        () => 'PASS' as const,
        () => 'DENY' as const,
      );

      expect({ face: 'download', address, allow, verdict: download }).toEqual({
        face: 'download',
        address,
        allow,
        verdict: want,
      });
      expect({ face: 'gitRepo', address, allow, verdict: gitRepo }).toEqual({
        face: 'gitRepo',
        address,
        allow,
        verdict: want,
      });
    },
  );

  it('两个面的 DNS 失败都 fail-closed（无法证明安全就不连）', async () => {
    const spy = jest
      .spyOn(dns.promises, 'lookup')
      .mockRejectedValue(new Error('ENOTFOUND') as never);
    try {
      await expect(
        assertSafeDnsResolution('http://nx.example/x', { allowPrivateNetwork: true }),
      ).rejects.toThrow(/DNS 解析失败/);
    } finally {
      spy.mockRestore();
    }
    await expect(
      assertGitRepoNetworkPolicyResolved(
        'https://nx.example/x.git',
        { allowPrivateNetwork: true },
        async () => {
          throw new Error('ENOTFOUND');
        },
      ),
    ).rejects.toThrow(/DNS 解析失败/);
  });
});

describe('R67: gitRepo 面的 host 提取形态不得成为绕过口', () => {
  // 提取错一格（scp / userinfo / 大写 scheme / 尾点 / mapped），类别表再准也白搭。
  const forms = [
    'git@169.254.169.254:repo.git',
    'https://user:pw@169.254.169.254:8443/x.git',
    'HTTPS://169.254.169.254/X.GIT',
    'git+ssh://git@169.254.169.254/repo.git',
    'https://[::ffff:169.254.169.254]/x.git',
    'git@100.100.100.200:repo.git',
  ];
  it.each(forms)('%s 在开/关两态都必须拒', (gitRepo) => {
    for (const allow of [false, true]) {
      expect(() => assertGitRepoNetworkPolicy(gitRepo, { allowPrivateNetwork: allow })).toThrow(
        /受限网络地址/,
      );
    }
  });

  it('内网自建 GitLab（privateIPv4）在开关开启时仍放行（不得收成 deny-all）', () => {
    for (const gitRepo of [
      'git@10.0.0.5:team/repo.git',
      'https://gitlab.corp.internal:8443/team/repo.git', // 主机名：同步闸放行，DNS 闸另行判定
    ]) {
      expect(() =>
        assertGitRepoNetworkPolicy(gitRepo, { allowPrivateNetwork: true }),
      ).not.toThrow();
    }
    expect(() =>
      assertGitRepoNetworkPolicy('https://gitlab.corp.internal/team/repo.git', {
        allowPrivateNetwork: false,
      }),
    ).not.toThrow(); // 同步闸不解析主机名——这是设计（DNS 面负责），不是漏洞
  });
});

// ---------------------------------------------------------------------------
// R67 缺陷（已修）：gitRepo 面在「Node 的 URL 解析器拒绝的主机形态」上 **fail-open**。
//
// Node 的 WHATWG URL 拒绝 host 里的 IPv6 **zone id**（`[fe80::1%eth0]` /
// 百分号编码的 `[fe80::1%25eth0]`）——`new URL()` 直接抛 `Invalid URL`。
// `gitRepoHost()` 于是返回空串，而两处闸门都是 `if (!host) return;`
// ⇒ **放行**。但 git / ssh 恰恰接受带 zone 的 scp-like 与 ssh URL：
//   `git@[fe80::1%eth0]:repo.git` / `ssh://git@[fe80::1%eth0]/repo.git`
// 这些目标落在 `linkLocal`（fe80::/10）与 ULA（fc00::/7，含 AWS IPv6 元数据
// `fd00:ec2::254`）——契约对这两类的 `allowedUnderPrivateNetwork` 都是 false，
// 任何开关状态都必须拒。
//
// 同一批地址喂下载面：`assertSafeHttpUrl` 在 URL 解析失败时抛「无效的 URL」
// ⇒ **DENY（fail-closed）**。⇒ 同一个目标、两条出站通道、两种结论 —— 正是
// ADR-032 的「三端两种承诺」在 node 内部的两面版本。
// ---------------------------------------------------------------------------
describe('R67: gitRepo 面不得对「解析不了的主机」fail-open（旧实现在此放行）', () => {
  const unparseableHostForms = [
    'ssh://git@[fe80::1%eth0]/repo.git', // IPv6 link-local + zone id
    'ssh://git@[fe80::1%25eth0]/repo.git', // 同一地址的百分号编码形态
    'git@[fe80::1%eth0]:team/repo.git', // scp-like + 方括号主机
    'https://[fe80::1%eth0]/repo.git', // https 形态（URL 同样解析失败）
    'ssh://git@[fd00:ec2::254]/repo.git', // AWS IPv6 元数据（ULA）
    'git@[::ffff:169.254.169.254]:repo.git', // mapped 云元数据 + 方括号
  ];

  it.each(unparseableHostForms)('%s 在开/关两态都必须拒', (gitRepo) => {
    for (const allow of [false, true]) {
      expect(() => assertGitRepoNetworkPolicy(gitRepo, { allowPrivateNetwork: allow })).toThrow(
        /受限网络地址/,
      );
    }
  });

  it('异步闸同样拒（不能让同步闸放行后再被 DNS 面静默跳过）', async () => {
    for (const gitRepo of unparseableHostForms) {
      await expect(
        assertGitRepoNetworkPolicyResolved(gitRepo, { allowPrivateNetwork: true }, async () => [
          '8.8.8.8',
        ]),
      ).rejects.toThrow(/受限网络地址/);
    }
  });

  it('两面在 zone-id 形态上同判（下载面一直是 DENY）', () => {
    for (const host of ['[fe80::1%eth0]', '[fe80::1%25eth0]', '[fd00:ec2::254]']) {
      for (const allow of [false, true]) {
        // 下载面：URL 解析失败 ⇒ 无效 URL ⇒ DENY（fail-closed）
        expect(downloadVerdict(host, allow)).toBe('DENY');
        // gitRepo 面：必须同样 DENY（修复前这里会 PASS）
        expect(gitRepoVerdict(host, allow)).toBe('DENY');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// R70（2026-11-06）：残留 fail-open —— **scp-like 形态没有 userinfo**（或 userinfo
// 含有窄正则不接受的字符）时，host 提取失败 ⇒ 两处闸门 `if (!host) return;` 放行。
//
// 下游行为取证（git 2.43.0，GIT_SSH_COMMAND=/bin/echo 观察它到底走没走 ssh）：
//   `git ls-remote '10.0.0.5:repo.git'`            → 走了 ssh（= 远端，不是本地路径）
//   `git ls-remote 'weird+user@10.0.0.5:repo.git'` → 走了 ssh
//   `git ls-remote './local/repo.git'`             → 本地路径（does not appear to be a git repository）
//   `git ls-remote 'file:///tmp/x.git'`            → 本地路径
// 即：**「第一个 '/' 之前有 ':'」= 远端**（git-fetch(1) GIT URLS 的 scp-like 规则），
// 与「有没有 userinfo」「userinfo 用哪些字符」无关 ⇒ 放行不安全。
//
// 修法：host 提取按 git 自己的 scp-like 规则来（无 userinfo 也要取 hosts），
// 并对「远端形态但提取不出主机」的串 **fail-closed**；本地路径 / file:// 维持放行。
// ---------------------------------------------------------------------------
describe('R70: scp-like / 异常 userinfo 不得绕过 host 闸（旧实现放行）', () => {
  const cases: Array<{ gitRepo: string; on: 'PASS' | 'DENY'; off: 'PASS' | 'DENY' }> = [
    // 无 userinfo 的 scp-like：git 会当远端连过去
    { gitRepo: '169.254.169.254:repo.git', on: 'DENY', off: 'DENY' },
    { gitRepo: '100.100.100.200:repo.git', on: 'DENY', off: 'DENY' },
    { gitRepo: '10.0.0.5:repo.git', on: 'PASS', off: 'DENY' }, // privateIPv4：开关只解锁这一类
    // userinfo 含窄正则不接受的字符
    { gitRepo: 'weird+user@169.254.169.254:repo.git', on: 'DENY', off: 'DENY' },
    { gitRepo: 'us!er@10.0.0.5:repo.git', on: 'PASS', off: 'DENY' },
    // 远端形态但连主机都解析不出来 ⇒ fail-closed
    { gitRepo: ':::not-a-host', on: 'DENY', off: 'DENY' },
    // 本地路径 / file:// 不是远端 —— 维持放行（git 按本地目录处理，无网络出站）
    { gitRepo: './local/repo.git', on: 'PASS', off: 'PASS' },
    { gitRepo: '/abs/path/repo.git', on: 'PASS', off: 'PASS' },
    { gitRepo: 'file:///tmp/x.git', on: 'PASS', off: 'PASS' },
    // 公网 scp-like：同步闸放行（类别 = null），主机名安全与否由 DNS 面判
    { gitRepo: 'example.com:repo.git', on: 'PASS', off: 'PASS' },
  ];

  it.each(cases)('$gitRepo：开关开=$on / 关=$off', ({ gitRepo, on, off }) => {
    for (const [allow, want] of [
      [false, off],
      [true, on],
    ] as Array<[boolean, 'PASS' | 'DENY']>) {
      const verdict = (() => {
        try {
          assertGitRepoNetworkPolicy(gitRepo, { allowPrivateNetwork: allow });
          return 'PASS';
        } catch {
          return 'DENY';
        }
      })();
      expect({ gitRepo, allow, verdict }).toEqual({ gitRepo, allow, verdict: want });
    }
  });

  it('异步闸同样拒（不能让同步闸 fail-open 后 DNS 面又直接跳过）', async () => {
    for (const gitRepo of ['169.254.169.254:repo.git', ':::not-a-host', 'us!er@10.0.0.5:repo.git']) {
      await expect(
        assertGitRepoNetworkPolicyResolved(gitRepo, { allowPrivateNetwork: false }, async () => [
          '8.8.8.8',
        ]),
      ).rejects.toThrow(/受限网络地址/);
    }
  });
});

// ---------------------------------------------------------------------------
// R82b（2026-11-06，W3 实测）：**尾点主机名**的 localhost 系漏判。
//
// `isLocalhostSynonym` 的语义与 admin 一致，但**没归一化**：`localhost.`（FQDN
// 写法，DNS 会解析到 127.0.0.1）既不是 `localhost` 也不以 `.localhost` 结尾 ⇒
// 三处同步闸全部放行（实测：gitRepo 同步闸 PASS / scp-like PASS / 下载面 PASS），
// 只有下载期的 DNS 面能兜住（太晚）。admin 侧 R79 已用 `normalizeHostname` 修掉。
//
// 修复：`address-category.normalizeHostname`（零依赖，小写 + 去尾点 + 去方括号），
// 分类器 / 恒拒表 / `isLocalhostSynonym` / `gitRepoHost` 统一先用它 —— **语义不变**
// （仍只拒 localhost 系与受限类，公网域名带尾点照常放行）。
// ---------------------------------------------------------------------------
describe('R82b: 尾点主机名（FQDN 写法）不得绕过 localhost 系判定', () => {
  const MUST_DENY = [
    'https://localhost./repo.git',
    'https://LOCALHOST./repo.git', // 大写 + 尾点
    'https://LOCALHOST/repo.git', // 仅大写（URL 已小写化，回归项）
    'https://Foo.LocalHost/repo.git',
    'git@localhost.:repo.git', // scp-like + 尾点
  ];

  it.each(MUST_DENY)('gitRepo 闸拒绝 %s', (gitRepo) => {
    for (const allow of [false, true]) {
      expect(() => assertGitRepoNetworkPolicy(gitRepo, { allowPrivateNetwork: allow })).toThrow(
        /受限网络地址/,
      );
    }
  });

  it('下载面同步闸同样拒绝 localhost. / LOCALHOST.（DNS 面之前就该拒）', () => {
    for (const host of ['localhost.', 'LOCALHOST.', 'foo.localhost.']) {
      for (const allow of [false, true]) {
        expect(() => assertSafeHttpUrl(`http://${host}/pkg.zip`, { allowPrivateNetwork: allow })).toThrow(
          /受限网络地址/,
        );
      }
    }
  });

  it('误伤检查：公网域名带尾点照常放行（归一化不得变成过度封锁）', () => {
    for (const host of ['example.com.', 'gitlab.corp.example.']) {
      expect(() => assertSafeHttpUrl(`http://${host}/pkg.zip`)).not.toThrow();
      expect(() =>
        assertGitRepoNetworkPolicy(`https://${host}/repo.git`, { allowPrivateNetwork: false }),
      ).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// R86（2026-11-06，W3 普查 🟢 项）：**语法闸与 DNS 闸是两层**，且两层必须认**同一组
// 名字**（admin `address-category.util.ts:507 isLoopbackHostname`：`localhost` /
// `localhost.localdomain` / `*.localhost`，归一化小写 + 去尾点）。
//
// 现状（改前）：语义闸已经对齐（分类器与 gitRepo 同步闸都认全三个形态），但
// `assertSafeDnsResolution` 的**跳过列表仍是两个字面名** ⇒ 对 `foo.localhost` /
// `localhost.` / `a.b.localhost` 仍会**发起 DNS 解析**。语义上没错（语法闸先拒），
// 但这意味着「DNS 层出问题/被改短时语义闸就漏」的纵深防御只落在两个名字上。
//
// 判据：同一批名字 —— ① 分类器判 loopback；② gitRepo 同步闸拒；
// ③ DNS 面**不发起解析**（与语法闸同一集合，且不因重复解析而多一次可被投毒的查询）。
// ---------------------------------------------------------------------------
describe('R86: 语法闸与 DNS 闸认同一组 localhost 系名字（两层纵深）', () => {
  const LOOPBACK_NAMES = [
    'localhost',
    'localhost.localdomain',
    'localhost.', // 尾点写法
    'foo.localhost',
    'a.b.localhost',
    'Foo.LocalHost.', // 大写 + 尾点
  ];
  const NON_LOOPBACK = ['notlocalhost.com', 'localhost.evil.com', 'example.com', 'mylocalhost'];

  it.each(LOOPBACK_NAMES)('语义层：%s 分类为 loopback 且被 gitRepo 同步闸拒', (name) => {
    expect(isRestrictedAddressForPolicy(name)).toBe('loopback');
    expect(() =>
      assertGitRepoNetworkPolicy(`https://${name}/repo.git`, { allowPrivateNetwork: true }),
    ).toThrow(/受限网络地址/);
  });

  it.each(LOOPBACK_NAMES)('DNS 层：%s **不发起解析**（语法闸已定论，无需也不该再查）', async (name) => {
    const spy = jest.spyOn(dns.promises, 'lookup');
    try {
      await expect(assertSafeDnsResolution(`http://${name}/x`)).resolves.toEqual([]);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it.each(NON_LOOPBACK)('反例：%s 仍不是 loopback、仍放行', (name) => {
    expect(isRestrictedAddressForPolicy(name)).toBeNull();
    expect(() =>
      assertGitRepoNetworkPolicy(`https://${name}/repo.git`, { allowPrivateNetwork: false }),
    ).not.toThrow();
  });
});

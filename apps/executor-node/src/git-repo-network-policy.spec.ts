/**
 * R2-1/P1b · A7：gitRepo 出站地址闸（按协议契约 `networkPolicy` 实现）的回归锁。
 *
 * ## 这批用例钉住什么
 *
 * 改前 node 侧用**两条字符串正则**（`privateIpPattern` / `loopbackPattern`），
 * 只认 RFC1918 点分十进制与 `localhost`/`127.x`。下列七类里**五类直接放行**并
 * 进入 `git clone`（云元数据是 SSRF 的头号目标）。python 侧（`_host_is_restricted`）
 * 早已覆盖全部七类 ⇒ 同一份任务在 python 被拒、在 node 放行。
 *
 * ## 与契约的对应关系
 *
 * 逐类对照 `packages/executor-protocol/protocol.json` 的 `networkPolicy.addresses`
 * （键名逐字相同）。**开关语义**由 `networkPolicy.switch` 规定：
 * **开关只放行 privateIPv4**，其余六类在任何开关状态下都拒。
 *
 * ## 反证方式
 *
 * 每条用例都写成「把闸退回字符串正则 / 把 categoryAllowed 写成 allow 就全放行
 * ⇒ 本用例转红」的形态。`privateIPv4 在开关开启时放行`那条是**对照项**——
 * 证明没有把闸开成 deny-all（否则任何内网 GitLab 拓扑都会被打死）。
 */
import {
  assertGitRepoNetworkPolicy,
  assertGitRepoNetworkPolicyResolved,
  categoryAllowed,
  gitRepoHost,
  type RestrictedCategory,
} from './git-repo-network-policy';
import { isRestrictedAddressForPolicy } from './lib/ssrf-guard';
import * as fs from 'node:fs';
import * as path from 'node:path';

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
);

// ── A7 的「改前放行 / 改后拒绝」表 ─────────────────────────────────────────
//
// 每一行 = 契约 networkPolicy 的一类，含：
//   category     : 契约键名（与 protocol.json 逐字对应）
//   url          : 该类的代表地址（多数用 IP 字面量 —— 同步闸即可判，避开 DNS）
//   wasAllowed   : **改前**（两条字符串正则）是否放行。true = 安全缺口。
const REJECTION_TABLE: {
  category: RestrictedCategory;
  url: string;
  wasAllowed: boolean;
  note: string;
}[] = [
  {
    category: 'loopback',
    url: 'http://127.0.0.1/x.git',
    wasAllowed: false,
    note: '改前正则已覆盖 127.x（这条是回归锁，非新增防护）',
  },
  {
    category: 'loopback',
    url: 'http://[::1]/x.git',
    wasAllowed: true,
    note: '**改前放行**：正则只认 127.x，不认 IPv6 回环',
  },
  {
    category: 'privateIPv4',
    url: 'http://10.0.0.1/x.git',
    wasAllowed: false,
    note: '改前正则已覆盖 RFC1918（开关关闭时拒）',
  },
  {
    category: 'linkLocal',
    url: 'http://169.254.169.254/latest/meta-data/',
    wasAllowed: true,
    note: '**改前放行**：云元数据（AWS/GCP/Azure 凭据端点）—— 本批最重要的修复',
  },
  {
    category: 'linkLocal',
    url: 'http://[fd00:ec2::254]/x.git',
    wasAllowed: true,
    note: '**改前放行**：AWS IPv6 元数据（ULA 段）',
  },
  {
    category: 'cgnat',
    url: 'http://100.64.0.1/x.git',
    wasAllowed: true,
    note: '**改前放行**：CGNAT 100.64/10',
  },
  {
    category: 'unspecified',
    url: 'http://0.0.0.0/x.git',
    wasAllowed: true,
    note: '**改前放行**：未指定地址（Linux 上「连本机」语义）',
  },
  {
    category: 'multicast',
    url: 'http://224.0.0.1/x.git',
    wasAllowed: true,
    note: '**改前放行**：组播（可用来打内网主机）',
  },
  {
    category: 'reserved',
    url: 'http://240.0.0.1/x.git',
    wasAllowed: true,
    note: '**改前放行**：保留段',
  },
];

describe('A7 契约对齐：networkPolicy.addresses 的七类与 protocol.json 一致', () => {
  it('分类器给出的七类键名与 protocol.json 的 addresses 键名逐字相同', () => {
    const contractKeys = Object.keys(protocol.networkPolicy.addresses).sort();
    const ourKeys = [
      'loopback',
      'privateIPv4',
      'linkLocal',
      'cgnat',
      'unspecified',
      'multicast',
      'reserved',
    ].sort();
    expect(ourKeys).toEqual(contractKeys);
  });

  it('契约里「只有 privateIPv4 可被开关放行」，分类器的组合规则与之一致', () => {
    const addresses = protocol.networkPolicy.addresses as Record<
      string,
      { allowedUnderPrivateNetwork: boolean }
    >;
    for (const [key, meta] of Object.entries(addresses)) {
      // 契约声明：开关开启时该类是否放行
      const contractAllows = meta.allowedUnderPrivateNetwork === true;
      // 我们的实现：开/关两种状态下分别判定
      const oursAllowedOn = categoryAllowed(key as RestrictedCategory, true);
      const oursAllowedOff = categoryAllowed(key as RestrictedCategory, false);
      // 开关关闭时**一律拒**（契约语义：默认全拒）
      expect(oursAllowedOff).toBe(false);
      // 开关开启时的判定必须与契约一致
      expect(oursAllowedOn).toBe(contractAllows);
    }
  });
});

describe('A7 拒绝清单：七类地址在 accept 期同步 400（含改前放行的五类）', () => {
  // 用 it.each 逐条展开，失败时点名是哪个 category / 哪个 URL
  it.each(REJECTION_TABLE.map((r) => [r.category + ' ' + r.url, r.url, r]))(
    '拒绝 %s',
    (_label, url, row) => {
      // 同步闸（IP 字面量形态）必须拒
      expect(() => assertGitRepoNetworkPolicy(url as string)).toThrow(
        /gitRepo URL 指向受限网络地址/,
      );
      // 分类器必须把它归到契约声明的类别（不是笼统的「受限」）
      const host = gitRepoHost(url as string);
      expect(isRestrictedAddressForPolicy(host)).toBe((row as { category: RestrictedCategory }).category);
    },
  );

  it('七类在**开关开启**时仍然拒绝（除 privateIPv4）', () => {
    const mustStillReject = [
      'http://127.0.0.1/x.git',
      'http://[::1]/x.git',
      'http://169.254.169.254/x.git',
      'http://[fd00:ec2::254]/x.git',
      'http://100.64.0.1/x.git',
      'http://0.0.0.0/x.git',
      'http://224.0.0.1/x.git',
      'http://240.0.0.1/x.git',
    ];
    for (const url of mustStillReject) {
      expect(() =>
        assertGitRepoNetworkPolicy(url, { allowPrivateNetwork: true }),
      ).toThrow(/gitRepo URL 指向受限网络地址/);
    }
  });
});

describe('A7 对照项：不把闸开成 deny-all', () => {
  it('privateIPv4 在**开关开启**时放行（内网自建 GitLab 是文档化拓扑）', () => {
    // 反证：把 categoryAllowed 改成「非 null 即拒」⇒ 本用例转红
    expect(() =>
      assertGitRepoNetworkPolicy('http://10.0.0.1/x.git', {
        allowPrivateNetwork: true,
      }),
    ).not.toThrow();
    expect(() =>
      assertGitRepoNetworkPolicy('http://192.168.1.1/x.git', {
        allowPrivateNetwork: true,
      }),
    ).not.toThrow();
  });

  it('privateIPv4 在**开关关闭**时拒绝（默认安全姿态）', () => {
    expect(() =>
      assertGitRepoNetworkPolicy('http://10.0.0.1/x.git', {
        allowPrivateNetwork: false,
      }),
    ).toThrow(/gitRepo URL 指向受限网络地址/);
  });

  it('公网地址**始终**放行（开关开或关都不拦）', () => {
    for (const allowPrivateNetwork of [true, false]) {
      expect(() =>
        assertGitRepoNetworkPolicy('http://8.8.8.8/x.git', { allowPrivateNetwork }),
      ).not.toThrow();
      expect(() =>
        assertGitRepoNetworkPolicy('https://github.com/o/r.git', { allowPrivateNetwork }),
      ).not.toThrow();
    }
  });

  it('scp-like 形态（git@host:path）的主机名解析正确', () => {
    expect(gitRepoHost('git@github.com:o/r.git')).toBe('github.com');
    expect(gitRepoHost('git@10.0.0.1:o/r.git')).toBe('10.0.0.1');
    expect(gitRepoHost('ssh://git@10.0.0.1:22/o/r.git')).toBe('10.0.0.1');
    expect(gitRepoHost('https://[::1]/x.git')).toBe('::1');
  });

  it('scp-like 形态指向私网/元数据也被拒', () => {
    expect(() =>
      assertGitRepoNetworkPolicy('git@169.254.169.254:o/r.git'),
    ).toThrow(/gitRepo URL 指向受限网络地址/);
    expect(() => assertGitRepoNetworkPolicy('git@10.0.0.1:o/r.git')).toThrow(
      /gitRepo URL 指向受限网络地址/,
    );
  });
});

describe('A7 DNS 级闸：主机名解析后逐地址判定（fail-closed）', () => {
  it('主机名解析到云元数据 ⇒ 拒绝（DNS rebinding 防线）', async () => {
    // 反证：去掉 async 闸、只留同步闸 ⇒ 本用例转红（主机名在同步闸里是放行的）
    await expect(
      assertGitRepoNetworkPolicyResolved('http://internal.corp/x.git', {}, async () => [
        '169.254.169.254',
      ]),
    ).rejects.toThrow(/gitRepo URL 指向受限网络地址/);
  });

  it('主机名解析到 CGNAT ⇒ 拒绝', async () => {
    await expect(
      assertGitRepoNetworkPolicyResolved('http://internal.corp/x.git', {}, async () => [
        '100.64.0.1',
      ]),
    ).rejects.toThrow(/gitRepo URL 指向受限网络地址/);
  });

  it('主机名**任一**解析地址受限 ⇒ 拒绝（不是「全都受限才拒」）', async () => {
    await expect(
      assertGitRepoNetworkPolicyResolved('http://mixed.corp/x.git', {}, async () => [
        '8.8.8.8',
        '127.0.0.1',
      ]),
    ).rejects.toThrow(/gitRepo URL 指向受限网络地址/);
  });

  it('DNS 解析失败 ⇒ fail-closed 拒绝（无法证明安全就不连）', async () => {
    await expect(
      assertGitRepoNetworkPolicyResolved('http://nxdomain.invalid/x.git', {}, async () => {
        throw new Error('ENOTFOUND');
      }),
    ).rejects.toThrow(/DNS 解析失败，fail-closed/);
  });

  it('解析出空地址表 ⇒ fail-closed 拒绝', async () => {
    await expect(
      assertGitRepoNetworkPolicyResolved('http://empty.corp/x.git', {}, async () => []),
    ).rejects.toThrow(/未解析出任何地址，fail-closed/);
  });

  it('主机名解析到公网 ⇒ 放行（对照项，证明 DNS 闸不是 deny-all）', async () => {
    await expect(
      assertGitRepoNetworkPolicyResolved('http://public.example/x.git', {}, async () => [
        '93.184.216.34',
      ]),
    ).resolves.toBeUndefined();
  });

  it('主机名解析到 privateIPv4：开关开启放行 / 关闭拒绝', async () => {
    const resolve = async () => ['10.0.0.5'];
    await expect(
      assertGitRepoNetworkPolicyResolved('http://internal.corp/x.git', {
        allowPrivateNetwork: true,
      }, resolve),
    ).resolves.toBeUndefined();
    await expect(
      assertGitRepoNetworkPolicyResolved('http://internal.corp/x.git', {
        allowPrivateNetwork: false,
      }, resolve),
    ).rejects.toThrow(/gitRepo URL 指向受限网络地址/);
  });

  it('IP 字面量不触发 DNS（同步闸已判，async 闸直接短路）', async () => {
    let resolveCalled = false;
    await expect(
      assertGitRepoNetworkPolicyResolved('http://8.8.8.8/x.git', {}, async () => {
        resolveCalled = true;
        return ['8.8.8.8'];
      }),
    ).resolves.toBeUndefined();
    expect(resolveCalled).toBe(false);
  });
});

/**
 * R89：`describeConnectionError` 的行为矩阵。
 *
 * 这条纯函数是 R86-A1 遗留② 的**收口点**：`config:test-connection` 此前把 `err.message` 原样回给
 * 渲染层，而 Node 的网络错误消息里带着**解析后的地址**（`connect ECONNREFUSED 192.168.1.5:3105`）
 * 与 `getaddrinfo ENOTFOUND <hostname>` —— 等于把这条通道变成 **DNS/内网端口探测器**。
 *
 * 修法不是禁私网（桌面端连的就是用户的 admin-api，`192.168.x.x` / `localhost` 是主要形态），
 * 而是**只回错误码文案、不回显解析结果**。本用例钉三件事：
 *  ① 常见 errno 各有稳定中文文案；
 *  ② **任何输入都不可能把地址带出来**（含未知码、注入域名/IP 的消息文本）；
 *  ③ 未知识别为 `未知错误` 而不是把原文回显。
 */
import * as assert from 'node:assert';
import {
  describeConnectionError,
  ipv4Rank,
  isUnusableIPv4,
  listLocalIPv4s,
} from './network-util';

function main(): void {
  // ① 已知 errno 的稳定文案
  const refused = describeConnectionError('ECONNREFUSED');
  assert.ok(refused.includes('连接被拒绝'), 'ECONNREFUSED 应说清“被拒绝”');
  assert.ok(describeConnectionError('ENOTFOUND').includes('无法解析'), 'ENOTFOUND 应说清“解析不了”');
  assert.ok(describeConnectionError('EAI_AGAIN').includes('无法解析'), 'EAI_AGAIN 同解析失败');
  assert.ok(describeConnectionError('EHOSTUNREACH').includes('不可达'), 'EHOSTUNREACH 应说清“不可达”');
  assert.ok(describeConnectionError('ETIMEDOUT').includes('超时'), 'ETIMEDOUT 应说清“超时”');
  assert.ok(describeConnectionError('ECONNRESET').includes('重置'), 'ECONNRESET 应说清“被重置”');
  assert.ok(describeConnectionError('DEPTH_ZERO_SELF_SIGNED_CERT').includes('TLS'), '证书错误应归到 TLS');

  // ② **不回显地址**：把真实报文形态与「长得像码」的注入都喂进去
  const hostileInputs: unknown[] = [
    'getaddrinfo ENOTFOUND internal.corp.example',
    'connect ECONNREFUSED 192.168.1.5:3105',
    'connect ECONNREFUSED ::1:3105',
    'ECONNREFUSED 10.0.0.7',
    null,
    undefined,
    123,
    { code: 'ECONNREFUSED', address: '10.0.0.7' },
  ];
  for (const input of hostileInputs) {
    const msg = describeConnectionError(input);
    for (const leak of ['192.168.1.5', '10.0.0.7', 'internal.corp.example', '::1', 'getaddrinfo']) {
      assert.ok(!msg.includes(leak), `文案不得包含 ${leak}（输入：${String(input)}）`);
    }
  }

  // ③ 未知码：回显**码本身**（那是常量枚举，不是数据），但不回显 message
  assert.equal(describeConnectionError('ESOMETHINGNEW'), '连接失败（ESOMETHINGNEW）');
  assert.equal(describeConnectionError(undefined), '连接失败（未知错误）');

  // ④ P1-1（生产实证 2026-10-22）：对外地址**排除段**与排序。
  //
  // 现场：执行器把「第一个非 internal IPv4」当对外地址上报，而装了 Clash 的机器
  // 上第一项恒为 198.18.0.1（fake-ip），于是整个机队上报同一个地址，中台侧
  // 反复告警「多份安装共享一个 address」。
  const denied = [
    '198.18.0.1', // Clash/Meta TUN fake-ip（跨机器相同 —— 本次事故的直接来源）
    '198.19.255.254',
    '169.254.1.1', // link-local
    '127.0.0.1', // loopback
    '0.0.0.0', // 监听地址，不是可路由地址
    '172.17.0.1', // docker 默认桥
    '224.0.0.1', // 多播
    '255.255.255.255',
    '192.0.2.10', // TEST-NET-1
    'not-an-ip',
  ];
  for (const ip of denied) {
    assert.ok(isUnusableIPv4(ip), `${ip} 不应作为对外地址`);
  }
  const allowed = ['192.168.1.40', '10.0.0.7', '172.20.5.5', '100.101.102.103', '8.8.8.8'];
  for (const ip of allowed) {
    assert.ok(!isUnusableIPv4(ip), `${ip} 应可作为对外地址`);
  }

  // 排序：局域网私网优先于 VPN/CGNAT 与公网（[0] 才是调用方的默认选择）。
  assert.ok(ipv4Rank('192.168.1.40') < ipv4Rank('10.0.0.7'), '192.168/16 应优先');
  assert.ok(ipv4Rank('10.0.0.7') < ipv4Rank('172.20.5.5'), '10/8 应优先于 172.16/12');
  assert.ok(ipv4Rank('172.20.5.5') < ipv4Rank('100.101.102.103'), '私网应优先于 CGNAT/Tailscale');
  assert.ok(ipv4Rank('100.101.102.103') < ipv4Rank('8.8.8.8'), 'CGNAT 仍优先于公网');

  // 实机遍历也必须不含被排除段（宿主装了 Clash/WSL/Docker 时尤其明显）。
  for (const ip of listLocalIPv4s()) {
    assert.ok(!isUnusableIPv4(ip), `listLocalIPv4s 返回了不可用地址 ${ip}`);
  }

  console.log(
    'network-util selftest: all assertions passed (connection error matrix, no-address-echo, address filtering/ranking)',
  );
}

main();

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
import { describeConnectionError } from './network-util';

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

  console.log('network-util selftest: all assertions passed (connection error matrix, no-address-echo)');
}

main();

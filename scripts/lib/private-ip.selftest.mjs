#!/usr/bin/env node
/**
 * `scripts/lib/private-ip.mjs` 的自检（RFC1918 判定 + 接口枚举 + 挑选优先级）。
 *
 * 为什么单独一个脚本：这个 helper 被多个真机自检共用（arch31-outbox-dup /
 * arch31-rollout-cross-instance），它的判据一旦错了 ⇒ 那些自检会**静默地**
 * 用错地址（要么红在环境上、要么红在判据上）。故判据本身必须被独立测。
 *
 * 判据面（全部用 fixture 注入，**不读真机网络**）：
 *   ① `isRfc1918`：三段各一条正例 + 四条反例（回环 / 169.254 / 100.64 / 公网）；
 *   ② `listPrivateIPv4`：只收 RFC1918、跳过 internal、跳过 IPv6；
 *   ③ `pickPrivateIPv4`：docker0 优先；无 docker0 时退化到首个；全无 ⇒ null。
 *
 * 最后一个反例最关键：**没有私网地址时必须返回 null**（调用方据此 skip），
 * 若返回 `undefined` 或空串，调用方的 `if (!HOST)` 判断虽也成立，但类型不一致
 * 会在后续 URL 拼接里变成 `http://undefined:port`。
 */
import assert from "node:assert/strict";

import { isRfc1918, listPrivateIPv4, pickPrivateIPv4 } from "./private-ip.mjs";

let passed = 0;
const failures = [];
const t = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ✔ ${name}`);
  } catch (err) {
    failures.push([name, err]);
  }
};

// ── ① isRfc1918 ──
t("10/8 正例", () => assert.equal(isRfc1918("10.0.0.1"), true));
t("172.16/12 正例（下界）", () => assert.equal(isRfc1918("172.16.0.1"), true));
t("172.31/12 正例（上界）", () => assert.equal(isRfc1918("172.31.255.254"), true));
t("192.168/16 正例", () => assert.equal(isRfc1918("192.168.1.1"), true));
t("反例：127.0.0.1（回环）", () => assert.equal(isRfc1918("127.0.0.1"), false));
t("反例：169.254.169.254（链路本地/云元数据）", () =>
  assert.equal(isRfc1918("169.254.169.254"), false));
t("反例：100.64.0.1（CGNAT，契约恒拒类）", () =>
  assert.equal(isRfc1918("100.64.0.1"), false));
t("反例：8.8.8.8（公网）", () => assert.equal(isRfc1918("8.8.8.8"), false));
t("反例：172.15.0.1（172.16/12 之下）", () =>
  assert.equal(isRfc1918("172.15.0.1"), false));
t("反例：172.32.0.1（172.16/12 之上）", () =>
  assert.equal(isRfc1918("172.32.0.1"), false));

// ── ② listPrivateIPv4 ──
const FIXTURE_INTERFACES = {
  lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
  eth0: [{ address: "192.168.3.47", family: "IPv4", internal: false }],
  docker0: [{ address: "172.17.0.1", family: "IPv4", internal: false }],
  eth1: [{ address: "fe80::1", family: "IPv6", internal: false }],
  pub: [{ address: "8.8.8.8", family: "IPv4", internal: false }],
};

t("listPrivateIPv4：只收 RFC1918 的非 internal IPv4",
  () => assert.deepEqual(listPrivateIPv4({ interfaces: FIXTURE_INTERFACES }), [
    "192.168.3.47",
    "172.17.0.1",
  ]));
t("listPrivateIPv4：跳过 internal（回环）接口",
  () => assert.ok(!listPrivateIPv4({ interfaces: FIXTURE_INTERFACES }).includes("127.0.0.1")));
t("listPrivateIPv4：跳过 IPv6",
  () => assert.ok(!listPrivateIPv4({ interfaces: FIXTURE_INTERFACES }).some((a) => a.includes(":"))));
t("listPrivateIPv4：一个私网都没有 ⇒ 空数组",
  () => assert.deepEqual(listPrivateIPv4({ interfaces: {} }), []));

// ── ③ pickPrivateIPv4 ──
t("pickPrivateIPv4：docker0 优先（172.17.x）",
  () => assert.equal(pickPrivateIPv4({ interfaces: FIXTURE_INTERFACES }), "172.17.0.1"));
t("pickPrivateIPv4：无 docker0 ⇒ 退化到首个 RFC1918",
  () => assert.equal(
    pickPrivateIPv4({
      interfaces: {
        eth0: [{ address: "192.168.3.47", family: "IPv4", internal: false }],
        pub: [{ address: "8.8.8.8", family: "IPv4", internal: false }],
      },
    }),
    "192.168.3.47",
  ));
t("pickPrivateIPv4：一个私网都没有 ⇒ null（调用方据此 skip）",
  () => assert.equal(pickPrivateIPv4({ interfaces: { lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }] } }), null));
t("pickPrivateIPv4：空接口表 ⇒ null",
  () => assert.equal(pickPrivateIPv4({ interfaces: {} }), null));

// ── 汇总 ──
if (failures.length > 0) {
  console.error(`\n✘ private-ip 自检失败：${failures.length} 条用例未通过`);
  for (const [name, err] of failures) console.error(`  ✘ ${name}: ${err?.message ?? err}`);
  process.exit(1);
}
console.log(`\n✔ private-ip 自检通过：${passed} 条用例`);

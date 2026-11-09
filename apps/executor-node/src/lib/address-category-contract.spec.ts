/**
 * R90（ADR-034 步骤 2 收口）：**兜底值与契约生成物逐字相等**。
 *
 * `address-category.ts` 必须保持 **0 import**（仓外判据用 `--experimental-strip-types`
 * 直接 import 它；无扩展名的相对导入在那条路径上解析不稳，R78 已实证）。
 * ⇒ 契约的 `allowedUnderPrivateNetwork` 由调用方注入（生产路径已注入）。
 *
 * 但仓外探针按**三参**调用 `verdictForAddress(addr, allow, metadata)` ⇒ 取默认值。
 * 默认值必须是契约的**真实值**（`['privateIPv4']`），不能是 `[]`：
 * 空数组 = fail-closed ⇒ 开关开启时 privateIPv4 被误拒 ⇒ 跨端判据 5 格假红（实测）。
 *
 * 本文件把「兜底 == 生成物」钉死：契约改了而兜底没跟 ⇒ 这里红。
 */
import { ALLOWED_UNDER_PRIVATE } from '../generated/protocol-categories';
import { DEFAULT_UNLOCKED_UNDER_SWITCH } from './address-category';

describe('R90 · 契约生成物 ↔ 兜底值', () => {
  it('DEFAULT_UNLOCKED_UNDER_SWITCH 与生成物的 ALLOWED_UNDER_PRIVATE 逐字相等', () => {
    expect([...DEFAULT_UNLOCKED_UNDER_SWITCH].sort()).toEqual(
      [...ALLOWED_UNDER_PRIVATE].sort(),
    );
  });

  it('生成物非空（空表 = 判据被关灯）', () => {
    expect(ALLOWED_UNDER_PRIVATE.length).toBeGreaterThan(0);
  });

  it('三参调用（探针形态）在开关开启时放行 privateIPv4', () => {
    // 探针就是这么调的：不传第四参
    const v = require('./address-category').verdictForAddress('10.0.0.1', true, []);
    expect(v.allowed).toBe(true);
    expect(v.category).toBe('privateIPv4');
  });

  it('三参调用在开关关闭时仍拒 privateIPv4（兜底不能放宽）', () => {
    const v = require('./address-category').verdictForAddress('10.0.0.1', false, []);
    expect(v.allowed).toBe(false);
  });
});

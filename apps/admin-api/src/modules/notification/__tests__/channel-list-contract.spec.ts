import { existsSync, readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";

import { AlertChannel } from "../notification.service";

/**
 * A4（DEEP_REVIEW §七 A4 · 契约单一事实源收口）：通知渠道清单的单一事实源。
 *
 * 渠道 id 在 admin-api 内部就有**两份**手写副本，彼此没有编译期耦合：
 *   ① `AlertChannel` 枚举（notification.service.ts）——DTO 用它做 `@IsIn` 与
 *      swagger enum，openapi / api-types 由它派生；
 *   ② 六个 channel 实现类的 `name = "..."`（channels/*.channel.ts）——真正决定
 *      「告警能发到哪」的是这份，不是枚举。
 * 再加 admin-web 的 `AlarmConfig` 手写选项列表，一共三份。
 *
 * 落这一段时实测已经漂了：`feishu` 在 ① 与 admin-web 通知设置页都在，唯独
 * `AlarmConfig` 的渠道选择器里没有——后端能发的渠道前端选不中。三份清单
 * 现在统一由 `packages/contract-fixtures/contract.json` 的 `channelList` 机检。
 */
describe("channelList contract (A4)", () => {
  const contract = loadContractFixture();
  const expected = new Set<string>(contract.channelList.channels);

  it("契约本身非空且无重复（判据自守）", () => {
    expect(expected.size).toBeGreaterThan(0);
    expect(contract.channelList.channels).toHaveLength(expected.size);
  });

  it("AlertChannel 枚举值集合 == 契约 channelList", () => {
    expect(new Set(Object.values(AlertChannel))).toEqual(expected);
  });

  it("六个 channel 实现类的 name 集合 == 契约 channelList", () => {
    const implemented = new Set(collectChannelClassNames());
    expect(implemented).toEqual(expected);
  });

  it("每个渠道都有对应实现类（枚举值不能悬空）", () => {
    // 与上一条互补：上一条防「实现类多了」，这一条防「枚举多了实现类没有」——
    // 单看集合相等其实够了，但相等失败时报的是整条集合，这条把缺口点名到具体渠道，
    // 便于新增渠道时知道该补哪一侧。
    const implemented = new Set(collectChannelClassNames());
    for (const channel of expected) {
      expect({ channel, implemented: implemented.has(channel) }).toEqual({
        channel,
        implemented: true,
      });
    }
  });
});

/** 扫描 channels/ 下所有 *.channel.ts 里声明的 `name = "..."`。 */
function collectChannelClassNames(): string[] {
  const dir = join(__dirname, "..", "channels");
  const names: string[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".channel.ts")) continue;
    const text = readFileSync(join(dir, file), "utf8");
    const m = /name\s*=\s*"([^"]+)"/.exec(text);
    if (m) names.push(m[1]);
  }
  return names;
}

/**
 * 按标记文件向上找仓库根再取 fixture——不要硬编码 `../`×N（层数随文件位置漂移，
 * A3 轮已因此踩过一次 ENOENT）。
 */
function loadContractFixture(): {
  channelList: { channels: string[] };
} {
  for (let dir = resolve(__dirname); ; dir = join(dir, "..")) {
    const candidate = join(
      dir,
      "packages",
      "contract-fixtures",
      "contract.json",
    );
    if (existsSync(candidate)) {
      return JSON.parse(readFileSync(candidate, "utf8"));
    }
    if (!existsSync(join(dir, "package.json")) && dir === resolve(dir, "..")) {
      throw new Error(
        "contract-fixtures/contract.json not found (repo root walk failed)",
      );
    }
  }
}

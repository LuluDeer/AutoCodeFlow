import { AgentMediaRetentionService } from "../agent-media-retention.service";

/**
 * F-5b（ARCH-27 配置收口）：Agent 媒体保留期的读取路径。
 *
 * 此前本服务裸读 env 键 "AGENT_MEDIA_RETENTION_DAYS"（ConfigService 的
 * process.env 回退）——Joi 已注册、configuration.ts 却未映射，属于审计登记
 * 的「注册面/映射面/消费面三方漂移」形态。收口后：configuration.ts 的
 * agent.mediaRetentionDays 承载 env 映射与默认值，本服务只读收口后的配置节，
 * 并保留一层防御性兜底（单测装配 ConfigService 缺席该节时回退 7）。
 */
describe("AgentMediaRetentionService.resolveRetentionDays（F-5b 配置收口）", () => {
  const makeService = (configValue: unknown) => {
    const config = { get: jest.fn().mockReturnValue(configValue) };
    const service = new AgentMediaRetentionService(
      // @Optional 的 LeaderGateService / mediaRepo 在本用例中不触达
      null as never,
      {} as never,
      config as never,
    );
    return { service, config };
  };

  it("读取收口后的 agent.mediaRetentionDays（不再裸读 env 键）", () => {
    const { service, config } = makeService(14);
    expect(
      (
        service as unknown as { resolveRetentionDays(): number }
      ).resolveRetentionDays(),
    ).toBe(14);
    expect(config.get).toHaveBeenCalledWith("agent.mediaRetentionDays");
  });

  it("缺省/非法值回退 7（roadmap §11 决策值，与旧运行时回退逐字节一致）", () => {
    for (const bad of [undefined, null, 0, -3, Number.NaN, "14"]) {
      const { service } = makeService(bad);
      expect(
        (
          service as unknown as { resolveRetentionDays(): number }
        ).resolveRetentionDays(),
      ).toBe(7);
    }
  });
});

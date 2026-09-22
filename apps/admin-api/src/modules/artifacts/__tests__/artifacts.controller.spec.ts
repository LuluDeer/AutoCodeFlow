import { Response } from "express";
import { ArtifactsController } from "../artifacts.controller";

/**
 * E-P2-P6：下载路由必须在响应头下发实际字节 sha256（X-SHA256）。
 * 这里只钉「controller 把 svc 返回的 sha256 写进 X-SHA256 响应头」这一契约，
 * 字节回环由 artifacts.service.spec 覆盖。
 */
describe("ArtifactsController.download（E-P2-P6 X-SHA256 头）", () => {
  it("把 openArtifact 返回的 sha256 写入 X-SHA256 响应头", async () => {
    const fakeSha =
      "9d06d8cd98ef94ef4f49c7d3d5e6a7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e";
    const svc = {
      openArtifact: jest.fn().mockResolvedValue({
        stream: { on: jest.fn() },
        fileSize: 11,
        contentType: "text/csv",
        sha256: fakeSha,
      }),
    } as unknown as ConstructorParameters<typeof ArtifactsController>[0];
    const controller = new ArtifactsController(svc);

    const setHeader = jest.fn();
    // res 不需要真正可写——header 在 pipeline 之前就已写定；pipeline 即便
    // 抛错也被 controller 的 try/catch 吞掉（记 warn），不影响本断言。
    const res = { setHeader } as unknown as Response;

    await expect(
      controller.download("exec-1", "report.csv", res),
    ).resolves.toBeUndefined();

    expect(svc.openArtifact).toHaveBeenCalledWith("exec-1", "report.csv");
    expect(setHeader).toHaveBeenCalledWith("X-SHA256", fakeSha);
  });
});

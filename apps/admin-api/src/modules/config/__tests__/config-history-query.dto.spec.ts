import { ValidationPipe, BadRequestException } from "@nestjs/common";
import { ConfigHistoryQueryDto } from "../dto/config-history-query.dto";

/**
 * R4 P1-1 regression: GET /config/history?key=...&page=... must pass the
 * global ValidationPipe whitelist. `key` previously lived only in a separate
 * @Query("key") param while the whole query object was validated against
 * PaginationDto (forbidNonWhitelisted), so every request carrying `key`
 * failed with 400 — the settings-page history drawer was permanently broken.
 */
describe("ConfigHistoryQueryDto", () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });

  function validate(value: object): Promise<ConfigHistoryQueryDto> {
    return pipe.transform(value, {
      type: "query",
      metatype: ConfigHistoryQueryDto,
    }) as Promise<ConfigHistoryQueryDto>;
  }

  it("accepts key + pagination (settings-page history drawer shape)", async () => {
    const result = await validate({ key: "executor.sharedToken", pageSize: "50" });
    expect(result.key).toBe("executor.sharedToken");
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(50);
  });

  it("accepts page/pageSize alone (key optional)", async () => {
    const result = await validate({ page: "3", pageSize: "10" });
    expect(result.key).toBeUndefined();
    expect(result.page).toBe(3);
  });

  it("accepts an empty query", async () => {
    const result = await validate({});
    expect(result.key).toBeUndefined();
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(20);
  });

  it("still rejects unknown properties (forbidNonWhitelisted)", async () => {
    await expect(validate({ key: "a", evil: "1" })).rejects.toThrow(
      BadRequestException,
    );
  });

  it("rejects a non-integer pageSize", async () => {
    await expect(validate({ key: "a", pageSize: "abc" })).rejects.toThrow(
      BadRequestException,
    );
  });
});

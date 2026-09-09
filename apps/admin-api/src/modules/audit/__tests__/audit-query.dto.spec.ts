import { ValidationPipe, BadRequestException } from "@nestjs/common";
import { AuditQueryDto } from "../dto/audit-query.dto";

/**
 * R4 P1-2 regression: GET /audit with the audit-page filter set
 * (action/resource/username/startTime/endTime) must pass the global
 * ValidationPipe whitelist. None of those fields were declared on
 * PaginationDto before, so adding any filter produced
 * "property x should not exist" 400s.
 */
describe("AuditQueryDto", () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });

  function validate(value: object): Promise<AuditQueryDto> {
    return pipe.transform(value, {
      type: "query",
      metatype: AuditQueryDto,
    }) as Promise<AuditQueryDto>;
  }

  it("accepts the full admin-web filter set", async () => {
    const result = await validate({
      page: "1",
      pageSize: "20",
      action: "auth.login",
      resource: "user",
      username: "admin",
      startTime: "2026-01-01T00:00:00.000Z",
      endTime: "2026-01-31T23:59:59.000Z",
    });
    expect(result.action).toBe("auth.login");
    expect(result.resource).toBe("user");
    expect(result.username).toBe("admin");
    expect(result.startTime).toBe("2026-01-01T00:00:00.000Z");
    expect(result.endTime).toBe("2026-01-31T23:59:59.000Z");
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(20);
  });

  it("accepts userId as a coerced integer", async () => {
    const result = await validate({ userId: "42" });
    expect(result.userId).toBe(42);
  });

  it("accepts plain pagination only", async () => {
    const result = await validate({ page: "2" });
    expect(result.action).toBeUndefined();
    expect(result.username).toBeUndefined();
    expect(result.page).toBe(2);
  });

  it("still rejects unknown properties (forbidNonWhitelisted)", async () => {
    await expect(validate({ action: "x", evil: "1" })).rejects.toThrow(
      BadRequestException,
    );
  });

  it("rejects a malformed startTime (not ISO 8601)", async () => {
    await expect(validate({ startTime: "not-a-date" })).rejects.toThrow(
      BadRequestException,
    );
  });

  // AUTH-05: the (resource, resourceId) pair filter rides the same whitelist
  // — declared fields pass, undeclared ones still 400 (W4 discipline kept).
  it("AUTH-05: accepts resourceId and passes the whitelist", async () => {
    const result = await validate({ resource: "executor", resourceId: "e-1" });
    expect(result.resource).toBe("executor");
    expect(result.resourceId).toBe("e-1");
  });
});

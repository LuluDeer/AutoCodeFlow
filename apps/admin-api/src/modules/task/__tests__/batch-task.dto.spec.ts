import { ValidationPipe, BadRequestException } from "@nestjs/common";
import {
  BatchTaskIdsDto,
  BATCH_TASK_IDS_MAX_SIZE,
} from "../dto/batch-task.dto";

/**
 * R-18（DEEP_REVIEW 0ef3bbe）: 批量任务 ID 列表的 ArrayMaxSize 回归。
 * 批量端点用 Promise.all 并发触发/暂停/删除——一次请求携数千 uuid 会炸开成
 * 数千并发事务。这里钉住超过 BATCH_TASK_IDS_MAX_SIZE 的请求体必须在
 * 全局 ValidationPipe 层被拒为 400，不进 service。
 */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

const validate = (value: object) =>
  pipe.transform(value, {
    type: "body",
    metatype: BatchTaskIdsDto,
  }) as Promise<BatchTaskIdsDto>;

// 合法 v4 uuid 生成（校验器仅校验形态，不要求真实存在）
const uuid = (i: number) =>
  `11111111-2222-4333-8444-${String(i).padStart(12, "0")}`;

describe("BatchTaskIdsDto (R-18 ArrayMaxSize)", () => {
  it("accepts a within-limit list of valid v4 uuids", async () => {
    const ids = [uuid(1), uuid(2), uuid(3)];
    const result = await validate({ taskIds: ids });
    expect(result.taskIds).toHaveLength(3);
  });

  it("rejects an empty list (ArrayMinSize(1))", async () => {
    await expect(validate({ taskIds: [] })).rejects.toThrow(
      BadRequestException,
    );
  });

  it("rejects a list above the hard cap with 400", async () => {
    const ids = Array.from({ length: BATCH_TASK_IDS_MAX_SIZE + 1 }, (_, i) =>
      uuid(i),
    );
    await expect(validate({ taskIds: ids })).rejects.toThrow(
      BadRequestException,
    );
  });

  it("accepts exactly the hard cap (boundary)", async () => {
    const ids = Array.from({ length: BATCH_TASK_IDS_MAX_SIZE }, (_, i) =>
      uuid(i),
    );
    const result = await validate({ taskIds: ids });
    expect(result.taskIds).toHaveLength(BATCH_TASK_IDS_MAX_SIZE);
  });

  it("rejects non-uuid entries", async () => {
    await expect(
      validate({ taskIds: ["not-a-uuid", uuid(1)] }),
    ).rejects.toThrow(BadRequestException);
  });
});

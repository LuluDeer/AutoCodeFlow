import { ValidationPipe, BadRequestException } from "@nestjs/common";
import { UpdateTaskDto } from "../dto/update-task.dto";
import { CreateTaskDto } from "../dto/create-task.dto";

/**
 * QA-01 回归锚：表单载体字段 upstreamDependencies 不得进入请求体。
 *
 * TaskFormPage.handleSubmit 取 form.getFieldsValue(true)（**全部**已注册字段），
 * buildExecutorPayload 以 `{ ...values }` 原样透传（见 admin-web executor-mode.ts）。
 * 表单存在 Form.Item name="upstreamDependencies"（TaskFormPage.tsx），而
 * CreateTaskDto 只声明 dependencies —— 编辑态 setFieldValue 恒把该字段置为数组
 * （无依赖时 []），一旦未被剥离即以未声明键出现在 PATCH/POST body。
 *
 * main.ts 全局管道开启 whitelist + forbidNonWhitelisted → 400，前端表现为
 * 「界面已切换、服务端旧值不变」（e2e 例 23/24 连红根因）。前端修复见
 * applyDependenciesPayload（delete 载体键）；本 spec 用与 main.ts 相同的管道配置
 * 钉死「载体键只要出现就必须被拒」这一后端契约，防止未来有人把 delete 改回置 null。
 * 值为 null 的未声明键同样触发 400（whitelist 按 Object.keys 判定），故修复必须用
 * delete 而非置空。
 */
describe("UpdateTaskDto/CreateTaskDto vs 表单负载（upstreamDependencies 泄漏契约）", () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });

  const validateUpdate = (value: object) =>
    pipe.transform(value, {
      type: "body",
      metatype: UpdateTaskDto,
    }) as Promise<UpdateTaskDto>;

  const validateCreate = (value: object) =>
    pipe.transform(value, {
      type: "body",
      metatype: CreateTaskDto,
    }) as Promise<CreateTaskDto>;

  // 编辑页实际提交的字段形状（TaskFormPage 表单 + buildExecutorPayload + apply*）
  const formShaped = {
    name: "e2e-residue-123456",
    runtime: "node",
    entrypoint: "index.js",
    triggerType: "manual",
    executeMode: "single",
    executorId: null,
    executorAppName: null,
    executorGroup: null,
    executorTags: null,
    requirements: null,
    dependencies: null,
  };

  it("基线：已剥离载体的表单负载通过（修复后的真实形状）", async () => {
    const result = await validateUpdate(formShaped);
    expect(result.name).toBe("e2e-residue-123456");
  });

  it("含 upstreamDependencies: []（编辑态置空后的漏剥离形状）→ 400", async () => {
    await expect(
      validateUpdate({ ...formShaped, upstreamDependencies: [] as string[] }),
    ).rejects.toThrow(BadRequestException);
  });

  it("含 upstreamDependencies: [id]（用户确实选了上游）→ 400", async () => {
    await expect(
      validateUpdate({
        ...formShaped,
        upstreamDependencies: ["550e8400-e29b-41d4-a716-446655440000"],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it("创建向导（POST）同样携带 upstreamDependencies → 400", async () => {
    await expect(
      validateCreate({
        name: "e2e-pin-123456",
        runtime: "node",
        entrypoint: "index.js",
        triggerType: "manual",
        executeMode: "single",
        executorId: null,
        upstreamDependencies: [],
      }),
    ).rejects.toThrow(BadRequestException);
  });
});

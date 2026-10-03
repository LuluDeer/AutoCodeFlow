/**
 * B-4: 官方模板 config 与 CreateTaskDto 校验口径的守卫 spec。
 *
 * ## 为什么需要
 *
 * OFFICIAL_TASK_TEMPLATES（task-template.constants.ts）是迁移 seed 的单一事实
 * 源——官方模板**不经 create 端点**（那是自定义模板的唯一校验点），由迁移直接
 * 落库。若 DTO 演进（CreateTaskDto 白名单/约束收紧）后无人发现官方 config 已
 * 不合法，漂移会潜伏到用户「从模板一键实例化」时才 400——离故障源头隔了迁移
 * + 实例化两步，排查代价高。本 spec 对每个官方 config 跑
 * assertValidTaskTemplateConfig（与 create 端点同源的校验设施），秒级红灯。
 *
 * 注意它是「常量↔校验器」的对齐守卫：改 CreateTaskDto 语义时它强制你同时
 * 评估五个官方模板；改官方模板字段时它强制先过校验器。
 */
import { OFFICIAL_TASK_TEMPLATES } from "../task-template.constants";
import { assertValidTaskTemplateConfig } from "../task-template.util";
import { OFFICIAL_TEMPLATE_KEYS } from "../task-template.constants";

describe("B-4: 官方模板 config 全量过 assertValidTaskTemplateConfig", () => {
  it("官方模板 key 清单与 seed 单一事实源一致（防两处维护漂移）", () => {
    expect(OFFICIAL_TEMPLATE_KEYS).toEqual(
      OFFICIAL_TASK_TEMPLATES.map((t) => t.key),
    );
    expect(OFFICIAL_TASK_TEMPLATES.length).toBeGreaterThan(0);
  });

  it.each(OFFICIAL_TASK_TEMPLATES.map((t) => [t.key, t.config] as const))(
    "官方模板「%s」的 config 是合法 CreateTaskDto 子集",
    async (_key, config) => {
      // 校验器对非法 config 抛 BadRequestException（字段级原因在消息里）。
      // 与 create 端点（自定义模板唯一校验点）同源——官方模板不经该端点，
      // 这里就是它们唯一的校验时刻。
      await expect(assertValidTaskTemplateConfig(config)).resolves.toBe(config);
    },
  );

  it("官方 config 均非空对象（空对象缺 CreateTaskDto 必填项，实例化必 400）", () => {
    for (const t of OFFICIAL_TASK_TEMPLATES) {
      expect(Object.keys(t.config).length).toBeGreaterThan(0);
    }
  });
});

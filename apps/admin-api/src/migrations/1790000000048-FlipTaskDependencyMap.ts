import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * FIX-1.1（依赖链契约翻转）：tasks.dependencies 的存量行从旧契约
 * `{上游任务uuid: 上游显示名}` 翻转为新契约 `{显示名: 上游任务uuid}`——
 * **value 才是依赖任务 id**。
 *
 * 背景：旧实现（前端 buildDependenciesPayload + 后端 DTO 文档）把映射写成
 * `{taskId: taskName}`（value=名字），而全部语义消费方——环检测
 * detectCycle（findOne({id: value})）、依赖满足判定 checkDependencies、
 * 上游 SUCCESS 扇出匹配 triggerDependentTasks、前端 DAG 图（dag-layout）——
 * 读的都是 **value**。value 存的是名字 → 这些判定全部静默失效（深层环放行、
 * 依赖链永不触发、DAG 图断边）。代码侧（前端 payload 构造 / 后端写面校验
 * assertDependencyValuesExist）已随契约翻转；本迁移负责把**已经写坏的历史行**
 * 刷成新契约，否则存量任务的依赖链在新代码下依旧静默失效。
 *
 * 逐条目判定（不是整行判定——同一行内可能混有已翻转/未翻转条目）：
 *  - key 是 UUID 且 value 不是 → 旧契约条目，翻转为 `{value: key}`；
 *  - 其余（key=显示名/value=id 的新契约条目、key 与 value 同为 id 的降级条目、
 *    双向都不是 id 的脏数据）→ 原样保留。
 *  这使重放天然幂等：翻转后的条目 key=显示名（非 UUID）不再命中判定，
 *  降级条目 value=id 也不再命中。
 *
 * key 冲突降级（与前端 buildDependenciesPayload 同语义）：两个上游任务同名、
 * 或翻转目标 key 已被既有条目占用时，展示别名让位语义位——后者降级 key=uuid，
 * 保证 value（扇出/环检测的判据）永不丢失。先处理到的条目保留显示名 key。
 *
 * 行级短路：翻转结果与原值深比较相同（整行已在新契约形态）则不发 UPDATE，
 * 重复执行零写放大。
 *
 * down：对称回翻（key 非 UUID 且 value 是 UUID 的条目 → `{value: key}`）。
 * 降级成 key=id 的条目无法恢复原显示名（迁移前未留名映射），down 后这些条目
 * 保持 `{id: id}` 形态——可接受：down 本身是回滚到旧代码场景，旧代码按
 * value=名字 消费，`{id: id}` 在旧语义下只是"依赖一个不存在的名字"，
 * 不会比迁移前的静默失效更糟。
 */

/** 任务主键为 uuid v4 形态（小写/大写均可）；宽松匹配 8-4-4-4-12 hex。 */
const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * 纯函数翻转单行 dependencies 映射（供迁移与单测共用——迁移内不做内联
 * SQL/DO 块，让翻转语义可被无 PG 的单测环境逐条验证）。
 *
 * @param deps 行内映射原值（假定来自 jsonb object；非对象由调用方过滤）
 * @param direction up=旧契约翻新（{uuid:name}→{name:uuid}）；
 *                 down=对称回翻（{name:uuid}→{uuid:name}）
 */
export function flipDependencyMap(
  deps: Record<string, string>,
  direction: "up" | "down" = "up",
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(deps ?? {})) {
    const needsFlip =
      direction === "up"
        ? UUID_RE.test(key) && !UUID_RE.test(value)
        : !UUID_RE.test(key) && UUID_RE.test(value);
    if (!needsFlip) {
      out[key] = value;
      continue;
    }
    // 翻转：key/value 互换。冲突降级——目标 key 已被先处理条目占用时，
    // 展示别名让位，key 保留原 uuid（value 语义位不丢）。
    const newKey = out[value] !== undefined ? key : value;
    out[newKey] = key;
  }
  return out;
}

export class FlipTaskDependencyMap1790000000048 implements MigrationInterface {
  name = "FlipTaskDependencyMap1790000000048";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.flipAll(queryRunner, "up");
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.flipAll(queryRunner, "down");
  }

  private async flipAll(
    queryRunner: QueryRunner,
    direction: "up" | "down",
  ): Promise<void> {
    // jsonb_typeof 兜底：脏形态（数组/标量/null）整行跳过——迁移只负责
    // object 形态的契约翻转，不做数据清洗。
    const rows: Array<{ id: string; dependencies: Record<string, string> }> =
      (await queryRunner.query(
        `SELECT "id", "dependencies" FROM "tasks"
         WHERE "dependencies" IS NOT NULL
           AND jsonb_typeof("dependencies") = 'object'`,
      )) ?? [];
    for (const row of rows) {
      const flipped = flipDependencyMap(row.dependencies, direction);
      // 行级短路：整行已是目标契约形态时不发 UPDATE（幂等重放零写放大）。
      if (JSON.stringify(flipped) === JSON.stringify(row.dependencies)) {
        continue;
      }
      await queryRunner.query(
        `UPDATE "tasks" SET "dependencies" = $1::jsonb WHERE "id" = $2`,
        [JSON.stringify(flipped), row.id],
      );
    }
  }
}

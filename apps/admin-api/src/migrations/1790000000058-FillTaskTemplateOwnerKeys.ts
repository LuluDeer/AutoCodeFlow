import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * R39-A1 后续：把**历史** task_templates 的属主键从裸 username 回填为 user:<id>|<username>。
 *
 * ## 为什么需要一条 data-only 迁移（不改 schema）
 *
 * R39-A1 把新写入的属主键改成 user:<id>|<username>（id 权威、username 段仅可读），判定走
 * isTemplateOwner：新键比 id、历史行（裸 username）仍比 username。后者是**兼容路径**——
 * 去掉它历史模板就会变成「谁都删不掉」。但兼容路径本身留着一个残余风险：users.service.remove()
 * 是**硬删除**，users.username 唯一索引随之释放 ⇒ 同名新注册账号能删掉历史行主人留下的模板。
 *
 * 这条迁移把「**属主仍然存在**」的历史行一次性升级成键（JOIN users ON username），于是这批行
 * 的判定也变成按 id，残余风险清零。属主**已被删**的行保持 legacy（它们本来就没有可解析的正确属主，
 * 任何猜测都是错的——把它们判给某个 id 才是真正的数据污染）。
 *
 * ## 三条刻意的取舍
 *
 * 1. **只 UPDATE、不改 schema**：createdBy 仍是 varchar(100)，只是内容换成键形态。可逆
 *    （down 用正则剥掉前缀即可回到裸 username），不需要双写兼容期。
 * 2. **截断只作用于 username 段**：键前缀 user:<id>| 最多约 16 字符（id 是 serial int），
 *    left(..., 100) 只会裁 username 尾巴，绝不会截断 id 段。反过来若先拼再左截而不考虑顺序，
 *    理论上可以把 id 截断成不可解析的形态——那会让该行从「按 id 判定」悄悄退回 legacy，
 *    这是本迁移最需要避免的失败模式（由 spec 钉住 left 的用法）。
 * 3. **幂等**：WHERE "createdBy" !~ '^user:[0-9]+\|' 让已升级的行不被二次处理，重放安全。
 *    注意反斜线竖线在 PG 正则里是**字面量竖线**（不是 alternation）——写错会让整个谓词失效。
 *
 * ## 数据风险
 *
 * 只读 users 做 JOIN、只写 task_templates 的 createdBy 列；不删行、不建索引、不锁表
 * （单条 UPDATE，行数 = 自定义模板数，量级百级）。回滚见 down。
 */
export class FillTaskTemplateOwnerKeys1790000000058 implements MigrationInterface {
  name = "FillTaskTemplateOwnerKeys1790000000058";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "task_templates" t
      SET "createdBy" = left('user:' || u.id::text || '|' || u.username, 100)
      FROM "users" u
      WHERE t."createdBy" = u.username
        AND t."createdBy" !~ '^user:[0-9]+\|'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 反向：把键还原成裸 username（只处理本迁移可能写过的新键形态）。
    // 刻意不做「按 id 反查当前 username」——那是另一次数据推断；revert 的语义应只是
    // 撤掉这次写入的内容，而不是重新解释属主。
    await queryRunner.query(`
      UPDATE "task_templates"
      SET "createdBy" = regexp_replace("createdBy", '^user:[0-9]+\|', '')
      WHERE "createdBy" ~ '^user:[0-9]+\|'
    `);
  }
}

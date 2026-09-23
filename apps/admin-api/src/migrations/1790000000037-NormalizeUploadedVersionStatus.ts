import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * 存量修复：把「zip 上传即产生版本」当初写下的 `status='uploaded'` 版本行
 * 归一为 `status='released'`。
 *
 * 背景（用户报障）：0c67ccfd 引入 `ApplicationService.recordUploadVersion`，
 * 让 zip 上传也落 application_versions 快照，本意是「上传的包也能在版本历史里
 * 回滚」。但该实现把 status 写成了 `'uploaded'`，而回滚面的判据历来只认
 * `'released'`：
 *   · 后端 `rollbackApplication`  → `if (version.status !== "released") throw 400`
 *   · 后端 `rollbackDeploymentToPrevious` → `where status: "released"`
 *   · 前端 `ApplicationDetailPage` → `rollbackDisabled = record.status !== 'released'`
 * 于是**每一个 zip 上传出来的旧版本**在版本历史里都恒显示
 * 「仅已发布版本可回滚」且按钮永久禁用——正是用户看到的"旧版本明明也是 zip
 * 包上传的，为什么说只有已发布版本可回滚"。
 *
 * 代码侧已改为直接写 `'released'`（与部署路径 `saveVersionSnapshot(..., "released")`
 * 统一语义）；本迁移负责把**已经写坏的历史行**刷回来，否则存量用户即便升级到
 * 新版，其既有 zip 版本仍永远不可回滚（只能靠重新上传同一版本号，而上游
 * dedupe 命中 `sourceDeploymentId IS NULL` 时又会直接 return，连刷都刷不掉）。
 *
 * 范围严格限定为「上传来源」的行：`sourceDeploymentId IS NULL` 且
 * `status = 'uploaded'`。部署路径产生的行 sourceDeploymentId 非空，其 status
 * （deploying/released/failed）由部署生命周期驱动，**不得**被本迁移触碰——那会
 * 把在途/失败的部署版本误标成已发布。
 *
 * `'uploaded'` 是本轮新引入的字面量，此前没有任何代码写入过它，故本迁移只会
 * 命中 0c67ccfd 之后新产生的行；重放无副作用（UPDATE 幂等）。
 *
 * down：不还原。`'uploaded'` 是缺陷取值，把它写回去等于重新制造该 bug；回滚
 * 语义由代码与前端判据共同决定，没有"恢复坏状态"的合理诉求（先例：数据修复类
 * 迁移的 down 一律 no-op）。
 */
export class NormalizeUploadedVersionStatus1790000000037 implements MigrationInterface {
  name = "NormalizeUploadedVersionStatus1790000000037";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "application_versions"
      SET "status" = 'released'
      WHERE "status" = 'uploaded'
        AND "sourceDeploymentId" IS NULL
    `);
  }

  public async down(): Promise<void> {
    // 有意为之的空操作：见类注释（不还原缺陷取值）。
  }
}

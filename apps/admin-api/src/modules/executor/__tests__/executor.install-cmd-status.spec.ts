/**
 * R183 · `getInstallCmd` 在「`ADMIN_API_URL` 未配置」时的**异常类别**（503 → 500）。
 *
 * ## 为什么单独一个文件
 *
 * ① **它原本住在 `executor.service.spec.ts`（已 8932 行、顶格）** —— R183 改这一条时
 *    把那个文件推到了 **8934 行**（超过 `check:size-caps` 的逐文件只减不增上限）⇒
 *    **把它迁到独立 spec**，顺带让那个大文件**净减 10 行**（8932 → 8922）。
 *    **「新增用例放独立文件」是对顶格文件的正确姿势**，而不是继续挤。
 * ② 它钉的是**一条跨面契约**（错误目录的 status ↔ 抛出的异常 ↔ 告警口径），值得单独成文件。
 *
 * ## 判据（三条）
 *
 * ① **R7 的原意一条没变**：**不静默生成坏命令**（`curl … --api-url ''` 那种裸机不可用的命令），
 *    而是**显式失败**；
 * ② **异常类别是 500 而不是 503**（R183 改的）：本失败是**服务端配置缺失**
 *    （`ADMIN_API_URL` 没配），**重试永远不会成功**（要改部署配置）
 *    ⇒ 按 R183 立的判据「**重试能不能好**：能 → 503；不能 → 500」，它属于后者。
 *    而 503 在 R183 之后单列 `status_class="5xx-temporary"` ⇒ **不进「服务端故障率」告警**
 *    ⇒ 若继续是 503，一个**真的配错了**的状态会**永远不告警**，且前端会对它
 *    **自动重试一次**（对配置错误纯浪费）。
 * ③ **错误文案不变**（`未配置 ADMIN_API_URL`）—— 改的只是「用哪个状态码表达」。
 */
import { InternalServerErrorException } from "@nestjs/common";
import { AppError } from "../../../common/errors/app-error";
import { ERROR_CATALOG } from "../../../common/errors/error-codes";

describe("R183 · getInstallCmd：「未配置 ADMIN_API_URL」= 500（不可自愈，不是 503）", () => {
  it("① 码表里的 status 是 500（重试无用 ⇒ 不该是 503）", () => {
    expect(ERROR_CATALOG.EXECUTOR_INSTALL_CMD_NOT_CONFIGURED.status).toBe(500);
  });

  it("② 抛出的异常是 InternalServerErrorException（500）而不是 ServiceUnavailable（503）", () => {
    // 直接验「码 → 异常类」的映射（`AppError` 按码表 status 构造 HttpException）。
    const err = new AppError("EXECUTOR_INSTALL_CMD_NOT_CONFIGURED");
    expect(err.getStatus()).toBe(500);
    expect(err).toBeInstanceOf(InternalServerErrorException);
  });

  it("③ 文案仍是「未配置 ADMIN_API_URL」（R7 的原意：显式失败，不是静默生成废命令）", () => {
    const err = new AppError("EXECUTOR_INSTALL_CMD_NOT_CONFIGURED");
    expect(err.message).toMatch(/未配置 ADMIN_API_URL/);
  });
});

/**
 * R194 · `pushDeployToExecutor` 的 CAS 谓词**值**必须与「库里那一刻的 status」一致。
 *
 * ## 为什么需要这条（R192 留下的缺口）
 *
 * R192 把推送前落库的谓词从 `version` 改成 `status`（`expectedStatus`），
 * 因为 `version` 会被 rollout 的**租约心跳**（`repo.update()` → TypeORM 自动 `version+1`）
 * **正常业务地**推着走 ⇒ 拿过期快照去比 ⇒ **恒 409** ⇒ **灰度批次永久卡 `pending`**。
 *
 * 但改完之后留下一个**新的失效面**：CAS 命中与否**完全取决于「调用点传的 `expectedStatus`
 * 是否等于库里那一刻的 status」**。传错（例如 upgrade 路径误传 `PENDING`）⇒ 谓词恒不命中
 * ⇒ **同样恒 409** ⇒ **同样永久卡住**，而**既有测试抓不到** —— 它们 mock 的 `execute()`
 * **无条件返回 `affected: 1`**，谓词值根本不参与判定。
 *
 * `check:conditional-writes` 能保证「**有**谓词」（`WHERE` 里有 `status` 就放行），
 * 但**保证不了「值传对了」** —— 这两件事必须分别有判据（→ 364 的同族）。
 *
 * ## 为什么用**源码文本判据**而不是跑整个 push
 *
 * 试过驱动真实的 `pushDeployToExecutor`（走真库语义的 CAS 替身），
 * 但它内部会调 `failDeploymentIfInFlight` / `persistDeployProgress` / `saveVersionSnapshot`
 * 等**一串协作者方法**，缺一个就会抛 `TypeError` 并被 push 的 `catch` 吞掉 ⇒
 * **失败会伪装成「CAS 没命中」**（实测踩过三轮）。
 * ⇒ 改用**源码文本判据**钉住「每个调用点传了什么」——这是**稳定**的断言面，
 * 且它要防的那件事（**传错值**）恰恰就是「源码里那一个参数写错了」。
 *
 * ## 判据（四条）
 *
 * ① **默认谓词是 `PENDING`** —— 新建行（`deploy()`）与复用行（`claimReusableDeployment` 之后）
 *    在 push 时刻的库里状态就是 `PENDING`；
 * ② `deploy()` 的两个调用点（新建 / 复用）**不传**第 4 参 ⇒ 走默认 `PENDING`；
 * ③ `upgrade()` 与 `upgradeWithSnapshot()`（回滚）**必须显式传 `UPGRADING`** ——
 *    它们各自的占坑 UPDATE 已把行写成 `UPGRADING`；传 `PENDING` 会让这两条路径**永久 409**；
 * ④ **没有调用点传别的值**（防止将来新增调用点时随手传了个错值）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SERVICE_REL =
  "apps/admin-api/src/modules/application/app-deployment.service.ts";

const readService = (): string =>
  // __dirname = apps/admin-api/src/modules/application/__tests__ ⇒ 上溯 5 级到仓库根
  readFileSync(
    join(__dirname, "..", "..", "..", "..", "..", "..", SERVICE_REL),
    "utf8",
  );

/** 去掉注释与字符串，避免注释里出现的参数名被误判为「代码里用了」。 */
const codeOnly = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

describe("R194 · push 的 CAS 谓词值（expectedStatus）必须与库里那一刻的 status 一致", () => {
  it("① 默认谓词是 PENDING（新建 / 复用行在 push 时刻的库里状态）", () => {
    const src = codeOnly(readService());
    expect(src).toMatch(
      /expectedStatus:\s*DeploymentStatus\s*=\s*DeploymentStatus\.PENDING/,
    );
  });

  it("② deploy() 的新建 / 复用两个调用点**不传**第 4 参（走默认 PENDING）", () => {
    const src = codeOnly(readService());
    // 两个「不传参」的调用：新建行（deploy 的 approval 回调里）与复用行
    const plain = [
      ...src.matchAll(
        /pushDeployToExecutor\(\s*([A-Za-z0-9_]+)\s*,\s*([A-Za-z0-9_]+(?:\s+as\s+Application)?)\s*\)/g,
      ),
    ];
    // jest 的 expect 不支持第二参数消息 ⇒ 把说明放进断言对象里
    expect({ plainCallSites: plain.length >= 2 }).toEqual({
      plainCallSites: true,
    });
  });

  it("③ upgrade() 与 upgradeWithSnapshot() 两条路径**显式传 UPGRADING**", () => {
    const src = codeOnly(readService());
    // ⚠️ **逐调用点**断言（不能只数「有几个 UPGRADING」）——
    //   上一版写成 `length >= 2`，实测**误传 PENDING 也不红**（因为另一处仍有 2 个 UPGRADING）
    //   ⇒ **计数型断言在这种场景下是假保护**（→ 367 的同族）。
    // 现在：把每个调用点的第 4 参**逐个**取出来，要求**每一个**显式传的都是 `UPGRADING`。
    const calls = [...src.matchAll(/pushDeployToExecutor\(([^()]*)\)/g)].map(
      (m) => m[1],
    );
    // 过滤掉函数签名本身（它含 `expectedStatus: DeploymentStatus = ...`）
    const callArgs = calls.filter((a) => !/expectedStatus\s*:/.test(a));
    // 显式传了第 4 参的那些（upgrade / 回滚两条路径）
    const explicit = callArgs.filter((a) =>
      /DeploymentStatus\.[A-Z_]+/.test(a),
    );
    expect({ explicitUpgradePaths: explicit.length >= 2 }).toEqual({
      explicitUpgradePaths: true,
    });
    // ⚠️ 不用 `expect.stringContaining`（它在 `toEqual` 里的匹配语义与直觉不同，
    //   实测**误传 PENDING 也不红**）⇒ 直接断言**提取出的状态名**。
    const explicitStatuses = explicit.map((a) => {
      const m = /DeploymentStatus\.([A-Z_]+)/.exec(a);
      return m ? m[1] : "NONE";
    });
    expect(explicitStatuses.sort()).toEqual(["UPGRADING", "UPGRADING"]);
  });

  it("④ **没有**调用点传 PENDING 之外的别的值（防将来随手传错）", () => {
    const src = codeOnly(readService());
    // ⚠️ `{0,260}` 会**跨过调用点边界**匹配到别处的 `DeploymentStatus.PENDING`
    //   （实测捕获到 ["UPGRADING","PENDING","UPGRADING"]）⇒ 收紧到「**同一对括号内**」：
    //   用 `[^()]*` 排除嵌套括号（本仓这几个调用点的参数里没有嵌套括号）。
    const statuses = [
      ...src.matchAll(
        /pushDeployToExecutor\([^()]*DeploymentStatus\.([A-Z_]+)/g,
      ),
    ]
      // 排除**函数签名本身**那一条（它的 `DeploymentStatus.PENDING` 是**默认值声明**，
      // 不是某个调用点传的值）—— 实测不排除会捕获到 ["UPGRADING","PENDING","UPGRADING"]。
      .filter((m) => !/expectedStatus\s*:/.test(m[0]))
      .map((m) => m[1]);
    // 允许的显式值只有 UPGRADING（其余走默认 PENDING）
    // 只允许 UPGRADING（其余走默认 PENDING）
    expect([...new Set(statuses)].sort()).toEqual(["UPGRADING"]);
  });
});

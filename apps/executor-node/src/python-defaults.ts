/**
 * Python 版本**策略常量**（本模块刻意零依赖）。
 *
 * ## 为什么单独成一个文件，而不是放在 `interpreters.ts`
 *
 * `DEFAULT_PYTHON_VERSION` 被**两条互相独立的链路**消费：
 *   1. **任务执行** (`routes/execute.ts`)：无 `runtimeVersion` 且宿主解释器不可用；
 *   2. **应用部署** (`python-venv.ts`)：应用无版本声明、池内无解释器、宿主也不可用。
 *
 * 它原本放在 `interpreters.ts` 里，但那个模块是"解释器池的运行时实现"（要 spawn uv、
 * 有缓存与并发状态），**测试里经常被整体 `jest.mock`**。把它放在那里意味着：任何
 * 一处 mock 忘了 re-export 它，取到的就是 `undefined` —— 而那会被静默地当成
 * "版本号 undefined" 传给 `uv python install`。这个坑在落地时**真实发生过**
 * （`routes/deploy.spec.ts` 的 `jest.mock('../interpreters', …)` 就漏了它，
 * 路由级回归用例因此断言到 `ensureVersion(undefined, …)`）。
 *
 * 策略常量与本模块的职责边界一致：**只描述"默认用哪个 Python 版本"这一件事**，
 * 不含任何行为。放在零依赖文件里，就不会被任何模块 mock 波及。
 *
 * ## 与 admin 侧的耦合（改一处必须同步另一处）
 *
 * 中台调度侧有 `LEGACY_DEFAULT_INTERPRETERS = ["3.12"]`
 *（`apps/admin-api/src/modules/executor/interpreter-match.util.ts:52`），语义是
 * "未上报解释器清单的旧执行器按 3.12 兜底"。本常量是执行器侧**真正去获取并使用**
 * 的那个版本；两者不一致就会出现"admin 按 3.12 预期、执行器实际装了 3.11"这类
 * **跨进程口径漂移**——与本次生产事故同一类病（"说的"和"做的"不是同一件事），
 * 只是换了方向。故必须同步修改，并有单测锚定。
 *
 * ## 取值约束
 *
 * 必须是合法 `X.Y`、且 ≥ `interpreters.ts` 的 `ONLINE_DOWNLOAD_MIN`（3.8），
 * 否则 uv 在线取不到，干净机器上将永远失败。选 3.12 而非更新的版本：它是 Tier 1
 * 里最保守、生态兼容面最广的一档，且与容器执行器镜像基座 `python:3.12-slim` 一致
 * （见 `docs/requirements/python-task-upload-and-multiversion/REQUIREMENTS.md` CON-01）。
 */

/**
 * **无声明版本**时执行器默认获取并使用的 Python 版本 —— 单一事实源。
 */
export const DEFAULT_PYTHON_VERSION = '3.12';

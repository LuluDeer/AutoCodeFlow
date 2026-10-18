/**
 * PLAN-OBSERVABILITY 收口守卫：观测面的两处「静默退化」。
 *
 * 背景：这两项都属于**删除死代码 / 更换日志 API**，本仓没有 main.ts 的
 * bootstrap 测试（进程级入口：真实起 Nest、连 DB/Redis，单测里起不动），
 * 所以此处改用源码级静态断言——不是为覆盖率凑数，而是因为这两类缺陷的
 * 共性是「**回归时没有任何运行期症状**」：
 *
 *  1) 死代码复活：`TraceMiddleware` 与已接线的 `TraceIdMiddleware` 功能几乎
 *     重复（都读 x-trace-id 否则 randomUUID，都写回响应头），唯一区别是前者
 *     多一行 `logger.log('[${traceId}] ${method} ${path}')`——**每请求一条
 *     info 日志**，正是它当年被换成无日志版 TraceIdMiddleware 的原因（每请求
 *     日志会淹掉 JSON 日志流）。若有人「顺手」把被注释掉的 import 接回去，
 *     编译通过、测试全绿、进程照跑，只有日志量悄悄翻倍。
 *
 *  2) 裸 console 污染：main.ts 的 fatal 路径曾用 `console.error("[FATAL]", …)`
 *     直接写 stderr——绕开 ConsoleLogger 的 JSON 管道（见 main.ts 里
 *     `app.useLogger(new ConsoleLogger(…, { json: true }))`），ELK/Loki 收到的
 *     就是一行无法解析的裸文本，且**丢了 context 与 level 字段**。改走静态
 *     `Logger.error(message, stack, context)` 后归流；若有人回退成 console.*，
 *     同样编译/测试全绿，只有日志管道里悄悄多出非结构化行。
 *
 * 先例：src/__tests__/main-env-preload.spec.ts（同样是 fs 读源码钉 main.ts
 * 不变量）、src/common/utils/__tests__/response-stream-error-listener.guard.spec.ts。
 * 注：本仓 admin-api 跑 Jest，expect 只接受单参数，断言消息一律走注释。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// __dirname = apps/admin-api/src/common/middleware/__tests__
const SRC_ROOT = join(__dirname, "..", "..", "..");
const MAIN_TS = join(SRC_ROOT, "main.ts");
const TRACE_MIDDLEWARE_TS = join(
  SRC_ROOT,
  "common",
  "middleware",
  "trace.middleware.ts",
);

/**
 * 剥掉注释后再断言：两处不变量都允许在**注释/说明**里提到被禁的符号
 * （例如本文件头注、main.ts 里解释「为什么不再用 console」的注释），
 * 否则守卫会被自己的文档咬到。剥除口径与 main-env-preload.spec.ts 一致。
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const mainCode = stripComments(readFileSync(MAIN_TS, "utf8"));

describe("观测卫生守卫 · 缺口4：TraceMiddleware 不得复活", () => {
  it("trace.middleware.ts 已删除（死代码不留在树里）", () => {
    expect(existsSync(TRACE_MIDDLEWARE_TS)).toBe(false);
  });

  it("main.ts 不再引用 TraceMiddleware / trace.middleware", () => {
    expect(mainCode).not.toMatch(/\bTraceMiddleware\b/);
    expect(mainCode).not.toMatch(/trace\.middleware/);
  });

  it("真正接线的是 TraceIdMiddleware（本守卫的立足点，别删错了对象）", () => {
    const appModuleSrc = readFileSync(join(SRC_ROOT, "app.module.ts"), "utf8");
    expect(appModuleSrc).toMatch(
      /consumer\.apply\(\s*TraceIdMiddleware\s*\)\.forRoutes\(\s*["']\*["']\s*\)/,
    );
    // 对照：TraceIdMiddleware 本体必须存在，且**不带**每请求 info 日志
    const traceIdSrc = stripComments(
      readFileSync(
        join(SRC_ROOT, "common", "middleware", "trace-id.middleware.ts"),
        "utf8",
      ),
    );
    expect(traceIdSrc).toMatch(/class\s+TraceIdMiddleware\b/);
    expect(traceIdSrc).not.toMatch(/\bconsole\./);
  });
});

describe("观测卫生守卫 · 缺口5：main.ts 的 fatal 路径走 Nest Logger", () => {
  it("main.ts 里不再出现任何 console.* 调用", () => {
    // 只匹配真实调用形态（console.error( / console.log( …），
    // 剥注释后正文里的「console.error」字样已不存在，仍用调用式更稳。
    expect(mainCode).not.toMatch(/\bconsole\s*\.\s*\w+\s*\(/);
  });

  it("fatal 出口经由静态 Logger.error（含 stack 位），而非 console", () => {
    // 静态调用形态：Logger.error(...) —— 不是 this.logger / new Logger() 实例
    expect(mainCode).toMatch(/\bLogger\.error\s*\(/);
    // 老形态的墓碑文案必须仍被 logFatal 产出（防「换 API 顺手改文案」）
    expect(mainCode).toMatch(/\[FATAL\]/);
    expect(mainCode).toMatch(/\[FATAL\]\s+Bootstrap failed:/);
  });

  it("bootstrap().catch 的兜底出口不再是 console.error", () => {
    // 抓最后那段 catch 块，确保它走 logFatal/Logger 而非裸 console。
    // 先钉住锚点真的存在——否则 indexOf 返回 -1 会让 slice 退化成
    // 单字符片段、断言变成永真的空转。
    const anchorAt = mainCode.indexOf("bootstrap().catch");
    expect(anchorAt).toBeGreaterThan(0);
    const tail = mainCode.slice(anchorAt);
    expect(tail).toMatch(
      /logFatal\s*\(\s*\[?["'][^"']*\[FATAL\] Bootstrap failed:/,
    );
    expect(tail).not.toMatch(/\bconsole\s*\./);
  });
});

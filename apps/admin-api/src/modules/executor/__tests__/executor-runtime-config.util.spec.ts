import {
  buildInstallCmd,
  buildInstallScriptUrl,
  deriveExecutorRuntimeConfigNumbers,
  resolveAddressTakeoverSilenceMs,
  resolveHeartbeatIntervalMs,
  resolveHeartbeatTimeoutMultiplier,
  resolveStaleConfirmations,
  shellQuote,
} from "../executor-runtime-config.util";
import { EXECUTOR_ADDRESS_TAKEOVER_SILENCE_MS } from "../executor-constants";
import { execFileSync } from "node:child_process";

/**
 * 用**真的 /bin/sh** 求值一个 shell 片段，返回它的标准输出。
 *
 * 用途：验证 `shellQuote` 的转义**语义正确**（还原出的值与原值逐字节相等），
 * 而不只是「看起来有引号」。
 */
function shellEvalToString(fragment: string): string {
  return execFileSync("/bin/sh", ["-c", `printf '%s' ${fragment}`], {
    encoding: "utf-8",
  });
}

/**
 * B0 拆分的独立单测（不走 DI 装配，直接调用纯函数）。
 *
 * ## 三个配置解析的 `||` vs `??` 陷阱
 *
 * 这三个解析函数**刻意保持 `||` 语义**（`0` 也回退缺省），与原实现
 * 逐字节一致：
 *
 * - `executor.heartbeatInterval`：`0 || 30000` → **30000**；
 * - `executor.heartbeatTimeoutMultiplier`：`0 || 3` → **3**；
 * - `executor.staleOfflineConfirmations`：`0` 非法（需 ≥1）→ **2**。
 *
 * 而 `executor.addressTakeoverSilenceMs` **相反**：`0` 是**合法值**（E-8：
 * 静默窗退化为零是危险配置但合法，判定是 `>= 0`），所以必须用显式的
 * 类型/范围判定，不能用 `||`。
 *
 * 这条「有的用 `||`、有的不能用」的差别极易在"顺手优化"时被抹平 ⇒
 * 本文件把两种语义都钉住。
 */

describe("resolveHeartbeatIntervalMs — 心跳间隔解析", () => {
  it("正常值原样返回", () => {
    expect(resolveHeartbeatIntervalMs(30_000)).toBe(30_000);
  });

  it("缺省（undefined）回退 30000", () => {
    expect(resolveHeartbeatIntervalMs(undefined)).toBe(30_000);
  });

  it("**0 也回退 30000**（`||` 语义，非 `??`）", () => {
    expect(resolveHeartbeatIntervalMs(0)).toBe(30_000);
  });
});

describe("resolveHeartbeatTimeoutMultiplier — 超时倍数解析", () => {
  it("正常值原样返回", () => {
    expect(resolveHeartbeatTimeoutMultiplier(3)).toBe(3);
  });

  it("缺省回退 3", () => {
    expect(resolveHeartbeatTimeoutMultiplier(undefined)).toBe(3);
  });

  it("**0 也回退 3**（`||` 语义，非 `??`）", () => {
    expect(resolveHeartbeatTimeoutMultiplier(0)).toBe(3);
  });
});

describe("resolveStaleConfirmations — 判死确认轮数解析", () => {
  it("≥1 的整数原样返回（向下取整）", () => {
    expect(resolveStaleConfirmations(1)).toBe(1);
    expect(resolveStaleConfirmations(3)).toBe(3);
    expect(resolveStaleConfirmations(2.9)).toBe(2);
  });

  it("0 / 负数 / 非数字 / NaN / Infinity 一律回退 2", () => {
    expect(resolveStaleConfirmations(0)).toBe(2);
    expect(resolveStaleConfirmations(-1)).toBe(2);
    expect(resolveStaleConfirmations("3")).toBe(2);
    expect(resolveStaleConfirmations(Number.NaN)).toBe(2);
    expect(resolveStaleConfirmations(Number.POSITIVE_INFINITY)).toBe(2);
    expect(resolveStaleConfirmations(undefined)).toBe(2);
  });
});

describe("resolveAddressTakeoverSilenceMs — 接管静默窗解析", () => {
  it("正常值原样返回", () => {
    expect(
      resolveAddressTakeoverSilenceMs(
        60_000,
        EXECUTOR_ADDRESS_TAKEOVER_SILENCE_MS,
      ),
    ).toBe(60_000);
  });

  it("**0 是合法值**（E-8：静默窗退化为零是危险配置但合法）", () => {
    expect(
      resolveAddressTakeoverSilenceMs(0, EXECUTOR_ADDRESS_TAKEOVER_SILENCE_MS),
    ).toBe(0);
  });

  it("负数 / 非数字 / NaN / Infinity 回退缺省", () => {
    expect(
      resolveAddressTakeoverSilenceMs(-1, EXECUTOR_ADDRESS_TAKEOVER_SILENCE_MS),
    ).toBe(EXECUTOR_ADDRESS_TAKEOVER_SILENCE_MS);
    expect(
      resolveAddressTakeoverSilenceMs(
        "60000",
        EXECUTOR_ADDRESS_TAKEOVER_SILENCE_MS,
      ),
    ).toBe(EXECUTOR_ADDRESS_TAKEOVER_SILENCE_MS);
    expect(
      resolveAddressTakeoverSilenceMs(
        Number.NaN,
        EXECUTOR_ADDRESS_TAKEOVER_SILENCE_MS,
      ),
    ).toBe(EXECUTOR_ADDRESS_TAKEOVER_SILENCE_MS);
    expect(
      resolveAddressTakeoverSilenceMs(
        Number.POSITIVE_INFINITY,
        EXECUTOR_ADDRESS_TAKEOVER_SILENCE_MS,
      ),
    ).toBe(EXECUTOR_ADDRESS_TAKEOVER_SILENCE_MS);
  });
});

describe("deriveExecutorRuntimeConfigNumbers — 派生公式（NETOPT-G P1-7）", () => {
  it("heartbeatTimeoutMs = 间隔 × 倍数", () => {
    const n = deriveExecutorRuntimeConfigNumbers({
      heartbeatIntervalMs: 30_000,
      heartbeatTimeoutMultiplier: 3,
      staleOfflineConfirmations: 2,
    });
    expect(n.heartbeatTimeoutMs).toBe(90_000);
  });

  it("effectiveOfflineAfterMs = 间隔 × 倍数 × 确认轮数（前端「多久判离线」的唯一依据）", () => {
    const n = deriveExecutorRuntimeConfigNumbers({
      heartbeatIntervalMs: 30_000,
      heartbeatTimeoutMultiplier: 3,
      staleOfflineConfirmations: 2,
    });
    expect(n.effectiveOfflineAfterMs).toBe(180_000);
  });

  it("确认轮数变化会改变有效窗口（迟滞上线后 UI 数字必须跟着变）", () => {
    const base = {
      heartbeatIntervalMs: 30_000,
      heartbeatTimeoutMultiplier: 3,
    };
    const two = deriveExecutorRuntimeConfigNumbers({
      ...base,
      staleOfflineConfirmations: 2,
    });
    const four = deriveExecutorRuntimeConfigNumbers({
      ...base,
      staleOfflineConfirmations: 4,
    });
    expect(four.effectiveOfflineAfterMs).toBe(two.effectiveOfflineAfterMs * 2);
  });

  it("listLimit 与 EXECUTOR_LIST_LIMIT 同源（findAll 的硬上限）", () => {
    const n = deriveExecutorRuntimeConfigNumbers({
      heartbeatIntervalMs: 30_000,
      heartbeatTimeoutMultiplier: 3,
      staleOfflineConfirmations: 2,
    });
    expect(n.listLimit).toBe(500);
  });

  it("原样透传三项基础值", () => {
    const n = deriveExecutorRuntimeConfigNumbers({
      heartbeatIntervalMs: 15_000,
      heartbeatTimeoutMultiplier: 5,
      staleOfflineConfirmations: 3,
    });
    expect(n.heartbeatIntervalMs).toBe(15_000);
    expect(n.heartbeatTimeoutMultiplier).toBe(5);
    expect(n.staleOfflineConfirmations).toBe(3);
  });
});

describe("shellQuote — Shell 单引号转义", () => {
  it("普通值原样包进单引号", () => {
    expect(shellQuote("abc")).toBe("'abc'");
  });

  it("单引号被转义成 `'\\''`（防止闭合引号注入）", () => {
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
  });

  it("**空串也被包引号**（不是裸空）", () => {
    expect(shellQuote("")).toBe("''");
  });

  it("注入载荷不会逃出引号（**真 shell 往返**验证，反证有牙）", () => {
    // 断言方式：把转义结果交给**真的 /bin/sh** 求值，看它还原出的值是否
    // 与原值逐字节相等。相等 ⇒ 载荷没能逃出引号、没被 shell 解释。
    // （比「数引号个数」强：后者对转义序列本身的引号会误判。）
    const hostile = "'; rm -rf /; echo '";
    const quoted = shellQuote(hostile);
    expect(shellEvalToString(quoted)).toBe(hostile);
  });

  it("普通值与含空格/换行的值都经真 shell 往返等价", () => {
    for (const v of [
      "abc",
      "a b c",
      "line1\nline2",
      "with 'quote' inside",
      "$HOME `whoami`",
    ]) {
      expect(shellEvalToString(shellQuote(v))).toBe(v);
    }
  });
});

describe("buildInstallScriptUrl / buildInstallCmd — 安装命令构造", () => {
  it("脚本 URL 去掉尾斜杠（不得出现 `//api`）", () => {
    expect(buildInstallScriptUrl("https://admin.example.com")).toBe(
      "https://admin.example.com/api/executors/install.sh",
    );
    expect(buildInstallScriptUrl("https://admin.example.com///")).toBe(
      "https://admin.example.com/api/executors/install.sh",
    );
  });

  it("命令形如 curl|bash 且带 --api-url 与 --secret", () => {
    const cmd = buildInstallCmd({
      adminApiUrl: "https://admin.example.com",
      sharedToken: "tok-123",
    });
    expect(cmd).toContain("curl -fsSL");
    expect(cmd).toContain("| bash -s --");
    expect(cmd).toContain("--api-url 'https://admin.example.com'");
    expect(cmd).toContain("--secret 'tok-123'");
  });

  it("三个值都经 shellQuote 转义（注入面闭合：真 shell 求值后仍是原值）", () => {
    const hostileUrl = "https://a.example.com/'; touch /tmp/pwn; echo '";
    const hostileToken = "tok'; echo '";
    const cmd = buildInstallCmd({
      adminApiUrl: hostileUrl,
      sharedToken: hostileToken,
    });
    // 把命令里 `--` 之后的参数交给**真 shell**求值（`set --` + 参数列表），
    // 再逐个打印 —— 确认 `--api-url` / `--secret` 的**参数值**与原值逐字节
    // 相等（载荷未生效、也没被 shell 解释）。
    const argTail = cmd.slice(
      cmd.indexOf("bash -s -- ") + "bash -s -- ".length,
    );
    const out = execFileSync(
      "/bin/sh",
      ["-c", `set -- ${argTail}; for a in "$@"; do printf '%s\n' "$a"; done`],
      {
        encoding: "utf-8",
      },
    );
    const argv = out.split("\n");
    // argv = [--api-url, <url>, --secret, <token>]
    expect(argv[0]).toBe("--api-url");
    expect(argv[1]).toBe(hostileUrl);
    expect(argv[2]).toBe("--secret");
    expect(argv[3]).toBe(hostileToken);
  });
});

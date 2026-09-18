/**
 * R12-fix：applyTaskRlimits 的 sh 包装回归测试。
 *
 * CI selftests pull-dispatch ④ 曾以 `Process exited with code 127` 失败——
 * 根因是包装脚本 `exec "$0" "$@"`：`sh -c <script> task node glue.js` 中
 * $0='task'（占位名）、$1=真实命令、$2..=参数，把占位名当命令 exec 必然
 * command not found → 127（Linux 任务全灭，Windows 直跑不受影响——这正是
 * 本地复现通过而 CI 失败的原因）。修复为 `cmd=$1; shift; exec "$cmd" "$@"`。
 *
 * 本测试不真 spawn（保持单测轻量），断言包装后的 argv 形状与脚本内容：
 * 命令与参数必须经位置参数透传，占位名绝不进入 exec。
 */
import { applyTaskRlimits, RlimitWrappedArgv } from "./process-rlimits";

// applyTaskRlimits 在 win32 上直接返回原样——CI 的 Linux 分支才是生产路径，
// 但测试要跨平台断言脚本形态，故直接校验非 win32 的包装逻辑。
const platform = process.platform;

function describeIfPosix(name: string, fn: () => void) {
  if (platform === "win32") {
    // win32 分支原样返回，用最小断言钉住「不包装」行为
    it(name, () => {
      const r = applyTaskRlimits("node", ["glue_script.js"], 60);
      expect(r.cmd).toBe("node");
      expect(r.args).toEqual(["glue_script.js"]);
    });
    return;
  }
  describe(name, fn);
}

describeIfPosix("applyTaskRlimits POSIX wrapper", () => {
  it("wraps with /bin/sh -c and passes command via positional params", () => {
    const r = applyTaskRlimits("node", ["glue_script.js"], 60);
    expect(r.cmd).toBe("/bin/sh");
    expect(r.args[0]).toBe("-c");
    const script = r.args[1] as string;
    expect(script).toContain("ulimit -n");
    expect(script).toContain("ulimit -t");
    // 占位名 'task' 是 $0，绝不能作为命令执行
    expect(script).not.toContain('exec "$0"');
    // 修复后：取 $1 为命令、shift 后 exec
    expect(script).toContain('cmd=$1; shift; exec "$cmd" "$@"');
    // 位置参数透传：$2.. 是原命令参数
    expect(r.args.slice(3)).toEqual(["node", "glue_script.js"]);
  });

  it("keeps the placeholder name as $0 only", () => {
    const r = applyTaskRlimits("bash", ["-c", "echo hi"], 30);
    expect(r.args[2]).toBe("task"); // $0 = 占位名
    expect(r.args.slice(3)).toEqual(["bash", "-c", "echo hi"]);
  });

  it("still wraps when only cpu limit applies", () => {
    const oldNofile = process.env.TASK_NOFILE_LIMIT;
    const oldCpu = process.env.TASK_CPU_LIMIT_SECONDS;
    process.env.TASK_NOFILE_LIMIT = "0";
    process.env.TASK_CPU_LIMIT_SECONDS = "5";
    try {
      const r = applyTaskRlimits("node", ["glue.js"], 60);
      expect(r.cmd).toBe("/bin/sh");
      expect(r.args[1]).toContain("ulimit -t 5");
      expect(r.args[1]).not.toContain("ulimit -n");
    } finally {
      if (oldNofile === undefined) delete process.env.TASK_NOFILE_LIMIT;
      else process.env.TASK_NOFILE_LIMIT = oldNofile;
      if (oldCpu === undefined) delete process.env.TASK_CPU_LIMIT_SECONDS;
      else process.env.TASK_CPU_LIMIT_SECONDS = oldCpu;
    }
  });
});

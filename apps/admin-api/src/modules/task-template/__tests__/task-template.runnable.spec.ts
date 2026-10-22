/**
 * 官方任务模板「开箱即跑」守卫（CORE-03 后续）。
 *
 * 背景：历史官方模板只预填 trigger/runtime/entrypoint，而 entrypoint 指向的
 * backup.sh / check.sh / sync.py / cleanup.sh / ping.js 在执行器工作目录里并不
 * 存在——「从模板创建」得到的任务必然跑不起来。现在改为内联 glueSource：
 *
 * - 静态守卫：每个模板都有非空 glueSource、runtime/glueLanguage 配对合法、
 *   不再携带 entrypoint；
 * - 行为守卫：把 glueSource 原样写到临时目录、按执行器的注入契约（cwd=工作目录、
 *   AUTOFLOW_PARAMS_JSON / AUTOFLOW_ARTIFACTS_DIR）真跑一遍，断言输出与副作用；
 * - 实例化守卫：从模板 instantiate 出来的任务确实带着 glueSource。
 *
 * 行为守卫用真实子进程（Node 恒可用；Python 缺失时跳过），这样「脚本能跑」不是
 * 靠读字符串猜的。脚本本身遵守四条约定的可执行性由这些用例锁定。
 */
import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { AddressInfo } from "net";
import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { TaskTemplateService } from "../task-template.service";
import { TaskTemplate } from "../entities/task-template.entity";
import { TaskService } from "../../task/task.service";
import { Task } from "../../task/entities/task.entity";
import { OFFICIAL_TASK_TEMPLATES } from "../task-template.constants";

jest.setTimeout(30_000);

/** runtime → 执行器 glue 分支真正接受的 glueLanguage（见 executor-node execute.ts）。 */
const LEGAL_GLUE_LANGUAGE: Record<string, string> = {
  node: "javascript",
  python: "python",
  shell: "shell",
};

const byKey = new Map(OFFICIAL_TASK_TEMPLATES.map((t) => [t.key, t]));

function template(key: string) {
  const t = byKey.get(key);
  if (!t) throw new Error(`unknown official template: ${key}`);
  return t;
}

function configOf(key: string): Record<string, unknown> {
  return template(key).config;
}

function glueOf(key: string): string {
  const source = configOf(key).glueSource;
  if (typeof source !== "string" || source.trim() === "") {
    throw new Error(`template ${key} has no glueSource`);
  }
  return source;
}

/** 每个用例独立的临时目录（afterAll 统一清理）。 */
const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** 与执行器同形：脚本落在工作目录，cwd=工作目录，参数走 AUTOFLOW_*。 */
interface GlueRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

async function runNodeGlue(
  source: string,
  opts: {
    cwd: string;
    params?: Record<string, unknown>;
    env?: Record<string, string>;
  },
): Promise<GlueRun> {
  const file = path.join(opts.cwd, "glue_script.js");
  fs.writeFileSync(file, source, "utf8");
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("AUTOFLOW_")) delete env[key];
  }
  if (opts.params !== undefined) {
    env.AUTOFLOW_PARAMS_JSON = JSON.stringify(opts.params);
  }
  Object.assign(env, opts.env ?? {});
  // 必须用异步 spawn：本文件里的 http 测试服务器跑在同一进程，spawnSync 会
  // 阻塞事件循环，让子进程的 fetch 永远等不到响应（表现为 5s 超时）。
  return new Promise<GlueRun>((resolve, reject) => {
    const child = spawn(process.execPath, [file], {
      cwd: opts.cwd,
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function findPython(): string | null {
  for (const candidate of ["python3", "python"]) {
    const probe = spawnSync(candidate, ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    if (probe.status === 0) return candidate;
  }
  return null;
}

function runPythonGlue(
  source: string,
  opts: { cwd: string; params?: Record<string, unknown> },
): GlueRun {
  const python = findPython();
  if (!python) throw new Error("python unavailable");
  const file = path.join(opts.cwd, "glue_script.py");
  fs.writeFileSync(file, source, "utf8");
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONIOENCODING: "utf-8" };
  for (const key of Object.keys(env)) {
    if (key.startsWith("AUTOFLOW_")) delete env[key];
  }
  if (opts.params !== undefined) {
    env.AUTOFLOW_PARAMS_JSON = JSON.stringify(opts.params);
  }
  const result = spawnSync(python, [file], {
    cwd: opts.cwd,
    env,
    encoding: "utf8",
    timeout: 20_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

async function withHttpServer(
  handler: http.RequestListener,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("官方模板静态契约：config 自带可运行 glueSource", () => {
  it("仍是 5 个官方模板，key/name/category 定位不变", () => {
    expect(OFFICIAL_TASK_TEMPLATES).toHaveLength(5);
    expect(OFFICIAL_TASK_TEMPLATES.map((t) => t.key)).toEqual([
      "scheduled_backup",
      "health_check",
      "data_sync",
      "log_cleanup",
      "webhook_ping",
    ]);
    expect(OFFICIAL_TASK_TEMPLATES.map((t) => t.category)).toEqual([
      "备份",
      "巡检",
      "同步",
      "清理",
      "通知",
    ]);
  });

  it.each(OFFICIAL_TASK_TEMPLATES.map((t) => [t.key, t] as const))(
    "「%s」：glueSource 非空、runtime/glueLanguage 配对、无 entrypoint",
    (_key, t) => {
      const config = t.config;
      const runtime = config.runtime;
      const glueLanguage = config.glueLanguage;
      expect(typeof runtime).toBe("string");
      expect(typeof glueLanguage).toBe("string");
      expect(LEGAL_GLUE_LANGUAGE[runtime as string]).toBe(glueLanguage);

      const source = config.glueSource;
      expect(typeof source).toBe("string");
      expect((source as string).trim().length).toBeGreaterThan(100);
      // 零第三方依赖的粗筛：Node 只 require 内置模块，Python 只 import 标准库。
      expect(source as string).not.toMatch(/require\(['"](?!fs|os|path)/);
      expect(source as string).not.toMatch(
        /^\s*import\s+(?!json\b|os\b|sys\b)/m,
      );
      expect(source as string).not.toMatch(
        /^\s*from\s+(?!json\b|os\b|sys\b)\w/m,
      );

      // 旧形态彻底退场：没有 entrypoint / 没有依赖声明（glue 分支会忽略它们）。
      expect(config).not.toHaveProperty("entrypoint");
      expect(config).not.toHaveProperty("requirements");

      // 面向用户的描述必须说明「开箱即跑」与可改参数。
      expect(t.description).toContain("开箱即跑");
      expect(t.description).toContain("可改参数");
    },
  );

  it("调度定位保持原意（cron/固定间隔/手动）", () => {
    expect(configOf("scheduled_backup").triggerType).toBe("cron");
    expect(configOf("scheduled_backup").cronExpression).toBe("0 2 * * *");
    expect(configOf("health_check").triggerType).toBe("fixed_rate");
    expect(configOf("health_check").fixedRate).toBe(60);
    expect(configOf("data_sync").runtime).toBe("python");
    expect(configOf("log_cleanup").cronExpression).toBe("30 3 * * *");
    expect(configOf("webhook_ping").triggerType).toBe("manual");
  });
});

describe("官方模板行为：glueSource 真能跑", () => {
  it("scheduled_backup：只读扫描 params.dir，manifest 落到 AUTOFLOW_ARTIFACTS_DIR", async () => {
    const work = makeTempDir("acf-backup-");
    const sourceDir = path.join(work, "source");
    const artifactsDir = path.join(work, "artifacts");
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.mkdirSync(path.join(sourceDir, "nested"), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "b.txt"), "hello");
    fs.writeFileSync(path.join(sourceDir, "a.txt"), "0123456789");
    const before = fs.readFileSync(path.join(sourceDir, "a.txt"), "utf8");

    const res = await runNodeGlue(glueOf("scheduled_backup"), {
      cwd: work,
      params: { dir: sourceDir },
      env: { AUTOFLOW_ARTIFACTS_DIR: artifactsDir },
    });

    expect(res.stderr).toBe("");
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("files=2 totalBytes=15");
    const manifest = JSON.parse(
      fs.readFileSync(path.join(artifactsDir, "backup-manifest.json"), "utf8"),
    );
    expect(manifest.sourceDir).toBe(sourceDir);
    expect(manifest.fileCount).toBe(2);
    expect(manifest.totalBytes).toBe(15);
    // 排序确定 + 只收顶层普通文件（nested/ 不算）
    expect(manifest.files.map((f: { name: string }) => f.name)).toEqual([
      "a.txt",
      "b.txt",
    ]);
    // 只读：源文件字节不变
    expect(fs.readFileSync(path.join(sourceDir, "a.txt"), "utf8")).toBe(before);

    // 两条参数通道都支持：只给 AUTOFLOW_<KEY>（无 AUTOFLOW_PARAMS_JSON）也能跑。
    const envRun = await runNodeGlue(glueOf("scheduled_backup"), {
      cwd: work,
      env: {
        AUTOFLOW_DIR: sourceDir,
        AUTOFLOW_ARTIFACTS_DIR: artifactsDir,
      },
    });
    expect(envRun.stderr).toBe("");
    expect(envRun.status).toBe(0);
    expect(envRun.stdout).toContain("files=2 totalBytes=15");
  });

  it("health_check：2xx 打印 status/耗时；5xx 抛错非零退出", async () => {
    const work = makeTempDir("acf-health-");

    await withHttpServer(
      (_req, res) => {
        res.statusCode = 200;
        res.end("ok");
      },
      async (baseUrl) => {
        const res = await runNodeGlue(glueOf("health_check"), {
          cwd: work,
          params: { url: baseUrl },
        });
        expect(res.status).toBe(0);
        expect(res.stdout).toContain("status=200");
        expect(res.stdout).toContain("elapsedMs=");
      },
    );

    await withHttpServer(
      (_req, res) => {
        res.statusCode = 503;
        res.end("nope");
      },
      async (baseUrl) => {
        const res = await runNodeGlue(glueOf("health_check"), {
          cwd: work,
          params: { url: baseUrl },
        });
        expect(res.status).not.toBe(0);
        expect(res.stdout + res.stderr).toContain("failed");
        expect(res.stdout).toContain("status=503");
      },
    );
  });

  it("webhook_ping：无 url 只打印 payload 并成功；有 url POST JSON", async () => {
    const work = makeTempDir("acf-ping-");

    const preview = await runNodeGlue(glueOf("webhook_ping"), {
      cwd: work,
      params: {},
    });
    expect(preview.status).toBe(0);
    expect(preview.stdout).toContain("payload=");
    expect(preview.stdout).toContain("webhook_ping");

    let method = "";
    let body = "";
    await withHttpServer(
      (req, res) => {
        method = req.method ?? "";
        req.on("data", (chunk) => {
          body += String(chunk);
        });
        req.on("end", () => {
          res.statusCode = 200;
          res.end("ok");
        });
      },
      async (baseUrl) => {
        const res = await runNodeGlue(glueOf("webhook_ping"), {
          cwd: work,
          params: { url: baseUrl },
        });
        expect(res.status).toBe(0);
        expect(res.stdout).toContain("status=200");
      },
    );
    expect(method).toBe("POST");
    expect(JSON.parse(body)).toMatchObject({ event: "webhook_ping" });
  });

  it("data_sync：默认 10 行确定性数据并打印 JSON 摘要（无 python 时跳过）", () => {
    if (!findPython()) {
      // 执行器侧 python 能力同理可能存在与否；这里跳过而不是断言不可用。
      expect(true).toBe(true);
      return;
    }
    const work = makeTempDir("acf-sync-");
    const res = runPythonGlue(glueOf("data_sync"), { cwd: work });
    expect(res.stderr).toBe("");
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("rows=10");
    expect(res.stdout).toContain('"rows": 10');
    expect(res.stdout).toContain('"totalValue": 550');

    const custom = runPythonGlue(glueOf("data_sync"), {
      cwd: work,
      params: { rows: 12 },
    });
    expect(custom.status).toBe(0);
    expect(custom.stdout).toContain("rows=12");
  });

  it("log_cleanup：默认 dry-run 只列不删；dryRun=false 只删演示目录内的过期文件", async () => {
    const demoRoot = path.join(os.tmpdir(), "acf-demo-logs");
    const targetDir = path.join(demoRoot, `spec-${process.pid}-${Date.now()}`);
    fs.mkdirSync(targetDir, { recursive: true });
    tempDirs.push(targetDir);
    const oldFile = path.join(targetDir, "old.log");
    const freshFile = path.join(targetDir, "fresh.log");
    fs.writeFileSync(oldFile, "old\n");
    fs.writeFileSync(freshFile, "fresh\n");
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldFile, old, old);
    const work = makeTempDir("acf-cleanup-");

    const dry = await runNodeGlue(glueOf("log_cleanup"), {
      cwd: work,
      params: { dir: targetDir },
    });
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain("expired=1");
    expect(dry.stdout).toContain("dry-run");
    expect(fs.existsSync(oldFile)).toBe(true);

    const real = await runNodeGlue(glueOf("log_cleanup"), {
      cwd: work,
      params: { dir: targetDir, dryRun: false },
    });
    expect(real.status).toBe(0);
    expect(real.stdout).toContain("deleted=1");
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(freshFile)).toBe(true);
  });

  it("log_cleanup：拒绝经目录软链删到演示目录之外（realpath 守卫）", async () => {
    if (process.platform === "win32") return; // 创建目录软链在 Windows 需额外权限
    const demoRoot = path.join(os.tmpdir(), "acf-demo-logs");
    fs.mkdirSync(demoRoot, { recursive: true });
    const outside = makeTempDir("acf-outside-");
    const victim = path.join(outside, "victim.log");
    fs.writeFileSync(victim, "keep\n");
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    fs.utimesSync(victim, old, old);
    const link = path.join(demoRoot, `spec-link-${process.pid}-${Date.now()}`);
    fs.symlinkSync(outside, link, "dir");
    try {
      const work = makeTempDir("acf-cleanup-link-");
      const res = await runNodeGlue(glueOf("log_cleanup"), {
        cwd: work,
        params: { dir: link, dryRun: false },
      });
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("delete skipped");
      // 软链指向的真实文件必须原封不动。
      expect(fs.existsSync(victim)).toBe(true);
    } finally {
      try {
        fs.unlinkSync(link);
      } catch {
        fs.rmdirSync(link);
      }
    }
  });

  it("log_cleanup：拒绝把 cwd 当清理根目录（防误删）", async () => {
    const work = makeTempDir("acf-cleanup-guard-");
    const res = await runNodeGlue(glueOf("log_cleanup"), {
      cwd: work,
      params: { dir: work, dryRun: false },
    });
    expect(res.status).not.toBe(0);
    expect(res.stdout + res.stderr).toContain("拒绝操作受保护目录");
  });
});

describe("从官方模板 instantiate 的任务带 glueSource", () => {
  const makeRepo = () => ({
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((d) => ({ id: "tpl-1", ...d })),
    save: jest.fn((e) => Promise.resolve(e)),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
  });

  async function buildService(seed: (typeof OFFICIAL_TASK_TEMPLATES)[number]) {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue({
      id: "official-1",
      key: seed.key,
      name: seed.name,
      description: seed.description,
      category: seed.category,
      config: seed.config,
      isOfficial: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as TaskTemplate);
    const taskService = {
      create: jest.fn((dto) => Promise.resolve({ id: "task-1", ...dto })),
    };
    const module = await Test.createTestingModule({
      providers: [
        TaskTemplateService,
        { provide: getRepositoryToken(TaskTemplate), useValue: repo },
        {
          provide: getRepositoryToken(Task),
          useValue: { findOne: jest.fn().mockResolvedValue(null) },
        },
        { provide: TaskService, useValue: taskService },
      ],
    }).compile();
    return { svc: module.get(TaskTemplateService), taskService };
  }

  it.each(OFFICIAL_TASK_TEMPLATES.map((t) => [t.key, t] as const))(
    "「%s」实例化产物透传 glueSource/glueLanguage，且不带 entrypoint",
    async (_key, seed) => {
      const { svc, taskService } = await buildService(seed);
      await svc.instantiate("official-1", { name: `task-${seed.key}` });
      expect(taskService.create).toHaveBeenCalledTimes(1);
      const dto = taskService.create.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(dto.glueSource).toBe(seed.config.glueSource);
      expect(dto.glueLanguage).toBe(seed.config.glueLanguage);
      expect(dto.runtime).toBe(seed.config.runtime);
      expect(dto).not.toHaveProperty("entrypoint");
    },
  );
});

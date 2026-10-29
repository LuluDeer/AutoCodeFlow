import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

/**
 * UPLOADS-PROXY 一致性闸（APP-002 生产故障后补）。
 *
 * ## 故障现场
 *
 * 生产部署应用时报：
 *
 *   Unsafe package rejected by zip-guard [unparseable]
 *
 * `unparseable` 的确切含义是 **EOCD 签名找不到**——即执行器拿到的字节
 * 根本不是 zip（不是"包太大/太危险"，那些是 ratio_exceeded / too_many_entries）。
 * 根因不在执行器，而在**代理层**：
 *
 *   - admin-api 的 `app.use("/uploads", …)` 注册在 `setGlobalPrefix("api")`
 *     **之前**（main.ts），故真实下载路径是 `/uploads/packages/*.zip`，
 *     **不在 `/api/` 前缀下**（docs/api-reference.md 早已如此记载）；
 *   - 但两份 nginx 配置此前**只代理 `/api/`**，`/uploads/…` 于是落进
 *     SPA 回退 `location / { try_files $uri $uri/ /index.html; }`；
 *   - 磁盘上没有该文件 → try_files 回退成 `/index.html` → 返回
 *     **HTTP 200 + HTML**；
 *   - 执行器把它当 zip 落盘 → zip-guard 找不到 EOCD → 报 unparseable。
 *
 * 这个故障形态**极难定位**，必须钉住：
 *   1. 错误信息指向执行器，根因在 nginx —— 排查方向天然跑偏；
 *   2. HTTP 状态是 **200**（不是 404/502），任何"看状态码"的排查都会认为
 *      下载成功，链路"看起来是通的"；
 *   3. 只有 packageUrl 这条路径受影响，git 仓库部署（gitRepo）完全正常，
 *      于是表现为"部分应用能部署、部分不能"。
 *
 * ## 为什么现在才暴露
 *
 * `API_BASE_URL` 缺失时上传接口**直接 500**（application.controller.ts 故意
 * fail-fast），请求根本走不到下载。接线后上传首次成功，下载路径才第一次被
 * 真正执行——即这个 nginx 缺口从 SEC-05 引入 /uploads 起就存在，只是被上游
 * 的 500 掩盖了。
 *
 * ## 本闸的判据
 *
 * 不解析 nginx 语法（那需要真机 nginx），而是断言**两份配置都显式代理
 * `/uploads/`**。这是"配置面"与"应用面"的对齐检查：
 * `main.ts` 挂载了 `/uploads`，代理层就必须有一条对应的 location。
 * 反证：从任一份配置删掉 `location ^~ /uploads/` 块，本 spec 立即转红。
 */

const REPO_ROOT_MARKER = path.join("infra", "nginx", "default.conf");

function findRepoRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 12; i++) {
    if (existsSync(path.join(dir, REPO_ROOT_MARKER))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error(`infra/nginx/default.conf not found above ${from}`);
}

const repoRoot = findRepoRoot(__dirname);

/**
 * deploy.sh 的 source 模式站点模板。
 *
 * OPS-01（2026-10-27 审计轮 #7）：`deploy.sh --mode source` 是 deployment.md
 * 里的"生产推荐"路径，但它用 **heredoc 生成** /etc/nginx 站点配置——第三份
 * nginx 配置，此前完全不在本闸的覆盖面内。于是同一类 APP-002 故障在这条路径上
 * 必然复现（`/uploads/` 无 location → SPA 回退 → 200 + index.html →
 * zip-guard unparseable），而两份仓库内配置是绿的，闸给不出任何信号。
 *
 * 取法刻意用"截取 heredoc 文本"而不是解析 shell：本闸只需要配置片段，
 * 不追 heredoc 的引号/缩进花样。`\$` 反转义模拟 heredoc 展开
 * （模板里写 `\$host` 就是为了让 nginx 看到 `$host`）。
 */
function readDeployGeneratedSite(): string {
  const script = readFileSync(path.join(repoRoot, "deploy.sh"), "utf-8");
  const marker = 'autocodeflow.conf" >/dev/null <<EOF';
  const at = script.indexOf(marker);
  expect(at).toBeGreaterThanOrEqual(0);
  const bodyStart = script.indexOf("\n", at) + 1;
  const end = script.indexOf("\nEOF\n", bodyStart);
  expect(end).toBeGreaterThan(bodyStart);
  return script.slice(bodyStart, end).replace(/\\\$/g, "$");
}

/** 必须保持同步的入口 nginx 配置（deployment.md 明文要求 + source 模式模板）。 */
const NGINX_CONFIGS = [
  {
    label: "infra/nginx/default.conf（HA / 多副本变量上游）",
    rel: REPO_ROOT_MARKER,
  },
  {
    label: "apps/admin-web/nginx.conf（镜像内置、静态上游）",
    rel: path.join("apps", "admin-web", "nginx.conf"),
  },
] as const;

const ADMIN_API_MAIN = path.join("apps", "admin-api", "src", "main.ts");

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), "utf-8");
}

/**
 * 取出 `location …<marker>… { … }` 的块体（含嵌套花括号的正确配平）。
 *
 * 不引入 nginx 解析器：本闸只需要"这一段里有没有某指令"，块体边界用花括号
 * 计数即可。找不到返回 ''（让调用方的断言以清晰信息失败）。
 */
function extractLocationBlock(conf: string, marker: string): string {
  const re = new RegExp("location[^\\n{]*" + marker + "[^\\n{]*\\{");
  const m = re.exec(conf);
  if (!m) return "";
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  while (i < conf.length && depth > 0) {
    const ch = conf[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    i++;
  }
  return conf.slice(start, i - 1);
}

describe("UPLOADS-PROXY：nginx 必须代理 /uploads（APP-002）", () => {
  it("前提：admin-api 确实把 /uploads 挂在 /api 前缀之外", () => {
    // 若将来 admin-api 把挂载点改到 /api/uploads（或加进 setGlobalPrefix 之后），
    // 本 spec 的前提就变了——届时必须同步改 nginx 与本文档，故先钉住现状。
    const main = read(ADMIN_API_MAIN);
    const uploadsMount = main.indexOf('app.use(\n    "/uploads"');
    const globalPrefix = main.indexOf('setGlobalPrefix("api")');

    // 找不到挂载点说明形态变了，本闸前提需重审（先断言两者都定位得到）。
    expect(uploadsMount).toBeGreaterThanOrEqual(0);
    expect(globalPrefix).toBeGreaterThanOrEqual(0);
    // app.use("/uploads") 必须注册在 setGlobalPrefix("api") **之前**——
    // 这正是下载路径为 /uploads/…（而非 /api/uploads/…）的原因。
    expect(uploadsMount).toBeLessThan(globalPrefix);
    expect(main).toContain('"/uploads"');
  });

  it.each(NGINX_CONFIGS)("$label 必须显式代理 /uploads/", ({ rel }) => {
    const conf = read(rel);

    // 判据 1：存在 ^~ /uploads/ 前缀 location。
    // 为什么钉 `^~`：普通前缀 location 命中后**仍会检查正则 location**，而
    // 两份配置下方都有 `location ~* \.(js|css|png|…)$` 静态资产正则——将来
    // /uploads 下出现同名扩展名文件会被它抢走并 404（该正则带 try_files =404）。
    expect(conf).toMatch(/location\s+\^~\s+\/uploads\/\s*\{/);

    // 判据 2：该 location 必须 proxy_pass，且**不带 URI 部分**。
    // `proxy_pass http://upstream/uploads/;` 之类带 URI 的形态会重写路径，
    // 与 admin-api 的实际挂载点错位（/api/ 块同理，带尾斜杠会剥掉前缀）。
    const block = extractLocationBlock(conf, "uploads");
    expect(block).toBeTruthy();
    expect(block).toMatch(/proxy_pass\s+http:\/\/[^;\s]+;/);
    expect(block).not.toMatch(/proxy_pass\s+http:\/\/[^;\s]*\/(\s|;)/);
  });

  it("两份配置的 /uploads 代理语义必须一致（同步红线）", () => {
    // deployment.md 明文要求两份 nginx 配置保持同步；差异只允许在**上游形态**
    // （default.conf 用 resolver 变量支持 --scale，admin-web 用静态服务名）。
    for (const { rel } of NGINX_CONFIGS) {
      const block = extractLocationBlock(read(rel), "uploads");
      expect(block).toMatch(/proxy_pass\s+http:\/\/[^;\s]+;/);
      expect(block).toMatch(/proxy_http_version\s+1\.1;/);
      expect(block).toMatch(/proxy_set_header\s+Host\s+\$host;/);
    }
  });

  it("deploy.sh 生成的 source 模式站点也必须代理 /uploads/（OPS-01）", () => {
    const conf = readDeployGeneratedSite();

    // 与两份仓库内配置同一组判据——三条路径必须同源，否则"生产推荐"的
    // source 模式会单独复现 APP-002（且闸全绿）。
    expect(conf).toMatch(/location\s+\^~\s+\/uploads\/\s*\{/);
    const block = extractLocationBlock(conf, "uploads");
    expect(block).toBeTruthy();
    expect(block).toMatch(/proxy_pass\s+http:\/\/[^;\s]+;/);
    expect(block).not.toMatch(/proxy_pass\s+http:\/\/[^;\s]*\/(\s|;)/);
    expect(block).toMatch(/proxy_http_version\s+1\.1;/);
    expect(block).toMatch(/proxy_set_header\s+Host\s+\$host;/);
    // 大包下载必须放开读超时（默认 60s 会在 >200MB 应用包上中途断开）。
    expect(block).toMatch(/proxy_read_timeout\s+300s;/);

    // SPA 回退不得因此被删（删了前端路由刷新即 404）。
    expect(conf).toMatch(/try_files\s+\$uri\s+\$uri\/\s+\/index\.html;/);
  });

  it("deploy.sh 的站点模板不得声明不存在的 /metrics 路径（OPS-09）", () => {
    // 真实指标端点是 /api/metrics（metrics.controller 类级装饰器 + 全局 api
    // 前缀），且需要鉴权。模板里的 location /metrics 指向一个不存在的路径：
    // Prometheus 抓到的只会是 SPA 回退（200 + index.html）或 404，而运维会
    // 据此认为"指标没开"。该 location 已删除，/api/ 块天然覆盖它。
    const conf = readDeployGeneratedSite();
    expect(conf).not.toMatch(/location\s+\/metrics\s*\{/);
    expect(conf).toMatch(/location\s+\/api\/\s*\{/);
  });

  it("SPA 回退仍然存在（不得为修本问题而删掉前端路由回退）", () => {
    // 反向保护：修 /uploads 的正确做法是**加**一条 location，而不是删 SPA
    // 回退。删掉回退会让 admin-web 的所有前端路由（/executors、/tasks/…）
    // 刷新即 404。
    for (const { rel } of NGINX_CONFIGS) {
      expect(read(rel)).toMatch(/try_files\s+\$uri\s+\$uri\/\s+\/index\.html;/);
    }
  });
});

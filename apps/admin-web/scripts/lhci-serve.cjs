#!/usr/bin/env node
/**
 * Lighthouse 专用静态服务器（构建产物 + 确定性 API 桩）。
 *
 * 为什么需要它：Lighthouse 审计的是**前端**性能与质量，但此前
 * `startServerCommand` 用的是裸 `vite preview`——它没有 `/api` 代理，
 * 而登录页挂载时会请求 `GET /api/auth/oidc/status`（SSO 可用性探测）。
 * 该请求在审计环境必然失败（502/ECONNREFUSED），于是 Lighthouse 的
 * `errors-in-console` 审计判定「浏览器控制台有错误」，score 0、整体失败。
 *
 * 这是**审计环境的伪缺陷**：真实部署里 admin-api 就在同一个 nginx 后面。
 * 用一个只回固定 JSON 的桩把这条路走通，`errors-in-console` 才重新只反映
 * 「前端自己打出来的错误」——那才是这条审计该管的事。
 *
 * 刻意不引入任何依赖（http/fs/path 即可），也不做真实业务逻辑：
 *   - `/api/*`  → 统一回 200 `{}`；`/api/auth/oidc/status` 回 `{enabled:false}`
 *   - 其余路径 → 先找 dist 里的真实文件，找不到回退 index.html（SPA 路由）
 *
 * 端口由 PORT 控制，默认 4173（与 lighthouserc.json 对齐）。启动后按
 * lighthouserc 的 startServerReadyPattern 打印一行 `Local: <url>`。
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const PORT = Number(process.env.PORT || 4173);
const DIST = path.join(__dirname, '..', 'dist');

/** 少量端点给真实形状的响应，其余 /api 一律空对象（不触发前端报错即可）。 */
const API_STUBS = {
  '/api/auth/oidc/status': { enabled: false },
};

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const COMPRESSIBLE = new Set([
  '.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt', '.map',
]);

function sendFile(req, res, filePath, statusCode = 200) {
  const ext = path.extname(filePath).toLowerCase();
  const body = fs.readFileSync(filePath);
  const headers = {
    'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream',
    // 不设 no-store：Lighthouse 的 bf-cache 审计会把 `cache-control: no-store`
    // 判为「无法进入往返缓存」的直接原因（实测 score 0）。这里只要求
    // 同一轮内行为确定，用 no-cache 即可（允许存储、每次校验）。
    'Cache-Control': 'no-cache',
  };

  // 生产用 nginx gzip_static（见 nginx.conf）。审计服务器也必须压缩：
  // 否则 Lighthouse 的 uses-text-compression 会把未压缩的 JS 判为浪费
  // （实测 1192 KiB），那同样是审计环境伪缺陷，不是前端问题。
  const acceptsGzip = String(req.headers['accept-encoding'] || '').includes('gzip');
  if (acceptsGzip && COMPRESSIBLE.has(ext) && body.length > 1024) {
    const gz = zlib.gzipSync(body);
    res.writeHead(statusCode, {
      ...headers,
      'Content-Encoding': 'gzip',
      Vary: 'Accept-Encoding',
      'Content-Length': gz.length,
    });
    res.end(gz);
    return;
  }

  res.writeHead(statusCode, { ...headers, 'Content-Length': body.length });
  res.end(body);
}

const server = http.createServer((req, res) => {
  // 只取 pathname：查询串不影响静态解析
  const pathname = decodeURIComponent((req.url || '/').split('?')[0]);

  if (pathname.startsWith('/api/')) {
    const stub = API_STUBS[pathname] || {};
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(stub));
    return;
  }

  // 防目录穿越：解析后必须仍在 DIST 内
  const candidate = path.join(DIST, pathname);
  const normalized = path.normalize(candidate);
  if (normalized.startsWith(DIST) && fs.existsSync(normalized) && fs.statSync(normalized).isFile()) {
    sendFile(req, res, normalized);
    return;
  }

  // SPA 回退：未知路径一律回 index.html（与 nginx try_files 语义一致）
  const indexPath = path.join(DIST, 'index.html');
  if (!fs.existsSync(indexPath)) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('dist/index.html 不存在——请先运行 npm run build');
    return;
  }
  sendFile(req, res, indexPath);
});

server.listen(PORT, () => {
  // lighthouserc.json 的 startServerReadyPattern 匹配这一行
  process.stdout.write(`Local: http://localhost:${PORT}\n`);
});

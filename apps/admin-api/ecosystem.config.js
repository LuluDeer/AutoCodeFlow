// PM2 ecosystem config — 路径适配多环境
// 使用 __dirname 动态解析，换目录/换机器无需修改
//   __dirname  = /www/wwwroot/AutoCodeFlow/apps/admin-api
//   项目根    = /www/wwwroot/AutoCodeFlow  ← .env 在此
const path = require('path');

// 项目根：向上一级（apps/admin-api → AutoCodeFlow/）
const PROJECT_ROOT = path.resolve(__dirname, '..');

module.exports = {
  apps: [{
    name: 'admin-api',
    script: 'dist/main.js',
    cwd: PROJECT_ROOT,
    // .env 在项目根，cwd 设到根后直接读 .env
    env_file: path.join(PROJECT_ROOT, '.env'),
  }]
}

import { defineConfig } from 'vitepress';

// AutoCodeFlow SDK 文档站（ECO-05）
// 内容纪律：所有页面为既有文档的「重组」而非重写——
//   docs/sdk-guide.md（ECO-01 能力矩阵）/ packages/autocodeflow-node-sdk/README.md /
//   packages/autoflow-sdk/README.md / examples/*/README.md / packages/contract-fixtures/README.md。
// 仓库相对链接（../ 前缀）一律指向 GitHub 仓库路径，站点内互链用站点根相对路径。
export default defineConfig({
  lang: 'zh-CN',
  title: 'AutoCodeFlow SDK 文档',
  description:
    'AutoCodeFlow 双 SDK（Node.js / Python）使用指南、能力矩阵、官方示例与发布契约',
  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: '/logo.svg' }]],
  ignoreDeadLinks: false,
  srcExclude: ['README.md'], // README 仅入库说明，不作为站点页面路由
  themeConfig: {
    nav: [
      { text: '首页', link: '/' },
      { text: '快速开始', link: '/getting-started' },
      { text: 'SDK 参考', link: '/sdk-node', activeMatch: '/sdk-(node|python)' },
      { text: '能力矩阵', link: '/capability-matrix' },
      { text: '示例库', link: '/examples' },
      { text: '契约', link: '/contract' },
      { text: '发布', link: '/release' },
    ],
    sidebar: [
      {
        text: '上手',
        items: [
          { text: '快速开始（5 分钟）', link: '/getting-started' },
        ],
      },
      {
        text: 'SDK 参考',
        items: [
          { text: 'Node.js — @autocodeflow/sdk', link: '/sdk-node' },
          { text: 'Python — autoflow-sdk', link: '/sdk-python' },
        ],
      },
      {
        text: '对照与示例',
        items: [
          { text: '能力矩阵（ECO-01）', link: '/capability-matrix' },
          { text: '官方示例库', link: '/examples' },
        ],
      },
      {
        text: '契约与发布',
        items: [
          { text: '回调与信封契约', link: '/contract' },
          { text: '版本与发布流程', link: '/release' },
        ],
      },
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/LuluDeer/AutoCodeFlow' },
    ],
    outline: { level: [2, 3], label: '本页目录' },
    docFooter: { prev: '上一页', next: '下一页' },
    lastUpdated: { text: '最后更新' },
    returnToTopLabel: '回到顶部',
    sidebarMenuLabel: '目录',
    lightModeSwitchTitle: '切换到浅色主题',
    darkModeSwitchTitle: '切换到深色主题',
  },
});

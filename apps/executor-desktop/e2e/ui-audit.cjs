// 全面 UI 审计：多窗口尺寸 × 全页面 × 多维检查（基于浏览器实际渲染测量）
// 用法：node e2e/ui-audit.cjs  （输出到 e2e/.ui-audit/）
const { _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_ENTRY = path.join(__dirname, '..', 'dist', 'main', 'index.js');
const ELECTRON_BIN = require('electron');
const OUT = path.join(__dirname, '.ui-audit');

function mkWorkDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-audit-'));
  const metaDir = path.join(root, 'meta');
  fs.mkdirSync(metaDir, { recursive: true });
  const now = Date.now();
  const MIN = 60_000;
  const records = [
    { executionId: 'e1f0a2b3-c7d8-4e5f-9a01-234567890abc', taskId: 't-1001', taskName: '每日报表生成与汇总推送', startTime: now - 8 * MIN, endTime: now - 5 * MIN, status: 'failed', exitCode: 1, errorMessage: 'python: No module named pandas（解释器 3.11 准备失败：下载超时）' },
    { executionId: 'e2f0a2b3-c7d8-4e5f-9a01-234567890abd', taskId: 't-1001', taskName: '每日报表生成与汇总推送', startTime: now - 3 * 60 * MIN, endTime: now - 2 * 60 * MIN, status: 'success', exitCode: 0 },
    { executionId: 'e3f0a2b3-c7d8-4e5f-9a01-234567890abe', taskId: 't-1001', taskName: '每日报表生成与汇总推送', startTime: now - 5 * 60 * MIN, endTime: now - 4 * 60 * MIN, status: 'success', exitCode: 0 },
    { executionId: 'e4f0a2b3-c7d8-4e5f-9a01-234567890abf', taskId: 't-1002', taskName: '库存系统定时对账', startTime: now - 30 * MIN, endTime: now - 28 * MIN, status: 'success', exitCode: 0 },
    { executionId: 'e5f0a2b3-c7d8-4e5f-9a01-234567890ac0', taskId: 't-1002', taskName: '库存系统定时对账', startTime: now - 26 * 60 * MIN, status: 'running' },
  ];
  records.forEach((r, i) => fs.writeFileSync(path.join(metaDir, `meta-${String(i).padStart(4, '0')}.json`), JSON.stringify(r)));
  const appA = path.join(root, 'apps', 'a1b2c3d4-0000-4000-8000-000000000001');
  const relA1 = path.join(appA, 'releases', '1.4.2-3fa1b2c3-0000-4000-8000-00000000000a');
  const relA2 = path.join(appA, 'releases', '1.4.3-3fa1b2c3-0000-4000-8000-00000000000b');
  fs.mkdirSync(relA1, { recursive: true });
  fs.mkdirSync(relA2, { recursive: true });
  fs.writeFileSync(path.join(appA, 'app.json'), JSON.stringify({ appName: '数据同步机器人', runMode: 'daemon' }));
  fs.writeFileSync(path.join(relA2, 'app.json'), JSON.stringify({ appName: '数据同步机器人', runMode: 'daemon' }));
  fs.writeFileSync(path.join(relA2, 'app.log'), Array.from({ length: 40 }, (_, i) => `2026-09-28T0${i % 10}:12:${String(i).padStart(2, '0')}.000Z [INFO] [23fb6898] sync batch #${i} done`).join('\n'));
  return root;
}

// ── 对比度计算（WCAG 相对亮度）──
function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrastRatio(fg, bg) {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}
function parseRgb(str) {
  const m = str.match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  return m ? [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])] : null;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-audit-user-'));
  const workDir = mkWorkDir();
  const app = await electron.launch({
    executablePath: ELECTRON_BIN,
    args: [APP_ENTRY],
    env: { ...process.env, ELECTRON_USER_DATA_DIR: userData },
  });

  const allIssues = [];
  const addIssue = (sev, page, type, detail) => {
    allIssues.push({ sev, page, type, detail });
  };

  // 注入审计脚本到页面
  const auditScript = `
    (function() {
      const issues = [];
      const winW = window.innerWidth;
      const winH = window.innerHeight;
      const page = document.querySelector('.tab-panel.is-active')?.id || 'unknown';

      // 工具
      const r = (el) => {
        const rect = el.getBoundingClientRect();
        return { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height), right: Math.round(rect.right), bottom: Math.round(rect.bottom) };
      };
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const cs = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity) > 0;
      };
      const clsOf = (el) => (el.className && el.className.toString ? el.className.toString().slice(0, 45) : el.tagName);
      const textOf = (el) => ((el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '?').trim().replace(/\\s+/g, ' ').slice(0, 28));

      // 1. 触控目标：可交互元素高度 < 24px（WCAG 2.5.5 / 2.1 draft 24px）
      document.querySelectorAll('button, input:not([type=hidden]), select, textarea, a, [role="button"], [role="tab"]').forEach((el) => {
        if (!visible(el)) return;
        const rect = el.getBoundingClientRect();
        const cs = window.getComputedStyle(el);
        // 排除纯图标极小钮（有 aria-label 且尺寸是容器有意设计的 30px app-icon-button 已在 24 之上）
        if (rect.height > 0 && rect.height < 24) {
          issues.push({ sev: 'warn', type: 'touch-target', detail: clsOf(el) + ' "' + textOf(el) + '" h=' + Math.round(rect.height) });
        }
        // 焦点可见性：focus-visible 元素应有 outline（静态近似检查：button 有无 :focus-visible 样式由 CSS 决定，略）
      });

      // 2. 文本溢出（水平）：叶子元素 scrollWidth 明显大于 clientWidth 且未设置 ellipsis
      document.querySelectorAll('span, p, label, strong, div, button, td, th').forEach((el) => {
        if (!visible(el)) return;
        if (el.closest('.log-viewer')) return;
        if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) {
          const cs = window.getComputedStyle(el);
          const hasEllipsis = cs.textOverflow === 'ellipsis' && cs.overflow !== 'visible';
          const rect = el.getBoundingClientRect();
          if (!hasEllipsis && rect.height < 60 && rect.height > 0 && rect.width < winW) {
            // 只有真正可见文本才报（过滤掉含块级子元素的容器）
            const hasBlockChild = Array.from(el.children).some(c => {
              const ccs = window.getComputedStyle(c);
              return ['block', 'flex', 'grid'].includes(ccs.display);
            });
            if (!hasBlockChild && el.textContent.trim().length > 3) {
              issues.push({ sev: 'warn', type: 'text-clipped', detail: clsOf(el) + ' "' + textOf(el) + '" scroll=' + el.scrollWidth + ' client=' + el.clientWidth });
            }
          }
        }
      });

      // 3. 元素超出视口 / 负坐标
      document.querySelectorAll('body *').forEach((el) => {
        if (!visible(el)) return;
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          if (rect.left < -2 || rect.top < -2) {
            const cs = window.getComputedStyle(el);
            if (cs.position !== 'fixed' || rect.width < winW) {
              issues.push({ sev: 'info', type: 'offscreen-neg', detail: clsOf(el) + ' x=' + Math.round(rect.left) + ' y=' + Math.round(rect.top) });
            }
          }
          if (rect.right > winW + 2 && !el.closest('.log-viewer')) {
            // 横向滚动容器豁免
            let p = el.parentElement;
            let scrollable = false;
            while (p) { const cs = window.getComputedStyle(p); if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') { scrollable = true; break; } p = p.parentElement; }
            if (!scrollable) {
              issues.push({ sev: 'warn', type: 'overflow-x', detail: clsOf(el) + ' right=' + Math.round(rect.right) + ' > ' + winW });
            }
          }
        }
      });

      // 4. 对比度：抽样正文/按钮文本，< 4.5 报 warn，< 3 报 err
      const sampleText = document.querySelectorAll('.hero-status-text, .overview-label, .cfg-hint, .cfg-subtitle, .history-subtitle, .apps-total, .log-empty, .app-group-summary, .empty-hint, .app-deployment-sub, .history-run-time, .wizard-subtitle, .toggle-info span, .cfg-toggle-info span, .py-env-val em');
      sampleText.forEach((el) => {
        if (!visible(el)) return;
        const cs = window.getComputedStyle(el);
        const color = cs.color;
        // 找最近的有背景色的祖先
        let bg = null;
        let node = el;
        while (node && node !== document.body) {
          const ncs = window.getComputedStyle(node);
          const bgc = ncs.backgroundColor;
          if (bgc && bgc !== 'rgba(0, 0, 0, 0)' && bgc !== 'transparent') { bg = bgc; break; }
          node = node.parentElement;
        }
        if (!bg) { bg = window.getComputedStyle(document.body).backgroundColor; }
        window.__contrastSamples = window.__contrastSamples || [];
        window.__contrastSamples.push({ cls: clsOf(el), color, bg, text: textOf(el) });
      });

      // 5. 间距一致性：同容器内兄弟卡片的垂直间距应一致（>0 且方差小）
      ['.cfg-scroll-inner', '.status-page', '.apps-list', '.wizard-body'].forEach((containerSel) => {
        const container = document.querySelector(containerSel);
        if (!container) return;
        const children = Array.from(container.children).filter(visible);
        for (let i = 1; i < children.length; i++) {
          const prev = children[i-1].getBoundingClientRect();
          const curr = children[i].getBoundingClientRect();
          const gap = Math.round(curr.top - prev.bottom);
          if (gap < 0) {
            issues.push({ sev: 'err', type: 'overlap', detail: containerSel + ' 子元素重叠 gap=' + gap + ' (' + clsOf(children[i-1]) + ' -> ' + clsOf(children[i]) + ')' });
          }
        }
      });

      // 6. 图片/图标缺失 alt/aria（svg icon 已 aria-hidden，跳过）

      // 7. 重复 id
      const ids = {};
      document.querySelectorAll('[id]').forEach((el) => { ids[el.id] = (ids[el.id] || 0) + 1; });
      Object.entries(ids).forEach(([id, n]) => { if (n > 1) issues.push({ sev: 'err', type: 'duplicate-id', detail: '#' + id + ' x' + n }); });

      return { page, issues, winW, winH };
    })()
  `;

  async function auditCurrent(win, label) {
    const res = await win.evaluate(auditScript);
    for (const i of res.issues) addIssue(i.sev, label, i.type, i.detail);
    // 对比度样本在主进程侧计算
    const samples = await win.evaluate(() => window.__contrastSamples || []);
    await win.evaluate(() => { window.__contrastSamples = []; });
    for (const s of samples) {
      const fg = parseRgb(s.color);
      const bg = parseRgb(s.bg);
      if (fg && bg) {
        const ratio = contrastRatio(fg, bg);
        if (ratio < 3) addIssue('err', label, 'contrast', `${s.cls} "${s.text}" ratio=${ratio.toFixed(2)} fg=${s.color} bg=${s.bg}`);
        else if (ratio < 4.5) addIssue('warn', label, 'contrast', `${s.cls} "${s.text}" ratio=${ratio.toFixed(2)} fg=${s.color} bg=${s.bg}`);
      }
    }
    return res;
  }

  try {
    const wizard = await app.firstWindow();
    await wizard.waitForLoadState('domcontentloaded');
    await wizard.getByText('欢迎使用').first().waitFor({ timeout: 20000 });

    // 向导各步
    await auditCurrent(wizard, '向导-step1');
    await wizard.getByRole('button', { name: /开始配置/ }).click();
    await wizard.waitForTimeout(300);
    await auditCurrent(wizard, '向导-step2');
    // step2 需要填 URL 才能点下一步
    await wizard.locator('input.input').first().fill('http://192.168.1.10:3001');
    await wizard.waitForTimeout(200);
    await wizard.getByRole('button', { name: /下一步/ }).click();
    await wizard.waitForTimeout(300);
    await auditCurrent(wizard, '向导-step3');
    // step3 需要填执行器名称才能点下一步
    await wizard.locator('input.input').first().fill('demo-executor-01');
    await wizard.waitForTimeout(200);
    await wizard.getByRole('button', { name: /下一步/ }).click();
    await wizard.waitForTimeout(300);
    await auditCurrent(wizard, '向导-step4');

    const cfg = await wizard.evaluate(() => window.electronAPI.getConfig());
    const statusReady = app.waitForEvent('window');
    await wizard.evaluate(([config, dir]) => {
      void window.electronAPI.saveAndCloseWizard({ ...config, workDir: dir, adminApiUrl: 'http://192.168.1.10:3001', executorName: 'demo-executor-01', autoStart: false, autoStartExecutor: false });
    }, [cfg, workDir]);
    const status = await statusReady;
    await status.waitForLoadState('domcontentloaded');
    await status.getByText('运行日志').first().waitFor({ timeout: 20000 });

    // 状态页 + 全屏日志查看器
    await auditCurrent(status, '状态页');
    await status.getByRole('button', { name: '查看日志' }).click();
    await status.waitForTimeout(300);
    await auditCurrent(status, '全屏日志');
    await status.keyboard.press('Escape');
    await status.waitForTimeout(200);

    // 配置页 5 分区
    await status.getByRole('tab', { name: '配置' }).click();
    await status.waitForTimeout(300);
    await auditCurrent(status, '配置-连接');
    for (const name of ['网络地址', 'Python 运行环境', 'Agent（实验性）', '基本设置']) {
      await status.getByRole('button', { name }).click();
      await status.waitForTimeout(250);
      await auditCurrent(status, '配置-' + name);
    }

    // 历史页 + 日志浮层
    await status.getByRole('tab', { name: '历史' }).click();
    await status.waitForTimeout(500);
    await auditCurrent(status, '历史页');
    await status.getByRole('button', { name: '查看日志' }).first().click();
    await status.waitForTimeout(300);
    await auditCurrent(status, '历史-日志浮层');
    await status.getByRole('button', { name: '关闭', exact: true }).click();
    await status.waitForTimeout(200);

    // 应用页 + 展开 + 确认条
    await status.getByRole('tab', { name: '应用' }).click();
    await status.waitForTimeout(400);
    await auditCurrent(status, '应用页');
    await status.getByRole('button', { name: /数据同步机器人/ }).first().click();
    await status.waitForTimeout(300);
    await auditCurrent(status, '应用-展开');
    await status.getByRole('button', { name: /删除 v1\.4\.2 的本地部署/ }).click();
    await status.waitForTimeout(200);
    await auditCurrent(status, '应用-删除确认');
    await status.getByRole('button', { name: '取消' }).click();
    await status.waitForTimeout(200);

    // 应用日志查看器
    const viewLogBtn = status.getByRole('button', { name: '应用日志' }).first();
    if (await viewLogBtn.count() > 0) {
      await viewLogBtn.click();
      await status.waitForTimeout(300);
      await auditCurrent(status, '应用-日志查看器');
      await status.keyboard.press('Escape');
      await status.waitForTimeout(200);
    }

    // ── 窄窗口审计（真实窗口缩放，非视口模拟）──
    // setViewportSize 只是 Emulation.setDeviceMetricsOverride——模拟视口指标，
    // 真实 BrowserWindow 不动，不触发主进程 resize 事件/尺寸记忆逻辑。
    // 正确做法：app.evaluate 在主进程对真实窗口调 setSize。
    const sizes = [
      { w: 960, h: 640, label: '窄窗口960x640' },
      { w: 760, h: 560, label: '最小760x560' },
    ];
    for (const s of sizes) {
      try {
        await app.evaluate(({ BrowserWindow }, { w, h }) => {
          const win = BrowserWindow.getAllWindows()[0];
          if (win) {
            if (win.isMaximized()) win.unmaximize();
            win.setSize(w, h);
          }
        }, { w: s.w, h: s.h });
        await status.waitForTimeout(500);
        const realSize = await status.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
        console.log(`  真实窗口缩放至 ${realSize.w}x${realSize.h}（请求 ${s.w}x${s.h}）`);
        // 逐页审计
        for (const tab of ['状态监控', '配置', '历史', '应用']) {
          await status.getByRole('tab', { name: tab }).click();
          await status.waitForTimeout(250);
          await auditCurrent(status, s.label + '-' + tab);
        }
      } catch (e) {
        addIssue('info', s.label, 'resize-fail', String(e).slice(0, 80));
      }
    }
    // 恢复窗口尺寸
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) win.setSize(1440, 900);
    });

    // ── 输出报告 ──
    const sev = { err: 0, warn: 0, info: 0 };
    for (const i of allIssues) sev[i.sev] = (sev[i.sev] || 0) + 1;

    const lines = [];
    lines.push(`UI 审计报告 — ${new Date().toISOString()}`);
    lines.push(`总计: ${allIssues.length} 个问题 (err=${sev.err} warn=${sev.warn} info=${sev.info})`);
    lines.push('');
    // 去重（同 page+type+detail）
    const seen = new Set();
    const uniq = allIssues.filter((i) => {
      const k = `${i.page}|${i.type}|${i.detail}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    lines.push(`去重后: ${uniq.length} 个独立问题`);
    lines.push('');
    const order = { err: 0, warn: 1, info: 2 };
    uniq.sort((a, b) => order[a.sev] - order[b.sev] || a.page.localeCompare(b.page));
    let curSev = null;
    for (const i of uniq) {
      if (i.sev !== curSev) { curSev = i.sev; lines.push(`\n── ${curSev.toUpperCase()} ──`); }
      lines.push(`[${i.page}] ${i.type}: ${i.detail}`);
    }

    const reportPath = path.join(OUT, 'audit-report.txt');
    fs.writeFileSync(reportPath, lines.join('\n'));
    console.log(lines.slice(0, 60).join('\n'));
    console.log(`\n... 完整报告: ${reportPath}`);
    console.log(`总计 ${allIssues.length} 原始 / ${uniq.length} 独立问题 (err=${sev.err} warn=${sev.warn} info=${sev.info})`);
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  }
})().catch((err) => { console.error(err); process.exit(1); });

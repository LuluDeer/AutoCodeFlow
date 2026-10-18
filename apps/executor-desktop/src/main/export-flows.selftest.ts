/**
 * 拓展包「配置导入/导出 + 执行日志导出 + 诊断报告」selftest。
 * Run via: npm run test:main
 *
 * 覆盖面：
 *  · export-flows.ts 纯函数行为（导出文件名 / 导入解析 / 掩码剥离 / 大小阈值）；
 *  · 掩码 token 导入语义的两层钉住：①导入解析层直接剥离掩码与空 token
 *    （本文件）；②ConfigStore.save 既有的「掩码哨兵=保留存量」分支不被
 *    拆除（SYNC 结构断言）——两层任一被拆，真实 token 都可能被掩码/空串
 *    覆盖或清空；
 *  · PLAN-EXECUTOR-DESKTOP-UX 5.2 诊断报告：段齐全 + **凭据永不出现** +
 *    体积有界 + 注入面隔离（绝不抛错）；
 *  · SYNC 接线守卫：IMPORTABLE_CONFIG_KEYS 与 config-store.ts 的 AppConfig
 *    接口逐键双向对齐；四条 IPC handler 的关键实现锚点不被静默拆除。
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CONFIG_IMPORT_MAX_BYTES,
  DIAGNOSTIC_FIELD_MAX_CHARS,
  DIAGNOSTIC_LOG_LINE_MAX_CHARS,
  DIAGNOSTIC_LOG_MAX_LINES,
  DIAGNOSTIC_REDACTED,
  EXPORT_TOKEN_MASK,
  IMPORTABLE_CONFIG_KEYS,
  LOG_EXPORT_MAX_BYTES,
  buildConfigExportPayload,
  buildDiagnosticReport,
  configExportFileName,
  diagnosticReportFileName,
  execLogExportFileName,
  formatBytesHuman,
  logExportTooLarge,
  parseImportedConfig,
} from './export-flows';

function read(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '..', 'src', 'main', rel), 'utf-8');
}

function main(): void {
  // ── 1. 导出默认文件名 ──────────────────────────────────────────────
  {
    assert.strictEqual(
      configExportFileName(new Date(2026, 9, 5, 8, 3, 9)),
      'acf-executor-config-20261005.json',
      '导出文件名必须是 acf-executor-config-YYYYMMDD.json（本地时区、月/日补零）',
    );
    assert.strictEqual(
      execLogExportFileName('exec-abc_123', new Date(2026, 0, 2)),
      'acf-exec-log-exec-abc_123-20260102.log',
      '日志导出文件名必须含执行 id 与日期',
    );
  }

  // ── 2. 导出载荷守卫：掩码之外的真实 token / 加密信封一律拒绝导出 ────
  {
    const maskedCfg = { executorToken: EXPORT_TOKEN_MASK, adminApiUrl: 'http://x' };
    assert.strictEqual(
      buildConfigExportPayload(maskedCfg),
      maskedCfg,
      '导出载荷必须透传入参（不复制不改写，与 getAllMasked 读面同一对象语义）',
    );
    assert.strictEqual(
      buildConfigExportPayload({ executorToken: '' }).executorToken,
      '',
      '空 token（未配置过密钥的机器）允许导出',
    );
    assert.throws(
      () => buildConfigExportPayload({ executorToken: 'real-plaintext-secret' }),
      /unmasked/,
      '明文 token 绝不允许进导出载荷（必须走 getAllMasked）',
    );
    assert.throws(
      () => buildConfigExportPayload({ executorToken: 'enc:ss:QUJD' }),
      /unmasked/,
      '加密信封同样不允许进导出载荷（掩码读面出现信封=调用侧拿错真值源）',
    );
  }

  // ── 3. 导入解析：形状校验 + 白名单 + 掩码/空 token 剥离 ─────────────
  {
    // 非对象根节点（含数组 / null / 标量）必须拒绝，而不是把 undefined/垃圾送进保存链
    for (const bad of [null, undefined, 42, 'cfg', [], true]) {
      const r = parseImportedConfig(bad);
      assert.ok(!r.ok, `${JSON.stringify(bad)} 必须被拒绝`);
      assert.ok(r.error.length > 0, '拒绝时必须带用户可见的错误信息');
    }
    // 白名单：未知键（含 __proto__ / constructor 等危险名）一律不进补丁。
    // 用 JSON.parse 造入参——文件导入的真实形态就是它（此时 __proto__ 是
    // 自有数据属性，而非对象字面量里的原型 setter 语法糖）。
    {
      const r = parseImportedConfig(JSON.parse(
        '{"executorName":"imported","__proto__":{"polluted":true},"constructor":"junk","someFutureField":"x"}',
      ));
      assert.ok(r.ok);
      assert.deepStrictEqual(Object.keys(r.payload), ['executorName'], '白名单外的键必须全部剔除');
      assert.strictEqual(
        Object.getPrototypeOf(r.payload),
        Object.prototype,
        '解析结果不得携带外来原型（原型污染防线）',
      );
    }
    // 掩码 token（导出文件的常态）导入时必须剥离——导入永不覆盖存量 token
    {
      const r = parseImportedConfig({ executorName: 'a', executorToken: EXPORT_TOKEN_MASK });
      assert.ok(r.ok);
      assert.ok(
        !('executorToken' in r.payload),
        "掩码 '******' 导入时必须剥离（不得覆盖真实 token）",
      );
    }
    // 空 token 同理剥离——save() 把空串解释为"用户清空密钥"，导入绝不因
    // 源机器没配过密钥而把目标机器的存量 token 清掉
    {
      const r = parseImportedConfig({ executorName: 'a', executorToken: '' });
      assert.ok(r.ok && !('executorToken' in r.payload), "空 token 导入时必须剥离（不得清空真实 token）");
    }
    // 真实 token（跨机完整迁移）原样保留，交由 sanitize → save 加密落盘
    {
      const r = parseImportedConfig({ executorName: 'a', executorToken: 'real-secret' });
      assert.ok(r.ok && r.payload.executorToken === 'real-secret', '真实 token 必须原样保留（完整迁移语义）');
    }
    // 空对象 / 全部键都被剥离 → 明确报错，而不是一次静默的空保存
    assert.ok(!parseImportedConfig({}).ok, '空配置必须报错');
    assert.ok(
      !parseImportedConfig({ executorToken: EXPORT_TOKEN_MASK }).ok,
      '剥掉掩码 token 后再无其它键 → 必须报错（不得静默空导入）',
    );
    // 文件大小上限是导出的配套常量：配置是 KB 级 JSON
    assert.ok(CONFIG_IMPORT_MAX_BYTES >= 64 * 1024, '导入上限不得小到卡死合法配置');
    assert.ok(CONFIG_IMPORT_MAX_BYTES <= 16 * 1024 * 1024, '导入上限必须足以拦下"拿错的大文件"');
    // i18n-DESK-01：界面语言设置必须**能**随备份迁移（跨机恢复时语言偏好一并
    // 带走），而不是被白名单静默丢掉——丢字段的形态是"导入成功但设置没搬过来"。
    {
      const r = parseImportedConfig({ uiLanguage: 'en' });
      assert.ok(r.ok && r.payload.uiLanguage === 'en', '导入白名单必须带上 uiLanguage（语言设置随备份迁移）');
      // 坏值不在这里拦（形状校验不复制消毒语义）——它必须能进补丁，
      // 由下游 sanitizeConfigInput 归一化成默认中文（同 save 链路）。
      const bad = parseImportedConfig({ uiLanguage: 'fr' });
      assert.ok(bad.ok && bad.payload.uiLanguage === 'fr', '非法语言值交给下游消毒层归一化，不在导入解析层静默丢弃');
    }
  }

  // ── 4. 日志导出的大文件阈值（200MB 边界）────────────────────────────
  {
    assert.strictEqual(logExportTooLarge(0), false, '空文件可导出');
    assert.strictEqual(logExportTooLarge(LOG_EXPORT_MAX_BYTES), false, '恰好 200MB 可导出（> 而非 >=）');
    assert.strictEqual(logExportTooLarge(LOG_EXPORT_MAX_BYTES + 1), true, '超过 200MB 必须拦截');
    assert.strictEqual(logExportTooLarge(NaN), false, 'stat 失败（NaN）不拦——错误留给 copyFile 抛');
    assert.strictEqual(logExportTooLarge(-1), false, '负数（stat 失败哨兵）不拦');
  }

  // ══════════════════════════════════════════════════════════════════════
  // 5. PLAN-EXECUTOR-DESKTOP-UX 5.2：诊断报告
  // ══════════════════════════════════════════════════════════════════════
  // 两条硬性验收口径（任务书原文）：(a) 永不包含密钥真值，(b) 所有段都在。
  // 另加体积有界与"绝不抛错"——诊断是排障最后手段，任何一项失守都会让用户
  // 拿不到现场。
  {
    // 注入面：一份**故意带明文 token** 的配置——生产侧会传 getAllMasked()，
    // 但"调用侧拿错真值源"是本仓反复出现的 bug 形态（见 buildConfigExportPayload
    // 的抛错守卫）。诊断报告必须在这种情况下仍然安全。
    const PLAINTEXT_TOKEN = 'real-plaintext-secret-value-1234567890';
    const ENVELOPE_TOKEN = 'enc:ss:QUJDREVGR0g=';
    const ADMIN_PASSWORD = 'admin-password-should-never-leak';

    const baseInputs = () => ({
      now: new Date(2026, 9, 5, 8, 3, 9),
      runtime: {
        appVersion: '1.9.0',
        electronVersion: '44.4.5',
        nodeVersion: '24.21.0',
        chromeVersion: '140.0.7339.41',
        osVersion: 'Windows_NT 10.0.22631',
        platform: 'win32',
        arch: 'x64',
        osRelease: '10.0.22631',
        packaged: true,
        locale: 'zh-CN',
      },
      config: {
        configured: true,
        adminApiUrl: 'https://admin.example.com',
        executorName: 'exec-1',
        executorHost: '0.0.0.0',
        executorPort: 8002,
        executorToken: PLAINTEXT_TOKEN,
        workDir: 'E:\\acf\\work',
        maxConcurrentTasks: 4,
        autoStart: false,
        autoStartExecutor: true,
        notifyEnabled: true,
        logLevel: 'info',
        uiLanguage: 'zh',
        pullMode: true,
        agentAllowedApps: ['app-a', 'app-b'],
      },
      health: {
        executorStatus: 'online',
        executorRunning: true,
        localHealthLive: true,
        adminRegistration: 'registered',
        heartbeatStatus: 'online',
        executorPort: 8002,
        adminApiUrl: 'https://admin.example.com',
      },
      workDir: {
        path: 'E:\\acf\\work',
        exists: true,
        writable: true,
        freeBytes: 50 * 1024 * 1024 * 1024,
        totalBytes: 500 * 1024 * 1024 * 1024,
      },
      recentLogs: [
        '2026-10-05 08:00:00 [INFO] executor started',
        `2026-10-05 08:00:01 [INFO] token=${PLAINTEXT_TOKEN}`,
        '2026-10-05 08:00:02 [WARN] heartbeat failed',
      ],
      knownSecrets: [PLAINTEXT_TOKEN, ENVELOPE_TOKEN, ADMIN_PASSWORD],
    });

    // ── (a) 段齐全 ────────────────────────────────────────────────────
    {
      const report = buildDiagnosticReport(baseInputs());
      assert.strictEqual(report.format, 'acf-diagnostic/1', '5.2: 报告格式标识必须稳定');
      assert.strictEqual(
        report.generatedAt,
        new Date(2026, 9, 5, 8, 3, 9).toISOString(),
        '5.2: generatedAt 必须来自注入的 now（可测）',
      );
      // 五段全部存在（任务书的段清单：环境 / 配置 / 健康 / 工作目录 / 日志）
      for (const section of ['runtime', 'config', 'health', 'workDir', 'recentLogs']) {
        assert.ok(
          report.sections[section as keyof typeof report.sections] !== undefined,
          `5.2: 报告必须包含 sections.${section}`,
        );
      }
      // 环境段逐字段
      const rt = report.sections.runtime;
      assert.strictEqual(rt.appVersion, '1.9.0', '5.2: 应用版本');
      assert.strictEqual(rt.electronVersion, '44.4.5', '5.2: Electron 版本');
      assert.strictEqual(rt.nodeVersion, '24.21.0', '5.2: Node 版本');
      assert.strictEqual(rt.chromeVersion, '140.0.7339.41', '5.2: Chrome 版本');
      assert.strictEqual(rt.platform, 'win32', '5.2: OS platform');
      assert.strictEqual(rt.arch, 'x64', '5.2: OS arch');
      assert.strictEqual(rt.osRelease, '10.0.22631', '5.2: OS release');
      assert.strictEqual(rt.packaged, true, '5.2: 打包态');
      // 健康段
      const h = report.sections.health;
      assert.strictEqual(h.executorStatus, 'online', '5.2: 执行器状态');
      assert.strictEqual(h.localHealthLive, true, '5.2: 本地健康探针');
      assert.strictEqual(h.adminRegistration, 'registered', '5.2: 中台注册判定');
      assert.strictEqual(h.executorPort, 8002, '5.2: 执行器端口');
      // 工作目录段（可写性 + 剩余空间）
      const wd = report.sections.workDir;
      assert.strictEqual(wd.path, 'E:\\acf\\work', '5.2: 工作目录路径');
      assert.strictEqual(wd.exists, true, '5.2: 工作目录存在性');
      assert.strictEqual(wd.writable, true, '5.2: 工作目录可写性');
      assert.strictEqual(wd.freeBytes, 50 * 1024 * 1024 * 1024, '5.2: 剩余空间字节数');
      assert.ok(wd.freeHuman && wd.freeHuman.includes('GB'), '5.2: 剩余空间必须有人类可读形式');
      // 日志段
      assert.strictEqual(report.sections.recentLogs.count, 3, '5.2: 日志行数');
      assert.strictEqual(report.sections.recentLogs.truncated, false, '5.2: 未超限时 truncated=false');
    }

    // ── (b) 密钥绝不出现（secret-redaction 断言）────────────────────────
    {
      const report = buildDiagnosticReport(baseInputs());
      // 序列化整份报告后做**全量子串**检查——这是最贴近真实泄漏的判据：
      // 只要任何一个字段（含嵌套的日志行、错误消息、地址）里出现了真值，
      // 序列化文本里就能搜到。逐字段断言会漏掉未来新增的字段。
      const serialized = JSON.stringify(report);
      for (const [label, secret] of [
        ['明文 executorToken', PLAINTEXT_TOKEN],
        ['加密信封 token', ENVELOPE_TOKEN],
        ['中台口令（knownSecrets）', ADMIN_PASSWORD],
      ] as const) {
        assert.ok(
          !serialized.includes(secret),
          `5.2 密钥泄漏：${label} 出现在了诊断报告里 —— 这是本功能最严重的失败形态`,
        );
      }
      // 配置段的 token 必须显式是掩码哨兵（而不是被静默删除——用户要知道
      // "这里有一项被藏起来了"，而不是以为根本没配）
      assert.strictEqual(
        report.sections.config.executorToken,
        DIAGNOSTIC_REDACTED,
        '5.2: 配置段的 executorToken 必须是掩码哨兵（不得缺字段）',
      );
      // meta.redactedKeys 必须留痕（不含值）——读报告的人能看到"这里被藏了"
      assert.ok(
        report.meta.redactedKeys.includes('executorToken'),
        '5.2: meta.redactedKeys 必须记录被掩码的键名（不含值）',
      );
      // 日志行里的 token 也必须被抹掉（自由文本子串级脱敏）
      assert.ok(
        report.sections.recentLogs.lines.some((l) => l.includes(DIAGNOSTIC_REDACTED)),
        '5.2: 日志行里的凭据真值必须被子串级抹除（不只是配置段）',
      );
      // 反向：非凭据的排障必需字段必须**保留原值**（脱敏过度会让报告没用）
      assert.strictEqual(
        report.sections.config.adminApiUrl,
        'https://admin.example.com',
        '5.2: 中台地址不是凭据，必须保留原值（否则"连的是哪台"都答不了）',
      );
      assert.strictEqual(report.sections.config.workDir, 'E:\\acf\\work', '5.2: 工作目录必须保留原值');
      assert.strictEqual(report.sections.config.executorPort, '8002', '5.2: 端口必须保留');
      assert.deepStrictEqual(
        report.sections.config.agentAllowedApps,
        ['app-a', 'app-b'],
        '5.2: 白名单必须保留结构（脱敏不砍排障信息）',
      );
    }

    // ── (c) 调用侧漏传 knownSecrets 时，凭据键仍然安全（三层防线独立成立）──
    {
      const inputs = baseInputs();
      // 故意不传 knownSecrets —— 只靠"配置里凭据键的真值"这一层
      const report = buildDiagnosticReport({ ...inputs, knownSecrets: [] });
      const serialized = JSON.stringify(report);
      assert.ok(
        !serialized.includes(PLAINTEXT_TOKEN),
        '5.2: 即便调用侧漏传 knownSecrets，配置里的 token 真值也必须被抹除' +
          '（buildDiagnosticReport 自行从 config 收集凭据）',
      );
      assert.strictEqual(
        report.sections.config.executorToken,
        DIAGNOSTIC_REDACTED,
        '5.2: 凭据键掩码不依赖 knownSecrets（第一层独立）',
      );
    }

    // ── (c2) 真凭据被误填进**非凭据键**时也必须被抹除（子串级防线）──────
    // 真实形态：用户把 token 粘进了 executorName / 把带 userinfo 的地址粘进了
    // adminApiUrl。键级白名单管不到这些键，只有子串级抹除能兜住。
    {
      const report = buildDiagnosticReport({
        ...baseInputs(),
        config: {
          ...baseInputs().config,
          // 误填：非凭据键里出现了 token 真值
          executorName: `my-exec-${PLAINTEXT_TOKEN}`,
          // 误填：地址里带 userinfo（那段是真凭据）
          adminApiUrl: 'https://bob:hunter2-secret-pw@admin.example.com',
        },
        knownSecrets: [PLAINTEXT_TOKEN, 'hunter2-secret-pw'],
      });
      const serialized = JSON.stringify(report);
      assert.ok(
        !serialized.includes(PLAINTEXT_TOKEN),
        '5.2: 误填进非凭据键（executorName）的 token 真值也必须被抹除（子串级防线）',
      );
      assert.ok(
        !serialized.includes('hunter2-secret-pw'),
        '5.2: adminApiUrl 里的 userinfo 口令也必须被抹除（子串级防线）',
      );
      // 抹除后仍要保留可读的上下文（不是整段删掉，否则排障价值归零）
      assert.ok(
        String(report.sections.config.executorName).includes('my-exec-'),
        '5.2: 子串级抹除必须保留周边文本（只换掉凭据本身）',
      );
      assert.ok(
        String(report.sections.config.adminApiUrl).includes('admin.example.com'),
        '5.2: 子串级抹除必须保留主机名（否则"连的是哪台"都答不了）',
      );
    }

    // ── (d) 绝不抛错：脏输入/缺字段一律降级 ─────────────────────────────
    {
      // 最小输入：只有 now + runtime + config 的必填字段
      const minimal = buildDiagnosticReport({
        now: new Date(0),
        runtime: {
          appVersion: '0.0.0',
          electronVersion: '',
          nodeVersion: '',
          chromeVersion: '',
          platform: 'linux',
          arch: 'arm64',
          osRelease: '',
        },
        config: {},
      });
      assert.strictEqual(minimal.sections.config.executorToken, undefined, '5.2: 未配置 token 时不虚构字段');
      assert.strictEqual(minimal.sections.health.executorStatus, null, '5.2: 无健康输入 → null（不是 undefined）');
      assert.strictEqual(minimal.sections.workDir.writable, null, '5.2: 无目录输入 → null');
      assert.strictEqual(minimal.sections.recentLogs.count, 0, '5.2: 无日志 → 空数组');
      assert.deepStrictEqual(minimal.meta.redactedKeys, [], '5.2: 无凭据时 redactedKeys 为空');
      // 脏 now：Invalid Date 不得让报告崩（回落 epoch）
      const badNow = buildDiagnosticReport({
        ...baseInputs(),
        now: new Date('not a date'),
      });
      assert.strictEqual(
        badNow.generatedAt,
        new Date(0).toISOString(),
        '5.2: 非法 now 必须降级为 epoch 而不是抛错',
      );
      // 脏日志项（非字符串 / null / undefined）不得炸
      const dirtyLogs = buildDiagnosticReport({
        ...baseInputs(),
        recentLogs: [null, undefined, 42, { a: 1 }, 'ok'] as unknown as string[],
      });
      assert.strictEqual(dirtyLogs.sections.recentLogs.count, 5, '5.2: 脏日志项必须被 String() 归一而不是丢弃');
    }

    // ── (e) 体积有界：行数 / 行长 / 字段长三道上限 ──────────────────────
    {
      const manyLines = Array.from({ length: DIAGNOSTIC_LOG_MAX_LINES + 50 }, (_, i) => `line-${i}`);
      const report = buildDiagnosticReport({ ...baseInputs(), recentLogs: manyLines });
      assert.strictEqual(
        report.sections.recentLogs.count,
        DIAGNOSTIC_LOG_MAX_LINES,
        `5.2: 日志行数必须封顶到 ${DIAGNOSTIC_LOG_MAX_LINES}`,
      );
      assert.strictEqual(report.meta.logsDropped, 50, '5.2: 被丢弃的行数必须如实记录（不得静默）');
      assert.strictEqual(report.sections.recentLogs.truncated, true, '5.2: 超限时 truncated=true');
      // 保留的是**尾部**（最近的），不是开头
      assert.strictEqual(
        report.sections.recentLogs.lines[report.sections.recentLogs.lines.length - 1],
        `line-${DIAGNOSTIC_LOG_MAX_LINES + 49}`,
        '5.2: 截断必须保留尾部（最近发生的），不是开头',
      );
      // 单行超长必须被截断
      const longLine = buildDiagnosticReport({
        ...baseInputs(),
        recentLogs: ['x'.repeat(DIAGNOSTIC_LOG_LINE_MAX_CHARS * 3)],
      });
      assert.ok(
        longLine.sections.recentLogs.lines[0].length <= DIAGNOSTIC_LOG_LINE_MAX_CHARS,
        `5.2: 单行必须封顶到 ${DIAGNOSTIC_LOG_LINE_MAX_CHARS} 字符`,
      );
      assert.strictEqual(longLine.meta.logsClipped, 1, '5.2: 被截断的行数必须如实记录');
      // 超长配置字段必须被截断（一个被误填成整篇文档的 adminApiUrl 不该撑爆报告）
      const longField = buildDiagnosticReport({
        ...baseInputs(),
        config: { ...baseInputs().config, adminApiUrl: 'h'.repeat(DIAGNOSTIC_FIELD_MAX_CHARS * 5) },
      });
      assert.ok(
        String(longField.sections.config.adminApiUrl).length <= DIAGNOSTIC_FIELD_MAX_CHARS,
        `5.2: 配置字段必须封顶到 ${DIAGNOSTIC_FIELD_MAX_CHARS} 字符`,
      );
      // 白名单条目数上限（5000 条白名单不该整份带走）
      const manyApps = buildDiagnosticReport({
        ...baseInputs(),
        config: { ...baseInputs().config, agentAllowedApps: Array.from({ length: 5000 }, (_, i) => `a${i}`) },
      });
      assert.ok(
        (manyApps.sections.config.agentAllowedApps as string[]).length <= 50,
        '5.2: 白名单条目数必须封顶（防单字段撑爆报告）',
      );
      // 报告整体可 JSON 序列化（IPC / 写文件的前提）
      assert.doesNotThrow(
        () => JSON.stringify(buildDiagnosticReport(baseInputs())),
        '5.2: 报告必须可 JSON 序列化（IPC 与写文件的前提）',
      );
    }

    // ── (f) 与 config:export 的**刻意差异**：诊断不抛错而是强制脱敏 ─────
    {
      const withRealToken = { executorToken: PLAINTEXT_TOKEN };
      // 导出守卫：抛错（宁可失败也不写错文件）
      assert.throws(
        () => buildConfigExportPayload(withRealToken),
        /unmasked/,
        '5.2 对照：buildConfigExportPayload 遇到明文 token 必须抛错（既有语义不变）',
      );
      // 诊断报告：不抛，而是脱敏（排障最后手段不能失败）
      assert.doesNotThrow(
        () =>
          buildDiagnosticReport({
            now: new Date(0),
            runtime: {
              appVersion: '1',
              electronVersion: '1',
              nodeVersion: '1',
              chromeVersion: '1',
              platform: 'linux',
              arch: 'x64',
              osRelease: '1',
            },
            config: withRealToken,
          }),
        '5.2 对照：诊断报告遇到明文 token 必须脱敏后继续（不得抛错）',
      );
    }

    // ── (g) 文件名与人类可读字节数 ────────────────────────────────────
    {
      assert.strictEqual(
        diagnosticReportFileName(new Date(2026, 9, 5, 8, 3, 9)),
        'acf-diagnostic-20261005-080309.json',
        '5.2: 诊断报告文件名必须是 acf-diagnostic-YYYYMMDD-HHmmss.json（本地时区）',
      );
      assert.strictEqual(formatBytesHuman(512), '512 B', '5.2: 字节格式化');
      assert.strictEqual(formatBytesHuman(2048), '2.0 KB', '5.2: KB 格式化');
      assert.strictEqual(formatBytesHuman(5 * 1024 * 1024), '5.0 MB', '5.2: MB 格式化');
      assert.strictEqual(formatBytesHuman(50 * 1024 * 1024 * 1024), '50.00 GB', '5.2: GB 格式化');
      // 不可用值一律 null（"读不到"不得被渲染成 0）
      for (const bad of [null, undefined, NaN, -1, Infinity]) {
        assert.strictEqual(
          formatBytesHuman(bad as number | null),
          null,
          `5.2: ${String(bad)} 必须归一成 null（指标不可用 ≠ 0 字节）`,
        );
      }
    }

    // ── (h) 上限常量本身的合理性（改坏了要有人知道）──────────────────
    {
      assert.ok(
        DIAGNOSTIC_LOG_MAX_LINES >= 50 && DIAGNOSTIC_LOG_MAX_LINES <= 2_000,
        `5.2: DIAGNOSTIC_LOG_MAX_LINES（${DIAGNOSTIC_LOG_MAX_LINES}）必须在 50–2000 的合理区间`,
      );
      assert.ok(
        DIAGNOSTIC_LOG_LINE_MAX_CHARS >= 500 && DIAGNOSTIC_LOG_LINE_MAX_CHARS <= 16_384,
        `5.2: DIAGNOSTIC_LOG_LINE_MAX_CHARS（${DIAGNOSTIC_LOG_LINE_MAX_CHARS}）必须在 500–16k 的合理区间`,
      );
      assert.strictEqual(
        DIAGNOSTIC_REDACTED,
        EXPORT_TOKEN_MASK,
        '5.2: 诊断掩码哨兵必须与导出掩码同值（两处掩码形态不得分裂）',
      );
    }
  }

  // ── 6. SYNC：IMPORTABLE_CONFIG_KEYS 与 AppConfig 接口逐键双向对齐 ───
  {
    const src = read('config-store.ts');
    const iface = /export interface AppConfig \{([\s\S]*?)\n\}/.exec(src);
    assert.ok(iface, 'SYNC: config-store.ts 找不到 AppConfig 接口');
    const interfaceKeys = [...iface![1].matchAll(/^  (\w+)\??:/gm)].map((m) => m[1]);
    assert.ok(interfaceKeys.length > 0, 'SYNC: AppConfig 接口键提取为空');
    const listed = new Set<string>(IMPORTABLE_CONFIG_KEYS);
    for (const key of interfaceKeys) {
      assert.ok(listed.has(key), `SYNC: AppConfig 字段 ${key} 未进导入白名单——导入会静默丢字段`);
    }
    for (const key of listed) {
      assert.ok(interfaceKeys.includes(key), `SYNC: 白名单里的 ${key} 不在 AppConfig 接口（键名漂移）`);
    }
    // 掩码哨兵两侧同值：export-flows 刻意不 import config-store（electron
    // 依赖），一致性只能靠这里钉住
    assert.ok(
      src.includes(`export const TOKEN_MASK = '${EXPORT_TOKEN_MASK}'`),
      `SYNC: config-store.TOKEN_MASK 必须与 EXPORT_TOKEN_MASK（${EXPORT_TOKEN_MASK}）同值`,
    );
    // save() 的掩码语义分支不被拆除（第二层防护：即使有人把导入解析层的
    // 剥离删了，save 仍必须把掩码哨兵解释为"保留存量"）
    assert.ok(
      /TOKEN_MASKS\.has\(v\)/.test(src) && /if \(!TOKEN_MASKS\.has\(v\)\) this\.store\.set\(k, v\);/.test(src),
      'SYNC: ConfigStore.save 的掩码哨兵分支（掩码=保留存量 token）不得被拆除',
    );
  }

  // ── 7. SYNC：四条 IPC handler 的实现锚点 ────────────────────────────
  {
    const ipc = read('ipc-handlers.ts');
    const handlerBlock = (name: string): string => {
      const start = ipc.indexOf(`ipcMain.handle('${name}'`);
      assert.ok(start >= 0, `SYNC: 找不到 handler ${name}`);
      const rest = ipc.slice(start + `ipcMain.handle('${name}'`.length);
      const next = rest.indexOf('ipcMain.handle(');
      return next >= 0 ? rest.slice(0, next) : rest;
    };
    // 导出必须取掩码读面（token 不落明文的真值源），且经导出守卫
    const exportBlock = handlerBlock('config:export');
    assert.ok(exportBlock.includes('getAllMasked()'), 'SYNC: config:export 必须导出 getAllMasked() 的掩码配置');
    assert.ok(exportBlock.includes('buildConfigExportPayload('), 'SYNC: config:export 必须过导出守卫');
    assert.ok(exportBlock.includes('configExportFileName('), 'SYNC: config:export 必须用建议文件名');
    // 导入必须走「解析 → 既有消毒通道 → save」同一条链路
    const importBlock = handlerBlock('config:import');
    assert.ok(importBlock.includes('parseImportedConfig('), 'SYNC: config:import 必须经 parseImportedConfig');
    assert.ok(importBlock.includes('sanitizeConfigInput('), 'SYNC: config:import 必须走既有 sanitizeConfigInput 消毒');
    assert.ok(importBlock.includes('configStore.save('), 'SYNC: config:import 必须经 ConfigStore.save 落盘');
    assert.ok(
      importBlock.includes('JSON.parse(') || importBlock.includes('parseImportedConfig('),
      'SYNC: config:import 必须解析 JSON 并把解析失败反馈给用户',
    );
    // 日志导出：copyFile 语义 + 大文件阈值 + 复用同一日志解析真值源
    const logBlock = handlerBlock('history:export-log');
    assert.ok(logBlock.includes('resolveExecutionLogFile('), 'SYNC: history:export-log 必须复用日志文件解析');
    assert.ok(logBlock.includes('copyFile('), 'SYNC: history:export-log 必须是 copyFile（原文件不动）');
    assert.ok(logBlock.includes('logExportTooLarge('), 'SYNC: history:export-log 必须做大文件拦截');
    // 保存收尾链必须被 config:save 与 config:import 共用（两处各写一遍必然漂移）
    const saveBlock = handlerBlock('config:save');
    assert.ok(saveBlock.includes('finalizeConfigSave('), 'SYNC: config:save 必须走共享的 finalizeConfigSave');
    assert.ok(importBlock.includes('finalizeConfigSave('), 'SYNC: config:import 必须走共享的 finalizeConfigSave');
    assert.ok(
      /async function finalizeConfigSave\(/.test(ipc),
      'SYNC: finalizeConfigSave 实现缺失',
    );
    // PLAN-EXECUTOR-DESKTOP-UX 5.2：诊断报告 handler 的三条契约——
    // ① 组装走纯函数 buildDiagnosticReport（行为由本文件第 5 节驱动）；
    // ② 配置取掩码读面（第一层脱敏；纯函数内还有两层）；
    // ③ 走 saveDialog + writeFile（与 config:export 同款落盘链路，
    //    不得自建第二条保存路径）。
    const diagBlock = handlerBlock('diagnostics:export');
    assert.ok(
      diagBlock.includes('buildDiagnosticReport('),
      'SYNC: diagnostics:export 必须经纯函数 buildDiagnosticReport 组装',
    );
    assert.ok(
      diagBlock.includes('collectDiagnosticInputs('),
      'SYNC: diagnostics:export 必须经 collectDiagnosticInputs 收现场（探针/statfs 都在那里）',
    );
    assert.ok(
      diagBlock.includes('showSaveDialog(') && diagBlock.includes('writeFile('),
      'SYNC: diagnostics:export 必须走 saveDialog + writeFile（与 config:export 同一落盘链路）',
    );
    assert.ok(
      diagBlock.includes('diagnosticReportFileName('),
      'SYNC: diagnostics:export 必须用建议文件名',
    );
    // 现场收集必须取掩码读面（第一层脱敏不得被换成 getAll()）
    assert.ok(
      /collectDiagnosticInputs[\s\S]*?getAllMasked\(\)/.test(ipc),
      'SYNC: 诊断现场必须取 getAllMasked() 的掩码配置（token 不落明文的真值源）',
    );
  }

  console.log(
    'export-flows selftest: all assertions passed (export mask guard, import whitelist + ' +
      'token-strip, 200MB gate, diagnostic report (5 sections + secret redaction + bounded size), ' +
      'SYNC anchors)',
  );
}

main();

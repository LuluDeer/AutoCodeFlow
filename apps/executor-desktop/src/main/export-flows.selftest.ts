/**
 * 拓展包「配置导入/导出 + 执行日志导出」selftest。
 * Run via: npm run test:main
 *
 * 覆盖面：
 *  · export-flows.ts 纯函数行为（导出文件名 / 导入解析 / 掩码剥离 / 大小阈值）；
 *  · 掩码 token 导入语义的两层钉住：①导入解析层直接剥离掩码与空 token
 *    （本文件）；②ConfigStore.save 既有的「掩码哨兵=保留存量」分支不被
 *    拆除（SYNC 结构断言）——两层任一被拆，真实 token 都可能被掩码/空串
 *    覆盖或清空；
 *  · SYNC 接线守卫：IMPORTABLE_CONFIG_KEYS 与 config-store.ts 的 AppConfig
 *    接口逐键双向对齐；三条 IPC handler 的关键实现锚点不被静默拆除。
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CONFIG_IMPORT_MAX_BYTES,
  EXPORT_TOKEN_MASK,
  IMPORTABLE_CONFIG_KEYS,
  LOG_EXPORT_MAX_BYTES,
  buildConfigExportPayload,
  configExportFileName,
  execLogExportFileName,
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
  }

  // ── 4. 日志导出的大文件阈值（200MB 边界）────────────────────────────
  {
    assert.strictEqual(logExportTooLarge(0), false, '空文件可导出');
    assert.strictEqual(logExportTooLarge(LOG_EXPORT_MAX_BYTES), false, '恰好 200MB 可导出（> 而非 >=）');
    assert.strictEqual(logExportTooLarge(LOG_EXPORT_MAX_BYTES + 1), true, '超过 200MB 必须拦截');
    assert.strictEqual(logExportTooLarge(NaN), false, 'stat 失败（NaN）不拦——错误留给 copyFile 抛');
    assert.strictEqual(logExportTooLarge(-1), false, '负数（stat 失败哨兵）不拦');
  }

  // ── 5. SYNC：IMPORTABLE_CONFIG_KEYS 与 AppConfig 接口逐键双向对齐 ───
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

  // ── 6. SYNC：三条 IPC handler 的实现锚点 ────────────────────────────
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
  }

  console.log('export-flows selftest: all assertions passed (export mask guard, import whitelist + token-strip, 200MB gate, SYNC anchors)');
}

main();

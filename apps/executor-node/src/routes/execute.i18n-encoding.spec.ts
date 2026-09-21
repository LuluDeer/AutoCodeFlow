/**
 * I18N-01（生产故障）：Windows 上中文任务日志/异常回溯全是乱码。
 *
 * 现象（用户报）：
 *   RuntimeError: ȱ�ٷ���ƾ֤������ƽ̨ secrets ���� FEISHU_APP_ID
 * 而原文是「缺少飞书凭证：请在平台 secrets 配置 FEISHU_APP_ID」——报错文案是
 * 给人看的，乱码后这条最有价值的诊断信息被销毁。
 *
 * 根因是**两层编码不匹配**：
 *   · Windows 上 Python 的 stderr 取 `locale.getpreferredencoding()`（实测
 *     cp936/GBK），且 `sys.stdout.reconfigure()` **管不到 stderr**——用户脚本
 *     里那句"重配 stdout"只救了 stdout，异常回溯走 stderr 仍是 GBK 字节；
 *   · 执行器用 `StringDecoder('utf8')` 解这两个流，GBK 字节被替换成 U+FFFD。
 *     实测原始字节 `D6 D0 CE C4`（GBK "中文"）按 UTF-8 解码即得 4 个 U+FFFD。
 *
 * 修法：给 python 子进程注入 `PYTHONIOENCODING=utf-8` + `PYTHONUTF8=1`。
 *
 * 本文件是**源码守卫**而非行为测试：真实复现需要 Windows + 非 UTF-8 locale 的
 * Python（本机实测 `locale.getpreferredencoding() == cp936`），CI 的 Linux 环境
 * 上不存在这个前提，行为断言会变成"在 Linux 上恒真"的假绿。而真正需要钉住的
 * 是"这两个变量确实被注入了"这一事实——它在任何平台上都可断言，且一旦有人
 * 删掉这段，Windows 上的乱码就会静默复发。
 */
import * as fs from 'fs';
import * as path from 'path';

const EXECUTE_TS = path.resolve(__dirname, 'execute.ts');

function stripComments(src: string): string {
  // 函数头注释里就写着反面示例与变量名（说明"为什么"），不剥注释会让守卫被
  // 自己的说明文字绊倒（同类教训：deploy-fs.spec.ts / zip-safety.spec.ts）。
  return src
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

describe('I18N-01: python 子进程的日志编码（Windows 中文乱码）', () => {
  const raw = fs.readFileSync(EXECUTE_TS, 'utf-8');
  const code = stripComments(raw);

  it('注入 PYTHONIOENCODING=utf-8（stderr 也走 UTF-8，与执行器解码口径对齐）', () => {
    expect(code).toMatch(/env\['PYTHONIOENCODING'\]\s*=\s*'utf-8'/);
  });

  it('注入 PYTHONUTF8=1（覆盖解释器启动早期的输出路径）', () => {
    expect(code).toMatch(/env\['PYTHONUTF8'\]\s*=\s*'1'/);
  });

  it('两者都只在 python runtime 下注入（node/shell 不受影响）', () => {
    // node 的 stdout/stderr 恒为 UTF-8；shell 是用户自己的脚本，编码是脚本
    // 作者的语义（chcp 等），执行器不该替它决定。
    const idx = code.indexOf("env['PYTHONIOENCODING']");
    expect(idx).toBeGreaterThan(-1);
    // 往前找最近的 runtime 判定，必须是 python
    const before = code.slice(0, idx);
    const guard = before.lastIndexOf('actualRuntime ===');
    expect(guard).toBeGreaterThan(-1);
    expect(before.slice(guard, guard + 40)).toContain("'python'");
  });

  it('注入点在 params 循环之后（用户参数不得覆盖编码开关）', () => {
    const paramsIdx = code.indexOf('env[`AUTOFLOW_${k.toUpperCase()}`]');
    const encIdx = code.indexOf("env['PYTHONIOENCODING']");
    expect(paramsIdx).toBeGreaterThan(-1);
    expect(encIdx).toBeGreaterThan(paramsIdx);
  });

  it('secret 闸门拒绝 PYTHON* 前缀，防止凭据把编码重新弄乱', () => {
    // 两处修复的交叉点：I18N-01 靠 PYTHONIOENCODING 保证可读性，而 SEC-02 的
    // 原名注入让用户能设置任意变量名——若不拒绝 PYTHON*，一个名为
    // PYTHONIOENCODING 的 secret 就能让中文日志重新变乱码。
    const secretEnv = fs.readFileSync(
      path.resolve(__dirname, '../secret-env.ts'),
      'utf-8',
    );
    expect(secretEnv).toMatch(/upper\.startsWith\('PYTHON'\)/);
  });
});

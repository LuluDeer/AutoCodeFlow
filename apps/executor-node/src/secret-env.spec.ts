/**
 * SEC-02 续（生产故障）：secrets 按原名注入的名字闸门。
 *
 * 生产实证：用户在平台配置 `FEISHU_APP_ID` 后，脚本读
 * `os.environ["FEISHU_APP_ID"]` 拿到空串 → 报「缺少飞书凭证」。根因是 secrets
 * 此前与 params 走同一条通道、被统一加 `AUTOFLOW_` 前缀——报错文案里写的名字
 * 与实际注入的名字不是同一个，用户照提示配置也永远配不对。
 *
 * 修法是"按原名再注入一份"。这把用户提供的键名**直接变成子进程的环境变量名**，
 * 于是闸门成为必需：一个名为 PATH 的 secret 会让子进程连解释器都找不到，任务
 * 以与凭据毫无关系的形态失败。本文件钉住闸门的每一条规则。
 */
import { injectSecretEnv, isInjectableSecretName } from './secret-env';
import { ENV_WHITELIST } from './env-whitelist';

describe('SEC-02: secrets 按原名注入的名字闸门', () => {
  describe('合法名放行（第三方 SDK 认的规范名必须能用）', () => {
    it.each([
      'FEISHU_APP_ID',
      'FEISHU_APP_SECRET',
      'AWS_ACCESS_KEY_ID', // boto3 认的规范名
      'AWS_SECRET_ACCESS_KEY',
      'OPENAI_API_KEY',
      'GITHUB_TOKEN',
      'MY_KEY_1',
      '_private',
      'lowercase_ok', // 环境变量名大小写敏感但都合法
    ])('%s 可注入', (name) => {
      expect(isInjectableSecretName(name)).toBe(true);
    });
  });

  describe('非法名拒绝', () => {
    it.each([
      ['空串', ''],
      ['含等号', 'KEY=VALUE'],
      ['含空格', 'MY KEY'],
      ['含短横线', 'MY-KEY'],
      ['含点', 'my.key'],
      ['数字开头', '1KEY'],
      ['含斜杠', 'A/B'],
      ['含换行', 'A\nB'],
      ['注入形态', 'KEY; rm -rf /'],
      ['含 $', '$HOME'],
    ])('%s 拒绝', (_label, name) => {
      expect(isInjectableSecretName(name)).toBe(false);
    });
  });

  describe('保留名拒绝（这是本闸门存在的核心理由）', () => {
    it('PATH 被拒绝 —— 否则子进程连解释器都找不到', () => {
      expect(isInjectableSecretName('PATH')).toBe(false);
      expect(isInjectableSecretName('Path')).toBe(false); // Windows 拼法
    });

    it('环境白名单里的宿主变量一律拒绝', () => {
      for (const name of ENV_WHITELIST) {
        expect(isInjectableSecretName(name)).toBe(false);
      }
    });

    it('执行器密钥被拒绝（本就不该进子进程）', () => {
      for (const name of [
        'EXECUTOR_SHARED_TOKEN',
        'EXECUTOR_SECRET',
        'EXECUTION_CALLBACK_SECRET',
      ]) {
        expect(isInjectableSecretName(name)).toBe(false);
      }
    });

    it('执行器注入的任务作用域变量被拒绝（否则回调/追踪静默失效）', () => {
      for (const name of ['EXECUTION_ID', 'TASK_ID', 'TASK_NAME']) {
        expect(isInjectableSecretName(name)).toBe(false);
      }
    });

    it('AUTOFLOW_ 前缀被拒绝（那是 params 的命名空间，占用会互相覆盖）', () => {
      expect(isInjectableSecretName('AUTOFLOW_FOO')).toBe(false);
      expect(isInjectableSecretName('AUTOFLOW_CALLBACK_TOKEN')).toBe(false);
    });

    it('PYTHON* 前缀被拒绝 —— 执行器必须独占日志编码开关', () => {
      // 这条直接关系到 I18N-01：PYTHONIOENCODING 被 secret 覆盖后中文日志
      // 会重新变乱码，而乱码正是本次要修的另一个生产故障。
      for (const name of [
        'PYTHONIOENCODING',
        'PYTHONUTF8',
        'PYTHONPATH',
        'PYTHONSTARTUP',
        'PYTHONHOME',
      ]) {
        expect(isInjectableSecretName(name)).toBe(false);
      }
    });
  });

  describe('injectSecretEnv 的写入行为', () => {
    it('按原名写入，不做大小写变换、不加前缀', () => {
      const env: NodeJS.ProcessEnv = {};
      const skipped = injectSecretEnv(env, {
        FEISHU_APP_ID: 'cli_abc',
        FEISHU_APP_SECRET: 'sec_xyz',
      });
      expect(skipped).toEqual([]);
      expect(env.FEISHU_APP_ID).toBe('cli_abc');
      expect(env.FEISHU_APP_SECRET).toBe('sec_xyz');
      // 关键反证：不得出现带前缀的形态
      expect(env.AUTOFLOW_FEISHU_APP_ID).toBeUndefined();
    });

    it('非字符串值 String() 化（数字/布尔）', () => {
      const env: NodeJS.ProcessEnv = {};
      injectSecretEnv(env, { PORT: 8080, FLAG: true });
      expect(env.PORT).toBe('8080');
      expect(env.FLAG).toBe('true');
    });

    it('null/undefined 值跳过（不写成语义错误的字面量）', () => {
      const env: NodeJS.ProcessEnv = {};
      injectSecretEnv(env, { A: null, B: undefined, C: 'ok' });
      expect(env.A).toBeUndefined();
      expect(env.B).toBeUndefined();
      expect(env.C).toBe('ok');
    });

    it('被拒绝的键名进 skipped（供调用方 warn），且不写入 env', () => {
      const env: NodeJS.ProcessEnv = {};
      const skipped = injectSecretEnv(env, {
        GOOD_KEY: 'v',
        PATH: '/evil',
        'BAD-NAME': 'v',
        AUTOFLOW_X: 'v',
        PYTHONIOENCODING: 'latin-1',
      });
      expect(skipped.sort()).toEqual(
        ['AUTOFLOW_X', 'BAD-NAME', 'PATH', 'PYTHONIOENCODING'].sort(),
      );
      expect(env.GOOD_KEY).toBe('v');
      expect(env.PATH).toBeUndefined();
      expect(env.PYTHONIOENCODING).toBeUndefined();
    });

    it('不覆盖调用方已设的保留变量（执行器自己的注入优先）', () => {
      // 模拟 execute.ts 的真实顺序：先建 env（含 PATH）与执行器变量，再注入
      // secrets。被拒绝的名字绝不能改写已有值。
      const env: NodeJS.ProcessEnv = {
        PATH: '/usr/bin',
        PYTHONIOENCODING: 'utf-8',
        AUTOFLOW_CALLBACK_TOKEN: 'v1.exec-real-token',
      };
      injectSecretEnv(env, {
        PATH: '/evil',
        PYTHONIOENCODING: 'latin-1',
        AUTOFLOW_CALLBACK_TOKEN: 'stolen',
      });
      expect(env.PATH).toBe('/usr/bin');
      expect(env.PYTHONIOENCODING).toBe('utf-8');
      expect(env.AUTOFLOW_CALLBACK_TOKEN).toBe('v1.exec-real-token');
    });

    it('null/undefined/非对象入参零副作用（旧执行器载荷无 secrets 字段）', () => {
      const env: NodeJS.ProcessEnv = { EXISTING: 'x' };
      expect(injectSecretEnv(env, null)).toEqual([]);
      expect(injectSecretEnv(env, undefined)).toEqual([]);
      expect(injectSecretEnv(env, 'not-an-object' as never)).toEqual([]);
      expect(env).toEqual({ EXISTING: 'x' });
    });

    it('空对象零副作用', () => {
      const env: NodeJS.ProcessEnv = {};
      expect(injectSecretEnv(env, {})).toEqual([]);
      expect(env).toEqual({});
    });
  });
});

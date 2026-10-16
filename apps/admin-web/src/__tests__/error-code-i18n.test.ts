/**
 * LANG-ERR-01：后端**错误码 → 本地化文案**链路的守卫。
 *
 * ## 为什么这个测试必须存在
 *
 * 这条链路是「用户配置了哪个语言就展示哪个语言」这句产品要求**唯一**的兑现点。
 * 它的失效形态全部是**静默**的：
 *   · 缺 `err.<CODE>` 词条 → i18next 缺失 key 时**不抛错**，会把 key 原样返回，
 *     于是用户读到的不是文案而是 `err.EXECUTOR_NOT_FOUND` 这种**标识符**
 *     （界面看起来坏了，构建与测试却全绿——本仓 i18n-source-guard 记录过同类
 *     生产故障）；
 *   · 忘了按码翻译、直接透传后端 `message` → 英文用户永远看到中文报错，
 *     而 zh 用户完全正常，本地化在那一格悄悄失效却无人察觉。
 *
 * 故这里钉的不是"函数被调用过"，而是**用户实际读到什么字符串**：同一个码在
 * zh / en 两种语言下必须渲染出各自语言的文案，且未登记的码必须
 * **回落服务端文案而不是裸码**。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import i18n, { setLanguage } from '../i18n';
import { getErrMsg, translateByErrorCode } from '../utils/error';

/** 造一个 axios 风格的错误对象（getErrMsg 的真实入参形态）。 */
function axiosErr(data: Record<string, unknown>): Error {
  const e = new Error('Request failed with status code 404');
  (e as unknown as { response: { data: unknown } }).response = { data };
  return e;
}

describe('LANG-ERR-01 错误码 → 本地化文案', () => {
  beforeEach(async () => {
    await setLanguage('zh');
  });

  it('按码取**中文**文案（界面为 zh 时）', () => {
    expect(translateByErrorCode({ errorCode: 'EXECUTOR_NOT_FOUND' })).toBe('执行器不存在');
  });

  it('同一码在**英文**界面下渲染英文文案（本地化的核心断言）', async () => {
    await setLanguage('en');
    expect(translateByErrorCode({ errorCode: 'EXECUTOR_NOT_FOUND' })).toBe('Executor not found');
    // 反向：切回中文必须跟着变（防"只写死了英文"的假修复）
    await setLanguage('zh');
    expect(translateByErrorCode({ errorCode: 'EXECUTOR_NOT_FOUND' })).toBe('执行器不存在');
  });

  it('用 params 插值（占位来自后端 params，不是前端拼串）', () => {
    expect(
      translateByErrorCode({ errorCode: 'TASK_NAME_EXISTS', params: { name: '每日报表' } }),
    ).toBe('任务名「每日报表」已存在');
  });

  it('未登记的码 → 返回 null（由调用方回落服务端 message），绝不返回裸码', () => {
    // 模拟"后端先上线了新码、前端字典还没跟上"的滚动升级窗口
    const out = translateByErrorCode({ errorCode: 'BRAND_NEW_CODE_FROM_BACKEND' });
    expect(out).toBeNull();
    // 关键：不得把 `err.BRAND_NEW_CODE_FROM_BACKEND` 这种标识符漏给用户
    expect(out ?? '').not.toContain('err.');
  });

  it('无码 → 返回 null（维持既有行为）', () => {
    expect(translateByErrorCode({})).toBeNull();
    expect(translateByErrorCode(null)).toBeNull();
    expect(translateByErrorCode(undefined)).toBeNull();
    // 非字符串码（后端异常形态变化）也不得崩
    expect(translateByErrorCode({ errorCode: 404 })).toBeNull();
  });

  it('getErrMsg：有码走本地化，忽略服务端的中文 message', () => {
    const err = axiosErr({
      errorCode: 'EXECUTOR_NOT_FOUND',
      message: '执行器不存在', // 后端兜底文案（服务端可能已是另一种语言）
    });
    expect(getErrMsg(err)).toBe('执行器不存在');
  });

  it('getErrMsg：未知码回落服务端 message（滚动升级期的降级路径）', async () => {
    await setLanguage('en');
    const err = axiosErr({
      errorCode: 'CODE_THE_FRONTEND_DOES_NOT_KNOW',
      message: '后端兜底文案（中文）',
    });
    // 关键：宁可显示后端的中文兜底，也不显示裸码——后者会被当成"界面坏了"
    expect(getErrMsg(err)).toBe('后端兜底文案（中文）');
  });

  it('getErrMsg：完全没有 errorCode 的老后端 → 行为不变', () => {
    expect(getErrMsg(axiosErr({ message: '某个老接口的错误' }))).toBe('某个老接口的错误');
  });

  it('getErrMsg：非 axios 的普通 Error 与空值仍走原兜底', () => {
    expect(getErrMsg(new Error('boom'))).toBe('boom');
    expect(getErrMsg(null, '自定义兜底')).toBe('自定义兜底');
  });

  it('字典里确实存在 err.* 词条（防止码表与字典脱节）', () => {
    expect(i18n.exists('err.EXECUTOR_NOT_FOUND')).toBe(true);
    expect(i18n.exists('err.TASK_NAME_EXISTS')).toBe(true);
    // 反向守卫：不能对任意字符串都返回 true，否则上面的 exists 断言就是永真
    expect(i18n.exists('err.THIS_CODE_DOES_NOT_EXIST')).toBe(false);
  });
});

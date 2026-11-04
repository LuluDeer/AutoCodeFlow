import { useEffect, useRef, useState } from 'react';
import type { CfgText } from './io-result';
import { listText, loadErrorMessage, planExternalSync } from './config-source';

/**
 * 设置页的**配置源层**（R7-B 第二刀：读路径出仓）—— 首屏 `loadConfig` +
 * `config:changed` 合并 + 它们的状态/ref。
 *
 * ## 为什么这一簇最难、以及为什么它还是能安全搬走
 *
 * 评估报告把本簇列为「风险最高」，理由有两条，两条都在这里被**结构性**消除，
 * 不靠"反正 effect 之间无依赖"来赌：
 *
 * ### ① effect 声明顺序是语义的一部分 ⇒ 顺序逐位保留
 *
 * 拆分前 `ConfigPage` 的实测（`grep -n 'useEffect('` + 逐个读块，2026-11-04）：
 * **页面 8 个 `useEffect` + `use-config-io.ts` 里 1 个 = 9 个**，运行时声明顺序：
 *
 *   | # | 位置 | 内容 |
 *   |---|------|------|
 *   | 1 | 页面 | `clampTimersRef` 卸载清理（P3-7） |
 *   | 2 | 页面 | **首屏 `loadConfig()`**（挂载一次，P3-10） |
 *   | 3 | 页面 | `externalSyncMsg` 6s 自动消退 |
 *   | 4 | 页面 | **`config:changed` 订阅**（P1-1 合并） |
 *   | 5 | 页面 | 切到 python 组刷新诊断（EXP-06） |
 *   | 6 | 页面 | 切到 agent 组拉托管状态（P7b） |
 *   | 7 | 页面 | 搜索命中后滚动到字段 |
 *   | 8 | 页面 | Ctrl/Cmd+S / Alt+1..5 键盘（F-… / UI V5） |
 *   | 9 | `use-config-io.ts` | 检查更新 6s 定时器卸载清理（F-38） |
 *
 * 本 hook 收的是 **#2 #3 #4**（三条相邻），且**在 hook 体内按同一顺序声明**；
 * 页面把 `useConfigSource(...)` 的调用点放在原 #2 的那一行 ⇒ 9 个 effect 的
 * 声明序号逐位不变（1 在 hook 前、5–8 在 hook 后、9 在 `useConfigIo` 里）。
 * 为什么 #2 在 #4 之前有意义：首屏 `loadConfig()` 先发 `getConfig()`，
 * 而 `config:changed` 的订阅在同一轮 commit 里随后建立——若反过来，广播在
 * 首屏读返回前就到了 `formRef`（初值 `{}`），合并基线会变成空对象。
 *
 * ### ② `loadConfig` 的「首屏 vs 后续」双角色 ⇒ 仍在同一处
 *
 * 它既是挂载时的初始加载，又是 `config:changed` 落盘后的重载基准（以及 P3-10
 * 错误行的「重试」入口）。三条入口共用**同一个** `loadConfig`（经返回值暴露
 * 给页面），不分成"初始化路径"与"刷新路径"两份实现——后者会在"首屏失败后重试"
 * 与"广播后重载"之间留下行为分叉（例如某一条忘了复位 `loadError`）。
 *
 * ### 刻意不碰的两处（上一轮/本轮的归属边界）
 *
 *   · `requestSaveRef.current = requestSave`（render-time 赋值，引用身份是语义）
 *     在页面的 `useConfigWriter` 侧，本 hook 不依赖它，也不读 `saving`/`saveError`。
 *   · `form` / `savedForm` 仍是页面的单一真值源：本 hook 只收它们的当前值与
 *     setter，自己不持有配置数据（`formRef`/`savedFormRef` 只是"给异步回调
 *     读最新值"的镜像，同原实现）。
 *
 * ## 无法单测的部分（如实交代）
 *
 * 三个 effect 的**时序**本身（"先 load 后订阅"、"广播到达时读到的是最新渲染
 * 的 form"）在 node 里跑不出来——没有 React 渲染器跑 effect，装一个等于给
 * 本仓引入新框架。这部分由两条既有网承担：①`renderer.selftest.mjs` 的文本
 * 契约（Promise.all 链有 .catch、`config:changed` 有订阅、订阅可取消）；
 * ②`config-source.selftest.mjs` 的"取数面自检 + 实现体唯一性"（防止实现被
 * 复制成两份后其中一份悄悄失去这些性质）。**判定**分支（合并语义/文案选择）
 * 已全部搬进 `config-source.ts` 并由真行为断言覆盖，时序里不再夹带分支。
 */

declare const window: Window & {
  electronAPI: {
    getConfig: () => Promise<Record<string, unknown>>;
    getLocalIPs: () => Promise<string[]>;
    getAutoLaunch?: () => Promise<boolean>;
  };
};

/** 页面注入的依赖（全部是页面拥有的真值源 / 状态，hook 不持有配置数据）。 */
export interface ConfigSourceDeps {
  /** 文案取值（语言在页面求值一次，与既有 N-04 口径一致）。 */
  t: CfgText;
  /** 当前草稿（每次渲染的最新值；`formRef` 镜像靠它）。 */
  form: Record<string, unknown>;
  /** 当前基线（每次渲染的最新值；`savedFormRef` 镜像靠它）。 */
  savedForm: Record<string, unknown>;
  setForm: (cfg: Record<string, unknown>) => void;
  setSavedForm: (cfg: Record<string, unknown>) => void;
  setAllowedAppsText: (text: string) => void;
  setAllowedDomainsText: (text: string) => void;
  /** `autoLaunch` 的真值归页面（`useConfigIo` 的写路径也用它），首屏只负责播种。 */
  setAutoLaunch: (enable: boolean) => void;
}

export interface ConfigSource {
  /** 首屏是否已有结论（成功或失败都算——失败时页面必须脱离「加载中」）。 */
  loaded: boolean;
  /** 首屏读取失败的人话原因；`null` = 没失败。 */
  loadError: string | null;
  /** 本机网卡地址（「对外地址」快捷选择的数据源）。 */
  localIPs: string[];
  /** 磁盘广播合并后的一次性提示（6s 消退）。 */
  externalSyncMsg: string | null;
  /** 可重入的读取（挂载 effect + 错误行「重试」共用同一个）。 */
  loadConfig: () => void;
}

export function useConfigSource(deps: ConfigSourceDeps): ConfigSource {
  const {
    t, form, savedForm,
    setForm, setSavedForm, setAllowedAppsText, setAllowedDomainsText, setAutoLaunch,
  } = deps;

  const [loaded, setLoaded] = useState(false);
  // NETOPT-7⑤（2026-09-20）：首屏配置读取失败的页内呈现（桌面端无 toast 体系）。
  // configStore.getAllMasked 读损坏配置/解密异常时 getConfig() 会 reject——
  // 不与 saveError 复用同一 state：保存失败行的「保存失败：」前缀会撒谎。
  const [loadError, setLoadError] = useState<string | null>(null);
  // UI V5：「对外地址」快捷选择的网卡清单（随首屏 Promise.all 同批取，零额外 IPC）。
  const [localIPs, setLocalIPs] = useState<string[]>([]);

  // P1-1：向导保存落盘后主进程广播 config:changed → 重取配置并合并。合并回调是
  // 异步的，必须读到**最新渲染**的 form/savedForm，故用 render-time 赋值的镜像
  // ref（与拆分前的 `formRef.current = form` 同形态、同位置语义：只在回调里读）。
  const formRef = useRef(form);
  formRef.current = form;
  const savedFormRef = useRef(savedForm);
  savedFormRef.current = savedForm;
  // 合并结果的一次性提示（6s 消退，同 checkMsg 纪律）：磁盘更新了 N 项 +
  // 有用户草稿被保留时如实提示，差异可见。
  const [externalSyncMsg, setExternalSyncMsg] = useState<string | null>(null);

  // P3-10：配置加载抽成可重入函数——挂载时跑一次，loadError 错误行提供
  // 「重试」钮（对齐 History/Apps/日志区的错误+重试口径）。
  function loadConfig(): void {
    Promise.all([window.electronAPI.getConfig(), window.electronAPI.getLocalIPs()])
      .then(([cfg, ips]) => {
        setForm(cfg);
        setSavedForm(cfg);
        setAllowedAppsText(listText(cfg.agentAllowedApps));
        setAllowedDomainsText(listText(cfg.agentAllowedDomains));
        setLocalIPs(ips);
        setLoaded(true);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        // NETOPT-7⑤（2026-09-20）：getConfig() 走主进程 configStore.getAllMasked——
        // 配置文件损坏/schema 校验抛错/token 解密异常时该 IPC reject。原实现无
        // .catch：loaded 恒 false → 整页永久「加载中...」+ unhandled rejection，
        // 用户既进不了设置页也不知道原因。对齐 EXP-04 修法（StatusWindow.tsx
        // getStatus() 同源缺陷的先例）：脱离加载态，把原因呈现在页内错误行。
        setLoadError(loadErrorMessage(err, t));
        setLoaded(true);
      });
    // 旧版 preload 可能未暴露 autolaunch 通道——容错降级为隐藏开关
    if (typeof window.electronAPI.getAutoLaunch === 'function') {
      window.electronAPI.getAutoLaunch().then(setAutoLaunch).catch(() => undefined);
    }
  }

  // —— effect #2（拆分前页面的第 2 个）：首屏读取，仅挂载一次 ——
  useEffect(() => {
    loadConfig();
    // 仅挂载时执行（P3-10 的重试走 loadConfig 按钮，不重挂 effect）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // —— effect #3（拆分前页面的第 3 个）：一次性提示 6s 自动消退 ——
  useEffect(() => {
    if (!externalSyncMsg) return;
    const timer = setTimeout(() => setExternalSyncMsg(null), 6000);
    return () => clearTimeout(timer);
  }, [externalSyncMsg]);

  // —— effect #4（拆分前页面的第 4 个）：config:changed 订阅 ——
  // 必须排在首屏读取之**后**（见文件头注①）。
  useEffect(() => {
    const electronAPI = (window as unknown as {
      electronAPI?: { onConfigChanged?: (cb: () => void) => () => void; getConfig?: () => Promise<Record<string, unknown>> };
    }).electronAPI;
    // 旧版 preload 缺通道时降级为既有行为（不合并——旧行为，不影响其余功能）
    if (typeof electronAPI?.onConfigChanged !== 'function' || typeof electronAPI.getConfig !== 'function') return;
    const offConfigChanged = electronAPI.onConfigChanged(() => {
      electronAPI.getConfig!() /* 闭包内 TS 不保留属性收窄（typeof 守卫在回调外），断言函数本身已由守卫保证 */
        .then((disk) => {
          // 合并语义（含两个 textarea 草稿的独立判定 + 提示文案选择）全在纯函数里，
          // 由 config-source.selftest.mjs 真执行断言；这里只落 setState。
          const plan = planExternalSync({
            form: formRef.current, savedForm: savedFormRef.current, disk, t,
          });
          setForm(plan.form);
          setSavedForm(plan.savedForm);
          // textarea 草稿是独立 state：字段未被用户编辑时随磁盘刷新；编辑过
          // 则保留（与 merge 的字段级语义一致）——null 即「用户编辑过，不动」。
          if (plan.allowedAppsText !== null) setAllowedAppsText(plan.allowedAppsText);
          if (plan.allowedDomainsText !== null) setAllowedDomainsText(plan.allowedDomainsText);
          if (plan.syncMsg !== null) setExternalSyncMsg(plan.syncMsg);
        })
        .catch(() => {
          // 重取失败：保持既有表单（磁盘可能只是瞬时不可读），不打断编辑。
        });
    });
    return () => offConfigChanged();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { loaded, loadError, localIPs, externalSyncMsg, loadConfig };
}

/**
 * N26 CLI 分发纯判定层：argv → 分发目标（不启动任何东西）。
 *
 * 桌面壳约束：Web 内容用 renderer webview、桌面壳只做窗口/凭证，避免 V2 重写。
 * 本层只返回 mode，真正的 TUI / Web / Agent CLI 启动不在此层，由接线层依据 mode 执行；
 * 零 Electron 依赖、零 IO、零进程副作用，供裸 Node selftest 直接驱动。
 */

export type CliDispatchMode = 'web' | 'tui' | 'agent' | 'default';

export interface CliDispatchResult {
  mode: CliDispatchMode;
  args: string[];
}

/** 仅识别三个分发旗标；其余 token（含其它 - 开头参数）一律透传下游。 */
function dispatchFlag(token: string): 'web' | 'tui' | 'agent' | null {
  switch (token) {
    case '--web': return 'web';
    case '--tui': return 'tui';
    case '--agent': return 'agent';
    default: return null;
  }
}

/**
 * 解析 argv，返回分发目标与剩余参数。
 *
 * - 恰好一个分发旗标 → 该 mode，旗标被消费（不留在 args）；
 * - 无分发旗标 → default，argv 原样作为 args；
 * - 两个及以上分发旗标（含重复） → null（fail-closed，不猜）；
 * - 未知旗标保留在 args 交下游；输入数组不被改写。
 */
export function parseCliDispatch(argv: string[]): { mode: 'web' | 'tui' | 'agent' | 'default'; args: string[] } | null {
  if (!Array.isArray(argv) || argv.some((token) => typeof token !== 'string')) return null;

  let mode: CliDispatchMode = 'default';
  let hits = 0;
  const args: string[] = [];

  for (const token of argv) {
    const hit = dispatchFlag(token);
    if (hit !== null) {
      hits += 1;
      mode = hit;
      continue;
    }
    args.push(token);
  }

  if (hits > 1) return null;
  return { mode, args };
}

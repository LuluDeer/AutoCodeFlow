/**
 * R235：gitRepo 的**凭据闸** —— 独立模块，因为它的**位置**本身是安全要求。
 *
 * ## 为什么必须单独拿出来（不是「为了拆而拆」）
 *
 * 「http(s) 不得带 userinfo / ssh 不得带 password」这条规则在 `execute.ts` 里有**两处**：
 * ① `acceptExecution` 内（原 P2-2，`:682` 附近）；② 本模块（**路由入口**，DNS 闸之前）。
 *
 * 两处**都不能少**，因为它们防的是**两个不同的泄漏面**：
 *
 * - ① 防「clone 失败时 stderr 回显完整 URL → errMsg → 日志/回调/审计」；
 * - ② 防「**DNS 闸先跑**、主机名解析到受限段时，`assertGitRepoNetworkPolicyResolved`
 *   抛的 `gitRepo URL 指向受限网络地址：${gitRepo}` **把含 user:token 的 URL 原样回显**」。
 *
 * ② 是 R234 实测发现的**真实缺陷**（本机 DNS 把 `example.com` 解析到 RFC2544 段时触发）：
 * 泄漏**发生在 accept 期**，不依赖 clone 是否失败，比 ① 那条更早、更无条件。
 *
 * ## 为什么抽成模块
 *
 * 这段逻辑放在 `execute.ts` 里会让该文件超体量上限（棘轮「只减不增」）。
 * 抽出来同时满足三件事：文件回到基线内、规则有**单一可测入口**、两处调用可以指向同一判据
 * （将来改规则不会只改一处）。**判据本身一行没改**，只是搬家。
 *
 * ## 与 python 侧的关系
 *
 * `execute.py` 的 ② 凭据闸在 ⑥ SSRF 闸之前 —— 顺序本来就是对的。本模块让 node 侧对齐它。
 */

/** `checkGitRepoCredentials` 的返回值：`null` = 放行；字符串 = 应返回 400 的文案。 */
export type GitRepoCredentialVerdict = string | null;

/**
 * 判定一个 gitRepo URL 是否因**内嵌凭据**而必须在发起任何网络动作之前被拒绝。
 *
 * 纯字符串/URL 解析，**零网络开销** —— 这正是它可以且必须前置的原因。
 *
 * 拒绝文案**刻意不含原 URL**：这个函数的错误路径本身就可能被回显给调用方，
 * 把 URL 拼进文案等于把要保护的凭据又写了一遍。
 *
 * @param gitRepo 原始 gitRepo 字符串
 * @returns `null` 放行；否则为给调用方的 400 文案
 */
export function checkGitRepoCredentials(gitRepo: string): GitRepoCredentialVerdict {
  let parsed: URL;
  try {
    parsed = new URL(gitRepo);
  } catch {
    // 解析失败**不在这里判死**：调用方各自的「无效的 gitRepo URL」分支会给出更准确的原因
    // （例如 `file:///etc/passwd` 应报「不允许的协议」而不是「无效 URL」）。
    return null;
  }
  const scheme = parsed.protocol.replace(/:$/, "");

  // ssh://git@host 是文档化形态（只有用户名、无密码）⇒ 放行；
  // scp-like（git@host:path）走不到这里（`new URL` 解析不了，上面已 return null）。
  if (scheme === "http" || scheme === "https") {
    if (parsed.username !== "" || parsed.password !== "") {
      return "gitRepo 不得内嵌凭据（userinfo）；请改用 GIT_ASKPASS / 凭据助手";
    }
    return null;
  }
  if (scheme === "ssh" && parsed.password !== "") {
    return "gitRepo 不得内嵌密码；请改用 SSH 密钥 / GIT_ASKPASS";
  }
  return null;
}

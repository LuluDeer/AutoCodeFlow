# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：以 `git log -1` 为准 · **5 worker 并行** · **守卫链 96 段全绿** · 工作区干净
**会话**：第 89 轮 · 并行第 25 批收尾

## 本轮落地（HEAD）
1. **python 下载面 IP 钉扎，堵掉 DNS rebinding**（`5e389098`，🟡 中危跨端口径差收口）：
   - **红证据**：注入式 rebinding 替身（闸门解析→公网；transport 模拟 socket 层二次解析→`169.254.169.254`）⇒ **旧实现首跳与重定向跳都连到 `169.254.169.254`**（`connected_ip` 实测），exit 1；
   - **改法**：`network_policy.validated_addresses()`（只解析一次 + 逐地址按契约判）+ `routers/execute.py::_pinned_download_target()`（host 换成已校验 IP，补 `Host` 头 + `extensions["sni_hostname"]` **保住证书校验**；IP 字面量不改写），**每跳**请求前钉扎（重定向分支算好复用、不重复解析），**既有逐跳复检保留**；
   - **三端对照（修后）**：同一构造下 admin/node/python **都连公网 IP**（修前 python 连元数据）；`Host`/SNI 仍为原主机名；
   - 误伤检查 8 类全绿（相对重定向 / 跨 host 剥 Bearer / 私网跳被拒 / 正常下载 / 超限中止 / 慢速滴流 / pkg-cache 命中与 purge）；定向 **350 passed**，全量 `-k not slow` **1945 passed**。
2. **registry 面「有意的不对称」落档**（`a010233b`）：`upstreamBlockedReason` 头注保留**四面对照表**（webhook/executor/gitRepo/registry）并写清「为什么允许 loopback」的**三条可独立核验依据**（① URL 只来自 registry.pypi.url/npm.url，**用户输入经白名单后只进 form body、不参与 host/path 拼接**；② 文档化默认值就是 `localhost:8003/4873`；③ 改它是破坏性变更：24 条 spec + 默认值 + 部署文档）；并**写死重新裁决条件**（默认值改非 loopback、或开放用户配置该 URL ⇒ 三条依据全失效）。ADR-033 §7.1 已记。
3. **跨端判据支持按端注入源码**（`f2ebde69`，修掉 R86/R87 两轮「反向验证不成立」的根因）：
   - 注入方式：`CROSS_END_ADMIN_DIR`（替换 admin 两个模块）/ `CROSS_END_NODE_SRC` / `CROSS_END_PY_SRC`（`importlib` 加载 `verdict_for_address`）；**未设则走真实路径**；
   - **红（打在语义层）**：只注入 admin 副本（`replace(/\.+$/,"")` 改回 `/\.$/`）⇒ **exit 1**，输出点名 `localhost.. × off ⇒ 契约期望 拒绝 / admin 实得 放行` + `三端不一致：admin=放行 / node=拒绝 / python=拒绝`；
   - **反向验证**：只关「契约期望比对」仍红（一致性分支独立命中）；**再关「三端一致性比对」⇒ 红消失** ⇒ **两条断言各自有牙**；
   - **健壮性**：注入源不存在 ⇒ **exit 1 + 明确报错，不回落真实实现**（杜绝「注入没生效却看起来绿」）。
4. **过期「已知差异」已清理**（`323ca3ee`）：`localhost..` 条目移除（附历史注释）；`KNOWN_DIVERGENCES` 现为空；输出「已知跨端差异」行数 = **0**。

## 方法论沉淀
- **反向验证必须打在语义层**：R86/R87 的失败是「某端不可用」，证据不成立；改成**只替换被判定的那一端**后，失败落在具体地址 + 三端结论上。**「注入没生效但看起来是绿」是同一类病**，故加「注入源不存在 ⇒ 明确报错」。
- **有意的不对称要写成可核验依据 + 重启条件**，而不是默默不拦。

## 待办（按优先级）
1. **ADR-034 实施步骤 1**（契约段 + 生成物 + 一端读；验收信号 = 标签差异先仍 4 条、切完 admin 才降 0）——**必须串行排期**，不能与其他 worker 并行改 `packages/` + 三端。
2. `registry` 面若将来开放用户配置该 URL ⇒ 触发重新裁决（已写死条件）。
3. 未收口：真机脚本接链（需 CI postgres）；R18-B blocked；flaky 待复发取证；node 语法闸已与 admin 同集（`5cb8d7d0`）。

## 纪律（并行版）
只信「命令 + 真实 exit code」；未跑标 `unverified`；**判据必须能红且红在语义层**；**反向验证要能隔离到单端**；**注入源缺失必须明确报错**；**先核对被测签名再判「不一致」**；**对照断言只证「重构未改行为」**；**错误码/文案都是对外接口**；**契约沉默区一律 fail-closed**；**rebinding 需要 IP 钉扎（逐跳复检不够），且要保证书校验（SNI）**；**有意的不对称写成依据 + 重启条件**；**降级/跳过必须显式打印**；**链必须在无在途改动时跑**；作者中断≠改动作废；一次只改一个文件 + `node --check` + 失败即回滚；定位代码块只用 CodeGraph；断言源码文本必须登记；`git add` 显式路径；遇 `index.lock` sleep 2s 重试；**禁 `pkill -f`**。

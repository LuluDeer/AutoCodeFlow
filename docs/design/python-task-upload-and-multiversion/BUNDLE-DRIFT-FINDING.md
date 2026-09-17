# desktop-bundle-drift 闸：为什么本地无法产出「CI 权威哈希」

> 结论：**`apps/executor-desktop/executor-node-bundle.sha256` 的期望值只能在
> CI 的 Linux runner 上产出**。本机（Windows，任意目录）重打 ncc 产物得到的
> hash **必然不同**，且这与本次 `python_task_multiversion` 改动**无关**——
> 用**未改动的 HEAD 源码**重打，同样对不上。

## 0. 结论的置信度说明（先说方法与自查）

这条结论经过**两轮自我纠错**才定稿，因为最初的交互式实验出现过**两次假阳性**
（在 PowerShell 里漏写 `$`，`$h=(...)` 被当成命令名，两边 hash 都是**空串**，
`-eq` 于是判定为 True，得出完全相反的"路径无关"结论）。

因此最终结论由脚本 `scripts/.tmp-bundle-path-experiment.ps1` 产出，该脚本强制：

1. **断言 hash 非空且为 64 字符** —— 杜绝"空串相等"这类假阳性；
2. **断言两棵输入树逐字节相同**（含 `node_modules`，逐文件指纹）——否则实验被混淆；
3. 才允许给出路径依赖与否的结论。

最终实测（输入树各 10371 个文件、指纹完全一致）：

| 观测 | 结果 |
|---|---|
| 同一目录重复构建 | **一致** → 构建是确定性的（hash 形式本身成立） |
| 不同绝对根、**相同相对结构** | **不一致** → **产物 PATH-DEPENDENT** |
| 差异归类 | 66788 行中 **1081 行不同，全部是 module id 引用，其它差异 0** |
| `subst X:` 别名 vs 真实路径（同一物理目录） | **一致** → 用的是 **realpath**，不是字面路径串 |

即：产物**语义完全等价**，仅 ncc 的 module id 编号随构建目录的**真实绝对路径**变化。

## 1. 复现步骤（全部实跑）

```powershell
# 取 HEAD 源码、按 lockfile 精确装依赖、按 CI 的同一条 ncc 命令重打
git archive HEAD apps/executor-node | tar -x -C $w
cd "$w/apps/executor-node"; npm ci --ignore-scripts
& <desktop>/node_modules/.bin/ncc build src/main.ts -o out --source-map --no-cache
sha256sum out/index.js
```

结果：

| 输入 | 绝对路径 | 产物大小 | SHA-256 |
|---|---|---|---|
| **HEAD 源码**（未改动） | `C:\Users\…\Temp\acf-ci-head` | 2283KB | `0ea86f84…` |
| **HEAD 源码**（未改动） | `C:\acfh` | 2283KB | `b658b21e…` |
| **HEAD 源码**（未改动） | `C:\acf-exp-a\executor-node` | 2373KB | `048445ed…` |
| **同一棵树**（指纹已验证相同） | `E:\acf-exp-b\executor-node` | 2373KB | `7cf70fbc…` |
| **本特性源码** | 仓库工作区 | 2373KB | `0bfdeca2…` |
| **manifest 声明的期望值** | （CI Ubuntu runner） | — | `485e69c9…` |

**同样的源码，仅因绝对路径不同就得到不同 hash**；同一目录内重复构建则字节一致。

## 2. 机制

ncc 0.44 内联 webpack，**module id 由「模块解析后的绝对真实路径」派生**。
因此产物字节随构建目录变化。实测证据：

1. 两次构建**行数完全相同**（66788 行），差异**只在 module id 数字**上：
   ```
   line 4   A: /***/ 6760:      B: /***/ 767:
   ```
   并且全量归类后"非 module id 的差异"为 **0**。
2. 同一物理目录用 `subst` 换一个盘符访问，hash **不变** → 用的是 realpath。
   反过来，两个**真实路径不同**的目录即使内容逐字节相同，hash 也不同。

## 3. 顺带更正 manifest 注释里的一处**事实错误**

`executor-node-bundle.sha256` 现有一句：

> 注：本次 CI(Ubuntu) 重打值与本地(Git Bash/Windows) 重打值**逐字节一致**
> （均 cc54aa2f…），说明 ncc 0.44 的 `--source-map` 绝对路径差异在 0.44 已不影响产物哈希

**该结论不成立**（本次实测推翻：ncc 0.44 下绝对真实路径依然影响 hash）。
推测当年"一致"是因为**两次构建恰好落在同一个绝对路径**（例如同一台机器的同一
checkout 目录），而非跨路径可比——这正是上面第 0 节所说的"假阳性"陷阱：
只要两边都算不出值、或都在同一路径，就很容易被读成"一致"。

另注：**`--no-source-map` 并不能消除该依赖**（实测两个不同路径下的
`--no-cache` 无 sourcemap 产物依然不同）——因为根源是 module id，不是 sourcemap。

## 4. 影响与处置

* **不影响 CI**：CI 每次都在固定的 `/home/runner/work/<repo>/<repo>` 下重打，
  只要 manifest 是在**同一条 runner 路径**下生成的，闸就能自洽通过。
* **影响本地改 `executor-node/src` 的人**：改完**无法**在本地算出正确的期望值，
  必须依赖 CI 报错回填（即"改源码 → 推 CI → 用 CI 输出的 actual 回填 manifest"）。
  这正是 ADR-005 记录的痛点，也是历史上 `cc54aa2f` 那次"漏打 bundle 导致 CI 红"的成因。
* **本次处置（诚实登记，未伪造哈希）**：
  **不手工改写 manifest**。理由：本机**任何**目录下都算不出 CI 的 `485e69c9…` 或
  其新版；擅自填入本地 hash 会让闸**由"红"变"红得更隐蔽"**——本地绿、CI 红，
  比现在更糟。正确做法是让 CI 产出 actual 后回填。
  已在本文件与 `INTEGRATION-BASELINE.md` 如实标注为**遗留动作**。

## 5. 给维护者的建议（未实施，供排期）

1. **把构建固定到仓库内的相对路径**：构建前先把源码镜像到
   `<repo>/.build/executor-node` 再打（或让 CI 与本地都从该固定目录构建）。
   这才是对症的——因为病根是"**真实绝对路径**参与 module id 派生"。
   > ⚠ **不要**指望 `--no-source-map`：实测无效（见 §2 末注），
   > 病根是 module id，不是 sourcemap。本文件早期草稿曾把它写成解法，已更正。
   > 同理，`subst` 换盘符也无效（用的是 realpath，见 §0 表最后一行）。
2. **或改为「语义漂移」判据**（更推荐）：不比对整体 hash，而是比对
   `executor-node/src` 的文件清单 + 各文件内容摘要 —— 同样能抓住"改了源码没重打"，
   却完全不依赖构建路径。（更能精准命中该闸的本意。）
3. **把 manifest 注释里那句错误结论删掉/更正**，避免后人继续据此以为本地可复现。
4. **让该闸的失败信息更可诊断**：现在只打印 actual/expected 两个 hash，
   而"本地算不出"和"真的漏打"给出的是同一句话。建议至少在失败时附带
   「若你在非 CI 机器上构建，请忽略本闸并改用 CI 输出」的提示。

---

## 6. 附带发现：另一处「CI 绿、本机红」——BUG-18 自检脚本的 Windows 路径 bug（**已修**）

排查本闸时顺带跑了 CI 的 `private-registry-contract` job，发现它在 Windows 上
**必然崩溃**（与本次特性无关，是存量 bug）：

```
BUG-18 selftest failed: Error: ENOENT: no such file or directory,
  open 'E:\E:\softwareData\coding\AutoCodeFlow\apps\registry-pypi\main.py'
```

**根因**（`scripts/bug18-private-registry-selftest.mjs:30`）：

```js
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
```

`URL.pathname` 在 Windows 上返回 `/E:/…` 这种**带前导斜杠的盘符路径**，
`path.resolve` 于是拼成 `E:\E:\…`，所有 `read()` 全部 ENOENT。
CI 跑 Linux（`/home/runner/…` 恰好是合法绝对路径）所以**从未暴露**。

**已修**：改用 `fileURLToPath(import.meta.url)`（跨平台正确）。
修复后 `npm run test:private-registry` → **22 assertions passed; 2 skipped**（退出 0）。

> 旁证：本任务新增的 `scripts/check-failure-reasons.mjs` 一开始就用了
> `fileURLToPath`，所以它在本机正常——这个对比正好说明该写法是仓库里的既有陷阱。
> 全仓扫描确认：**只有这一个脚本**用了 `new URL(...).pathname` 写法。

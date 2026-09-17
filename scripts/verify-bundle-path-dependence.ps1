# 严格测定：ncc 产物 hash 是否依赖构建目录的绝对路径
#
# 为什么需要脚本：在交互式 shell 里反复写 `$h=(...)` 极易漏掉 `$`，
# 结果两边都是空串，`-eq` 判定为 True —— 会得出完全错误的"路径无关"结论。
# 本脚本 (a) 断言 hash 非空，(b) 断言输入树真的逐字节相同，(c) 才给结论。

$ErrorActionPreference = 'Continue'
$ncc = "$env:TEMP\acf-ci-sim\executor-desktop\node_modules\.bin\ncc.cmd"
if (-not (Test-Path $ncc)) { throw "ncc not found: $ncc" }

function Assert-NonEmptyHash([string]$path, [string]$label) {
  if (-not (Test-Path $path)) { throw "[$label] output missing: $path" }
  $h = (Get-FileHash $path -Algorithm SHA256).Hash.ToLower()
  if ($h.Length -ne 64) { throw "[$label] hash not 64 chars: '$h'" }
  return $h
}

function Get-TreeFingerprint([string]$root, [string]$exclude) {
  # 注意：必须用 @() 与 ArrayList —— 若直接 `$entries = foreach {...}` 且集合为空，
  # 返回值是 $null，后续 Compare-Object 会因 ReferenceObject 为 null 报错，
  # 而"两边都为 null"还会被误判成"相同"（本次实验第一版就踩了这个坑）。
  $files = @(Get-ChildItem $root -Recurse -File -Force -ErrorAction SilentlyContinue)
  if ($exclude) { $files = @($files | Where-Object { $_.FullName -notmatch $exclude }) }
  $entries = New-Object System.Collections.ArrayList
  foreach ($f in $files) {
    $rel = $f.FullName.Substring($root.Length)
    [void]$entries.Add("$rel|$((Get-FileHash $f.FullName -Algorithm SHA256).Hash)")
  }
  return @($entries | Sort-Object)
}

function Invoke-NccBuild([string]$srcDir, [string]$outDir) {
  Push-Location $srcDir
  try {
    & $ncc build src/main.ts -o $outDir --source-map --no-cache *> $null
    if ($LASTEXITCODE -ne 0) { throw "ncc failed in $srcDir (exit $LASTEXITCODE)" }
  } finally { Pop-Location }
  return (Join-Path $outDir 'index.js')
}

$base = "$env:TEMP\acf-ci-sim\executor-node"
if (-not (Test-Path "$base\src\main.ts")) { throw "base tree missing" }

# 准备两个不同的绝对根，但保持**相同的相对结构** <root>\executor-node
$rootA = "C:\acf-exp-a"
$rootB = "E:\acf-exp-b"
foreach ($r in @($rootA, $rootB)) {
  if (Test-Path $r) { Remove-Item -Recurse -Force $r }
  New-Item -ItemType Directory -Force -Path $r | Out-Null
  robocopy $base "$r\executor-node" /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed for $r (exit $LASTEXITCODE)" }
}

$srcA = "$rootA\executor-node"
$srcB = "$rootB\executor-node"

Write-Host "=== 1. 确认两棵输入树逐字节相同（含 node_modules） ==="
$fpA = @(Get-TreeFingerprint $srcA '')
$fpB = @(Get-TreeFingerprint $srcB '')
Write-Host ("  A files: {0} | B files: {1}" -f $fpA.Count, $fpB.Count)
if ($fpA.Count -eq 0 -or $fpB.Count -eq 0) {
  throw "fingerprint empty (A=$($fpA.Count) B=$($fpB.Count)) - cannot conclude anything"
}
$treeDiff = Compare-Object $fpA $fpB
if ($treeDiff) {
  Write-Host ("  !! TREES DIFFER: {0} entries" -f $treeDiff.Count) -ForegroundColor Red
  $treeDiff | Select-Object -First 5 | Format-Table -AutoSize
  throw "input trees are not identical - the experiment would be confounded"
}
Write-Host "  OK: input trees are byte-identical" -ForegroundColor Green

Write-Host ""
Write-Host "=== 2. 在两个根下分别构建 ==="
$outA = Invoke-NccBuild $srcA "$rootA\out"
$outB = Invoke-NccBuild $srcB "$rootB\out"

Write-Host ""
Write-Host "=== 3. 第三次：回到 A 原位重建，验证「同目录可重复」 ==="
$outA2 = Invoke-NccBuild $srcA "$rootA\out2"

$hA  = Assert-NonEmptyHash $outA  'A-run1'
$hB  = Assert-NonEmptyHash $outB  'B-run1'
$hA2 = Assert-NonEmptyHash $outA2 'A-run2'

Write-Host ""
Write-Host "  A run1 ($rootA) : $hA"
Write-Host "  A run2 (same)                : $hA2"
Write-Host "  B run1 ($rootB) : $hB"
Write-Host ""

$sameDirRepeatable = ($hA -eq $hA2)
$crossRootSame     = ($hA -eq $hB)

Write-Host ("  同一目录重复构建一致 (确定性) : {0}" -f $sameDirRepeatable)
Write-Host ("  不同绝对根构建一致 (路径无关) : {0}" -f $crossRootSame)
Write-Host ""

if (-not $sameDirRepeatable) {
  Write-Host "结论：构建本身不确定 —— 该闸无法用 hash 形式成立。" -ForegroundColor Yellow
} elseif ($crossRootSame) {
  Write-Host "结论：产物 PATH-INDEPENDENT —— 本地可以复现 CI 哈希。" -ForegroundColor Green
} else {
  Write-Host "结论：产物 PATH-DEPENDENT —— 本地无法复现 CI 哈希。" -ForegroundColor Yellow
  Write-Host "      依据：输入树逐字节相同、仅绝对根不同，产物即不同。" -ForegroundColor Yellow
}

# 差异归类：确认差异是否**只**在 module id 上
Write-Host ""
Write-Host "=== 4. 差异归类（差异是否只来自 module id） ==="
$la = Get-Content $outA
$lb = Get-Content $outB
Write-Host ("  lines: A={0} B={1}" -f $la.Count, $lb.Count)
$idOnly = 0; $other = 0; $otherSamples = @()
$n = [Math]::Min($la.Count, $lb.Count)
for ($i = 0; $i -lt $n; $i++) {
  if ($la[$i] -ceq $lb[$i]) { continue }
  $isId = ($la[$i] -match '^/\*\*\*/ \d+:$' -and $lb[$i] -match '^/\*\*\*/ \d+:$') -or
          ($la[$i] -match '__nccwpck_require__\(\d+\)' -and $lb[$i] -match '__nccwpck_require__\(\d+\)')
  if ($isId) { $idOnly++ } else { $other++; if ($otherSamples.Count -lt 3) { $otherSamples += $i } }
}
Write-Host ("  module-id-only diffs : {0}" -f $idOnly)
Write-Host ("  other diffs          : {0}" -f $other)
foreach ($i in $otherSamples) {
  Write-Host ("    line {0}" -f ($i + 1))
  Write-Host ("      A: {0}" -f $la[$i].Substring(0, [Math]::Min(160, $la[$i].Length)))
  Write-Host ("      B: {0}" -f $lb[$i].Substring(0, [Math]::Min(160, $lb[$i].Length)))
}
if ($other -eq 0) {
  Write-Host "  => 两产物语义等价，差异仅为 ncc 的 module id 编号。" -ForegroundColor Green
}

Write-Host ""
Write-Host "=== 附：subst 别名测试（同一物理目录、两个路径拼写） ==="
$alias = 'Y:'
& subst $alias $rootB 2>&1 | Out-Null
try {
  if (Test-Path "$alias\executor-node\src\main.ts") {
    $outY = Invoke-NccBuild "$alias\executor-node" "$alias\out-alias"
    $hY = Assert-NonEmptyHash $outY 'alias'
    Write-Host ("  via realpath {0} : {1}" -f $rootB, $hB)
    Write-Host ("  via alias    {0} : {1}" -f $alias, $hY)
    Write-Host ("  alias == realpath: {0}  (true => 用的是 realpath，不是字面路径)" -f ($hY -eq $hB))
  } else { Write-Host "  (subst alias not usable, skipped)" }
} finally {
  & subst $alias /D 2>&1 | Out-Null
}

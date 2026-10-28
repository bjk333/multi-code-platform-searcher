# tests/u260-execution-harness.ps1 —— U-260（B2-5）的数据面：**直调纯函数 `New-ExecutionBlock`**，不跑检索。
#
# 为什么可以"只跑纯函数"：execution 块的全部判定（是否截断、哪些源算 skipped、逐池透传）都在这个函数里，
#   载荷那一段只负责取数（总预算、墙钟、poolStats）。所以这里不需要网络，也不需要造 27 个引擎。
#
# 七个臂对应七种真实形态（每条都在现场见过或能一眼看出是谎）：
#   A 空            —— 什么都没跑：budgetMs=0（**不编默认值**）、truncated=false、pools=[]
#   B 池早停        —— earlyStop ⇒ truncated=true，pools 原样透传（含被收紧后的预算）
#   C deadline 码   —— 无池早停，但引擎自己报 deadline ⇒ 仍算截断
#   D 预算整段跳过  —— 码是历史值 error、文案写着"未执行（不是 0 命中）" ⇒ skipped 必须点名且改判 budget-truncated
#   E 真·未执行类码 —— health-skip / user-disabled / missing-credential 各按原码进 skipped
#   F 排序与去重    —— skipped 按引擎名排序（同一轮两次跑出不同顺序会让 diff 噪音压过变化）
#   G 负数防御      —— 传负的预算/墙钟 ⇒ 夹到 0（对外字段是 minimum:0，不能靠"调用方不会传负的"）
param([string]$SkillDir = '')
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
if (-not $SkillDir) { $SkillDir = (Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..')).Path }
$env:MCPS_NO_MAIN = '1'
. (Join-Path (Resolve-Path $SkillDir).Path 'multi-platform-searcher.ps1')

$fails = @()
function Check([string]$id, [bool]$cond, [string]$detail = '') { if (-not $cond) { $script:fails += ("{0}: {1}" -f $id, $detail) } }
function Codes($pairs) { $h = [ordered]@{}; foreach ($k in $pairs.Keys) { $h[$k] = $pairs[$k] }; return $h }

$arms = @()

# A 空
$a = New-ExecutionBlock
$arms += [PSCustomObject]@{ id = 'A'; budgetMs = $a.budgetMs; spentMs = $a.spentMs; reserveMs = $a.reserveMs; truncated = $a.truncated; skipped = @($a.skipped); pools = @($a.pools) }
Check 'A.budgetMs=0（未设预算不编默认值）' ($a.budgetMs -eq 0) "$($a.budgetMs)"
Check 'A.truncated=false' (-not $a.truncated) ''
Check 'A.pools 空' (@($a.pools).Count -eq 0) ''

# B 池早停 + 透传
$p1 = [PSCustomObject]@{ mode = 'repo'; budgetMs = 8000; spentMs = 7900; earlyStop = $true; sufficient = $false }
$b = New-ExecutionBlock -PoolStats @($p1) -TotalBudgetSec 40 -SpentMs 12345
$arms += [PSCustomObject]@{ id = 'B'; budgetMs = $b.budgetMs; spentMs = $b.spentMs; truncated = $b.truncated; poolCount = @($b.pools).Count; pool0 = $b.pools[0] }
Check 'B.budgetMs=40000' ($b.budgetMs -eq 40000) "$($b.budgetMs)"
Check 'B.spentMs=12345' ($b.spentMs -eq 12345) "$($b.spentMs)"
Check 'B.earlyStop⇒truncated' ($b.truncated) ''
Check 'B.pools 透传 1 条且字段不丢' ((@($b.pools).Count -eq 1) -and ($b.pools[0].mode -eq 'repo') -and ($b.pools[0].earlyStop -eq $true)) ''

# C deadline 码（无池）
$c = New-ExecutionBlock -ReasonCodes (Codes @{ HF = 'deadline' })
$arms += [PSCustomObject]@{ id = 'C'; truncated = $c.truncated; skipped = @($c.skipped | ForEach-Object { $_.engine }) }
Check 'C.deadline⇒truncated' ($c.truncated) ''
Check 'C.deadline 不进 skipped（它跑了）' (@($c.skipped).Count -eq 0) (@($c.skipped).Count)

# D 预算整段跳过（码=error + 文案）
$texts = [System.Collections.Concurrent.ConcurrentDictionary[string, string]]::new()
$texts['GitHub'] = '本轮总预算已耗尽，未执行（不是 0 命中）'
$texts['Gitee'] = '本轮总预算已耗尽，未执行（不是 0 命中）'
$d = New-ExecutionBlock -ReasonCodes (Codes @{ GitHub = 'error'; Gitee = 'error' }) -ReasonTexts $texts
$arms += [PSCustomObject]@{ id = 'D'; truncated = $d.truncated; skipped = @($d.skipped | ForEach-Object { "$($_.engine)=$($_.reasonCode)" }) }
Check 'D.预算跳过⇒truncated' ($d.truncated) ''
Check 'D.skipped 点名 2 个' (@($d.skipped).Count -eq 2) (@($d.skipped).Count)
Check 'D.码改判 budget-truncated' (@($d.skipped | Where-Object { $_.reasonCode -eq 'budget-truncated' }).Count -eq 2) (($d.skipped | ForEach-Object { $_.reasonCode }) -join ',')

# E 未执行类码逐个保留
$e = New-ExecutionBlock -ReasonCodes (Codes @{ HF = 'health-skip'; Old = 'user-disabled'; Gh = 'missing-credential'; SG = 'tool-missing'; X = 'not-run' })
$arms += [PSCustomObject]@{ id = 'E'; skipped = @($e.skipped | ForEach-Object { "$($_.engine)=$($_.reasonCode)" }) }
Check 'E.5 类未执行码全进 skipped' (@($e.skipped).Count -eq 5) (@($e.skipped).Count)
Check 'E.码原样保留' (((@($e.skipped | ForEach-Object { $_.reasonCode }) | Sort-Object) -join ',') -eq 'health-skip,missing-credential,not-run,tool-missing,user-disabled') ((@($e.skipped | ForEach-Object { $_.reasonCode }) | Sort-Object) -join ',')

# F 排序
# ★必须传**有序**字典：普通 @{} 的枚举顺序是哈希序（且逐进程随机化），"不排序"的对照就不可复现 ——
#   实测在全量并发下这条变异偶发通过（顺序恰好等于哈希序）。ordered 才让"去掉 Sort-Object"这件事有确定后果。
$fOrdered = [ordered]@{}; $fOrdered['Zebra'] = 'health-skip'; $fOrdered['Alpha'] = 'health-skip'; $fOrdered['Mike'] = 'health-skip'
$f = New-ExecutionBlock -ReasonCodes $fOrdered
$arms += [PSCustomObject]@{ id = 'F'; order = @($f.skipped | ForEach-Object { $_.engine }) }
Check 'F.skipped 按引擎名排序' (((@($f.skipped | ForEach-Object { $_.engine })) -join ',') -eq 'Alpha,Mike,Zebra') ((@($f.skipped | ForEach-Object { $_.engine })) -join ',')

# G 负数夹到 0
$g = New-ExecutionBlock -TotalBudgetSec -3 -SpentMs -7 -ReserveMs -1
$arms += [PSCustomObject]@{ id = 'G'; budgetMs = $g.budgetMs; spentMs = $g.spentMs; reserveMs = $g.reserveMs }
Check 'G.负数全夹到 0' (($g.budgetMs -eq 0) -and ($g.spentMs -eq 0) -and ($g.reserveMs -eq 0)) "$($g.budgetMs)/$($g.spentMs)/$($g.reserveMs)"

[PSCustomObject]@{ ok = (@($fails).Count -eq 0); fails = @($fails); arms = @($arms) } | ConvertTo-Json -Depth 6 -Compress
if (@($fails).Count -gt 0) { exit 1 }

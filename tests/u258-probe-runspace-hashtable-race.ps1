# 探针 2：普通 Hashtable 被 N 个 runspace 并发写，丢不丢键？（B2 的传输层前提）
$ErrorActionPreference = 'Stop'
$rounds = 40
$lost = 0; $threw = 0
for ($r = 0; $r -lt $rounds; $r++) {
    $ht = @{}
    $pool = [runspacefactory]::CreateRunspacePool(1, 8)
    $pool.ApartmentState = 'MTA'
    $pool.Open()
    $psList = @()
    for ($i = 0; $i -lt 8; $i++) {
        $ps = [powershell]::Create(); $ps.RunspacePool = $pool
        [void]$ps.AddScript({
            param($Inject, $Id)
            foreach ($k in $Inject.Keys) { Set-Variable -Name $k -Value $Inject[$k] }
            . ([scriptblock]::Create('function Set-EngineStatus { param([string]$Name,[string]$Status) $script:_engineStatus[$Name] = $Status }'))
            for ($j = 0; $j -lt 20; $j++) { Set-EngineStatus -Name ("E$Id-$j") -Status 'ok' }
        }).AddArgument(@{ _engineStatus = $ht }).AddArgument($i)
        $psList += $ps
    }
    foreach ($ps in $psList) { try { $null = $ps.Invoke() } catch { $threw++ } }
    foreach ($ps in $psList) { $ps.Dispose() }
    $pool.Close(); $pool.Dispose()
    $lost += (160 - $ht.Count)
}
"$rounds 轮 × 8 runspace × 20 键：期望 6400 键，实收 $((  $rounds*160 ) - $lost)，丢失 $lost，Invoke 抛错 $threw 次"

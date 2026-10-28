# 探针：runspace 内 Set-EngineStatus 的写入到底能不能回父作用域？
# 目的：注释说"写不进"，但 _engineStatus 在 _injectVars 里（引用类型 hashtable）—— 二者矛盾，必须实测。
$ErrorActionPreference = 'Stop'

# 臂 A：普通 Hashtable（现状）
$ht = @{}
$pool = [runspacefactory]::CreateRunspacePool(1, 1)
$pool.ApartmentState = 'MTA'
$pool.Open()
$ps = [powershell]::Create()
$ps.RunspacePool = $pool
[void]$ps.AddScript({
    param($Inject)
    foreach ($k in $Inject.Keys) { Set-Variable -Name $k -Value $Inject[$k] }
    . ([scriptblock]::Create('function Set-EngineStatus { param([string]$Name,[string]$Status) $script:_engineStatus[$Name] = $Status }'))
    Set-EngineStatus -Name 'ProbeA' -Status 'ok'
}).AddArgument(@{ _engineStatus = $ht })
$null = $ps.Invoke()
$ps.Dispose(); $pool.Close(); $pool.Dispose()
"A 普通Hashtable：父侧看到 = " + ($(if ($ht.ContainsKey('ProbeA')) { $ht['ProbeA'] } else { '<丢失>' }))

# 臂 B：ConcurrentDictionary（若 A 丢失，则应改用它）
$cd = [System.Collections.Concurrent.ConcurrentDictionary[string, string]]::new()
$pool = [runspacefactory]::CreateRunspacePool(1, 1)
$pool.ApartmentState = 'MTA'
$pool.Open()
$ps = [powershell]::Create()
$ps.RunspacePool = $pool
[void]$ps.AddScript({
    param($Inject)
    foreach ($k in $Inject.Keys) { Set-Variable -Name $k -Value $Inject[$k] }
    . ([scriptblock]::Create('function Set-EngineStatus2 { param([string]$Name,[string]$Status) $script:_cd[$Name] = $Status }'))
    Set-EngineStatus2 -Name 'ProbeB' -Status 'ok'
}).AddArgument(@{ _cd = $cd })
$null = $ps.Invoke()
$ps.Dispose(); $pool.Close(); $pool.Dispose()
"B ConcurrentDictionary：父侧看到 = " + ($(if ($cd.ContainsKey('ProbeB')) { $cd['ProbeB'] } else { '<丢失>' }))

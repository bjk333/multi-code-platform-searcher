# engines/hugging-face.ps1 —— 由 U-100 步骤 C 从 multi-platform-searcher.ps1 位移而来（2026-09-28）
#   只含函数定义，无顶层副作用；由主脚本 dot-source（注入链 (Get-Item "function:X").Definition 零改动）。
#   位移来源：主脚本 L2028–2065（38 行，权威 AST 口径）；body_sha256=235e575012394ec579cab17a6d0341c1d411364467076ec8a73e2c726e9868f1
#   ★B2-1（U-258，2026-10-26）：本引擎已迁 EngineContract v1 —— 返回**封套**而不是数组，且**不再自报 status**
#     （由池侧 Resolve-EngineVerdict 派生；理由见主脚本 New-EngineEnvelope 头注：自报与派生只能有一个真源）。

function Search-HuggingFace {
    param($Keyword, $Limit)
    Write-ColorOutput "正在 Hugging Face Hub 检索（models / datasets / spaces）..." "Cyan"
    $t0 = [DateTime]::UtcNow
    # B2-1：逐引擎请求账 —— C4 此前只有全局口径（`metrics.Requests`），"哪个源在烧请求"无从回答。
    #   只数本引擎真正发出的（try 前 +1），传输异常记 failed。
    $req = @{ attempted = 0; succeeded = 0; failed = 0 }
    $kinds = @(
        @{ suffix = 'models';   label = 'model';   urlPrefix = 'https://huggingface.co/' }
        @{ suffix = 'datasets'; label = 'dataset'; urlPrefix = 'https://huggingface.co/datasets/' }
        @{ suffix = 'spaces';   label = 'space';   urlPrefix = 'https://huggingface.co/spaces/' }
    )
    $results = @(); $i = 1
    # R5-TLS（2026-10-10）：**按 kind 记账** —— 此前 catch 只打印、`if (-not $data) { continue }` 也不记账，
    #   于是「三个 kind 全部连不上」与「三种都搜了确实没结果」在载荷里**无法区分**：状态未设 ⇒ 被池尾兜底
    #   判成 empty/zero-hit（"搜了没结果"），而事实是「连不上」。实测（隔离 HF + 把域名改坏）：
    #   `ReasonCodes={"HF":"zero-hit"}` 且 errors[] 里没有 HF ⇒ **失败不可见**。
    #   ★引擎名用注册表的 Name='HF'（Platforms 才是 HuggingFace）。
    $failedKinds = @()
    foreach ($k in $kinds) {
        $uri = "https://huggingface.co/api/$($k.suffix)?search=$([uri]::EscapeDataString($Keyword))`&limit=$Limit"
        $req.attempted++
        try {
            $data = (Invoke-ApiRequest -Uri $uri -Headers @{"User-Agent" = "multi-code-platform-searcher/$VERSION"}).Content | ConvertFrom-Json
            $req.succeeded++
            if (-not $data) { continue }
            foreach ($item in $data) {
                $id = if ($item.id) { $item.id } else { $null }
                if (-not $id) { continue }
                $dl = if ($null -ne $item.downloads) { $item.downloads } else { 0 }
                $likes = if ($null -ne $item.likes) { $item.likes } else { 0 }
                $results += [PSCustomObject]@{
                    Index   = $i
                    Platform = "HuggingFace"
                    Name    = "$($k.label):$id"
                    Stars   = $dl
                    Unit = 'downloads/month'
                    Url     = "$($k.urlPrefix)$id"
                    Desc    = "kind=$($k.label); likes=$likes"
                    License = if ($item.license) { [string]$item.license } else { '' }
                    Updated = ''
                }
                $i++
            }
        }
        catch { Write-ColorOutput "Hugging Face $($k.label) 检索失败(可忽略): $_" "DarkYellow"; $req.failed++; $failedKinds += $k.label }
    }
    # R5-TLS：失败必须显式（不许被池尾兜成"搜了没结果"）—— 现在由 failure 字段承载，L1 据此派生 degraded / error。
    #   reasonCode 用 'error' 而不是 'network-unavailable'：本引擎没有对异常分档（403/429/TLS 都混在一起），
    #   猜成 network-unavailable 只会把"被限流"误导成"网络不通"。分档留给 B2-6 的失败分类账，先如实说 'error'。
    $failure = $null
    if ($failedKinds.Count -ge $kinds.Count) {
        $failure = @{ reasonCode = 'error'; reason = ("全部 kind 检索失败: " + ($failedKinds -join ', ') + " ⇒ 先查 huggingface.co 可达性与代理白名单，勿当零命中") }
        Add-EngineWarning -Engine 'HF' -Message ("[HuggingFace] 全部 kind 检索失败（" + ($failedKinds -join ', ') + "）") -From 'engine' -To 'error'
    }
    elseif ($failedKinds.Count -gt 0) {
        # 部分 kind 失败、仍有产出 ⇒ degraded（与 package-registries 子源失败同口径：不假装完整成功）
        $failure = @{ reasonCode = 'error'; reason = ("部分 kind 失败: " + ($failedKinds -join ', ')) }
        Add-EngineWarning -Engine 'HF' -Message ("[HuggingFace] 部分 kind 失败: " + ($failedKinds -join ', ')) -From 'engine' -To 'degraded'
    }
    Write-ColorOutput "Hugging Face Hub 命中 $($results.Count) 条（models / datasets / spaces）" "Green"
    return New-EngineEnvelope -Engine 'HF' -Kind 'research' -Results $results -Requests $req -Failure $failure `
        -Quota @{ class = 'anonymous'; limit = $null; remaining = $null; resetAt = $null } -StartedAt $t0
}

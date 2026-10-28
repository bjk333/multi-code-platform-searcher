# engines/local-code.ps1 —— 由 U-100 步骤 C 从 multi-platform-searcher.ps1 位移而来（2026-09-28）
#   只含函数定义，无顶层副作用；由主脚本 dot-source（注入链 (Get-Item "function:X").Definition 零改动）。
#   位移来源：主脚本 L1884–1965（82 行，权威 AST 口径）；body_sha256=cc3ea5a788e3edf18f801bc7d975aec6f33b51adea684c03cadc5d3e2e75775f

function Search-LocalCode {
    param($Keyword, $LocalPath, $Limit, [switch]$UseAstGrep)
    if (-not $LocalPath -or -not (Test-Path $LocalPath)) {
        # v1.21.0 P0-1：LocalPath 无效不是"0 命中"，显式标注
        Set-EngineStatus -Name 'LocalCode' -Status 'error' -Reason "需要存在的 -LocalPath 目录（当前: $LocalPath）"
        Write-ColorOutput "本地代码检索需提供存在的 -LocalPath 目录" "Yellow"
        return $null
    }
    # P1（v1.15.0）：ast-grep 结构化检索（-UseAstGrep 显式启用；缺失自动回退 rg/ugrep）
    if ($UseAstGrep) {
        $ag = Find-AstGrep
        if ($ag) {
            Write-ColorOutput "正在用 ast-grep 结构化模式检索代码证据（$ag）..." "Cyan"
            try {
                $json = (& $ag run -p $Keyword --json $LocalPath 2>$null) | Out-String
                $data = $json | ConvertFrom-Json
                $results = @(); $i = 1
                # v1.20.0 实机复测修复：ast-grep 0.45.x --json 顶层为数组（旧版为 {"matches":[...]}），
                # 行号在 range.start.line（0 基，+1 转 1 基）、lines 为匹配行字符串（旧版为对象）。
                $matches = @()
                if ($data -is [System.Array]) { $matches = $data }
                elseif ($data -and $data.matches) { $matches = @($data.matches) }
                foreach ($m in $matches) {
                    $file = [string]$m.file
                    $ln = 0
                    if ($m.range -and $m.range.start -and $null -ne $m.range.start.line) { $ln = [int]$m.range.start.line + 1 }
                    elseif ($m.lines -and $m.lines.start -and $null -ne $m.lines.start.line) { $ln = [int]$m.lines.start.line + 1 }
                    $txt = ([string]$m.text -replace '\s+', ' ').Trim()
                    $preview = Get-SafePreview -Text $txt -MaxChars $script:Cfg.PreviewLen   # U-134：按字符截断且不切开代理对（emoji），保证 JSON 合法 UTF-8
                    $abs = $file
                    try { $abs = (Resolve-Path $file -ErrorAction SilentlyContinue).Path } catch { }
                    $url = if ($abs) { "file:///$abs" } else { $file }
                    $results += [PSCustomObject]@{ Index = $i; Platform = "ast-grep"; Name = $file; File = $file; Line = $ln; Preview = $preview; Url = $url; Desc = $null }
                    $i++
                    if ($i -gt $Limit) { break }
                }
                Set-EngineStatus -Name 'LocalCode' -Status 'ok' -Reason ''
                Write-ColorOutput "ast-grep 命中 $($results.Count) 条代码证据" "Green"
                return $results
            }
            catch { Write-ColorOutput "ast-grep 检索失败(可忽略)，回退 rg/ugrep: $_" "DarkYellow" }
        }
        else { Write-ColorOutput "未检测到 ast-grep，回退 ripgrep/ugrep" "DarkYellow" }
    }
    $bin = Find-LocalSearchBinary
    if (-not $bin) {
        # v1.21.0 P0-1：真正根因——本地检索二进制缺失。标记 tool_missing（此前静默降级远程，伪装成"无结果"）
        Set-EngineStatus -Name 'LocalCode' -Status 'tool_missing' -Reason '未检测到 ripgrep(rg)/ugrep，本地代码检索不可用'
        Write-ColorOutput "未检测到 ripgrep/ugrep，跳过本地代码检索(将降级远程)" "DarkYellow"
        return $null
    }
    Write-ColorOutput "正在用 $bin 本地检索代码证据..." "Cyan"
    try {
        $out = & $bin -n --color=never -e $Keyword $LocalPath 2>$null
        $results = @(); $i = 1
        foreach ($line in $out) {
            if (-not $line) { continue }
            # 兼容 Windows 绝对路径（含 C:）、相对路径；ugrep 可能额外带列号
            if ($line -match '^(?<pre>[A-Za-z]:)?(?<path>.*?):(?<line>\d+):(?<rest>.*)$') {
                # R2（活体 payload 门实证）：Line 原为字符串（-match 捕获组）⇒ 违反 schema 的 integer；Preview 原未截断（U-134 只接到了 ast-grep 分支）
                $file = $matches['pre'] + $matches['path']; $lineNo = [int]$matches['line']; $rest = $matches['rest']
                # ugrep 可能输出 file:line:col:content，去掉列号前缀
                if ($rest -match '^(\d+):(.*)$') { $rest = $matches[2] }
                $abs = $file
                try { $abs = (Resolve-Path $file -ErrorAction SilentlyContinue).Path } catch { }
                $url = if ($abs) { "file:///$abs" } else { $file }
                $preview = Get-SafePreview -Text (($rest -replace '\s+', ' ').Trim()) -MaxChars $script:Cfg.PreviewLen
                $results += [PSCustomObject]@{ Index = $i; Platform = "Local"; Name = $file; File = $file; Line = $lineNo; Preview = $preview; Url = $url; Desc = $null }
                $i++
                if ($i -gt $Limit) { break }
            }
        }
        # v1.21.0：区分 "本地检索成功但 0 命中"（empty，可信）与 "检索失败"（error）
        if ($results.Count -eq 0) { Set-EngineStatus -Name 'LocalCode' -Status 'empty' -Reason '本地检索成功但 0 命中' }
        else { Set-EngineStatus -Name 'LocalCode' -Status 'ok' -Reason '' }
        Write-ColorOutput "本地命中 $($results.Count) 条代码证据" "Green"
        return $results
    }
    catch {
        Set-EngineStatus -Name 'LocalCode' -Status 'error' -Reason $_.Exception.Message
        Write-ColorOutput "本地代码检索失败(可忽略): $_" "DarkYellow"
        return $null
    }
}

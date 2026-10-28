# engines/codeberg.ps1 —— 由 U-100 步骤 C 从 multi-platform-searcher.ps1 位移而来（2026-09-28）
#   只含函数定义，无顶层副作用；由主脚本 dot-source（注入链 (Get-Item "function:X").Definition 零改动）。
#   位移来源：主脚本 L1723–1746（24 行，权威 AST 口径）；body_sha256=7d963a0aa148a3c8968b6ebd82b480bcf8e78fd12be25d9410ab585103be50f5

function Search-Codeberg {
    param($Keyword, $Language, $MinStars, $Limit)
    Write-ColorOutput "正在 Codeberg 搜索..." "Cyan"
    $uri = "https://codeberg.org/api/v1/repos/search?q=$([uri]::EscapeDataString($Keyword))`&sort=stars`&order=desc`&limit=$Limit"
    try {
        $data = (Invoke-ApiRequest -Uri $uri -Headers @{"User-Agent" = "multi-code-platform-searcher/$VERSION"}).Content | ConvertFrom-Json
        $results = @(); $i = 1
        if ($data -and $data.data) {
            foreach ($item in $data.data) {
                # v1.45.3（2026-10-20 全量验收 P2-3）：`stars` 缺失时输出 **null（未知）**，不再写成 0。
                #   旧写法把「未知」显示成「0 星」⇒ `-MinStars 100` 的结果里出现 0 星仓库，调用方无法区分
                #   「真 0 星」与「该源不填字段」。schema 的 Stars 已允许 null；主脚本三处消费点（L1726/1805/1882）
                #   都用 `$null -ne` 或真值判断 ⇒ 排序/归一化把 null 当 0，不会崩。
                $stars = if ($null -ne $item.stars) { $item.stars } else { $null }
                # Gitea/Codeberg 搜索结果常返回 stars:null（不填充），此时按「通过」处理，
                # 仅当确知 star 数且低于阈值才过滤，避免全部被误杀导致 Codeberg 恒为 0 结果。
                $passStars = if ($null -eq $item.stars) { $true } else { $item.stars -ge $MinStars }
                if ($passStars -and (-not $Language -or (([string]$item.language).ToLower() -eq $Language.ToLower()))) {
                    # v1.46.7：Gitea 返回 archived（实测 True/False 都有）；缺失 ⇒ $null（未知），不伪造 false
                    $results += [PSCustomObject]@{ Index = $i; Platform = "Codeberg"; Name = $item.full_name; Stars = $stars; Unit = 'stars'; Url = $item.html_url; Desc = $item.description; License = $null; Updated = $item.updated_at; Archived = $(if ($null -ne $item.archived) { [bool]$item.archived } else { $null }) }
                    $i++
                }
            }
        }
        Write-ColorOutput "Codeberg 搜索完成（命中 $($results.Count) 条）" "Green"
        # R5-TLS（2026-10-10）：**显式设状态，不靠池尾兜底**。
        #   由来：本引擎原先两条出口都不设状态 ⇒ 池尾兜底（主脚本 L3056-3057）把
        #   「unknown + 0 结果」一律判成 `empty`（"检索成功但 0 命中"）⇒ **catch 吞掉的失败被洗成成功**
        #   ⇒ 不进 degraded ⇒ `coverage.Verdict` 仍是 **full**，而该源实际一条都没取到（静默假阴性）。
        #   与 search-gitlab/engines 的 U-157 修法同款（先例注释见该文件头部）。
        if ($results.Count -eq 0) { Set-EngineStatus -Name 'Codeberg' -Status 'empty' -Reason '检索成功但 0 命中' }
        else { Set-EngineStatus -Name 'Codeberg' -Status 'ok' -Reason '' }
        return $results
    }
    catch {
        # ★失败必须显式上报（旧写法 `return @()` 不设状态 ⇒ 被池尾兜成 empty ⇒ Verdict=full）
        Write-ColorOutput "Codeberg 搜索失败: $_" "Red"
        Set-EngineStatus -Name 'Codeberg' -Status 'error' -Reason "检索失败: $($_.Exception.Message)"
        Add-EngineWarning -Engine 'Codeberg' -Message "[Codeberg] 检索失败：$($_.Exception.Message)" -From 'engine' -To 'error'
        return @()
    }
}
